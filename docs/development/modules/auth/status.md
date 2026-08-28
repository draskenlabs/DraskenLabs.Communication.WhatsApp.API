# Module: Auth – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ✅ Complete |
| Completion | 100% |
| Blocking Issues | None |
| Last Updated | 2026-08-01 |

---

## Wave Status

| Wave | Name | Status | Notes |
|------|------|--------|-------|
| A.0 | Browser Authorize Redirect | ✅ Complete | Handled by the web app — redirect to `${SSO_ACCOUNTS_URL}/authorize`; this API no longer exposes `GET /auth/authorize` |
| A.1 | SSO Callback + JWT Issuance | ✅ Complete | `POST /auth/callback` — confidential code→token exchange, decodes SSO token, issues internal JWT |
| A.2 | JWT Auth Middleware | ✅ Complete | `AuthMiddleware` — Redis user cache (15 min TTL); falls through to DB on miss |
| A.3 | User Profile Endpoint | ✅ Complete | `GET /user/profile` live — reads through to the SSO (`GET /users/me`) for the full profile (name, username, emailVerified, imageUrl, createdAt), falling back to the login session snapshot when the SSO is unreachable |
| A.4 | API Key Generation | ✅ Complete | `POST /api-keys` — `ak_` + `sk_` pair; secret encrypted; cached in Redis |
| A.5 | API Key Auth Middleware | ✅ Complete | `ApiKeyAuthMiddleware` — Redis-first lookup, validates secret |
| A.6 | API Key Listing | ✅ Complete | `GET /api-keys` live |
| A.7 | API Key Revocation | ✅ Complete | `DELETE /api-keys/:id` — deactivates in DB, removes Redis cache entry |
| A.8 | Account Deletion | ✅ Complete | `DELETE /user/account` — transactional delete of everything this platform holds for the user (WABAs, Meta tokens, phone numbers, templates, messages, inbound messages, webhook events, API keys), plus a Redis purge. The SSO account is NOT deleted, and the WABA stays with Meta. Contacts are org-scoped, so they only go when no other user of this platform remains in the organisation |

---

## Endpoint Status

| Method | Endpoint | Auth | Status |
|--------|----------|------|--------|
| POST | `/auth/callback` | None | ✅ Live (returns session token + orgs) |
| GET | `/auth/organisations` | App JWT | ✅ Live |
| POST | `/auth/organisations` | App JWT | ✅ Live (create + switch) |
| POST | `/auth/select-org` | App JWT | ✅ Live (switch) |
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

## 2026-08-28 — an agency can enter its clients

`POST /auth/select-org` has a second way in. Membership, as the SSO reports it,
still decides for everyone else; a **client** organisation is reached because
`OrganisationSettings.agencyOrgId` names one of the session's own organisations.
That relationship is ours, not the SSO's — nobody at the agency is a member of a
client organisation there, and we do not delegate SSO membership to make them
one.

The token then carries `role: 'agency'` and an `agencyOrgId` claim, which
`AuthMiddleware` puts on the request, so a handler can tell an agency is acting
inside a client without another lookup. The claim is absent on every other
token; sending it always would make the reading meaningless.

`GET /auth/organisations` and the login response list the SSO's organisations
first, then the clients of any of them that is an agency, each carrying
`agencyOrgId`. Clients are added on the way out only: what the session record
stores is membership, and that is what `selectOrg` checks against. A client is
named by the agency's own label, falling back to whatever name we know — a
client organisation whose people have never logged in has no name anywhere else.

See `docs/development/modules/agency/definition.md`.

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
