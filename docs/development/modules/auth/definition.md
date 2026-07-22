# Module: Auth – Definition

## Purpose

Handles all authentication and authorisation for the application. Implements two strategies:

1. **JWT** — issued after a PKCE SSO login with Drasken SSO; used for all user-facing endpoints
2. **API Key** — programmatic access for server-to-server integrations; uses `x-access-key` + `x-secret-key` headers

Organisation endpoints (`/organisation/*`) are a separate SSO proxy pattern — the SSO access token is forwarded directly; no JWT or API Key required for those routes.

---

## Scope

| Area | Included | Excluded |
|------|----------|----------|
| PKCE SSO login flow | ✅ Yes | — |
| JWT issuance and validation | ✅ Yes | — |
| Redis user cache (auth middleware) | ✅ Yes | — |
| API key generation (access + secret) | ✅ Yes | — |
| API key validation on requests | ✅ Yes | — |
| API key listing | ✅ Yes | — |
| API key revocation | ✅ Yes | — |
| Role-based access control (RBAC) | ❌ No | Enforced at SSO level |
| OAuth 2.0 server (issuing tokens) | ❌ No | Drasken SSO handles this |
| User registration / profile management | ❌ No | Managed by Drasken SSO |

---

## Authentication Strategies

| Strategy | Endpoints | Token Location | Validation |
|----------|-----------|----------------|------------|
| JWT | All protected routes except `/organisation` and messaging | `Authorization: Bearer <jwt>` | Verified against `JWT_SECRET`; payload: `{ sub, orgId, role }` |
| API Key | `/messages` routes | `x-access-key` + `x-secret-key` headers | Access key looked up in Redis cache, secret verified |
| SSO Token (proxy) | `/organisation/*` | `Authorization: Bearer <sso_token>` | Forwarded directly to Drasken SSO API; not validated locally |

---

## JWT Payload

```json
{
  "sub": 1,
  "orgId": "sso_org_uuid",
  "role": "admin"
}
```

`sub` → internal `User.id`; `orgId` → SSO organisation UUID (used for multi-tenant scoping); `role` → `owner | admin | member`.

---

## PKCE Login Flow

This API is a **confidential client**. The browser is redirected to the SSO
login UI by the web app; this API only performs the server-side code→token
exchange, so the client secret never reaches the browser.

```
1. Web app generates codeVerifier + codeChallenge + state, then redirects the
   browser to ${SSO_ACCOUNTS_URL}/authorize?clientId&redirectUri&codeChallenge
   &codeChallengeMethod=S256&state  (this API is not involved)

2. User authenticates at Drasken SSO (accounts UI)
   → SSO redirects the browser back to redirectUri (web app /auth/callback)
     with ?code=...&state=...  — the web app verifies state (CSRF)

3. Web app calls POST /auth/callback { code, codeVerifier }
   → API exchanges the code at POST {SSO_API_URL}/auth/token, sending
     clientId + clientSecret + codeVerifier + redirectUri (confidential)
   → Decodes SSO access token → extracts ssoId, email
   → Finds or creates User by ssoId
   → Fetches the user's orgs from GET {SSO_API_URL}/organizations and caches the
     SSO access token + org list in Redis (ssosession:{sessionId})
   → Issues a SESSION JWT { sub, sessionId } (no org) and returns
     { access_token, user, organisations }

4. Client selects/creates an organisation → API re-issues an ORG-SCOPED JWT:
   - POST /auth/select-org { orgId } → validates membership (cached) → JWT { sub, orgId, role, sessionId }
   - POST /auth/organisations { name } → creates org in SSO → JWT { sub, orgId, role: owner, sessionId }
   - GET  /auth/organisations → lists the cached orgs
```

**Session model.** The SSO access token carries **no organisation claim**, so
organisation is not resolved at login. Instead the API keeps a **BFF session**:
it stores the user's SSO access token + org membership in Redis
(`ssosession:{sessionId}`, TTL 1 day) so org list/create/switch run behind the
app JWT without the SSO token ever reaching the browser. The session JWT can't
call business routes (they require `orgId`); the client must select or create an
org first. Switching org = re-issuing the org-scoped JWT.

`SSO_REDIRECT_URI` must be the web app's `/auth/callback` URL and match exactly
both the value the browser redirected with and the one sent at token exchange.

---

## API Key Model

| Component | Format | Storage |
|-----------|--------|---------|
| Access Key | `ak_` + UUID v4 | DB plain text; Redis indexed |
| Secret Key | `sk_` + UUID v4 | DB AES-256-GCM encrypted; Redis encrypted |
| Status | Boolean (`true` = active) | DB only |

---

## Redis Key Schema

| Key | TTL | Value |
|-----|-----|-------|
| `state:{uuid}` | 5 min | `{}` (presence check) |
| `ssosession:{sessionId}` | 1 day | `{ ssoId, ssoAccessToken, orgs[] }` (BFF org session) |
| `user:{id}` | 15 min | `{ id, ssoId }` |
| `apiKey:{accessKey}` | None | `{ userId, ssoOrgId, secretKey (encrypted) }` |

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/callback` | None | Exchange SSO code (+ PKCE verifier) for a session token + orgs |
| GET | `/auth/organisations` | App JWT | List the session user's organisations |
| POST | `/auth/organisations` | App JWT | Create an organisation and switch into it |
| POST | `/auth/select-org` | App JWT | Switch into a member org (re-issues the token) |
| GET | `/user/profile` | JWT | Get authenticated user profile |
| POST | `/api-keys` | JWT | Create a new API key pair |
| GET | `/api-keys` | JWT | List active API keys for the user |
| DELETE | `/api-keys/:id` | JWT | Revoke an API key |

---

## Security Considerations

| Concern | Mitigation |
|---------|-----------|
| JWT forgery | Signed with `JWT_SECRET`; validated per request |
| PKCE code interception | `codeVerifier` only sent on callback; never stored |
| CSRF on the SSO callback | `state` generated + verified by the web app (sessionStorage); SSO code is single-use, 60s TTL |
| Secret key exposure | AES-256-GCM encrypted in DB; returned once on creation only |
| API key brute-force | `ak_` + UUID v4 (122-bit entropy); Redis lookup is constant time |
| Meta token exposure | Stored AES-256-GCM encrypted; decrypted only at request time |
