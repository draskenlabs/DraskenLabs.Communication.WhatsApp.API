# Module: Search – Definition

## Purpose

One query across everything the console can link to. The console's top bar
offers a single field; without this module it would have to fan out to five
list endpoints, filter each in the browser, and still miss anything past the
first page of results.

---

## Scope

| Area | Included | Excluded |
|------|----------|----------|
| Contacts by name, phone or email | ✅ Yes | — |
| Messages by recipient, Meta message ID or template name | ✅ Yes | — |
| Templates by name | ✅ Yes | — |
| Phone numbers by display name, number or Meta ID | ✅ Yes | — |
| WABAs by name or ID | ✅ Yes | — |
| Per-type counts alongside a capped list | ✅ Yes | — |
| Message **body** search | ❌ No | Outbound bodies live in a JSON `payload` column that cannot be scanned |
| Template **body** search | ❌ No | Components are JSON, same reason |
| Inbound message search | ❌ No | Future |
| Fuzzy matching / typo tolerance | ❌ No | `contains`, case-insensitive |
| Relevance ranking across types | ❌ No | Type order is fixed; within a type, newest first |
| Full-text index (tsvector / trigram) | ❌ No | Future — see Performance |
| API key search | ❌ No | Secrets are not searchable by design |

---

## Endpoint

| Method | Path | Auth |
|--------|------|------|
| GET | `/search` | Console JWT only |

Console-only, like Analytics: a search reads across every domain in the
organisation, which is wider than the per-phone-number send an API key
authorises. `SearchModule` applies `AuthMiddleware` to the controller.

### Query

| Parameter | Type | Notes |
|-----------|------|-------|
| `q` | string | Required. Under 2 characters returns an empty result rather than everything |
| `limit` | number | Results **per type**, 1–20, default 5. Clamped server-side |
| `types` | string[] | Repeated or comma-separated. Omit to search everything. An unrecognised value falls back to everything |

### Response

```
{ query, total, groups: [ { type, total, items: [ SearchResult ] } ] }
```

`groups` only contains types that matched. `group.total` is the full count, so
the console can say "showing 5 of 37" rather than implying five is all there is.

`SearchResult` is deliberately uniform across types — `type`, `id`, `title`,
`subtitle?`, `description?`, `badge?`, `timestamp?` — so one renderer handles
every result and the API decides what a contact's headline is, not the client.

---

## Per-type mapping

| Type | Matched on | title / subtitle / description | badge |
|------|-----------|-------------------------------|-------|
| `contact` | name, email, phone | name (or phone) / phone / email | `Opted out` |
| `message` | `metaMessageId`, `templateName`, `to` | recipient / template name or type / message ID | status |
| `template` | name | name / `CATEGORY · language` | status |
| `phoneNumber` | verified name, display number, phone number ID | verified name / display number | quality rating |
| `waba` | name, WABA ID | name / WABA ID | — |

A message that used a template reports the template name rather than the
literal string "template", which tells the reader nothing new.

---

## Business rules

- **Scoped to the organisation.** Contacts, messages and WABAs carry
  `ssoOrgId`. Templates and phone numbers do not — they hang off a WABA — so
  both are scoped through the organisation's own `wabaId`s, resolved once per
  request.
- **Two-character minimum.** A single character matches nearly every row; that
  is a table scan with a search box drawn on it, not a search.
- **Phone-shaped queries are normalised.** Phone columns hold digits only, so
  `+44 7911 123456` is matched against its digits *and* as typed. When the
  query is already digits, the clause is not duplicated.
- **Per-type limits, not a global one.** Five contacts and five messages beats
  ten contacts and no messages.

---

## Performance

Each type runs a `findMany` and a `count` in parallel, and the types run in
parallel with each other — ten queries per request at the widest.

`contains` with `mode: 'insensitive'` is a sequential scan on Postgres. That is
acceptable at current row counts and is the reason for the two-character floor
and the per-type cap. A trigram (`pg_trgm`) or `tsvector` index is the next
step if these tables grow; nothing in the response shape has to change for it.
