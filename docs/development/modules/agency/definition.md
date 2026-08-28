# Module: Agency – Definition

## Purpose

An **agency** is one business that runs WhatsApp for other businesses. It pays
once, on a quoted plan, and every client organisation beneath it inherits that
entitlement.

A **client is an organisation**, not an account. An agency's client can have
several WABAs and several numbers, so a WABA switcher would not have described
the thing being switched between; the organisation is the unit the agency
already thinks in, and it is the unit everything else here — limits, contacts,
webhooks, team members — is already scoped by.

The relationship is **ours, not the SSO's**. Nobody at the agency is a member of
a client organisation in the SSO, and we do not delegate SSO membership to make
them one. What makes an organisation a client is a row here.

---

## Scope

| Area | Included | Excluded |
|------|----------|----------|
| Marking an organisation an agency | ✅ Yes, operator only | Self-serve |
| Taking a client on, letting one go | ✅ Yes, operator only | Self-serve |
| An agency entering its clients | ✅ Yes | SSO membership delegation |
| A client roster with usage counters | ✅ Yes | — |
| Renaming a client | ✅ Yes, by the agency | Renaming the SSO organisation |
| One quoted subscription covering the roster | ✅ Yes | Per-client billing |
| Nested agencies | ❌ No | One level, no chains |
| An agency running several businesses | ❌ No | One business, clients beneath it |
| Per-WABA member permissions | ❌ No | Out of scope, kept for later |
| Slab pricing by client count | ❌ No | Deferred; minimum + ceiling instead |

---

## Data

`OrganisationSettings`, keyed by `ssoOrgId`. Most organisations have no row at
all, which is why every read falls back to defaults rather than requiring one to
be written at signup.

| Column | Meaning |
|--------|---------|
| `agencyOrgId` | The agency that pays for this organisation, or null. A column on the client rather than a join table, because a client belongs to at most one agency |
| `isAgency` | Whether this organisation manages clients. Set by us, never self-serve — it is a privilege boundary, not a plan feature |
| `clientName` | What the agency calls this client, for its own switcher and reporting |
| `convertedBy` / `convertedAt` | Who marked it an agency, and when. The row that explains why a user could read another organisation's messages |
| `payerVersion` | Bumped whenever the payer changes or their subscription does; part of every access-cache key derived from this organisation |

**One level, no chains.** An organisation with `agencyOrgId` set must never be an
agency itself, and an agency cannot be taken on as a client. "Who pays" has to
stay a lookup rather than a walk, because every limit question starts with it.

---

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/agency/clients` | JWT (an agency) | The roster: a row per client with its accounts, numbers, contacts and messages this month, plus the totals against what the agency's plan includes |
| PATCH | `/agency/clients/:ssoOrgId` | JWT (the agency) | Rename a client. The label is the agency's own |
| POST | `/agency/internal/convert` | `x-agency-admin-token` | Mark an organisation an agency, or demote one |
| POST | `/agency/internal/clients` | `x-agency-admin-token` | Take a client on |
| DELETE | `/agency/internal/clients/:agencyOrgId/:ssoOrgId` | `x-agency-admin-token` | Let a client go |

The two operator endpoints hand out something no plan describes — the right to
enter organisations you are not a member of, and a change to who is billed — so
they are behind a shared secret and **off unless `AGENCY_ADMIN_TOKEN` is set**,
in the same shape as the mail broadcast endpoint. A self-hosted install ships
with them disabled.

The agency's own routes take the agency from the **token**, never from the body:
taking it from the request would let any agency read and rename any other
agency's clients.

---

## Getting in

`POST /auth/select-org` has two ways in:

1. Membership, as the SSO reports it — everyone else.
2. A client: the target organisation's `agencyOrgId` is one of the session's own
   organisations.

The second issues a token with `role: 'agency'` and an `agencyOrgId` claim, so a
request can tell an agency is acting inside a client without another lookup. The
console uses it to hide what a client cannot change — its own subscription, and
`/organisation`, because there is no SSO membership there to manage.

`GET /auth/organisations` lists the SSO's organisations first, then the clients
of any of them that is an agency, each carrying `agencyOrgId`. Clients are added
on the way out only; what the session record stores is membership, and that is
what `selectOrg` checks against. A client is named by the agency's own label,
falling back to whatever name we know — a client organisation whose people have
never logged in has no name anywhere else.

---

## Billing

The agency's subscription answers for the whole roster.

- `OrganisationSettings.billingOrgFor()` resolves the payer, and every access
  and limit question calls it. For an organisation with no agency the payer is
  itself, which is why it is safe to call unconditionally.
- `billingScope()` is the payer plus everyone inheriting from it — what the
  overage counters are measured across, so an agency's accounts and numbers are
  counted once, together.
- A client is **refused a subscription of its own**: it already has the
  entitlement, and selling it one would charge twice for the same thing and stop
  its usage counting against the agency's deal.
- The quoted plan is a private `Plan` row scoped by `Plan.ssoOrgId`, so it is
  visible and sellable only to the agency, and checkout happens inside the
  platform like any other tier.
- The plan is a **minimum with a ceiling**: the mandate is authorised at the
  ceiling and the charge rises with what they actually connect, never past it.
  Slabs were considered and deferred.

### Cache invalidation

A client's access depends on its agency's subscription, so one failed debit has
to darken every client and every account each of them holds. The cache key
carries the **payer's** `payerVersion`, so a single increment orphans all of
them at once rather than requiring the keys to be enumerated. Taking a client on
or letting one go bumps the client's own version, so what was cached under the
old payer stops matching.

### Off-boarding

A detached client keeps its data and its organisation; what it loses is the
agency's subscription. Until it buys one of its own the APIs answer **not
subscribed** — the same thing they answer anyone who has never paid. There is no
grace window.

---

## The roster

`GET /agency/clients` is four queries for the whole roster, not four per client:
an agency with fifty clients is the case the page exists for, and a per-row
query would make it slowest exactly there. Each row carries accounts, phone
numbers, contacts and messages sent since the first of the month; the totals sit
against `includedClients` and `includedWabas` from the agency's own plan.

---

## Business rules

- **Conversion is internal.** `isAgency` defaults to false and only an operator
  can change it.
- An organisation that is somebody's client cannot be made an agency; an agency
  with clients still attached cannot be demoted — they would go on inheriting
  from an organisation that manages nothing, subscribed to nothing, with no
  error anyone could act on.
- A client already belonging to another agency is not moved silently: that would
  change who is billed without either agency being told.
- An organisation cannot be its own client.
- An agency has **one business** and its clients beneath it. It does not create
  more organisations of its own from inside the console.

---

## Configuration

| Variable | Required | Purpose |
|----------|----------|---------|
| `AGENCY_ADMIN_TOKEN` | Optional | Enables `/agency/internal/*`. Unset means disabled |
