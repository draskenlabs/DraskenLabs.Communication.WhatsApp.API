# Module: Auth – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ✅ Complete |
| Completion | 100% |
| Blocking Issues | None |
| Last Updated | 2026-08-30 |

---

## Wave Status

| Wave | Name | Status | Notes |
|------|------|--------|-------|
| A.0 | Browser Authorize Redirect | ✅ Complete | Handled by the web app — redirect to `${SSO_ACCOUNTS_URL}/authorize`; this API no longer exposes `GET /auth/authorize` |
| A.1 | SSO Callback | ✅ Complete | `POST /auth/callback` — confidential code→token exchange; returns the SSO's own access token and sets the refresh cookie |
| A.2 | Auth Middleware | ✅ Complete | `AuthMiddleware` — verifies the SSO token against JWKS, resolves `X-Org-Id`; Redis user cache (15 min TTL), falls through to DB on miss |
| A.3 | User Profile Endpoint | ✅ Complete | `GET /user/profile` live — reads through to the SSO (`GET /users/me`) for the full profile (name, username, emailVerified, imageUrl, createdAt), falling back to the login session snapshot when the SSO is unreachable |
| A.4 | API Key Generation | ✅ Complete | `POST /api-keys` — `ak_` + `sk_` pair; secret encrypted; cached in Redis |
| A.5 | API Key Auth Middleware | ✅ Complete | `ApiKeyAuthMiddleware` — Redis-first lookup, validates secret |
| A.6 | API Key Listing | ✅ Complete | `GET /api-keys` live |
| A.7 | API Key Revocation | ✅ Complete | `DELETE /api-keys/:id` — deactivates in DB, removes Redis cache entry |
| A.8 | Account Deletion | ✅ Complete | `DELETE /user/account` — transactional delete of everything this platform holds for the user (WABAs, Meta tokens, phone numbers, templates, messages, inbound messages, webhook events, API keys), plus a Redis purge. The SSO account is NOT deleted, and the WABA stays with Meta. Contacts are org-scoped, so they only go when no other user of this platform remains in the organisation |
| A.9 | Token Verification | ✅ Complete | `SsoTokenService` — RS256 against `/.well-known/jwks.json`, checking `iss`, `aud`, `exp` and `kid`, with a cooled-down refetch on rotation |
| A.10 | Refresh + Logout | ✅ Complete | `POST /auth/refresh` (HttpOnly cookie, rotation, replay grace window) and `POST /auth/logout` (revokes at the SSO) |

---

## Endpoint Status

| Method | Endpoint | Auth | Status |
|--------|----------|------|--------|
| POST | `/auth/callback` | None | ✅ Live (returns the SSO access token + orgs) |
| POST | `/auth/refresh` | Refresh cookie | ✅ Live |
| POST | `/auth/logout` | SSO token | ✅ Live |
| GET | `/auth/organisations` | SSO token | ✅ Live |
| POST | `/auth/organisations` | SSO token | ✅ Live (create + enter) |
| POST | `/auth/select-org` | SSO token | ✅ Live (records a grant) |
| GET | `/user/profile` | SSO token | ✅ Live |
| POST | `/api-keys` | SSO token | ✅ Live |
| GET | `/api-keys` | SSO token | ✅ Live |
| DELETE | `/api-keys/:id` | SSO token | ✅ Live |

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
| `AuthMiddleware` | `auth.middleware.spec.ts` | ✅ 6 tests |
| `SsoTokenService` | `sso-token.service.spec.ts` | ✅ 13 tests |
| `OrgAccessService` | `org-access.service.spec.ts` | ✅ 10 tests |
| `SsoService` | `sso.service.spec.ts` | ✅ 6 tests |
| `AuthService` | `auth.service.spec.ts` | ✅ 13 tests |
| `AuthController` | `auth.controller.spec.ts` | ✅ 10 tests |
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

The grant then carries `role: 'agency'` and an `agencyOrgId`, which
`AuthMiddleware` puts on the request, so a handler can tell an agency is acting
inside a client without another lookup. It is absent on every other grant;
setting it always would make the reading meaningless.

`GET /auth/organisations` and the login response list the SSO's organisations
first, then the clients of any of them that is an agency, each carrying
`agencyOrgId`. Clients are added on the way out only: what the session record
stores is membership, and that is what a grant is resolved against. A client is
named by the agency's own label, falling back to whatever name we know — a
client organisation whose people have never logged in has no name anywhere else.

See `docs/development/modules/agency/definition.md`.

---

## 2026-08-30 — the SSO's token is the credential

This API used to mint its own JWT at login and re-mint it on every organisation
switch, holding the user's SSO access token in Redis and never showing it to the
browser. There were two credentials for one session, and they could disagree:
the local token lived a day, the SSO's ten minutes, and a session revoked at the
SSO stayed good here until the local token expired.

Now there is one. `POST /auth/callback` returns the SSO's own access token; every
request is verified against the SSO's published keys, checking `iss`, `aud` and
`exp` as well as the signature. Nothing here signs an access token, and
`JWT_SECRET` is left only for the HMACs this API makes for itself, such as the
one on an unsubscribe link.

What that costs and what it buys:

- **`X-Org-Id` on every request.** The SSO's token carries no organisation, so
  the request names it and `AuthMiddleware` checks it against the session's
  grants — 403 for one it was never granted. `POST /auth/select-org` records the
  grant and issues nothing.
- **Ten-minute tokens, so refresh had to exist.** `POST /auth/refresh` spends
  the SSO refresh token, which this API keeps in an HttpOnly cookie rather than
  handing to the page. Because the SSO revokes a session family on a replayed
  refresh token, refreshes are serialised per token and a concurrent tab is
  handed the pair the first one bought.
- **Signing out reaches the SSO.** `POST /auth/logout` revokes there, so the
  other Drasken applications on that session are told.
- **The organisation proxy stopped storing a token.** `/organisation/*` forwards
  the caller's live token; a copy cached at login would be stale within minutes
  of a ten-minute lifetime.
- **CORS is no longer a wildcard.** A cookie only travels on a credentialed
  request, which a wildcard origin may not answer. See `WEB_APP_ORIGINS`.
- **`POST /user/test-token` is gone.** It minted a local JWT, and there is no
  local signing key for access tokens any more.

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
