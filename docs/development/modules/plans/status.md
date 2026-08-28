# Module: Plans – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ✅ Built |
| Last Updated | 2026-08-28 |

## Implemented

- **Tiers are wired to Razorpay from configuration.** `RAZORPAY_PLAN_IDS`
  (`code:plan_id` pairs) is applied to the `Plan` table at boot by
  `PlanSyncService`. A tier with no id is published as `available: false`, and
  the console offers to talk rather than opening a checkout that would refuse.
- **A tier says what the price includes, not what is allowed.**
  `maxWabas`/`maxPhoneNumbersPerWaba` became
  `includedWabas`/`includedPhoneNumbersPerWaba`, and neither refuses any more —
  an account past the count bills at ₹299 and a number past it at ₹199. The
  rename was the point: "how many you may have" and "how many the price covers"
  are different products, and the name is the only thing that keeps them apart
  at a call site.
- **The caps that remain are enforced.** `PlanLimitsService` answers "how many"
  from the **payer's** best plan by `rank`, with the cheapest published plan as
  the floor for anyone not paying yet: webhook endpoints (1/5/10), API keys per
  account (1/5/10), contacts (1,000/10,000/50,000), messages a minute per API
  key (100/500/1,000), team members at invite, and retention.
- **`forWaba` falls back to the organisation's plan**, not to the entry limits.
  Under an organisation-level subscription no account has a plan of its own, and
  the old fallback quietly held a paying customer to Starter on every account.
- **Extras are charged.** As each cycle is charged, the accounts beyond
  `includedWabas` and the numbers beyond `includedPhoneNumbersPerWaba` are
  raised as Razorpay add-ons on the next invoice. Numbers are counted **per
  account**, so one account's spare does not cover another's; only numbers live
  on the Cloud API count; and the path is deduplicated by the webhook event id,
  so a retry cannot bill a cycle twice.
- **A send-rate guard** (`SendRateGuard`) keyed on the **API key**, not the
  caller's address — Nest's own throttler tracks by IP, which is wrong in both
  directions for server-to-server traffic and cannot vary by what a customer
  pays. Refuses with 429 and a `Retry-After`, and allows the send when Redis is
  unreachable: the limit protects the send path, it is not the send path.
- **Private plans.** `Plan.ssoOrgId` scopes `findAll`, `findByCode` and
  `sellablePlan`, so a negotiated rate is listed and sold only to its own
  organisation. `/plans` stays public; `GET /plans/mine` is the authenticated
  view that adds theirs. Custom and Agency are public quoted cards carrying no
  numbers — a signed deal is a private row marked `subscribe`, which checks out
  inside the platform like any other tier.
- **Retention runs.** A nightly sweep deletes raw webhook events and settled
  deliveries past the window the Privacy Policy promises, and holds message
  history to each plan's window — the destructive half only counts and logs
  until `PLAN_RETENTION_ENFORCED=true`.

- **Checkout sells the chosen tier.** `POST /billing/subscription` takes a
  required `planCode`; the subscription is created against that plan's
  `razorpayPlanId`, `Subscription.planRefId` records which tier it was sold as,
  and the tier travels to Razorpay in the subscription's notes. A tier that is
  quoted or has no Razorpay plan behind it is refused before anything is created
  there. There is no deployment-wide default plan to fall back on:
  `RAZORPAY_PLAN_ID` is gone, and `isConfigured()` is the credentials alone.
- Subscription state is priced from the tier the subscription actually holds, so
  a Growth customer is not shown the Starter price.

- `Plan` and `PlanFeature` tables, with limits as columns and features as rows
  (`20260816300000_plans`).
- `Subscription.planRefId` foreign key mapping a subscription to the plan it
  was sold from, leaving the Razorpay plan id untouched as the record of what
  is charged.
- The published tiers and their feature lists seeded by the migration, with the
  bullets republished alongside the columns whenever the columns change — a card
  that disagrees with what is enforced is worse than a card with fewer bullets.
- `GET /plans`, `GET /plans/mine` and `GET /plans/:code`, excluding
  `razorpayPlanId`.
- Specs for the service (ordering, limit mapping, unpriced plans, the id that
  must not leak) and the controller.

- **Phone numbers are priced, not rationed.** Every published tier once had both
  a per-number price and a cap on numbers per account, and the two could not
  both be true: on Starter the cap was one, so the ₹199 could never be charged.
  `20260817120000_numbers_priced_per_number` removed the cap;
  `20260828100000_org_billing_and_agency` settled the shape it should have had
  all along — **one number included per account on every tier**, with the second
  onward billed. An inclusion count is what makes the add-on sellable; a cap is
  what made it unsellable.
- **Changing tier on a live subscription.** `PATCH /billing/subscription/plan`.
  A dearer tier is a *second* Razorpay subscription starting where the paid
  month ends, with the pro-rated difference as a one-off add-on, and the
  customer sent back to Checkout — a mandate is authorised for a fixed amount,
  so nothing can raise what they are charged without them approving it. Nothing
  they hold moves until `/confirm`, which is also where the old subscription is
  cancelled at its cycle end. A cheaper tier stays
  `schedule_change_at: 'cycle_end'` with no new mandate and no credit, recorded
  as `pendingPlanRefId` / `pendingPlanAt`. Where the current price cannot be
  read, the change waits for the renewal rather than asking somebody to
  re-authorise on a guess. The old immediate `schedule_change_at: 'now'` is what
  the bank's ceiling used to refuse; that refusal is the reason for this design.
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
| Usage against the limit in the console | `GET /billing/subscription` now carries `usage` — accounts and numbers against the tier's inclusions, with the price of the next one. The capped limits still have no "3 of 5 used" view |
| Slab pricing for a quoted agency plan | A quoted deal is a minimum with a `mandateCeiling` today; bands by client count were discussed and deferred |
| Per-WABA member permissions | Out of scope, kept in the definition: a team member sees every account in the organisation |
| Limits under concurrency | The checks are count-then-insert without a transaction, so two simultaneous requests can both pass at the boundary. A unique or exclusion constraint is the fix if it ever matters |

## Testing

Unit specs cover the decisions; `test/integration/plan-limits.int-spec.ts`
counts real rows against the tier a subscription actually holds, and
`test/integration/billing-payment.int-spec.ts` proves the tier reaches Razorpay
and the add-on is raised at the published price.
`test/integration/plan-change.int-spec.ts` covers moving between tiers in both
directions — the second subscription an upgrade creates, its `start_at`, its
pro-rated add-on, the tier *not* moving until the money is authorised, the swap
at `/confirm`, the abandoned upgrade leaving no trace, and the proof that no
PATCH raising an amount is ever sent — along with the boot-time adoption of
subscriptions that predate the price list. All need a database — see
[`test/integration/README.md`](../../../../test/integration/README.md).
