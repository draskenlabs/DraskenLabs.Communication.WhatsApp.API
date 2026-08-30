# DraskenLabs WhatsApp Communication API

NestJS REST API for sending and receiving WhatsApp messages via the Meta Cloud API. Supports multi-tenant organisations, PKCE SSO authentication, API key programmatic access, and real-time webhook event processing.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | NestJS v11 (TypeScript) |
| Database | PostgreSQL via Prisma v7 |
| Cache | Redis via ioredis |
| Auth | Drasken SSO (PKCE OAuth2) + API Key |
| Encryption | AES-256-GCM (stored tokens) |
| Docs | Swagger / OpenAPI at `/swagger/docs` (off unless `SWAGGER_ENABLED=true`) |

---

## Quick Start

```bash
# Install dependencies
npm install

# Copy and fill environment variables
cp .env.example .env

# Run database migrations
npx prisma migrate deploy

# Start in watch mode
npm run start:dev
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (default 3000) |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_HOST` | Redis hostname |
| `REDIS_PORT` | Redis port |
| `ENCRYPTION_KEY` | 32-byte hex key for AES-256-GCM |
| `JWT_SECRET` | HMAC secret for the signatures this API makes for itself (e.g. unsubscribe links) — **not** access tokens |
| `META_APP_ID` | Meta app ID |
| `META_APP_SECRET` | Meta app secret |
| `META_REDIRECT_URI` | OAuth redirect URI registered in Meta |
| `WEBHOOK_VERIFY_TOKEN` | Token for Meta webhook verification |
| `SSO_CLIENT_ID` | Drasken SSO client ID — also the `aud` every access token must carry |
| `SSO_CLIENT_SECRET` | Drasken SSO client secret (confidential client) |
| `SSO_API_URL` | Drasken SSO API base URL — JWKS and token endpoints live under it |
| `SSO_REDIRECT_URI` | The console's `/auth/callback` URL; its origin is allowed through CORS |
| `SSO_ISSUER` | Optional — the `iss` on SSO tokens, when it is not `SSO_API_URL` |
| `SSO_REFRESH_TOKEN_TTL` | Optional — refresh-token lifetime in seconds (default 2592000) |
| `WEB_APP_ORIGINS` | Optional — extra browser origins allowed credentialed requests |
| `AUTH_COOKIE_SAMESITE` | Optional — `lax` (default) or `none` for the refresh cookie |

---

## Authentication

Two strategies are supported:

### SSO access token (user-facing)

`POST /auth/callback` completes the PKCE exchange and returns the **SSO's own**
RS256 access token — this API signs none of its own. Pass it as:

```
Authorization: Bearer <sso access token>
X-Org-Id: <organisation id from POST /auth/select-org>
```

It is verified offline against the keys the SSO publishes at
`/.well-known/jwks.json`, checking `iss`, `aud` (this client id), `exp` and the
header `kid`. It lives about ten minutes; `POST /auth/refresh` mints the next
one from the refresh token, which the API keeps in an HttpOnly cookie so page
scripts never see it. `POST /auth/logout` ends the session at the SSO.

The token carries no organisation, so a request names the one it is working in
with `X-Org-Id`, checked against the grants the session holds.

### API Key (programmatic)

Created via `POST /api-keys`. Pass both headers:
```
x-access-key: ak_...
x-secret-key: sk_...
```

### Organisation endpoints

`/organisation/*` is a proxy onto the Drasken SSO's own organisation API. It
takes the same access token as everything else — verified here, then forwarded
to the SSO as-is, because the caller already holds the token the SSO wants.

---

## API Modules

| Tag | Base Path | Auth | Description |
|-----|-----------|------|-------------|
| Auth | `/auth` | — / SSO token | PKCE login, refresh, logout, organisation selection |
| User | `/user` | SSO token | User profile |
| Organisations | `/organisation` | SSO token | SSO org & member management (proxy) |
| Connect | `/connect` | SSO token | WhatsApp Embedded Signup |
| WABAs | `/wabas` | SSO token | WABA management and sync |
| WABA Phone Numbers | `/wabas/:id/phone-numbers` | SSO token | Phone number sync |
| API Keys | `/api-keys` | SSO token | Programmatic key management |
| Messaging | `/messages` | API Key | Send and retrieve messages |
| Inbox | `/inbox` | SSO token / API Key | Conversations, threads and replies |
| Templates | `/templates` | SSO token | Message template sync from Meta |
| Contacts | `/contacts` | SSO token | Contact and opt-out management |
| Webhooks | `/webhooks` | HMAC / None | Meta event ingestion |

---

## Swagger

Served only when `SWAGGER_ENABLED=true`. `.env.example` turns it on for local
development; deployments leave it off, so a public instance does not hand out a
map of every endpoint and payload.

```
http://localhost:3000/swagger/docs   — Swagger UI
http://localhost:3000/swagger/json   — OpenAPI JSON
```

---

## Tests

```bash
npm run test          # unit tests (115 tests, 20 suites)
npm run test:cov      # coverage report
```

---

## Project Layout

```
src/
  auth/               PKCE SSO flow, token verification, refresh, org grants
  user/               User profile, auth middleware
  org/                Organisation proxy (SSO)
  connect/            WhatsApp Embedded Signup
  waba/               WABA management
  waba-phone-number/  Phone number management
  api-key/            API key CRUD + auth middleware
  messaging/          Send/receive messages
  inbox/              Conversations, threads, replies
  templates/          Message templates
  contacts/           Contact management
  webhooks/           Meta webhook handler
  redis/              Redis service
  prisma/             Prisma service
  common/             Shared interceptors, filters, encryption
prisma/
  schema.prisma
  migrations/
docs/
  development/        Architecture, phases, module docs
  integration/        Frontend integration guide
```
