# Module: API Keys – Status

| Field | Value |
|-------|-------|
| Status | ✅ Implemented |
| Last Updated | 2026-08-01 |

## Implemented

- Create / list / revoke, with the secret shown once and stored encrypted.
- **Keys are scoped to one WABA** (`20260801600000_api_key_per_waba`). The WABA
  is validated against the caller's organisation on create, carried on the
  request as `apiKeyWabaId`, and enforced on send (`403` for a number belonging
  to another account) and on reads (list, detail and analytics see only that
  account's numbers).
- Keys with no WABA are refused at authentication rather than left org-wide.
- The Redis entry carries the WABA, and a pre-change entry is treated as stale
  — those keys are written without a TTL and would otherwise outlive the deploy.
- The list returns the account's name alongside its id, for the console.

## Migration notes

The column is nullable and backfilled for organisations with exactly one WABA,
which is the unambiguous case. Keys in multi-WABA organisations are left null
deliberately — guessing the account is how a key ends up sending from the wrong
number — and their owners are told to issue a scoped key. Check for them before
deploying:

```sql
SELECT "ssoOrgId", COUNT(*) FROM "UserApiKey"
WHERE "wabaId" IS NULL AND "status" GROUP BY "ssoOrgId";
```

## Pending / not in scope

- No per-key permissions: a key can both send and read within its account.
- No rotation or expiry — replacing a key means creating one and revoking the old.
- Rate limiting is per route, not per key.
- Only the creating user can revoke a key; an org admin cannot revoke someone
  else's.
- `CreateApiKeyDto.label` is accepted and validated but never stored — there is
  no column for it, so the console cannot show what a key was named.

## Blockers

None.
