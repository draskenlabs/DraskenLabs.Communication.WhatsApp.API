# Module: Plans – Definition

## Purpose

The published price list, as data. Four tiers — Starter, Growth, Business and
Agency — with what each costs, what it allows and what it includes, served to
the console's pricing page.

Deliberately separate from **Billing**: this answers "what is on offer",
Billing answers "what has this account paid for". Billing sells a subscription
against a *Razorpay* plan; this is the catalogue a customer reads first.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/plans` | None | Every active plan, in published order |
| GET | `/plans/:code` | None | One plan by code (starter, growth, business, agency) |

Both are public on purpose: a price list nobody can read without an account is
not a price list. Nothing here can be written over HTTP — the catalogue is
changed by a migration, not by a call.

---

## Data Model

### `Plan`

| Field | Type | Notes |
|-------|------|-------|
| `id` | Int | PK — what the foreign keys point at |
| `code` | String | Unique, human-facing: `starter`, `growth`, `business`, `agency` |
| `name`, `audience` | String | Card heading and the one-line "who it's for" |
| `price` | Int? | Per WABA per month, in paise. Null where pricing is quoted |
| `priceLabel` | String? | Shown instead of an amount when `price` is null — "Custom" |
| `currency`, `unit` | String | `INR`, `/WABA/month` |
| `additionalNumberPrice` | Int? | Monthly charge per phone number after the first on a WABA |
| `maxWabas` | Int? | **Limits are columns, not a JSON blob** — they are what enforcement queries |
| `maxPhoneNumbersPerWaba` | Int? | Null means the plan puts no number on it: unlimited, or negotiated |
| `maxTeamMembers` | Int? | — |
| `maxWebhookEndpoints` | Int? | — |
| `historyDays` | Int? | Message and webhook-event retention |
| `razorpayPlanId` | String? | Unique. The plan a subscription on this tier is created against. **Never leaves the API** |
| `inheritsPlanId` | Int? | Self-FK — "Everything in Growth, plus:". `RESTRICT` |
| `recommended` | Boolean | The one tier the pricing page highlights |
| `ctaKind`, `ctaLabel` | String | `subscribe` or `contact`, and the button's wording |
| `sortOrder`, `active` | Int / Boolean | Published order; a withdrawn plan stays for the subscriptions on it |

### `PlanFeature`

| Field | Type | Notes |
|-------|------|-------|
| `planId` | Int | FK → `Plan`, `CASCADE` |
| `label` | String | One bullet |
| `sortOrder` | Int | Published order |

A child table rather than a string array, so a line can be reordered or
withdrawn without rewriting the plan.

### `Subscription.planRefId`

Nullable FK → `Plan`, `RESTRICT`. Which published plan a subscription was sold
from. `Subscription.planId` stays the *Razorpay* plan actually charged, so an
existing subscription bills exactly as agreed whatever happens to the price
list — and a plan cannot be deleted while somebody is still on it.

---

## Seeded price list

The migration seeds all four tiers and their features: ₹499, ₹999 and ₹1,999
per WABA per month, ₹199 a month per additional number, and Agency quoted.
`razorpayPlanId` is left null and filled in per deployment — plan ids differ
between test and live accounts.

---

## Enforcement

`PlanLimitsService` is the one place that answers "how many", so no call site
keeps a constant that could contradict the price list.

| Limit | Enforced at | Measured against |
|-------|-------------|------------------|
| `maxWabas` | `WabaService.createOrUpdateWaba`, only for an account the organisation does not already hold | The best tier the organisation holds |
| `maxPhoneNumbersPerWaba` | `WabaPhoneNumberService.registerPhoneNumber`, only for a number not already live | That account's own plan |
| `maxWebhookEndpoints` | `WebhookEndpointsService.create` | That account's own plan |
| `maxTeamMembers` | `OrgService.inviteMember`, counting members *and* invitations already out | The best tier the organisation holds |
| `historyDays` | The nightly retention sweep | Each organisation's own plan |

An organisation with nothing subscribed is held to the cheapest published
plan — it can try the product without exceeding what the entry price buys — and
a deployment with no price list at all limits nothing.

## Charging for additional numbers

Razorpay has no second recurring price on a plan, so the per-number charge is
an add-on raised once per cycle: as `subscription.charged` lands, the numbers
beyond the one the plan includes are added to the *next* invoice at
`Plan.additionalNumberPrice`. That is also why a number added today is billed
from the next invoice rather than prorated into the current one. The path runs
inside the webhook handler, which deduplicates on the event id, so a retried
webhook cannot bill the same cycle twice — and a failure to raise the add-on is
logged rather than thrown, because the webhook's real job is recording a
payment that has already happened.

## Business rules

- Amounts are in paise. Nothing divides until it is displayed.
- `razorpayPlanId` is excluded from every response: the browser is told a
  price, not the provider's identifier for it.
- Null limits mean "no number on it", never zero.
- Meta's conversation charges are not in any plan price and never should be —
  Meta bills those to the customer's own WhatsApp account.
