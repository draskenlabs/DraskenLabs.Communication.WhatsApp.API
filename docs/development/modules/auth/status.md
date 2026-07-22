# Module: Auth – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ✅ Complete |
| Completion | 100% |
| Blocking Issues | None |
| Last Updated | 2026-05-03 |

---

## Wave Status

| Wave | Name | Status | Notes |
|------|------|--------|-------|
| A.0 | Browser Authorize Redirect | ✅ Complete | Handled by the web app — redirect to `${SSO_ACCOUNTS_URL}/authorize`; this API no longer exposes `GET /auth/authorize` |
| A.1 | SSO Callback + JWT Issuance | ✅ Complete | `POST /auth/callback` — confidential code→token exchange, decodes SSO token, issues internal JWT |
| A.2 | JWT Auth Middleware | ✅ Complete | `AuthMiddleware` — Redis user cache (15 min TTL); falls through to DB on miss |
| A.3 | User Profile Endpoint | ✅ Complete | `GET /user/profile` live |
| A.4 | API Key Generation | ✅ Complete | `POST /api-keys` — `ak_` + `sk_` pair; secret encrypted; cached in Redis |
| A.5 | API Key Auth Middleware | ✅ Complete | `ApiKeyAuthMiddleware` — Redis-first lookup, validates secret |
| A.6 | API Key Listing | ✅ Complete | `GET /api-keys` live |
| A.7 | API Key Revocation | ✅ Complete | `DELETE /api-keys/:id` — deactivates in DB, removes Redis cache entry |

---

## Endpoint Status

| Method | Endpoint | Auth | Status |
|--------|----------|------|--------|
| POST | `/auth/callback` | None | ✅ Live |
| GET | `/user/profile` | JWT | ✅ Live |
| POST | `/api-keys` | JWT | ✅ Live |
| GET | `/api-keys` | JWT | ✅ Live |
| DELETE | `/api-keys/:id` | JWT | ✅ Live |

---

## Auth Middleware — Cache Behaviour

| Scenario | DB Hit | Source |
|----------|--------|--------|
| First request after login | Yes (cache miss) | DB → writes to Redis |
| Subsequent requests (within 15 min) | No | Redis cache |
| After cache invalidation | Yes | DB → writes to Redis |

---

## Test Coverage

| Component | Test File | Status |
|-----------|-----------|--------|
| `AuthMiddleware` | `auth.middleware.spec.ts` | ✅ 4 tests |
| `SsoService` | `sso.service.spec.ts` | ✅ 6 tests |
| `AuthService` | `auth.service.spec.ts` | ✅ 4 tests |
| `AuthController` | `auth.controller.spec.ts` | ✅ 1 test |
| `UserService` | — | ❌ Missing |
| `ApiKeyService` | `api-key.service.spec.ts` | ✅ 4 tests |
| `ApiKeyController` | — | ❌ Missing |
| `ApiKeyAuthMiddleware` | — | ❌ Missing |

---

## Breaking Changes from Previous Implementation

| Old (Clerk) | New (Drasken SSO) |
|-------------|-------------------|
| `POST /auth/signup` | Removed — registration handled by SSO |
| `POST /auth/login` | Removed — replaced by PKCE flow |
| `ClerkService` | Removed — replaced by `SsoService` |
| `User.email`, `User.firstName`, etc. | Removed — profile data lives in SSO |
| `Organisation`, `OrgMember` tables | Removed — `ssoOrgId: String` used instead |
| `user.status` check in middleware | Removed — SSO handles account state |
