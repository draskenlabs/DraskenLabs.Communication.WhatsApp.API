# Module: Plans – Definition

## Purpose

The published price list, as data. Five cards — Starter, Growth, Business,
Custom and Agency — with what each costs and what it includes, served to the
console's pricing page. The last two carry no numbers: they are what a visitor
sees, and every real figure of a signed deal lives on a **private plan row**
scoped by `Plan.ssoOrgId`.

A tier says **what the price includes**, not what the customer is allowed. An
account or a number past the included count is sold as an add-on rather than
refused; the things that cost capacity rather than money — team members, webhook
endpoints, API keys, contacts, send rate, retention — are still caps.

Deliberately separate from **Billing**: this answers "what is on offer", Billing
answers "what has this organisation paid for". Billing sells a subscription
against a *Razorpay* plan; this is the catalogue a customer reads first.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/plans` | None | Every published plan, in order |
| GET | `/plans/mine` | JWT | The published plans plus any negotiated for this organisation |
| GET | `/plans/:code` | None | One plan by code |

The two public routes are public on purpose: a price list nobody can read
without an account is not a price list. `/plans/mine` is behind auth because a
plan negotiated for one organisation is not part of the published list — one
customer's agreed rate is not something the next visitor gets to read. Every
read filters on `ssoOrgId IS NULL OR ssoOrgId = <caller>`, including
`findByCode`, so a guessable code does not leak a private row.

Nothing here can be written over HTTP — the catalogue is changed by a migration,
not by a call.

---

## Data Model

### `Plan`

| Field | Type | Notes |
|-------|------|-------|
| `id` | Int | PK — what the foreign keys point at |
| `code` | String | Unique, human-facing: `starter`, `growth`, `business`, `agency` |
| `name`, `audience` | String | Card heading and the one-line "who it's for" |
| `price` | Int? | Per organisation per month, in paise. Null where pricing is quoted |
| `priceLabel` | String? | Shown instead of an amount when `price` is null — "Custom" |
| `currency`, `unit` | String | `INR`, `/month` |
| `ssoOrgId` | String? | Null for a published tier. Set on a negotiated one, which is then only ever listed or sold to that organisation |
| `rank` | Int | What `forOrg` sorts on when an organisation holds more than one. Price cannot express it — a quoted plan has none |
| `mandateCeiling` | Int? | On a quoted plan: the amount the mandate is authorised at, above the minimum actually charged |
| `additionalNumberPrice` | Int? | Monthly charge per phone number past what the tier includes (₹199) |
| `additionalWabaPrice` | Int? | Monthly charge per account past what the tier includes (₹299) |
| `includedWabas` | Int? | **Limits are columns, not a JSON blob** — they are what enforcement queries. Formerly `maxWabas`; an account past this is billed, not refused |
| `includedPhoneNumbersPerWaba` | Int? | Formerly `maxPhoneNumbersPerWaba`. One on every published tier; the second onward bills |
| `includedClients` | Int? | Client organisations a quoted agency plan covers |
| `maxTeamMembers` | Int? | A cap |
| `maxWebhookEndpoints` | Int? | A cap: 1 / 5 / 10 |
| `maxApiKeysPerWaba` | Int? | A cap: 1 / 5 / 10 |
| `maxContacts` | Int? | A cap: 1,000 / 10,000 / 50,000 |
| `maxMessagesPerMinute` | Int? | A cap, per API key: 100 / 500 / 1,000 |
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

| | Starter | Growth | Business | Custom | Agency |
|---|---|---|---|---|---|
| Price | ₹499/month | ₹999/month | ₹1,999/month | Quoted | Quoted |
| `rank` | 10 | 20 | 30 | 35 | 40 |
| WABAs included | 1 | 3 | 10 | Negotiated | Negotiated |
| Numbers per WABA included | 1 | 1 | 1 | Negotiated | Negotiated |
| Extra WABA | ₹299/month | ₹299/month | ₹299/month | — | — |
| Extra number | ₹199/month | ₹199/month | ₹199/month | — | — |
| Team members | 2 | 5 | 15 | Negotiated | Negotiated |
| Webhook endpoints | 1 | 5 | 10 | Negotiated | Negotiated |
| API keys per WABA | 1 | 5 | 10 | Negotiated | Negotiated |
| Contacts | 1,000 | 10,000 | 50,000 | Negotiated | Negotiated |
| Messages a minute | 100 | 500 | 1,000 | Negotiated | Negotiated |
| History | 30 days | 90 days | 1 year | Negotiated | Negotiated |

Quoted plans rank **above** every published tier, because that is what the
customer is paying for and price cannot say so.

`razorpayPlanId` is left null and filled in per deployment from
`RAZORPAY_PLAN_IDS` — plan ids differ between test and live accounts.

The bullets are seeded with the columns. A card that disagrees with what is
enforced is worse than a card with fewer bullets on it.

---

## Enforcement

`PlanLimitsService` is the one place that answers "how many", so no call site
keeps a constant that could contradict the price list.

**Sold, not refused:**

| Inclusion | Charged at | Counted across |
|-----------|-----------|----------------|
| `includedWabas` | `subscription.charged`, as an add-on for the next cycle | Every organisation the subscription answers for |
| `includedPhoneNumbersPerWaba` | Same | Per account, so one account's spare does not cover another's |

**Capped:**

| Limit | Enforced at | Measured against |
|-------|-------------|------------------|
| `maxWebhookEndpoints` | `WebhookEndpointsService.create` | The organisation's plan |
| `maxApiKeysPerWaba` | `ApiKeyService.createApiKey`, counting live keys only | The organisation's plan |
| `maxContacts` | `ContactsService`, batch-aware for an import | The organisation's plan |
| `maxMessagesPerMinute` | `SendRateGuard`, keyed on the API key | The organisation's plan |
| `maxTeamMembers` | `OrgService.inviteMember`, counting members *and* invitations already out | The organisation's plan |
| `historyDays` | The nightly retention sweep | The organisation's plan |

`forOrg` resolves the **payer** first, so an agency's client is answered from
the agency's plan, and picks the best by `rank` where an organisation holds more
than one. `forWaba` falls back to `forOrg` rather than to the entry limits:
under an organisation-level subscription no account has a plan of its own, and
answering "the cheapest published tier" for every account would quietly hold a
paying customer to Starter.

An organisation with nothing subscribed is held to the cheapest published plan —
it can try the product without exceeding what the entry price buys — and a
deployment with no price list at all limits nothing.

## Charging for what is past the inclusions

Razorpay has no second recurring price on a plan, so the charge is an add-on
raised once per cycle: as `subscription.charged` lands, the accounts beyond
`includedWabas` and the numbers beyond `includedPhoneNumbersPerWaba` are added
to the *next* invoice at `Plan.additionalWabaPrice` and
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
- An inclusion count is not a cap. `includedWabas` is what the price covers;
  the console prices the next account rather than refusing it.
- A private plan is never listed or sold to anybody but its own organisation —
  `findAll`, `findByCode` and `sellablePlan` all filter on `ssoOrgId`.
- Meta's conversation charges are not in any plan price and never should be —
  Meta bills those to the customer's own WhatsApp account.
