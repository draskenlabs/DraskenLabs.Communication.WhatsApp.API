# Phase 10 – Testing & Documentation: Plan

Waves 10.1–10.5 and 10.10–10.11 were planned before the later feature phases
existed. Waves 10.6–10.9 were added as those phases landed, so the plan covers
what the suite actually has to cover. See
[`status.md`](./status.md) for what is done.

## Waves

| Wave | Name | Description | Deliverables |
|------|------|-------------|-------------|
| 10.1 | Foundation Tests | Unit tests for Prisma, Redis, EncryptionService, base response, interceptor, exception filter | 6 spec files |
| 10.2 | Auth & User Tests | Unit tests for AuthMiddleware, SsoService, AuthService/Controller, UserService/Controller, UserWhatsappService | 7 spec files |
| 10.3 | Connect Tests | Unit tests for ConnectService and ConnectController | 2 spec files |
| 10.4 | WABA Tests | Unit tests for WabaService/Controller, WabaMembershipService, WabaPhoneNumberService/Controller | 5 spec files |
| 10.5 | API Key Tests | Unit tests for ApiKeyService, ApiKeyController and ApiKeyAuthMiddleware | 3 spec files |
| 10.6 | Messaging, Templates, Contacts, Webhooks | Unit tests for the four domain modules, the webhook handlers and both signature/auth middlewares | 13 spec files |
| 10.7 | Analytics & Search | Unit tests for the analytics aggregations and the cross-domain search | 2 spec files |
| 10.8 | Billing, Notifications, Mail, Provisioning | Unit tests for Razorpay, subscription access and middleware, the notification feed, SES mail and the provisioning sweep | 11 spec files |
| 10.9 | Boot Check | A spec that compiles the module graph so a circular dependency fails CI | 1 spec file |
| 10.10 | E2E Tests | Full HTTP flow tests for the main endpoint groups | E2E spec suite |
| 10.11 | Documentation | Swagger annotations review, module and phase docs, developer docs | Complete docs |

---

## Wave Detail

### Wave 10.1 – Foundation Tests

| Test File | What to Test |
|-----------|-------------|
| `prisma.service.spec.ts` | Connection lifecycle, `onModuleInit`, `onModuleDestroy` |
| `redis.service.spec.ts` | `get`, `set`, `del`, `expire` — mock ioredis |
| `crypto.service.spec.ts` | `encrypt` → `decrypt` round-trip, invalid ciphertext rejection |
| `base-response*.spec.ts`, `global-exception.filter.spec.ts` | Envelope shape for data, arrays and errors |

### Wave 10.2 – Auth & User Tests

| Test File | What to Test |
|-----------|-------------|
| `auth.middleware.spec.ts` | Valid JWT, expired JWT, missing header, unknown session |
| `sso.service.spec.ts` | PKCE code exchange, profile and organisation reads, SSO error mapping |
| `auth.service.spec.ts` / `auth.controller.spec.ts` | Callback, organisation list/create, org switch and token re-issue |
| `user.service.spec.ts` / `user.controller.spec.ts` | Profile from the cached SSO session, account deletion |
| `user-whatsapp.service.spec.ts` | Upsert, token encryption on write, decryption on read |

### Wave 10.3 – Connect Tests

| Test File | What to Test |
|-----------|-------------|
| `connect.service.spec.ts` | Token exchange, Redis state CRUD, Meta API mocks, derived business id, pending-sync numbers |
| `connect.controller.spec.ts` | Route binding, response format, manual-connect gate |

### Wave 10.4 – WABA Tests

| Test File | What to Test |
|-----------|-------------|
| `waba.service.spec.ts` | List, fetch from Meta (mocked axios), upsert, disconnect, delete |
| `waba.controller.spec.ts` | Route binding, response shapes |
| `waba-membership.service.spec.ts` | Two organisations holding the same account |
| `waba-phone-number.service.spec.ts` / `.controller.spec.ts` | List, sync with pruning, Cloud API register |

### Wave 10.5 – API Key Tests

| Test File | What to Test |
|-----------|-------------|
| `api-key.service.spec.ts` | Key generation, encryption, Redis cache write, listing |
| `api-key.controller.spec.ts` | Route binding, creation response includes the secret once |
| `api-key-auth.middleware.spec.ts` | Cache hit and miss, revoked key, WABA scope |

### Wave 10.6 – Messaging, Templates, Contacts, Webhooks

| Test File | What to Test |
|-----------|-------------|
| `messaging.service.spec.ts` / `.controller.spec.ts` / `send-message.dto.spec.ts` | Every payload type, Meta error passthrough, opt-out refusal, pagination |
| `templates.service.spec.ts` / `.controller.spec.ts` / `create-template.dto.spec.ts` | Sync, create, edit, delete, migrate, library, status counts, OTP field survival |
| `contacts.service.spec.ts` / `.controller.spec.ts` | CRUD, org scoping, opt-out |
| `webhooks.*` + 4 handler specs + signature middleware | Verification challenge, HMAC rejection, inbound/status/template/account handling |

### Wave 10.7 – Analytics & Search

| Test File | What to Test |
|-----------|-------------|
| `analytics.service.spec.ts` | Each aggregation, the delivery funnel, CSV export |
| `search.service.spec.ts` | Per-type grouping, counts, org scoping |

### Wave 10.8 – Billing, Notifications, Mail, Provisioning

| Test File | What to Test |
|-----------|-------------|
| `billing.service.spec.ts`, `razorpay.service.spec.ts` | Register, confirm, cancel, webhook idempotency, reconciliation |
| `subscription-access.service.spec.ts`, `subscription.middleware.spec.ts` | Access per organisation per account, cached and uncached, `402` refusal |
| `razorpay-signature.middleware.spec.ts` | Signature accept and reject |
| `notifications.service.spec.ts` | Feed, unread count, mark-read, preference gating, device token lifecycle |
| `mail.service.spec.ts`, `mail.notifications.spec.ts`, `mail.scheduler.spec.ts` | Suppression, unsubscribe, per-kind templates, the daily summary |
| `waba-provisioning.service.spec.ts` | First paid subscription pulls numbers and templates; repeat payments do not |

### Wave 10.9 – Boot Check

| Test File | What to Test |
|-----------|-------------|
| `boot.spec.ts` | The whole module graph compiles — a circular dependency fails here, not at container start |

### Wave 10.10 – E2E Tests

Not started. `npm run test:e2e` points at `test/jest-e2e.json`, and the `test/`
directory does not exist — the config has to be created with the first flow.

| Test Scenario | Endpoint Group |
|---------------|---------------|
| Root info endpoint | `GET /` |
| User profile flow | `GET /user/profile` with valid/invalid token |
| OAuth connect flow | `POST /connect` end-to-end |
| WABA list and sync | `GET /wabas`, `POST /wabas/:id/sync` |
| Phone number sync | `POST /wabas/:id/phone-numbers/sync` |
| API key create and list | `POST /api-keys`, `GET /api-keys` |
| Subscribe then send | `POST /billing/subscriptions/:wabaId` → `POST /messages` |

### Wave 10.11 – Documentation

| Task | Notes |
|------|-------|
| Audit all `@ApiProperty()` decorators | Ensure all DTO fields documented |
| Add response example annotations | Use `@ApiResponse` with `example` |
| Keep the module and phase docs current | Every feature phase updates `status.md` and its module doc |
| Write `README.md` | Setup, run, test, env vars |
