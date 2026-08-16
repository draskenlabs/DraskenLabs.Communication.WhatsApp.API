# Module: Plans – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ✅ Built |
| Last Updated | 2026-08-16 |

## Implemented

- **Tiers are wired to Razorpay from configuration.** `RAZORPAY_PLAN_IDS`
  (`code:plan_id` pairs) is applied to the `Plan` table at boot by
  `PlanSyncService`. A tier with no id is published as `available: false`, and
  the console offers to talk rather than opening a checkout that would refuse.
- **The limits are enforced.** `PlanLimitsService` answers "how many" — the best
  tier the organisation holds for anything organisation-wide, that account's own
  plan for anything per account, and the cheapest published plan as the floor
  for anyone not paying yet. Applied to WABAs at connect, phone numbers at
  registration, webhook endpoints at creation and team members at invite (the
  one point the platform sees an organisation grow, since membership is the
  SSO's).
- **Additional numbers are charged.** As each cycle is charged, the numbers
  beyond the one the plan includes are raised as a Razorpay add-on on the next
  invoice, at the plan's `additionalNumberPrice`. Only numbers live on the
  Cloud API count; the path is deduplicated by the webhook event id, so a retry
  cannot bill a cycle twice.
- **Retention runs.** A nightly sweep deletes raw webhook events and settled
  deliveries past the window the Privacy Policy promises, and holds message
  history to each plan's window — the destructive half only counts and logs
  until `PLAN_RETENTION_ENFORCED=true`.

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
| Creating the plans at Razorpay | The mapping is configuration; somebody still has to create one plan per tier in the Razorpay account, at the published price, and list them in `RAZORPAY_PLAN_IDS` |
| Team-member limit on acceptance | The invite path is ours and is capped; somebody added directly in the SSO is not seen by this API |
| Changing tier on a live subscription | Upgrading is cancel-and-resubscribe today. An in-place `PATCH /subscriptions/:id` with a new plan needs a decision on proration and on re-authorising the mandate for a higher amount |
| Billing additional numbers | The per-number price is published, not charged — that needs subscription quantity |
| Admin editing | The catalogue changes by migration; there is no write endpoint |
