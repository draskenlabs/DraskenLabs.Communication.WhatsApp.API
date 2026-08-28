# Module: Billing – Status

| Field | Value |
|-------|-------|
| Status | ✅ Implemented (not yet exercised against live Razorpay) |
| Last Updated | 2026-08-28 |

## Implemented

- `Subscription` and `SubscriptionEvent` (webhook audit and idempotency) —
  migrations `20260801700000_subscriptions` onward.
- **A subscription belongs to the organisation.** `wabaId IS NULL` is what makes
  a row the organisation's, and the partial unique index `Subscription_org_key`
  is what stops there being two of them — `@@unique([wabaId, ssoOrgId])` cannot,
  because Postgres treats NULLs as distinct. Migration
  `20260828100000_org_billing_and_agency` collapses the per-account rows onto
  their organisation: the best-ranked plan survives, the rest are marked
  `superseded` rather than deleted, because a subscription is a record of money
  and dropping our row would not stop it debiting at Razorpay.
- **Limits stopped being ceilings where we mean to sell.** `maxWabas` and
  `maxPhoneNumbersPerWaba` are `includedWabas` and `includedPhoneNumbersPerWaba`;
  accounts and numbers past them are billed at `additionalWabaPrice` (₹299) and
  `additionalNumberPrice` (₹199) rather than refused. Team members, webhook
  endpoints, API keys, contacts, send rate and retention stay capped.
- **The unit on the price card is `/month`, not `/WABA/month`.** That
  contradiction — a per-account price beside an organisation-wide inclusion
  count — is what the whole change was for.
- `RazorpayService`: customer, subscription create (with `start_at`), plan
  change, cancel, fetch and add-ons over their REST API. Absent credentials
  disable billing rather than break the boot. `isConfigured()` is the key pair
  alone: which Razorpay plan a tier charges against is a column on that tier.
- `BillingService`: register, confirm, change tier, cancel, state, cached access
  check, webhook handling, overage add-ons and the hourly reconciliation sweep.
- `GET/POST/DELETE /billing/subscription`, `POST /billing/subscription/confirm`
  and `PATCH /billing/subscription/plan` behind the JWT;
  `POST /billing/webhook` behind an HMAC signature check.
- **Upgrading authorises before it cancels.** A dearer tier is a second Razorpay
  subscription starting where the paid month ends, with the pro-rated difference
  as a one-off add-on, and the customer sent back to Checkout. Nothing they hold
  moves until `/confirm`; the old subscription is cancelled at its cycle end
  only once the new mandate exists. An abandoned upgrade leaves them exactly
  where they were. Downgrades stay `schedule_change_at: 'cycle_end'` with no new
  mandate and no credit.
- **Private tiers.** `Plan.ssoOrgId` scopes `findAll`, `findByCode` and
  `sellablePlan`, so a negotiated rate is only ever answered — and only ever
  sold — to the organisation it was written for. `/plans` stays public and shows
  the published tiers; `/plans/mine` is the authenticated view that adds theirs.
- **Agency clients inherit.** Every access and limit question resolves the payer
  first, the cache key carries the payer's version so one failed debit darkens
  every client at once, and a client is refused a subscription of its own.
- The paywall covers the operation, not just the key: `requireAccess()` gates
  sending and template sync/creation whoever asks, so the console cannot be used
  to do for free what an API key is charged for.
- `SubscriptionMiddleware` on `/messages` additionally covers the API-key path's
  reads. `402` is the refusal.
- Billing emails: charged, payment failed (retrying vs stopped), cancelled. Each
  names the organisation — they are the organisation's subscription now, so the
  per-account line is gone.
- The console is told the price, the recent debits (amount, method, instrument,
  date), the next charge date, every account the subscription covers, and
  `usage` against what the tier includes with the price of the next account and
  number.
- **Provisioning** fires on the not-granting to granting edge and pulls in
  *every* account in the organisation, because one payment covers them all. One
  account failing does not stop the others.
- **Razorpay Checkout** rather than the hosted page: register returns the
  subscription id and publishable key, and `POST /confirm` verifies Checkout's
  signature before re-reading the subscription. The hosted page stays in the
  response as a fallback.
- Tests: the unit suite covers register (including the agency-client refusal and
  the private-plan scoping), confirm in both shapes (first authorisation and
  upgrade promotion), the upgrade's `start_at`, its pro-rated add-on and its
  refusal to move `planRefId` early, the downgrade needing no new mandate,
  cancel abandoning an unauthorised upgrade, the state endpoint's `covers` and
  `usage`, the add-ons, webhook idempotency and ordering, and reconciliation.
- **Payment and plan changes are covered end to end** —
  `test/integration/billing-payment.int-spec.ts` and `plan-change.int-spec.ts`,
  against a real Postgres and a Razorpay stand-in over real HTTP: the plan id a
  subscription is created against and the basic-auth pair it is created with;
  one subscription opening every account in the organisation; a private tier
  refused to everyone but its own organisation and absent from `/plans`;
  checkout over HTTP; the Checkout signature, forged and genuine; a signed
  `subscription.charged`; the ₹199 add-on's amount and quantity; the same event
  delivered three times billing once; the whole upgrade round trip including
  the old subscription being cancelled only after the new one is authorised; and
  the proof that no PATCH raising an amount is ever sent. They need a database:
  see [`test/integration/README.md`](../../../../test/integration/README.md).

## Before this can take money

1. Activate Subscriptions on the Razorpay account and create one plan per tier
   at the published price; put the `code:plan_id` pairs in `RAZORPAY_PLAN_IDS`.
2. Register `POST /billing/webhook` in the Razorpay dashboard for the
   `subscription.*` events and set `RAZORPAY_WEBHOOK_SECRET` to match.
3. Run the flow end to end in test mode: subscribe → authorise in Checkout →
   first charge → upgrade → authorise → cancel → confirm access lasts to
   `currentEnd`.
4. Decide what happens to existing accounts. Enforcement begins the moment
   credentials are set, and it is per organisation now — one subscription opens
   every account they hold.

## Pending / not in scope

- Checkout is loaded from `checkout.razorpay.com` at runtime. A deployment that
  adds a Content-Security-Policy will need `script-src` and `frame-src` entries
  for Razorpay, or the overlay will not open and the fallback link is all that
  is left.
- **No card update in the console.** Razorpay has no hosted customer portal, so
  a replaced card means cancelling and registering again.
- **No credit on a downgrade**, and no refunds — refunds by hand in Razorpay.
- **Agency slab pricing is out of scope.** A quoted agency deal is a minimum
  with a ceiling: the mandate is authorised at the ceiling and the charge rises
  with what they actually connect. Bands (0–5 at one rate, 6–10 at another) were
  discussed and deliberately deferred.
- **Per-WABA member permissions are out of scope**, kept here for later: a team
  member today sees every account in the organisation.
- The mandate limits are Razorpay's: card and UPI auto-debits above the RBI
  e-mandate threshold prompt the customer each cycle. If a quoted price crosses
  it, offer eNACH.
- Nothing dunning-related is ours: retry cadence and pre-debit notices are
  Razorpay's.
- Gated: sending, template sync/create, template edit/delete (through
  `resolveWabaContext`) and phone-number registration. Not gated, deliberately:
  reads of any kind, and contact records, which are the organisation's own data
  rather than an action on the account.
- Reconciliation takes 100 subscriptions an hour; that is ample now and will
  need a cursor long before it is not.
- `Subscription_org_key` is a partial unique index Prisma cannot express, so
  `migrate dev` reports it as drift. It stays: without it two organisation-level
  rows are possible, and with them two mandates and two debits a month.

## Blockers

None.
