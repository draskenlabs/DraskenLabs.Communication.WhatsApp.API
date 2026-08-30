# Module: Auth – Definition

## Purpose

Handles all authentication and authorisation for the application. Implements two strategies:

1. **SSO access token** — the RS256 token DraskenLabs SSO mints for this client,
   obtained by the PKCE flow and used for every user-facing endpoint. This API
   signs no access token of its own.
2. **API Key** — programmatic access for server-to-server integrations; uses `x-access-key` + `x-secret-key` headers

Organisation endpoints (`/organisation/*`) are a proxy onto the SSO's own
organisation API: the caller's token is verified here and forwarded as-is.

---

## Scope

| Area | Included | Excluded |
|------|----------|----------|
| PKCE SSO login flow | ✅ Yes | — |
| Offline SSO token verification (JWKS / RS256) | ✅ Yes | — |
| Refresh + logout against the SSO | ✅ Yes | — |
| Organisation grants (`X-Org-Id`) | ✅ Yes | — |
| Issuing access tokens | ❌ No | The SSO mints them; this API only verifies |
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
| SSO access token | All protected routes except messaging's API-key path | `Authorization: Bearer <sso access token>` (+ `X-Org-Id`) | Verified offline against `{SSO_API_URL}/.well-known/jwks.json` |
| API Key | `/messages` routes | `x-access-key` + `x-secret-key` headers | Access key looked up in Redis cache, secret verified |
| SSO access token (proxy) | `/organisation/*` | `Authorization: Bearer <sso access token>` | Verified here, then forwarded to the SSO unchanged |

---

## Verifying the access token

`SsoTokenService` fetches the SSO's public keys once, caches them, and verifies
every request locally. Four checks, not just the signature:

| Check | Why |
|-------|-----|
| `iss` = `SSO_ISSUER` (default `SSO_API_URL`) | Another issuer's token is not ours to accept |
| `aud` = `SSO_CLIENT_ID` | A token minted for another Drasken application must not open this one |
| `exp` in the future | 5s clock tolerance for host drift |
| header `kid` resolves | An unknown one refetches the ring — that is what a key rotation looks like from here |

`alg` must be `RS256`, checked from the header before a key is chosen, so
`alg: none` and an HMAC over something we hold never reach the verifier.

The ring is refetched at most once per 30s for an unknown `kid`, so a forged
token cannot turn into an outbound flood; an empty ring retries every 5s.
An SSO answer with no usable keys leaves the ring we hold in place, because
replacing it with nothing would reject everybody.

**Offline verification has a staleness window.** A session revoked at the SSO
stays acceptable here until the token expires — ten minutes by default. That is
the trade for not making the SSO a hard availability dependency of every page.

### Claims read

| Claim | Used for |
|-------|---------|
| `sub` | SSO user id → the local `User` row, looked up by `ssoId` |
| `sid` (or `sessionId`) | The session key — `ssosession:{sid}` |
| `email` | Fallback contact detail when `/users/me` is unreachable |

---

## Organisation context

The SSO access token carries **no organisation**, because the SSO does not know
what one means here. A request names the organisation it is working in:

```
X-Org-Id: <sso organisation id>
```

`AuthMiddleware` checks it against the grants on the session record and answers
**403** for one the session was never granted — a header proves nothing on its
own, and quietly ignoring it would leave `orgId` undefined on a request the
handler believes is scoped. A request with no header is authenticated but has no
organisation, which is what `/auth/*` and `/user/profile` need.

A grant is resolved once, by `OrgAccessService`, and cached on the session:

| Basis | Role |
|-------|------|
| The SSO lists the organisation in the user's membership | `member` |
| The user created it through `POST /auth/organisations` | `owner` |
| The organisation is a client of an agency the user belongs to | `agency` (+ `agencyOrgId`) |

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
   → Verifies the returned access token against the SSO's JWKS → sub, sid
   → Finds or creates User by ssoId
   → Fetches the user's orgs from GET {SSO_API_URL}/organizations and writes
     the session record at ssosession:{sid} — membership and grants, no token
   → Returns { accessToken, expiresIn, tokenType, user, organisations }, and
     sets the SSO refresh token as an HttpOnly cookie

4. Client enters an organisation. No token is issued — a grant is recorded:
   - POST /auth/select-org { orgId } → { orgId, organisation, role, agencyOrgId? }
   - POST /auth/organisations { name } → creates it in the SSO, role: owner
   - GET  /auth/organisations → membership, then the clients of any agency in it

5. Every subsequent request sends the SSO access token as the bearer, plus
   X-Org-Id. When it expires, POST /auth/refresh mints the next one.
```

**Session model.** The credential is the SSO's own access token, and it is
short-lived (ten minutes by default). The session record in Redis is keyed on
the token's `sid`, which survives a refresh, and holds what the SSO cannot
answer: which organisations this person may enter here. It holds **no token of
theirs** — every request carries the live one, so nothing stored here can go
stale.

### Refresh

`POST /auth/refresh` trades the refresh token for a new pair at
`POST {SSO_API_URL}/auth/refresh`.

- **The refresh token is an HttpOnly cookie** (`dl_wa_refresh`, path `/auth`),
  set by this API. It is good for thirty days — far longer than the access token
  it buys — and in `localStorage` every script the page loads could read it.
  A caller that stores the token itself may still send it in the body.
- **Refreshes are serialised per token.** The SSO rotates on use and treats a
  second presentation of the same token as theft: it revokes the whole session
  family. Two console tabs share one cookie, so the first caller takes a Redis
  lock, and anyone else holding the token it spent is handed the pair it got
  (`refresh:{sha256}`, 60s).
- A refusal clears the cookie, so the browser does not come back to be refused
  on every load.

`POST /auth/logout` revokes the session at the SSO — so every Drasken
application sharing it is told — drops the grants, and clears the cookie.

### CORS

A cookie only travels on a credentialed request, and a wildcard origin may not
answer one. CORS is therefore restricted to the console's origin (taken from
`SSO_REDIRECT_URI`) plus anything in `WEB_APP_ORIGINS`, with credentials
enabled. Server-to-server API-key callers are unaffected — CORS is a browser
rule.

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
| `ssosession:{sid}` | 30 days | `{ ssoId, profile snapshot, orgs[], grants }` — keyed on the SSO session id |
| `user:{id}` | 15 min | `{ id, ssoId }` |
| `usersso:{ssoId}` | 15 min | `{ id, ssoId }` — the same row, reached from the SSO id on the token |
| `refresh:{sha256(token)}` | 60 s | The pair a spent refresh token bought, for a concurrent tab |
| `refreshlock:{sha256(token)}` | 10 s | Held while that pair is being bought |
| `apiKey:{accessKey}` | None | `{ userId, ssoOrgId, secretKey (encrypted) }` |

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/callback` | None | Exchange SSO code (+ PKCE verifier) for the SSO access token + orgs |
| POST | `/auth/refresh` | Refresh cookie | Mint a new access token, rotating the cookie |
| POST | `/auth/logout` | SSO token | End the session here and at the SSO |
| GET | `/auth/organisations` | SSO token | List the session user's organisations |
| POST | `/auth/organisations` | SSO token | Create an organisation and enter it |
| POST | `/auth/select-org` | SSO token | Enter a member org — records a grant, issues nothing |
| GET | `/user/profile` | SSO token | Get authenticated user profile |
| POST | `/api-keys` | SSO token | Create a new API key pair |
| GET | `/api-keys` | SSO token | List active API keys for the user |
| DELETE | `/api-keys/:id` | SSO token | Revoke an API key |

---

## Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Token forgery | RS256 against the SSO's published keys; `alg` pinned before a key is chosen, so `alg: none` and an HMAC never reach the verifier |
| A token from another application | `aud` must equal this client's `SSO_CLIENT_ID` |
| A forged `X-Org-Id` | Checked against the session's grants on every request; 403 otherwise |
| Refresh token theft from the page | HttpOnly cookie — never in a response body, never readable by page scripts |
| A refresh race revoking the session | One caller per token takes a Redis lock; the rest are handed its result |
| A revoked session still being accepted | Bounded by the access-token lifetime (10 min); `/auth/logout` revokes at the SSO |
| PKCE code interception | `codeVerifier` only sent on callback; never stored |
| CSRF on the SSO callback | `state` generated + verified by the web app (sessionStorage); SSO code is single-use, 60s TTL |
| Secret key exposure | AES-256-GCM encrypted in DB; returned once on creation only |
| API key brute-force | `ak_` + UUID v4 (122-bit entropy); Redis lookup is constant time |
| Meta token exposure | Stored AES-256-GCM encrypted; decrypted only at request time |
