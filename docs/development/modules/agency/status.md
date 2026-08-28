# Module: Agency – Status

| Field | Value |
|-------|-------|
| Status | ✅ API implemented; console work pending |
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
- Tests: 29 across the service and controller — conversion in both directions
  and its refusals, attach/detach and theirs, the roster's counters and its
  fixed query count, the empty roster, the name fallbacks, and the operator
  token (wrong, missing, and not configured at all). Plus the `selectOrg` and
  `listOrganisations` branches in the auth suite.

## Pending

- **Console.** The client switcher, the clients page, per-client usage, and
  hiding `/organisation` and the billing page in an agency context.
- **Onboarding a client organisation** is operator work today: the organisation
  has to exist in the SSO before it can be attached. Whether an agency should be
  able to create one from the console is open — it would mean either delegating
  SSO organisation creation or making the agency a member of it, and both were
  ruled out for now.
- **Slab pricing** by client count. A quoted deal is a minimum with a ceiling
  today; bands were discussed and deferred.
- **Per-WABA member permissions**, kept in the definition for later: a team
  member today sees every account in the organisation.

## Blockers

None.
