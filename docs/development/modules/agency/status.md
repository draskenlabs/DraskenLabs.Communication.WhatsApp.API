# Module: Agency – Status

| Field | Value |
|-------|-------|
| Status | ✅ Built — per-client subscriptions, API and console |
| Last Updated | 2026-08-28 |

## Implemented

- `OrganisationSettings` — migration `20260828100000_org_billing_and_agency`.
  `agencyOrgId`, `isAgency`, `clientName`, `convertedBy`/`convertedAt` and
  `payerVersion`, with an index on `agencyOrgId`.
- `OrganisationSettingsService`, its own `@Global` module: `PlanLimitsService`
  needs it and `OrgService` needs `PlanLimitsService`, so putting it in either
  would close a cycle. `get`, `billingOrgFor`, `cacheVersionFor`, `clientsOf`,
  `clientRoster`, `billingScope`, `bumpPayerVersion`.
- **`selectOrg` lets an agency into its clients**, with `role: 'agency'` and an
  `agencyOrgId` claim on the token; `AuthMiddleware` puts the claim on the
  request. `listOrganisations` and the login response list the clients after the
  SSO's own organisations, named by the agency's label.
- `AgencyService` and `AgencyController`: the roster with its counters, renaming
  a client, and the three operator endpoints behind `AGENCY_ADMIN_TOKEN`.
- The guards that keep "who pays" a lookup: no chains, no silent transfers, no
  demoting an agency with a roster, no organisation as its own client.
- **Billing resolves the payer everywhere** — access, limits, the overage
  counters — and the access cache keys on the payer's version so one failed
  debit darkens the whole roster at once.
- A client is refused a subscription of its own.
- Tests: the service and controller — conversion in both directions and its
  refusals, attach/detach and theirs, the roster's counters, the plan named on
  each row, its fixed query count, the empty roster, the name fallbacks, and
  the operator token (wrong, missing, and not configured at all). Plus the
  `selectOrg` and `listOrganisations` branches in the auth suite, and
  `test/integration/agency-billing.int-spec.ts` (14) against a real database
  and the provider stand-in over HTTP: a client entitled by a row of its own,
  a second client riding the same mandate, an unauthorised mandate re-asked at
  the right size, a mandate per plan, each client held to its own plan, a
  charge moving every client on the group, a client sending only once the
  mandate is paid, what the client's billing page says, what the roster says,
  and both halves of letting a client go.

### Per-client subscriptions

- **An agency buys a plan per client.** `AgencyBillingService.subscribeClient`
  writes a `Subscription` for the client with `payerOrgId` set to the agency,
  so limits and money move together: a client on Growth has Growth's limits
  because somebody is paying Growth's price for it. This replaces the
  arrangement where one plan's ceilings applied to every client at once and
  nothing charged for the multiplication.
- **One mandate per plan, not per client.** `AgencyBillingGroup` holds the
  provider subscription and a `quantity`; taking a client on moves it by one
  (`schedule_change_at: 'now'`). A subscription per client would be an
  authorisation per client, and nobody sits through eight of those. The client's
  own row carries `razorpaySubscriptionId: null` and a `billingGroupId`.
- **An unauthorised mandate is replaced, not patched.** The provider refuses a
  quantity change on a subscription still in `created`, so `replaceUnauthorised`
  cancels the unpaid mandate and creates a new one at the higher quantity.
- **`createClient`** does the three steps as one intent: allowance check, SSO
  organisation, attach, subscribe. The id comes from the organisation just
  created, so it cannot be a typo — which is how the old attach endpoint
  produced clients pointing at nothing.
- **`releaseClient`** runs before the detach, and stops at the end of the month
  already paid for. Detaching first would leave a client paid for by nobody and
  still being charged to somebody. The last client on a plan cancels its
  mandate.
- **`mandates()`** answers what the agency is actually charged, one line per
  plan — "2 × Growth · ₹1,998" — because that is what the statement carries.
- **The roster names each client's plan** and the state of the mandate covering
  it, in one query for the whole roster.
- **Payments belong to the group.** `SubscriptionPayment.subscriptionId` is now
  nullable, with `billingGroupId` beside it: one debit covers several clients,
  so it belongs to the group rather than to any one of them.
- **A client's own billing page is correct by construction** — it has a real
  subscription, so `billing.state` reports its plan, its status and
  `payerOrgId`/`payerName`. It used to say "not subscribed" over working keys
  and offer a Subscribe button that always 400d.
- **Overage is not pooled across a roster.** A client's counters are scoped to
  itself rather than to its agency's billing scope, since it is now paying for
  its own plan.

### The old model's limit

- **`includedClients` is enforced on attach.** It was read in four places and
  checked in none, so an agency could hold an unlimited roster. That matters
  more here than an ordinary limit would: a client inherits the agency's plan
  but is *counted separately*, so every client on the roster is another full
  allowance of contacts, seats, endpoints and keys on one subscription. The
  roster length is the multiplier on the whole estate, and this is the only
  thing bounding it.
  Re-attaching a client already on the roster is a rename and takes no new
  place — refusing that would leave a full agency unable to correct a label.
- Classed as an inclusion rather than a ceiling in the schema, because the
  intention is to sell clients by the unit. Until there is an
  `additionalClientPrice` to charge beyond it, "included" with nothing past it
  is a number that means nothing, so it refuses. Moving it back to the billable
  column is the change to make when per-client pricing arrives.

## Pending

- **Letting a client go is still operator work.** `releaseClient` exists and is
  wired into `detachClient`, but nothing on the agency's own console calls it —
  it stops a charge and reduces a mandate's quantity, so it is deliberately not
  a button yet.
- **Moving a client between plans.** Putting one *on* a plan is built; moving it
  means leaving one mandate and joining another, and is not.
- **`x-agency-admin-token` on `/agency/internal/*`** still works. The operator
  console does the same three things with a named operator and an audit row
  behind them; the shared token should be retired once nothing calls it.
- **Slab pricing** by client count. A quoted deal is a minimum with a ceiling
  today; bands were discussed and deferred.
- **Per-WABA member permissions**, kept in the definition for later: a team
  member today sees every account in the organisation.

## Blockers

None.
