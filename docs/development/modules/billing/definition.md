# Module: Billing – Definition

## Purpose

A flat monthly subscription **per WhatsApp Business Account**, collected by
Razorpay auto-debit, which is what entitles an API key scoped to that account
to call the Messaging API. The console itself is not sold and not gated.

Per account rather than per organisation because API keys are already scoped to
one WABA: the account a key names is the account that has to be paid for, so
"is this request paid for" is a lookup rather than an allocation of seats to
accounts. Paying for one account buys nothing for its neighbour.

The rule the whole module exists to enforce: **a customer may subscribe or
cancel any account at any moment, and access lasts to the end of the month they
have paid for.**

---

## Scope

| Area | Included | Excluded |
|------|----------|----------|
| Monthly plan, one per WABA | ✅ Yes | — |
| Register (mandate authorisation via Razorpay) | ✅ Yes | — |
| Cancel at any time, access to end of paid month | ✅ Yes | — |
| Auto-debit each cycle, with retries | ✅ Yes | Razorpay's own dunning schedule |
| Webhook-driven state, hourly reconciliation | ✅ Yes | — |
| Paywall on API-key traffic | ✅ Yes | Console (JWT) stays free |
| Metered or usage pricing | ❌ No | Flat per account |
| Volume discount across accounts | ❌ No | Each account is its own subscription |
| Proration, upgrades, plan changes | ❌ No | One plan |
| Refunds | ❌ No | Handled manually in Razorpay |
| In-app card update | ❌ No | Re-register; Razorpay has no hosted portal |

---

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/billing/subscriptions` | JWT | One row per connected account: active, status, period, cancel flag, authorisation URL |
| POST | `/billing/subscriptions/:wabaId` | JWT | Subscribe that account. Returns the subscription id to open Checkout with, the publishable key, and the hosted page as a fallback. Throttled 5/min |
| POST | `/billing/subscriptions/:wabaId/confirm` | JWT | Record a mandate authorised in Checkout, signature-checked |
| DELETE | `/billing/subscriptions/:wabaId` | JWT | Cancel that account. Keeps the paid month |
| POST | `/billing/webhook` | HMAC signature | Razorpay events |

---

## Access rule

`BillingService.grants()` is the single definition, used by the state endpoint
and the paywall alike:

1. `currentEnd` in the future → **allowed**, whatever the status. This is what
   makes cancellation keep the paid month, and it also carries a customer
   through a failed renewal while Razorpay retries.
   The check is per account: one WABA lapsing does not touch another.
2. Otherwise `active` or `authenticated` → allowed.
3. Otherwise refused.

A subscription in `created` — registered but the mandate never authorised — has
paid nothing and is refused.

## Enforcement

The subscription buys the **account**, not one way of reaching it. Two layers:

**`BillingService.requireAccess(wabaId)`** — called by the operations
themselves, so the console pays too: sending a message, and syncing or creating
templates. Gating only the API key would have left the console as a free way to
do the very things being sold. Reads are deliberately not gated; someone who
has stopped paying keeps their history, their exports and the ability to
subscribe again.

**`SubscriptionMiddleware`** runs after `MessagingAuthMiddleware` on the
`/messages` routes, so both `authType` and `apiKeyWabaId` are already set. It
covers the API-key path's reads as well, which the service-level check does not
see. The account
checked is the one the key names — there is no mapping to get wrong and no way
for a key to ride on an account somebody else paid for. Only API-key traffic is
charged for; console requests carry a JWT and pass untouched. Someone who stops paying keeps
their history, their exports and their ability to re-subscribe — ending a
subscription is not locking someone out of their own account.

Refusal is **402 Payment Required**, naming the console as the place to fix it.

A deployment with no Razorpay credentials lets everything through, so
development and self-hosting need no payment provider.

## Caching

`sub:{wabaId}` in Redis holds the allow/deny answer for 60 seconds. Every
webhook invalidates it, so a cancellation or a failed debit lands at once; the
TTL is the backstop for a webhook that never arrives. Unlike the API-key cache,
this one must never be written without an expiry.

---

## Razorpay specifics

- **Plan** is created in the dashboard; `RAZORPAY_PLAN_ID` names it. Plans are
  immutable, so a price change means a new plan id and a migration of existing
  subscribers.
- **`total_count: 120`** — their API has no "until cancelled", so ten years of
  months stands in for it.
- **Mandate** is registered by the customer in **Razorpay Checkout**, opened in
  the console against `subscription_id`. Nothing is charged until they complete
  it, and RBI's additional-factor and pre-debit notification rules are handled
  on their side. The hosted page (`short_url`) is still returned and still
  works, as a fallback for a browser that cannot run Checkout — and because
  hosted pages depend on an account-level setting that Checkout does not.
- **Checkout's success payload is not trusted.** The browser reports its own
  success, so `/confirm` verifies the signature — HMAC over
  `payment_id|subscription_id` under the key secret — before anything is
  written, and then takes the actual period from Razorpay rather than from the
  browser: the payload says a mandate exists, not what it bought. A signature
  valid for a different subscription is rejected by comparing the id first.
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
| `subscription.activated`, `subscription.charged` | `active`, period extended, receipt emailed |
| `subscription.pending` | A debit failed, retries under way. Access continues on the paid month; customer emailed |
| `subscription.halted` | Retries exhausted. Access still runs to `currentEnd`; customer emailed |
| `subscription.cancelled`, `completed`, `expired` | Recorded; access runs to `currentEnd` |

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

---

## Configuration

| Variable | Required | Purpose |
|----------|----------|---------|
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Optional | API credentials. Absent → billing disabled |
| `RAZORPAY_PLAN_ID` | Optional | The monthly plan to subscribe against |
| `RAZORPAY_WEBHOOK_SECRET` | Optional | HMAC secret for `/billing/webhook` |

All four are optional together: unset means no subscriptions are sold and no
API traffic is charged for.

## Business rules

- One subscription per account. A second registration while one is running is
  refused — two mandates on one account would mean two debits a month.
- The WABA is validated against the caller's organisation, so an id alone
  cannot start a subscription against someone else's account.
- One Razorpay **customer** per organisation, reused across accounts and across
  re-registrations, so a customer paying for three accounts has one payment
  history rather than three. Its name and email come from the **user row**, not
  from the request — the auth middleware attaches only an id and an SSO id, so
  reading them there produced blank customers. A reused customer is patched on
  each subscribe, which fills in the ones created before this was true.
- Each account authorises its own mandate. A customer with three accounts
  completes three authorisations and receives three debits a month.
- Deleting a WABA leaves its subscription row behind as history, granting
  nothing — cascading would erase what was charged.
- Cancelling twice is refused rather than silently repeated.
- The person who registered receives the billing emails.
- Money is never taken by this codebase. Cards and mandates live at Razorpay;
  nothing here stores an instrument.
