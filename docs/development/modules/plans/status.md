# Module: Plans – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ✅ Built |
| Last Updated | 2026-08-17 |

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

- **Phone numbers are priced, not rationed** (`20260817120000_numbers_priced_per_number`).
  Every published tier had both a per-number price and a cap on numbers per
  account, and the two could not both be true: on Starter the cap was one, so
  the ₹199 could never be charged, and on the tiers where it could the customer
  paid for the same capacity twice — once in a tier price that exists to allow
  more numbers, and again per number. `maxPhoneNumbersPerWaba` is now null on
  starter, growth and business, so a number costs what the price list says a
  number costs on any plan. The tiers differ on what actually differs between
  them: accounts, team members, webhook endpoints and history. The feature
  bullets that quoted the cap went with it.
- **Changing tier on a live subscription.**
  `PATCH /billing/subscriptions/:wabaId/plan` moves a running subscription to
  another published tier. A tier that costs more takes effect immediately
  (`schedule_change_at: now`), so the limits change with it; one that costs the
  same or less takes effect at the renewal, recorded as `pendingPlanRefId` /
  `pendingPlanAt` and surfaced as `pendingPlanCode` on the subscription state.
  Nothing is prorated in either direction. Where the current price cannot be
  read, the change waits for the renewal rather than shortening a paid month on
  a guess. Razorpay refusing because the mandate will not cover the higher
  amount is turned into a message that says to cancel and resubscribe, which is
  the only thing the customer can act on.
- **Existing subscriptions are adopted at boot.** `PlanSyncService` fills a
  blank `planRefId` by matching `Subscription.planId` to `Plan.razorpayPlanId`
  once the configured ids are applied — a migration cannot do it, because the
  mapping it needs is configuration. Without it, every customer who subscribed
  before the price list existed was held to the entry limits and skipped by the
  per-number charge. Live subscriptions still unmatched are counted in a
  warning at boot.
- `applyRemote` follows the plan Razorpay reports: a scheduled change that has
  taken effect, or one made in their dashboard, updates the tier here rather
  than leaving the two to drift.

## Pending / not in scope

| Item | Notes |
|------|-------|
| Creating the plans at Razorpay | The mapping is configuration; somebody still has to create one plan per tier in the Razorpay account, at the published price, and list them in `RAZORPAY_PLAN_IDS` |
| Team-member limit on acceptance | The invite path is ours and is capped; somebody added directly in the SSO is not seen by this API |
| Admin editing | The catalogue changes by migration; there is no write endpoint |
| Usage against the limit in the console | The API refuses past the limit with the plan's own number in the message; nothing shows "3 of 5 used" before somebody hits it |
| Limits under concurrency | The checks are count-then-insert without a transaction, so two simultaneous requests can both pass at the boundary. A unique or exclusion constraint is the fix if it ever matters |

## Testing

Unit specs cover the decisions; `test/integration/plan-limits.int-spec.ts`
counts real rows against the tier a subscription actually holds, and
`test/integration/billing-payment.int-spec.ts` proves the tier reaches Razorpay
and the add-on is raised at the published price.
`test/integration/plan-change.int-spec.ts` covers moving between tiers in both
directions — what is sent to Razorpay, when the limits actually change, and the
renewal that settles a scheduled change — along with the boot-time adoption of
subscriptions that predate the price list. All need a database — see
[`test/integration/README.md`](../../../../test/integration/README.md).
