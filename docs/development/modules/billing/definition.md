# Module: Billing – Definition

## Purpose

A flat monthly subscription **per organisation**, collected by Razorpay
auto-debit, which is what entitles the organisation's API keys to call the
Messaging API. The console itself is not sold and not gated.

Per organisation, not per account. It used to be per account, and the price
list could not be read coherently as a result: the card said *"₹999 /WABA/month"*
while the limit printed on the same card counted the organisation's accounts,
so a customer with three was told to buy Growth three times to get a limit of
three. One subscription, one price, one renewal date.

What a tier decides is therefore **what the price includes**, not what the
customer is allowed. Accounts and phone numbers past the included counts are
sold as add-ons; the things that cost us capacity rather than money — team
members, webhook endpoints, API keys, contacts, send rate, retention — stay
capped.

An **agency** pays once for itself and for every client organisation beneath it.
Every question about what an organisation may do resolves the payer first, so a
client inherits its agency's subscription and never buys one of its own. See
`docs/development/modules/agency/definition.md`.

The rule the whole module exists to enforce: **a customer may subscribe or
cancel at any moment, and access lasts to the end of the month they have paid
for.**

---

## Scope

| Area | Included | Excluded |
|------|----------|----------|
| Monthly plan, one per organisation | ✅ Yes | — |
| Tiers from the published price list, and privately negotiated ones | ✅ Yes | — |
| Register (mandate authorisation via Razorpay Checkout) | ✅ Yes | — |
| Cancel at any time, access to end of paid month | ✅ Yes | — |
| Upgrade with a new mandate, charging only the difference | ✅ Yes | — |
| Downgrade at the renewal | ✅ Yes | Credit for the unused month |
| Add-ons for accounts and numbers past what the tier includes | ✅ Yes | — |
| Auto-debit each cycle, with retries | ✅ Yes | Razorpay's own dunning schedule |
| Webhook-driven state, hourly reconciliation | ✅ Yes | — |
| Paywall on API-key traffic | ✅ Yes | Console (JWT) stays free |
| Metered or usage pricing | ❌ No | Flat monthly plus add-ons |
| Refunds | ❌ No | Handled manually in Razorpay |
| In-app card update | ❌ No | Re-register; Razorpay has no hosted portal |

---

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/billing/subscription` | JWT | The organisation's subscription: active, status, period, cancel flag, the tier, the price, recent debits, the next charge date, every account it covers, and `usage` against what the tier includes |
| POST | `/billing/subscription` | JWT | Subscribe on a tier. Returns the subscription id to open Checkout with, the publishable key, and the hosted page as a fallback. Throttled 5/min |
| POST | `/billing/subscription/confirm` | JWT | Record a mandate authorised in Checkout, signature-checked. Also the point at which an upgrade takes effect |
| PATCH | `/billing/subscription/plan` | JWT | Move to another tier |
| DELETE | `/billing/subscription` | JWT | Cancel. Keeps the paid month |
| POST | `/billing/webhook` | HMAC signature | Razorpay events |

`GET /billing/subscription` answers even when there is no subscription: the
console's job is to say whether the organisation is paid up and offer a tier if
it is not, and an empty response would read as a fault rather than as "not
subscribed".

---

## Which row is the organisation's

`Subscription.wabaId IS NULL` is what makes a row the organisation's. Rows that
still carry a `wabaId` are history: a subscription whose account was deleted, or
one marked `superseded` when the migration collapsed the per-account ones.

`@@unique([wabaId, ssoOrgId])` cannot express "one per organisation" — Postgres
treats NULLs as distinct, so it would allow two organisation-level rows and with
them two mandates and two debits a month. The constraint that does say it is the
partial unique index `Subscription_org_key`, created in raw SQL. Prisma cannot
express a partial index, so `migrate dev` reports it as drift; it stays.

---

## Access rule

`SubscriptionAccessService.grants()` is the single definition, used by the state
endpoint and the paywall alike:

1. `superseded` → **refused**, whatever the dates say. Such a row was replaced
   by the organisation's subscription; honouring a paid month on it would grant
   access nobody is paying for.
2. `currentEnd` in the future → **allowed**, whatever the status. This is what
   makes cancellation keep the paid month, and it also carries a customer
   through a failed renewal while Razorpay retries.
3. Otherwise `active` or `authenticated` → allowed.
4. Otherwise refused.

A subscription in `created` — registered but the mandate never authorised — has
paid nothing and is refused.

The lookup resolves the **payer** first (`OrganisationSettings.billingOrgFor`),
so an agency's clients are answered from the agency's subscription.

## Enforcement

The subscription buys the **organisation**, not one way of reaching it. Two
layers:

**`BillingService.requireAccess(ssoOrgId, wabaId)`** — called by the operations
themselves, so the console pays too: sending a message, syncing or creating
templates, and registering a phone number. Gating only the API key would have
left the console as a free way to do the very things being sold. Reads are
deliberately not gated; someone who has stopped paying keeps their history,
their exports and the ability to subscribe again.

**`SubscriptionMiddleware`** runs after `MessagingAuthMiddleware` on the
`/messages` routes, so both `authType` and `apiKeyWabaId` are already set. It
covers the API-key path's reads as well, which the service-level check does not
see. Only API-key traffic is charged for; console requests carry a JWT and pass
untouched.

Refusal is **402 Payment Required**, naming the console as the place to fix it.

A deployment with no Razorpay credentials lets everything through, so
development and self-hosting need no payment provider.

## Caching

`sub:{ssoOrgId}:{wabaId}:v{payerVersion}` in Redis holds the allow/deny answer
for 60 seconds. Two parts matter beyond the ids:

- The **organisation** is in the key for the same reason it is in the row: two
  organisations holding one account must not share one answer.
- The **payer version** is what makes an agency workable. A client's access
  depends on its agency's subscription, so one failed debit has to darken every
  client of that agency and every account each of them holds. Enumerating those
  keys is fine at five clients and a problem at five hundred; bumping the
  payer's version orphans all of them in a single write instead.

Every webhook invalidates it, so a cancellation or a failed debit lands at once;
the TTL is the backstop for a webhook that never arrives. Unlike the API-key
cache, this one must never be written without an expiry.

---

## Changing tier

Two paths, and they follow from what a Razorpay mandate is: it is authorised for
a fixed amount, so nothing can raise what a customer is charged without them
approving it again.

### Up a tier — authorise, then cancel

1. A **second** Razorpay subscription is created on the new tier, with
   `start_at` set to the end of the month already paid for. Without it Razorpay
   would charge the new tier today and the customer would have bought the same
   days twice.
2. A one-off **add-on** for the pro-rated difference —
   `(newPrice − oldPrice) × daysLeft ÷ cycleLength`, rounded down so a rounding
   error is never charged to the customer — is raised on that subscription. It
   is what the dearer tier costs them for the rest of the month they are in.
3. The customer is sent back to Checkout. Until they authorise it, **nothing
   changes**: `planRefId` — which every limit reads — stays on the tier they
   hold and are still paying for. The new subscription is parked in
   `pendingRazorpaySubscriptionId` / `pendingShortUrl`, and the tier they asked
   for in `pendingPlanRefId`.
4. `/confirm` with the new subscription's id is where the two swap over: the old
   one is cancelled `at_cycle_end`, the new one becomes the organisation's, and
   the pending columns are cleared.

An upgrade abandoned at Checkout therefore leaves no trace beyond a Razorpay
subscription nobody authorised, and cancelling abandons it explicitly.

Old behaviour asked Razorpay to re-point the running subscription with
`schedule_change_at: 'now'`, which the bank's ceiling refused as soon as the new
amount was higher than the mandate. That refusal is the reason for this design;
the ceiling branch survives in `RazorpayService` as a defence on a path that
should no longer raise an amount.

### Down a tier — at the renewal

`schedule_change_at: 'cycle_end'`, `pendingPlanRefId` set, no new mandate
needed: the amount is falling, so what the customer already authorised covers
it. The month already paid for keeps the tier it was bought at, and the console
says which tier starts when. **No credit either way** — the same bargain the
add-ons make.

Where the current price cannot be read — a subscription on a plan no tier
claims, or Razorpay unreachable — the change waits for the renewal. Asking
somebody to re-authorise on a guess is the worse mistake.

---

## Add-ons

Razorpay has no second recurring price on a plan, so anything past what the tier
includes is an add-on raised **once per cycle, for the cycle after it**. That is
also why something switched on today is billed from the next invoice rather than
prorated into the current one.

| Add-on | Priced from | Counted as |
|--------|-------------|-----------|
| Additional WhatsApp Business Account | `Plan.additionalWabaPrice` (₹299) | accounts across the billing scope, less `Plan.includedWabas` |
| Additional phone number | `Plan.additionalNumberPrice` (₹199) | per account: numbers on it, less `Plan.includedPhoneNumbersPerWaba` — one account's spare does not cover another's |
| Upgrade difference | computed, one-off | see above |

The **billing scope** is the payer and everyone inheriting from it, so an
agency's overage is counted across all of its clients at once.

Raising an add-on never throws: it is money to collect, not state the
subscription depends on, and throwing would fail a webhook whose real job was to
record a payment that has already happened.

---

## Razorpay specifics

- **Plans** live in the `Plan` table, one Razorpay plan id per tier
  (`Plan.razorpayPlanId`). There is no deployment-wide plan: a price list with
  four tiers cannot be expressed by one environment variable, and a plan
  negotiated for one customer cannot be expressed by one at all.
  `RAZORPAY_PLAN_IDS` is a boot-time convenience that writes `code:plan_id`
  pairs onto those rows. Razorpay plans are immutable, so a price change means a
  new plan id.
- **`total_count: 120`** — their API has no "until cancelled", so ten years of
  months stands in for it.
- **Mandate** is registered by the customer in **Razorpay Checkout**, opened in
  the console against `subscription_id`. Nothing is charged until they complete
  it, and RBI's additional-factor and pre-debit notification rules are handled
  on their side. The hosted page (`short_url`) is still returned and still
  works, as a fallback for a browser that cannot run Checkout.
- **Checkout's success payload is not trusted.** The browser reports its own
  success, so `/confirm` verifies the signature — HMAC over
  `payment_id|subscription_id` under the key secret — before anything is
  written, and then takes the actual period from Razorpay rather than from the
  browser: the payload says a mandate exists, not what it bought. A signature
  valid for a different subscription is rejected by comparing the id first —
  against both the current subscription and the pending upgrade, which are the
  only two the organisation can be authorising.
- **`/confirm` duplicates what `subscription.authenticated` and `charged` will
  say, deliberately.** Waiting for a webhook would leave the customer looking at
  "awaiting authorisation" seconds after paying. Both paths write through the
  same method, so they cannot drift.
- **Cancellation** uses `cancel_at_cycle_end: 1` when a paid month remains, and
  an immediate cancel when the mandate was never authorised — there is nothing
  to protect in that case.
- **Webhook idempotency** keys on the `X-Razorpay-Event-Id` header, written to
  `SubscriptionEvent` before anything is applied. Their webhooks retry, and a
  replayed `subscription.charged` must not extend a month twice.
- **`currentEnd` never moves backwards.** Events can arrive out of order, and a
  late `authenticated` must not shorten a month a `charged` already paid for.

### Events handled

| Event | Effect |
|-------|--------|
| `subscription.authenticated` | Mandate registered; authorisation URL dropped |
| `subscription.activated`, `subscription.charged` | `active`, period extended, receipt emailed, add-ons queued for the next cycle |
| `subscription.pending` | A debit failed, retries under way. Access continues on the paid month; customer emailed |
| `subscription.halted` | Retries exhausted. Access still runs to `currentEnd`; customer emailed |
| `subscription.cancelled`, `completed`, `expired` | Recorded; access runs to `currentEnd` |

## Provisioning on the payment edge

Connecting an account deliberately syncs nothing, so the first payment is what
turns a connected account into a working one. It fires on the edge —
not-granting to granting — so a renewal or a replayed webhook does not set it
off again, and `isProvisioned` is the second guard.

Every account in the organisation is pulled in, because one payment covers them
all. One account failing does not stop the others: they were paid for by the
same debit.

## What the console is told about the money

- **The plan.** `GET /plans/:id` at Razorpay, cached for the process's lifetime
  (plans are immutable there — a price change is a new plan id, so there is
  nothing to invalidate). Null rather than an error when it cannot be read: the
  page's job is to say whether the organisation is paid for, and it can still do
  that without a price.
- **The debits.** `subscription.charged` carries a payment entity alongside the
  subscription; `SubscriptionPayment` keeps a copy — amount in the smallest
  currency unit, currency, status, method, and enough of the instrument to
  recognise it ("Visa ···· 4242", a UPI handle, a bank). Keyed on Razorpay's
  payment id, so a retried webhook updates its row rather than growing a
  duplicate. The instrument itself never leaves Razorpay.
- **The next charge.** The renewal date, until there is not going to be one —
  a cancelled subscription runs to the end of the month already paid for and
  then stops, so a date there would be a promise to debit that is never kept.
- **What it covers.** Every account in the organisation with its number count,
  and `usage` against the tier's inclusions and add-on prices. Nothing here is a
  cap, so the console's job is to price the next account rather than refuse it.

Razorpay stays the ledger. This is what lets the console answer "what was I
charged, when, on which card" without a round trip.

## One writer

`applyRemote()` is the only place a subscription's status and period are
written — webhooks, checkout confirmations and the reconciliation sweep all go
through it, so the three cannot disagree. It is also where `currentEnd` is
stopped from moving backwards.

## Reconciliation

`@Cron(EVERY_HOUR)` re-reads every subscription whose paid month has run out —
or that never had one — straight from Razorpay. Webhooks get missed, and a
missed `charged` reads exactly like a lapsed customer while a missed `halted`
reads like a paying one. One unreachable subscription does not stop the sweep.

`superseded` rows are excluded with the finished ones. They may well still be
live at Razorpay — that is exactly why they are not `cancelled` — but this
product no longer answers for them, and re-applying their remote state would
resurrect an entitlement the organisation's own subscription replaced.

---

## Configuration

| Variable | Required | Purpose |
|----------|----------|---------|
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Optional | API credentials. Absent → billing disabled |
| `RAZORPAY_PLAN_IDS` | Optional | `code:plan_id` pairs, written onto the tiers at boot. Without it no tier can be bought and the price list offers "contact sales" |
| `RAZORPAY_WEBHOOK_SECRET` | Optional | HMAC secret for `/billing/webhook` |

All are optional together: unset means no subscriptions are sold and no API
traffic is charged for.

`RAZORPAY_PLAN_ID` — the old deployment-wide default plan — is gone.
`isConfigured()` is now the credentials and nothing else.

## Business rules

- **One subscription per organisation.** A second registration while one is
  running is refused — two mandates would mean two debits a month. Changing
  tier is what a customer wants there.
- **A client of an agency cannot subscribe.** It already has the entitlement;
  selling it one of its own would charge twice for the same thing and stop its
  usage counting against the deal the agency signed.
- **A private tier is only sellable to the organisation it was written for.**
  `Plan.ssoOrgId` scopes `findAll`, `findByCode` and `sellablePlan` alike;
  without the filter on the last of those, knowing a code would be enough to buy
  somebody else's agreed rate.
- **A quoted tier cannot be checked out.** The public Custom and Agency cards
  carry no numbers and no Razorpay plan; a signed deal is a private row marked
  `subscribe`, which checks out like any other tier.
- One Razorpay **customer** per organisation, reused across re-registrations and
  upgrades, so a customer has one payment history rather than several. Its name
  and email come from the **user row**, not from the request — the auth
  middleware attaches only an id and an SSO id, so reading them there produced
  blank customers. A reused customer is patched on each subscribe, which fills
  in the ones created before this was true.
- Deleting a WABA leaves its subscription row behind as history, granting
  nothing — cascading would erase what was charged.
- Cancelling twice is refused rather than silently repeated.
- The person who registered receives the billing emails.
- Money is never taken by this codebase. Cards and mandates live at Razorpay;
  nothing here stores an instrument.
