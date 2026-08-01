# Module: API Keys – Definition

## Purpose

Access/secret key pairs that let a customer's own systems call the Messaging
API without a browser session. A key authenticates as the user who created it
and is scoped to **one WhatsApp Business Account**.

---

## Scope

| Area | Included | Excluded |
|------|----------|----------|
| Create a key for a WABA | ✅ Yes | — |
| List an organisation's keys | ✅ Yes | — |
| Revoke a key | ✅ Yes | — |
| Key scoped to one WABA | ✅ Yes | — |
| Per-key permissions (read-only, send-only) | ❌ No | Future |
| Key rotation / expiry | ❌ No | Future |
| Per-key rate limits | ❌ No | Throttling is per route |

---

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api-keys` | JWT | Create a key for a WABA. Returns the secret once |
| GET | `/api-keys` | JWT | List the organisation's keys |
| DELETE | `/api-keys/:id` | JWT | Revoke a key (sets `status = false`) |

Keys are managed from the console only — a key cannot mint another key.

---

## Scoping

`UserApiKey.wabaId` names the account the key may act on. It is validated on
create against the caller's organisation, so an id belonging to another
organisation cannot be used to mint a key into it.

Enforcement happens per request, because the WABA is not in the request body:

| Route | How the scope is applied |
|-------|--------------------------|
| `POST /messages` | `phoneNumberId` resolves to a WABA through the phone cache; a mismatch is `403`. Without this, a key issued for one account could send from every number the organisation owns |
| `GET /messages` | Narrowed to the numbers of the key's WABA |
| `GET /messages/:id` | A message on another account is **404**, not `403` — whether traffic exists elsewhere in the organisation is not the key's business either |
| `GET /messages/analytics` | Counted over the key's numbers only |

`ApiKeyAuthMiddleware` puts the scope on the request as `apiKeyWabaId`. The JWT
path leaves it undefined, which is what keeps the console — where the user
picks the account in the interface — unaffected by key scoping.

A key with no WABA (issued before scoping, or whose account was deleted, since
the foreign key is `ON DELETE SET NULL`) is refused at authentication rather
than left with the run of the organisation.

---

## Caching

`apiKey:{accessKey}` in Redis holds `{ userId, ssoOrgId, wabaId, secretKey }`.
The entry is written **without a TTL**, so `getApiKeyCache` treats an entry
with no `wabaId` field as stale and re-reads the row: a cache filled before
this change would otherwise survive the deploy and authenticate unscoped.

Revocation deletes the cache entry, so it takes effect immediately.

---

## Business rules

- The secret is returned exactly once, at creation. It is stored encrypted
  (AES-256-GCM) and never emailed — creation and revocation each send an alert
  instead, which is what catches a key somebody else made.
- Revocation flips `status` rather than deleting the row, so the key stays
  visible in the console as revoked.
- Only the user who created a key can revoke it.
- A key reaches one WABA. Sending from several accounts means several keys.
