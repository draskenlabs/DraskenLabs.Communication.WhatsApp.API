# Module: Plans – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ✅ Built |
| Last Updated | 2026-08-16 |

## Implemented

- **Checkout sells the chosen tier.** `POST /billing/subscriptions/:wabaId`
  takes an optional `planCode`; the subscription is created against that plan's
  `razorpayPlanId`, `Subscription.planRefId` records which tier it was sold as,
  and the tier travels to Razorpay in the subscription's notes. A tier that is
  quoted (Agency) or has no Razorpay plan behind it is refused before anything
  is created there. Omitting `planCode` keeps the previous behaviour.
- Subscription state is priced per subscription (`planCode`, `planName` and the
  plan's own amount), so a Growth customer is no longer shown the Starter price.
  One Razorpay lookup per distinct tier, cached per process.

- `Plan` and `PlanFeature` tables, with limits as columns and features as rows
  (`20260816300000_plans`).
- `Subscription.planRefId` foreign key mapping a subscription to the plan it
  was sold from, leaving the Razorpay plan id untouched as the record of what
  is charged.
- The four published tiers and their feature lists seeded by the migration.
- Public `GET /plans` and `GET /plans/:code`, excluding `razorpayPlanId`.
- Specs for the service (ordering, limit mapping, unpriced plans, the id that
  must not leak) and the controller.

## Pending / not in scope

| Item | Notes |
|------|-------|
| Enforcing the limits | The columns are published and queryable; nothing counts WABAs, numbers, members or endpoints against them yet |
| A Razorpay plan per tier | The wiring is done; each deployment must still create the plans at Razorpay and set `Plan.razorpayPlanId` on each row, or only the configured fallback can be sold |
| Changing tier on a live subscription | Upgrading is cancel-and-resubscribe today. An in-place `PATCH /subscriptions/:id` with a new plan needs a decision on proration and on re-authorising the mandate for a higher amount |
| Billing additional numbers | The per-number price is published, not charged — that needs subscription quantity |
| Admin editing | The catalogue changes by migration; there is no write endpoint |
