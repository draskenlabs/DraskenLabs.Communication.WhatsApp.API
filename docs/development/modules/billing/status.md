# Module: Billing – Status

| Field | Value |
|-------|-------|
| Status | ✅ Implemented (not yet exercised against live Razorpay) |
| Last Updated | 2026-08-01 |

## Implemented

- `Subscription` (one per org) and `SubscriptionEvent` (webhook audit and
  idempotency) — migration `20260801700000_subscriptions`.
- `RazorpayService`: customer, subscription create, cancel and fetch over their
  REST API. Absent credentials disable billing rather than break the boot.
- `BillingService`: register, cancel, state, cached access check, webhook
  handling and the hourly reconciliation sweep.
- `GET`/`POST`/`DELETE /billing/subscription` behind the JWT, and
  `POST /billing/webhook` behind an HMAC signature check.
- `SubscriptionMiddleware` on `/messages`: API-key traffic needs a subscription,
  console traffic does not, and `402` is the refusal.
- Billing emails: charged, payment failed (retrying vs stopped), cancelled.
- Tests: 34 — the access rule in six shapes (including cancelled-but-paid and
  retrying), register/cancel guards, webhook idempotency and out-of-order
  ordering, reconciliation resilience, the paywall, and signature verification.

## Before this can take money

1. Activate Subscriptions on the Razorpay account and create the monthly plan;
   put its id in `RAZORPAY_PLAN_ID`.
2. Register `POST /billing/webhook` in the Razorpay dashboard for the
   `subscription.*` events and set `RAZORPAY_WEBHOOK_SECRET` to match.
3. Run the flow end to end in test mode: register → authorise → first charge →
   cancel → confirm access lasts to `currentEnd`.
4. Decide what happens to existing organisations. Enforcement begins the moment
   credentials are set, so either subscribe them first or leave Razorpay
   unconfigured until they have.

## Pending / not in scope

- **No card update in the console.** Razorpay has no hosted customer portal, so
  a replaced card means cancelling and registering again. Worth building a
  proper flow before this has many customers.
- No proration, plan changes or refunds — one plan, one price, refunds by hand.
- The mandate limits are Razorpay's: card and UPI auto-debits above the RBI
  e-mandate threshold prompt the customer each cycle. If the price ever crosses
  it, offer eNACH.
- Nothing dunning-related is ours: retry cadence and pre-debit notices are
  Razorpay's.
- The paywall covers `/messages` only, which is the whole of the API-key
  surface today. Any future API-key route must be added to it.
- Reconciliation takes 100 subscriptions an hour; that is ample now and will
  need a cursor long before it is not.

## Blockers

None.
