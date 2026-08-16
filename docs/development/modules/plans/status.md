# Module: Plans – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ✅ Built |
| Last Updated | 2026-08-16 |

## Implemented

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
| Selling a specific tier | `BillingService.register` still creates against the single configured `RAZORPAY_PLAN_ID`; wiring it to `Plan.razorpayPlanId` is the next step, and needs a Razorpay plan per tier |
| Billing additional numbers | The per-number price is published, not charged — that needs subscription quantity |
| Admin editing | The catalogue changes by migration; there is no write endpoint |
