# Architecture Gap Analysis

Audit of the current codebase against `docs/development/architecture.md`.

---

## Summary Scorecard

| Category | Count | Verdict |
|----------|-------|---------|
| 🔴 Critical Security | 3 | Must fix before any production deployment |
| 🔴 Critical Architecture | 5 | Core multi-WABA design not implemented — messaging module cannot be built on current Redis structure |
| 🟠 Functional Missing | 6 (1 fixed) | Auth module 25% incomplete, key features absent. F6 is closed |
| 🟡 Minor | 6 | Low risk, addressable incrementally |
| **Total Gaps** | **20** | |

---

## 🔴 Critical Security Gaps

| # | Gap | Location | Impact |
|---|-----|----------|--------|
| C1 | **WABA upsert has no `userId` check on update** — `createOrUpdateWaba()` uses `where: { wabaId }` only. Any authenticated user can call `POST /wabas/:wabaId/sync` with another user's `wabaId` and overwrite its `userId`, stealing ownership. | `src/waba/waba.service.ts` | Account takeover |
| C2 | **API secret key stored plaintext in Redis** — `setApiKey()` stores the raw `secretKey` string in Redis with no encryption and no TTL. Architecture specifies AES-256-GCM encryption, same as DB. | `src/redis/redis.service.ts`, `src/api-key/api-key.service.ts` | Credential exposure if Redis is compromised |
| C3 | **`GET /connect/:businessId/clientWABAs` is unprotected** — Not listed in `ConnectModule.configure()` middleware binding. Controller has `@ApiBearerAuth()` (Swagger only — not functional auth). | `src/connect/connect.module.ts` | Unauthenticated access to Meta WABA data |

### C1 — Detail: WABA Ownership Bug

```
// Current (vulnerable)
return this.prisma.waba.upsert({
  where: { wabaId: data.wabaId },   // ← no userId check
  update: { name, currency, ... },   // ← overwrites userId if record exists
  create: { wabaId, userId, ... },
});

// Fix required
return this.prisma.waba.upsert({
  where: { wabaId: data.wabaId },
  update: { name, currency, ... },
  create: { wabaId, userId, ... },
});
// + verify waba.userId === requestingUserId before allowing update
```

### C2 — Detail: Redis Secret Storage

```
// Current (insecure)
await this.redisService.setApiKey(
  accessKey,
  secretKey,          // ← plaintext UUID stored in Redis hash
  dto.phoneNumberId,
  decryptedAccessToken,
);

// Architecture requires
await this.redis.set(
  `apiKey:${accessKey}`,
  JSON.stringify({
    userId,
    secretKey: this.cryptoService.encrypt(secretKey),  // ← encrypted
  }),
);
```

---

## 🔴 Critical Architecture Gaps

| # | Gap | Architecture Specifies | Current Code |
|---|-----|------------------------|-------------|
| A1 | **Phone→token Redis cache does not exist** | `phone:{phoneNumberId}` → `{ userId, wabaId, accessToken: encrypted }` is the core of multi-WABA message routing | Never created. Neither `connectWhatsapp()` nor `syncPhoneNumbers()` writes this key |
| A2 | **User phone index Set does not exist** | `user:{userId}:phones` Redis Set — enables bulk cache invalidation on WABA disconnect | Never created anywhere in the codebase |
| A3 | **API Key Redis schema is completely wrong** | `apiKey:{accessKey}` → String JSON `{ userId, secretKey: encrypted }` | Actual: `access_key:{accessKey}` Redis Hash with fields `secret_key` (plaintext) + `{phoneNumberId}: accessToken`. Wrong key prefix, wrong type, wrong shape, mixes API key and phone token concerns into one structure |
| A4 | **No API Key auth middleware/guard exists** | `x-access-key` + `x-secret-key` headers validated on messaging, contacts, analytics routes | Not built. API keys can be created and listed but cannot authenticate any request |
| A5 | **`RedisService` has no generic operations** | `get`, `set`, `del`, `expire`, `sadd`, `smembers` needed to support all cache patterns | Only 5 domain-specific methods: `getState`, `createState`, `updateState`, `setApiKey`, `getApiKey` |

### A3 — Detail: Redis Schema Comparison

| Field | Architecture | Current Code |
|-------|-------------|-------------|
| API Key key name | `apiKey:{accessKey}` | `access_key:{accessKey}` |
| API Key Redis type | String (JSON) | Hash |
| API Key value shape | `{ userId, secretKey: encrypted }` | Hash fields: `secret_key` (plaintext) + `{phoneNumberId}: decryptedAccessToken` |
| Phone token key | `phone:{phoneNumberId}` | ❌ Does not exist |
| User phone index | `user:{userId}:phones` (Set) | ❌ Does not exist |
| OAuth state key | `waba:connect:state:{uuid}` | Different prefix format, same purpose |

### A3 — Root Cause

The current `setApiKey()` signature requires a `phoneNumberId` and a decrypted `accessToken` at API key creation time:

```typescript
// Current — wrong design
setApiKey(accessKey, secretKey, phoneNumberId, accessToken): Promise<void>
```

This conflates two separate concerns: **API key auth** and **phone→token resolution**. The architecture separates them entirely — the API key cache holds only `{ userId, secretKey }`, and the phone token cache is populated independently during phone number sync.

---

## 🟠 Functional Gaps (Missing Features)

| # | Gap | Architecture Specifies | Current Code |
|---|-----|------------------------|-------------|
| F1 | **No `DELETE /api-keys/:id` endpoint** | Keys must be revocable — clears DB record and Redis entry | Not built. Keys are permanent once created |
| F2 | **No `user.status` check in `AuthMiddleware`** | Deactivated users must be rejected at auth layer | Middleware loads user but never checks `user.status === true` |
| F3 | **Connect flow does not populate phone cache** | After `POST /connect`, `phone:{phoneNumberId}` entries must be written to Redis | `connectWhatsapp()` only saves to DB (`UserWhatsapp` record) |
| F4 | **Phone number sync does not populate phone cache** | After `POST /wabas/:wabaId/phone-numbers/sync`, all phone entries written to Redis | `syncPhoneNumbers()` only saves to DB (`WabaPhoneNumber` records) |
| F5 | **No `DELETE /wabas/:wabaId/connect` endpoint** | WABA disconnect must remove `UserWhatsapp` record and invalidate all `phone:{id}` Redis entries via `user:{userId}:phones` Set | Not built |
| F6 | ✅ **Fixed** — **`POST /user/test-token` not gated by environment** | Must be disabled or unreachable in production | Now off unless `ALLOW_TEST_TOKENS` is set to exactly `true`, and refused as 404. See the note below |

### F6 — Detail: why the gate is a positive flag, not `NODE_ENV`

The endpoint mints a working session for user id 1 to whoever asks, with no
credential of any kind, so the gate in front of it is the whole of its
security. The obvious gate is the wrong one:

```
// Rejected
if (process.env.NODE_ENV === 'production') throw ...
```

That infers safety from the *absence* of a value. An environment that never
set `NODE_ENV`, set it to `Production`, or lost it when a container was
rebuilt is indistinguishable from a developer's laptop, and hands out a
session to anybody who can reach the port. Staging clusters and review apps
are exactly the deployments that get this wrong, and they usually hold real
data.

The gate is therefore positive and exact — `ALLOW_TEST_TOKENS` must be set to
the string `true` — so that a deployment which says nothing gets nothing.

It refuses as **404**, not 403: a 403 confirms the route exists and tells
somebody probing what to come back for once they find a misconfigured
environment.

Covered by `src/user/user.controller.spec.ts` (each near-miss value refused
individually, and no database call while it is off) and by
`test/integration/route-auth.int-spec.ts`, which probes it over HTTP with no
credential in a harness that sets no flag. The integration test seeds user id 1
first, so it fails for want of the flag and not for want of a row: against the
old gate it gets `201` and a token, against this one `404`.

---

## 🟡 Minor Gaps

| # | Gap | Location | Fix |
|---|-----|----------|-----|
| M1 | Swagger title reads "Utility CRM API" | `src/main.ts` — `DocumentBuilder` | Update to correct product name |
| M2 | No startup env var validation | `src/app.module.ts` | Add `joi` or `zod` schema to `ConfigModule` |
| M3 | No Redis connection retry strategy | `src/redis/redis.service.ts` | Add `retryStrategy` to ioredis config |
| M4 | Overall test coverage ~8% | All modules | Target is 80% — prioritise auth middleware and services |
| M5 | No rate limiting on `POST /api-keys` | `src/api-key/api-key.controller.ts` | Add `@Throttle()` guard |
| M6 | `forbidUnknownValues: false` in `ValidationPipe` | `src/main.ts` | Set to `true` for strict input validation |

---

## Fix Priority Order

| Priority | Fix | Effort |
|----------|-----|--------|
| 1 | **C1** — Add `userId` ownership check to `createOrUpdateWaba()` | Low |
| 2 | **C3** — Add `AuthMiddleware` to `GET /connect/:businessId/clientWABAs` | Low |
| 3 | **A3 + C2** — Redesign Redis schema: split API key cache from phone token cache, encrypt secret | Medium |
| 4 | **A5** — Add generic `get`, `set`, `del`, `expire`, `sadd`, `smembers` to `RedisService` | Low |
| 5 | **A1 + A2** — Populate `phone:{phoneNumberId}` and `user:{userId}:phones` on phone sync and connect | Medium |
| 6 | **A4** — Build API Key auth middleware (reads `x-access-key` / `x-secret-key`, validates via Redis) | Medium |
| 7 | **F1** — Add `DELETE /api-keys/:id` — soft delete DB + `DEL apiKey:{accessKey}` Redis | Low |
| 8 | **F2** — Add `user.status === true` check in `AuthMiddleware` | Low |
| 9 | **F5** — Add `DELETE /wabas/:wabaId/connect` — remove `UserWhatsapp`, invalidate phone cache | Medium |
| 10 | ✅ **F6** — Done. Gated on `ALLOW_TEST_TOKENS === 'true'`, not on `NODE_ENV` | Low |
| 11 | **M1–M6** — Minor fixes | Low |

---

## What Cannot Be Built Until Gaps Are Fixed

| Planned Feature | Blocked By |
|----------------|-----------|
| Send messages via API key | A4 (no API key auth), A1 (no phone→token cache) |
| Multi-WABA phone routing | A1, A2, A3 (Redis schema wrong) |
| WABA disconnect | F5, A2 (no phone index for invalidation) |
| API key revocation | F1, A3 (Redis schema must be correct first) |
| Messaging module | A1, A3, A4 must all be resolved first |
