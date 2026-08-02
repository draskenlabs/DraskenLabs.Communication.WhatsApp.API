# Module: Billing – Status

| Field | Value |
|-------|-------|
| Status | ✅ Implemented (not yet exercised against live Razorpay) |
| Last Updated | 2026-08-02 |

## Implemented

- `Subscription` (one per organisation per WABA) and `SubscriptionEvent`
  (webhook audit and idempotency) — migrations `20260801700000_subscriptions`
  and `20260801900000_subscription_per_organisation`.
- **A subscription is one organisation's use of one account.** `wabaId` alone
  was unique, which was right while an account could only be connected once.
  Now that two organisations can hold the same WABA, that constraint told the
  second one "this account already has a subscription" — and the first
  organisation's payment would have granted the second free API access.
  `hasAccess`/`requireAccess` take the organisation as well as the account, and
  the Redis key is `sub:{ssoOrgId}:{wabaId}`.
- `RazorpayService`: customer, subscription create, cancel and fetch over their
  REST API. Absent credentials disable billing rather than break the boot.
- `BillingService`: register, cancel, state, cached access check, webhook
  handling and the hourly reconciliation sweep.
- `GET /billing/subscriptions` (one row per connected account, subscribed or
  not) and `POST`/`DELETE /billing/subscriptions/:wabaId` behind the JWT;
  `POST /billing/webhook` behind an HMAC signature check.
- The paywall covers the operation, not just the key: `requireAccess()` gates
  sending and template sync/creation whoever asks, so the console cannot be
  used to do for free what an API key is charged for.
- `SubscriptionMiddleware` on `/messages` additionally covers the API-key
  path's reads. `402` is the refusal, naming the account so the message says
  which subscription is missing.
- Billing emails: charged, payment failed (retrying vs stopped), cancelled.
- **Razorpay Checkout** rather than the hosted page: register returns the
  subscription id and publishable key, and `POST /confirm` verifies Checkout's
  signature before re-reading the subscription, so the console reflects a
  payment immediately instead of waiting for a webhook. The hosted page stays
  in the response as a fallback.
- The Razorpay customer carries the subscriber's name and email, read from the
  user row; existing blank customers are filled in the next time that
  organisation subscribes.
- Tests: 58 — signature verification in four shapes (valid, wrong
  subscription, wrong length, no secret configured), the confirm path
  (verified, unverified, mismatched subscription, missing subscription), the
  access rule in six shapes (including cancelled-but-paid and
  retrying), per-account isolation, per-organisation isolation (one
  organisation's payment grants the other nothing, at the service and at the
  middleware), the org-ownership check on subscribe,
  customer reuse across accounts, listing accounts with and without
  subscriptions, register/cancel guards, webhook idempotency and out-of-order
  ordering, reconciliation resilience, the paywall, and signature verification.

## Before this can take money

1. Activate Subscriptions on the Razorpay account and create the monthly plan;
   put its id in `RAZORPAY_PLAN_ID`.
2. Register `POST /billing/webhook` in the Razorpay dashboard for the
   `subscription.*` events and set `RAZORPAY_WEBHOOK_SECRET` to match.
3. Run the flow end to end in test mode: subscribe → authorise in Checkout →
   first charge → cancel → confirm access lasts to `currentEnd`.
4. Decide what happens to existing accounts. Enforcement begins the moment
   credentials are set, and it is per organisation per account — every
   organisation's connection to a WABA needs its own subscription or its keys
   stop. Subscribe them first, or leave Razorpay unconfigured until they have.

## Pending / not in scope

- Checkout is loaded from `checkout.razorpay.com` at runtime. A deployment that
  adds a Content-Security-Policy will need `script-src` and `frame-src` entries
  for Razorpay, or the overlay will not open and the fallback link is all that
  is left.

- **No card update in the console.** Razorpay has no hosted customer portal, so
  a replaced card means cancelling and registering again. Worth building a
  proper flow before this has many customers.
- No proration, plan changes or refunds — one plan, one price, refunds by hand.
- No volume pricing: ten accounts is ten subscriptions at the same price, and
  ten mandate authorisations. If that becomes a complaint, a quantity-based
  single subscription is the alternative — at the cost of having to decide
  which account loses access when the quantity drops.
- The mandate limits are Razorpay's: card and UPI auto-debits above the RBI
  e-mandate threshold prompt the customer each cycle. If the price ever crosses
  it, offer eNACH.
- Nothing dunning-related is ours: retry cadence and pre-debit notices are
  Razorpay's.
- Gated: sending, template sync/create, template edit/delete (through
  `resolveWabaContext`) and phone-number registration. Not gated, deliberately:
  reads of any kind, and contact records, which are the organisation's own data
  rather than an action on the account.
- Reconciliation takes 100 subscriptions an hour; that is ample now and will
  need a cursor long before it is not.

## Blockers

None.
