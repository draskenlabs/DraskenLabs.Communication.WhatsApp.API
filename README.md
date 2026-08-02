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
| `JWT_SECRET` | Secret for signing internal JWTs |
| `META_APP_ID` | Meta app ID |
| `META_APP_SECRET` | Meta app secret |
| `META_REDIRECT_URI` | OAuth redirect URI registered in Meta |
| `WEBHOOK_VERIFY_TOKEN` | Token for Meta webhook verification |
| `SSO_CLIENT_ID` | Drasken SSO client ID |
| `SSO_API_URL` | Drasken SSO API base URL |
| `SSO_ACCOUNTS_URL` | Drasken SSO accounts UI base URL |

---

## Authentication

Two strategies are supported:

### JWT (user-facing)

Issued by `POST /auth/callback` after a PKCE SSO login. Pass as:
```
Authorization: Bearer <jwt>
```

### API Key (programmatic)

Created via `POST /api-keys`. Pass both headers:
```
x-access-key: ak_...
x-secret-key: sk_...
```

### SSO Token (organisation endpoints only)

`/organisation/*` endpoints are a proxy to the Drasken SSO API. Pass the **SSO access token** received during login:
```
Authorization: Bearer <sso_access_token>
```

---

## API Modules

| Tag | Base Path | Auth | Description |
|-----|-----------|------|-------------|
| Auth | `/auth` | — | PKCE login flow, JWT issuance |
| User | `/user` | JWT | User profile |
| Organisations | `/organisation` | SSO Token | SSO org & member management (proxy) |
| Connect | `/connect` | JWT | WhatsApp Embedded Signup |
| WABAs | `/wabas` | JWT | WABA management and sync |
| WABA Phone Numbers | `/wabas/:id/phone-numbers` | JWT | Phone number sync |
| API Keys | `/api-keys` | JWT | Programmatic key management |
| Messaging | `/messages` | API Key | Send and retrieve messages |
| Templates | `/templates` | JWT | Message template sync from Meta |
| Contacts | `/contacts` | JWT | Contact and opt-out management |
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
  auth/               PKCE SSO flow, JWT issuance
  user/               User profile, auth middleware
  org/                Organisation proxy (SSO)
  connect/            WhatsApp Embedded Signup
  waba/               WABA management
  waba-phone-number/  Phone number management
  api-key/            API key CRUD + auth middleware
  messaging/          Send/receive messages
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
