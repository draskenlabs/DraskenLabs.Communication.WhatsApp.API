# Development Status

Current overall status of the DraskenLabs WhatsApp Communication API.

**Last verified: 2026-08-07** — against `main` at commit `acccb9c`, with the
test suite run (`npx jest`) and every route, model and module read from source.

---

## Project Overview

| Field | Value |
|-------|-------|
| Project Name | DraskenLabs.Communication.WhatsApp.API |
| Version | 0.0.1 |
| Framework | NestJS v11 |
| Database | PostgreSQL (via Prisma v7, `@prisma/adapter-pg`) |
| Cache | Redis (via ioredis v5, single `REDIS_URL`) |
| API Standard | REST + Swagger/OpenAPI (served only when `SWAGGER_ENABLED=true`) |
| Auth | Drasken SSO (PKCE OAuth2) + API Key (`x-access-key` / `x-secret-key`) |
| Billing | Razorpay subscriptions (REST API + signed webhook) |
| Email | Amazon SES v2, with SNS bounce/complaint feedback |
| Push | Firebase Admin (FCM) |
| Scheduling | `@nestjs/schedule` — reconciliation sweep, daily summary mail |
| Multi-tenancy | `ssoOrgId: String` from the SSO token, plus a `WabaOrganisation` join so two organisations can hold the same account. No local org tables |
| Deployment | Docker image published to GHCR; Kubernetes manifests in `k8s/` |

---

## Phase Completion

| Phase | Status | Completion |
|-------|--------|-----------|
| Phase 1 – Foundation & Infrastructure | ✅ Complete | 100% |
| Phase 2 – WhatsApp OAuth Connect | ✅ Complete | 100% |
| Phase 3 – User Management & SSO Auth | ✅ Complete | 100% |
| Phase 4 – WABA & Phone Numbers | ✅ Complete | 100% |
| Phase 5 – API Key Management | ✅ Complete | 100% |
| Phase 6 – Messaging | ✅ Complete | 100% |
| Phase 7 – Templates & Contacts | ✅ Complete | 100% |
| Phase 8 – Webhooks | ✅ Complete | 100% |
| Phase 9 – Organisation Proxy | ✅ Complete | 100% |
| Phase 10 – Testing & Documentation | 🔄 Ongoing | Unit suite complete and green; no E2E suite |
| Phase 11 – Analytics & Search | ✅ Complete | 100% |
| Phase 12 – Notifications & Email | ✅ Complete | 100% |
| Phase 13 – Billing & Subscriptions | ✅ Complete (not exercised against live Razorpay) | 100% |
| Phase 14 – Multi-organisation Accounts & Provisioning | ✅ Complete | 100% |

---

## Module Completion

| Module | Status | Completion | Notes |
|--------|--------|-----------|-------|
| Auth | ✅ Complete | 100% | PKCE SSO code exchange, session → org-scoped JWT, org select/create, JWT middleware (Redis cache-first) |
| User | ✅ Complete | 100% | Profile read from the SSO session; `DELETE /user/account` removes this platform's data only |
| Organisation | ✅ Complete | 100% | SSO proxy — the app JWT carries a `sessionId`, the SSO access token is read from Redis, so the browser never holds it |
| Account Management (Connect) | ✅ Complete | 100% | Embedded Signup + a dev-only manual connect behind `ALLOW_MANUAL_CONNECT`. Connecting no longer syncs — provisioning waits for payment |
| WABA | ✅ Complete | 100% | Sync from Meta, list, get, disconnect, delete. Webhook subscription registered on connect |
| WABA Phone Numbers | ✅ Complete | 100% | Sync (pruning numbers removed at Meta), list by WABA, Cloud API register with PIN |
| API Keys | ✅ Complete | 100% | Create (throttled), list, revoke; scoped to one WABA; Redis-cached for the auth middleware |
| Messaging | ✅ Complete | 100% | Send text/media/template/location/interactive, list (paginated), get, per-org analytics. Opt-out and subscription enforced at send time |
| Templates | ✅ Complete | 100% | Sync, create, edit, delete, migrate between WABAs, Meta Template Library browse/adopt, per-status counts |
| Contacts | ✅ Complete | 100% | CRUD, paginated list, opt-out flag enforced at send time |
| Webhooks | ✅ Complete | 100% | Meta verification + HMAC-signed ingestion (inbound, status, template status, quality/account events) and console read endpoints |
| Analytics | ✅ Complete | 100% | Overview, messages, templates, contacts, phone numbers, CSV export |
| Search | ✅ Complete | 100% | One query across contacts, messages, templates, numbers and WABAs |
| Billing | ✅ Complete | 100% | Razorpay subscription per organisation per WABA, Checkout mandate confirm, cancel, signed webhook, hourly reconciliation. Not yet run against live Razorpay |
| Notifications | ✅ Complete | 100% | FCM device tokens, org-scoped feed, unread count, mark-read, per-kind preferences, test send |
| Mail | ✅ Complete | 100% | SES v2 sender, support mailbox routing, unsubscribe, SNS bounce/complaint suppression, operator broadcast, daily summary scheduler |
| Provisioning | ✅ Complete | 100% | First paid subscription is what pulls phone numbers and templates for an account (`WabaProvisioningService`) |
| Boot check | ✅ Complete | 100% | A spec that compiles the module graph, so a circular dependency fails CI rather than the container |

---

## Implemented API Endpoints

76 routes across 16 controllers.

### Health

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | None | Health check |

### Auth

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/auth/callback` | None | Exchange the SSO code + verifier for a **session** JWT and the user's organisations |
| GET | `/auth/organisations` | Session JWT | List the organisations the signed-in user can enter |
| POST | `/auth/organisations` | Session JWT | Create an organisation and switch into it |
| POST | `/auth/select-org` | Session JWT | Switch organisation — re-issues an org-scoped token |

### User

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/user/profile` | JWT | Profile, read from the cached SSO session |
| DELETE | `/user/account` | JWT | Delete this platform's account and all of its WhatsApp data |
| POST | `/user/test-token` | None | Dev-only token minting (excluded from the auth middleware) |

### Organisation (SSO proxy)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/organisation` | JWT → SSO | List the user's organisations |
| GET | `/organisation/:orgId` | JWT → SSO | Organisation details |
| PATCH | `/organisation/:orgId` | JWT → SSO | Update name or slug (admin) |
| GET | `/organisation/:orgId/members` | JWT → SSO | List members |
| POST | `/organisation/:orgId/members/invite` | JWT → SSO | Invite a member |
| PATCH | `/organisation/:orgId/members/:userId/role` | JWT → SSO | Update a member's role (admin) |
| DELETE | `/organisation/:orgId/members/:userId` | JWT → SSO | Remove a member (admin) |
| GET | `/organisation/:orgId/invitations` | JWT → SSO | List pending invitations |

### Connect

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/connect` | JWT | Complete Meta Embedded Signup and store the encrypted token |
| POST | `/connect/manual` | JWT | Dev-only direct connect, gated on `ALLOW_MANUAL_CONNECT` |

### WABAs & Phone Numbers

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/wabas` | JWT | List WABAs for the current organisation |
| GET | `/wabas/:wabaId` | JWT | WABA details from the Meta Graph API |
| POST | `/wabas/:wabaId/sync` | JWT | Sync WABA details from Meta |
| DELETE | `/wabas/:wabaId/connect` | JWT | Disconnect (drops the stored token) |
| DELETE | `/wabas/:wabaId` | JWT | Delete the account and its data for this organisation |
| GET | `/wabas/:wabaId/phone-numbers` | JWT | List phone numbers |
| POST | `/wabas/:wabaId/phone-numbers/sync` | JWT | Sync from Meta, pruning numbers removed there |
| POST | `/wabas/:wabaId/phone-numbers/:phoneNumberId/register` | JWT | Register a number on the Cloud API with a 6-digit PIN |

### API Keys

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api-keys` | JWT (throttled) | Create a key pair, scoped to one WABA |
| GET | `/api-keys` | JWT | List active keys |
| DELETE | `/api-keys/:id` | JWT | Revoke a key |

### Messaging

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/messages` | JWT **or** API key + subscription | Send text, media, template, location or interactive |
| GET | `/messages` | JWT **or** API key + subscription | List messages for the organisation (paginated) |
| GET | `/messages/analytics` | JWT **or** API key + subscription | Message analytics for the organisation |
| GET | `/messages/:id` | JWT **or** API key + subscription | A single message, including the sent payload |

### Templates

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/templates/sync/:wabaId` | JWT | Sync templates from Meta |
| POST | `/templates/:wabaId` | JWT | Create a template |
| POST | `/templates/migrate/:destinationWabaId` | JWT | Migrate approved templates from another WABA |
| GET | `/templates/library/:wabaId` | JWT | Browse Meta's Template Library |
| POST | `/templates/library/:wabaId` | JWT | Adopt a library template |
| GET | `/templates` | JWT | List templates (status / category filters, paginated) |
| GET | `/templates/status-counts` | JWT | Count templates per status within a category |
| GET | `/templates/:id` | JWT | Get a template |
| PATCH | `/templates/:id` | JWT | Edit a template |
| DELETE | `/templates/:id` | JWT | Delete a template |

### Contacts

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/contacts` | JWT | Create a contact |
| GET | `/contacts` | JWT | List contacts (paginated) |
| GET | `/contacts/:id` | JWT | Get a contact |
| PATCH | `/contacts/:id` | JWT | Update name, email, opt-out or metadata |
| DELETE | `/contacts/:id` | JWT | Delete a contact |

### Webhooks

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/webhooks/config` | JWT | Callback URL and verify-token state for the console |
| GET | `/webhooks/events` | JWT | Delivered event feed (paginated) |
| GET | `/webhooks` | None | Meta verification challenge |
| POST | `/webhooks` | HMAC-SHA256 | Meta event ingestion |

### Analytics & Search

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/analytics/overview` | JWT | Headline metrics, daily series, delivery funnel |
| GET | `/analytics/messages` | JWT | Volume, type mix, failure reasons, send-time heatmap |
| GET | `/analytics/templates` | JWT | Per-template rates and the approval funnel |
| GET | `/analytics/contacts` | JWT | Growth and opt-out rate |
| GET | `/analytics/phone-numbers` | JWT | Per-number volume, failure rate, quality history |
| GET | `/analytics/export` | JWT | Any of the above as CSV |
| GET | `/search` | JWT | Contacts, messages, templates, numbers and WABAs in one query |

### Billing

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/billing/subscriptions` | JWT | Subscription state for every connected account |
| POST | `/billing/subscriptions/:wabaId` | JWT (throttled) | Subscribe one account |
| POST | `/billing/subscriptions/:wabaId/confirm` | JWT | Record a mandate authorised in Razorpay Checkout |
| DELETE | `/billing/subscriptions/:wabaId` | JWT | Cancel one account's subscription |
| POST | `/billing/webhook` | Razorpay HMAC | Subscription and payment events (idempotent on event id) |

### Notifications

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/notifications/tokens` | JWT | Register this device for push |
| DELETE | `/notifications/tokens` | JWT | Forget a device |
| GET | `/notifications` | JWT | The feed for the current organisation |
| GET | `/notifications/unread-count` | JWT | Unread count for the bell badge |
| POST | `/notifications/read` | JWT | Mark notifications as read |
| GET | `/notifications/preferences` | JWT | Which notifications this user receives |
| PATCH | `/notifications/preferences` | JWT | Turn one kind on or off |
| POST | `/notifications/test` | JWT | Send a test notification to this user's devices |

### Mail

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/mail/support` | None | Support, privacy, security, abuse or legal mailbox — public by design |
| POST | `/mail/unsubscribe` | Unsubscribe token | Turn off one kind of email, or all of them |
| POST | `/mail/events` | SNS envelope | SES bounce and complaint feedback → suppression list |
| POST | `/mail/broadcast` | `x-mail-admin-token` | Operator broadcast; disabled unless the token is configured |

---

## Database Models

20 models.

| Model | Status | Notes |
|-------|--------|-------|
| `User` | ✅ Live | `ssoId` unique; cached name/email from SSO |
| `UserWhatsapp` | ✅ Live | Encrypted (AES-256-GCM) Meta access token per user + WABA |
| `Waba` | ✅ Live | `ssoOrgId` for the connecting organisation |
| `WabaOrganisation` | ✅ Live | Join table — one account may be held by several organisations |
| `WabaPhoneNumber` | ✅ Live | Number metadata synced from Meta |
| `UserApiKey` | ✅ Live | `ssoOrgId` + optional `wabaId`; secret AES-256-GCM encrypted |
| `Subscription` | ✅ Live | One per organisation per WABA; Razorpay ids, status, period, cancel-at-cycle-end |
| `SubscriptionPayment` | ✅ Live | Amount, currency, method and instrument per debit |
| `SubscriptionEvent` | ✅ Live | Razorpay webhook audit and idempotency (`eventId` unique) |
| `Message` | ✅ Live | Outbound messages, status timestamps, failure reason, `templateName` |
| `MessageTemplate` | ✅ Live | Synced from Meta; status updated via webhook |
| `Contact` | ✅ Live | `ssoOrgId + phone` unique; opt-out enforced at send time |
| `InboundMessage` | ✅ Live | Idempotent on `metaMessageId` |
| `PhoneQualityEvent` | ✅ Live | Quality rating and limit-tier history per number |
| `WebhookEvent` | ✅ Live | Raw event log with processed/error flags |
| `DeviceToken` | ✅ Live | FCM token per user + device, with last-seen |
| `Notification` | ✅ Live | Org-scoped feed entry, kind, link, `readAt` |
| `NotificationPreference` | ✅ Live | Per-user in-app and email switches, including the daily/weekly summaries |
| `MailSuppression` | ✅ Live | Bounced or complained addresses — never mailed again |
| `MailLog` | ✅ Live | Per-send record: kind, subject, status, provider message id |
| `Organisation` | ❌ Removed | Managed entirely by Drasken SSO — no local table |
| `OrgMember` | ❌ Removed | Managed entirely by Drasken SSO — no local table |

---

## Test Coverage

`npx jest` — **53 suites, 518 tests, all passing** (2026-08-07).

`npx jest --coverage`:

| Metric | Coverage |
|--------|----------|
| Statements | 82.65% (3498/4232) |
| Lines | 83.25% (3177/3816) |
| Functions | 69.85% (445/637) |
| Branches | 59.91% (985/1644) |

| Area | Suites | Tests |
|------|--------|-------|
| Analytics | `analytics.service` | 20 |
| API Keys | `api-key.controller`, `api-key.service`, `api-key-auth.middleware` | 22 |
| Auth & SSO | `auth.controller`, `auth.service`, `sso.service`, `auth.middleware` | 31 |
| Billing | `billing.service`, `razorpay.service`, `subscription-access.service`, `subscription.middleware`, `razorpay-signature.middleware` | 79 |
| Boot | `boot.spec` (module graph compiles) | 1 |
| Common | `crypto.service`, `base-response`, `base-response.interceptor`, `global-exception.filter` | 25 |
| Connect | `connect.controller`, `connect.service` | 10 |
| Contacts | `contacts.controller`, `contacts.service` | 20 |
| Mail | `mail.service`, `mail.notifications`, `mail.scheduler` | 28 |
| Messaging | `messaging.service`, `messaging.controller`, `send-message.dto` | 27 |
| Notifications | `notifications.service` | 20 |
| Organisation | `org-directory.service` | 11 |
| Prisma / Redis | `prisma.service`, `redis.service` | 14 |
| Provisioning | `waba-provisioning.service` | 8 |
| Search | `search.service` | 13 |
| Templates | `templates.service`, `templates.controller`, `create-template.dto` | 45 |
| User | `user.service`, `user.controller`, `user-whatsapp.service` | 29 |
| WABA & Numbers | `waba.service`, `waba.controller`, `waba-membership.service`, `waba-phone-number.service`, `waba-phone-number.controller` | 58 |
| Webhooks | `webhooks.service`, `webhooks.controller`, 4 handlers, signature middleware | 61 |
| App | `app.controller` | 1 |

---

## Critical Gaps

| Gap | Module | Priority |
|-----|--------|----------|
| No E2E suite — `npm run test:e2e` points at `test/jest-e2e.json`, and the `test/` directory does not exist | Testing | 🟡 Medium |
| Billing has never been run against live Razorpay credentials; only the mocked service paths are proven | Billing | 🟡 Medium |
| `docs/development/architecture-gap-analysis.md` and `gap-fill-plan.md` predate the SSO, billing and multi-org work and are not maintained | Documentation | 🟡 Medium |
| Branch coverage is 59.91% — the error and edge paths are the thin part, not the happy paths | Testing | 🟡 Medium |
| API-key secrets are stored reversibly encrypted rather than hashed, because the console reveals them once | API Keys | 🟢 Low |
| No coverage threshold enforced in the Jest config, so coverage can regress silently | Testing | 🟢 Low |
| No load or contract testing | Testing | 🟢 Low |
