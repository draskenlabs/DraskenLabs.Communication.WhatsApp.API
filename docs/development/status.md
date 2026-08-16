# Development Status

Current overall status of the DraskenLabs WhatsApp Communication API.

---

## Project Overview

| Field | Value |
|-------|-------|
| Project Name | DraskenLabs.Communication.WhatsApp.API |
| Version | 0.0.1 |
| Framework | NestJS v11 |
| Database | PostgreSQL (via Prisma v7) |
| Cache | Redis (via ioredis v5) |
| API Standard | REST + Swagger/OpenAPI |
| Auth | Drasken SSO (PKCE OAuth2) + API Key |
| Multi-tenancy | `ssoOrgId: String` — org ID sourced from SSO token, no local org tables |

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
| Phase 10 – Testing & Documentation | 🔄 In Progress | 60% |

---

## Module Completion

| Module | Status | Completion | Notes |
|--------|--------|-----------|-------|
| Auth | ✅ Complete | 100% | PKCE SSO login, JWT middleware (cache-first), API key auth middleware |
| Organisation | ✅ Complete | 100% | SSO proxy — list orgs, member invite/role/remove via SSO Bearer token |
| Account Management (Connect) | ✅ Complete | 100% | WhatsApp Embedded Signup, phone cache on connect. Disconnect invalidates cache. |
| WABA | ✅ Complete | 100% | Sync from Meta, list, get, disconnect |
| WABA Phone Numbers | ✅ Complete | 100% | Sync from Meta, list by WABA |
| API Keys | ✅ Complete | 100% | Create, list, revoke; Redis-cached for auth middleware |
| Messaging | ✅ Complete | 100% | Send (text/media/template), list, get. Opt-out enforced at send time. |
| Templates | ✅ Complete | 100% | Sync from Meta, list, get. Status updated by webhook handler. |
| Contacts | ✅ Complete | 100% | CRUD, opt-out flag enforced at send time |
| Webhooks | ✅ Complete | 100% | GET verification + POST HMAC-signed processing. Inbound, status, quality, account events. |
| Analytics | ✅ Complete | 100% | Overview, messages, templates, contacts, phone numbers, CSV export |
| Search | ✅ Complete | 100% | One query across contacts, messages, templates, numbers and WABAs |

---

## Implemented API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | None | Health check |
| GET | `/auth/authorize` | None | Get SSO PKCE redirect URL + state |
| POST | `/auth/callback` | None | Exchange SSO code for internal JWT |
| GET | `/user/profile` | JWT | Get authenticated user profile |
| GET | `/organisation` | SSO Token | List user's organisations |
| GET | `/organisation/:orgId` | SSO Token | Get organisation details |
| PATCH | `/organisation/:orgId` | SSO Token | Update organisation (admin) |
| GET | `/organisation/:orgId/members` | SSO Token | List organisation members |
| POST | `/organisation/:orgId/members/invite` | SSO Token | Invite a member |
| PATCH | `/organisation/:orgId/members/:userId/role` | SSO Token | Update member role |
| DELETE | `/organisation/:orgId/members/:userId` | SSO Token | Remove a member |
| GET | `/organisation/:orgId/invitations` | SSO Token | List pending invitations |
| POST | `/connect` | JWT | Initiate WhatsApp Embedded Signup |
| GET | `/wabas` | JWT | List WABAs for current org |
| GET | `/wabas/:wabaId` | JWT | Get WABA details from Meta |
| POST | `/wabas/:wabaId/sync` | JWT | Sync WABA details from Meta to DB |
| DELETE | `/wabas/:wabaId/connect` | JWT | Disconnect a WABA |
| GET | `/wabas/:wabaId/phone-numbers` | JWT | List phone numbers for a WABA |
| POST | `/wabas/:wabaId/phone-numbers/sync` | JWT | Sync phone numbers from Meta |
| POST | `/api-keys` | JWT | Create API key pair |
| GET | `/api-keys` | JWT | List active API keys |
| DELETE | `/api-keys/:id` | JWT | Revoke an API key |
| POST | `/messages` | API Key | Send a WhatsApp message |
| GET | `/messages` | API Key | List sent messages for org |
| GET | `/messages/:id` | API Key | Get a single message |
| POST | `/templates/sync/:wabaId` | JWT | Sync templates from Meta |
| GET | `/templates` | JWT | List templates for org |
| GET | `/templates/:id` | JWT | Get a template |
| POST | `/contacts` | JWT | Create a contact |
| GET | `/contacts` | JWT | List contacts for org |
| GET | `/contacts/:id` | JWT | Get a contact |
| PATCH | `/contacts/:id` | JWT | Update a contact |
| DELETE | `/contacts/:id` | JWT | Delete a contact |
| GET | `/webhooks` | None | Meta webhook verification challenge |
| POST | `/webhooks` | HMAC-SHA256 | Meta webhook event ingestion |
| GET | `/analytics/overview` | JWT | Headline stats, daily series, delivery funnel |
| GET | `/analytics/messages` | JWT | Volume, type mix, failure reasons, send-time heatmap |
| GET | `/analytics/templates` | JWT | Per-template rates and the approval funnel |
| GET | `/analytics/contacts` | JWT | Growth and opt-out rate |
| GET | `/analytics/phone-numbers` | JWT | Per-number volume, failure rate, quality history |
| GET | `/analytics/export` | JWT | Any of the above as CSV |
| GET | `/search` | JWT | Contacts, messages, templates, numbers and WABAs in one query |
| GET | `/plans` | None | The published price list — plans, prices and limits |
| GET | `/plans/:code` | None | One plan by code |

---

## Database Models

| Model | Status | Notes |
|-------|--------|-------|
| `User` | ✅ Live | `{ id, ssoId, createdAt }` — slim; profile data lives in SSO |
| `UserWhatsapp` | ✅ Live | Encrypted Meta access token per user+WABA |
| `Waba` | ✅ Live | `ssoOrgId String` for multi-tenancy (no local org FK) |
| `WabaPhoneNumber` | ✅ Live | Phone number metadata synced from Meta |
| `UserApiKey` | ✅ Live | `ssoOrgId String`; secret AES-256-GCM encrypted |
| `Message` | ✅ Live | Outbound messages with status tracking |
| `MessageTemplate` | ✅ Live | Synced from Meta; status updated via webhook |
| `Contact` | ✅ Live | `ssoOrgId + phone` unique; opt-out enforced at send time |
| `InboundMessage` | ✅ Live | Inbound messages; idempotent on `metaMessageId` |
| `WebhookEvent` | ✅ Live | Raw event log with processed/error flags |
| `WebhookEndpoint` | ✅ Live | Customer-registered delivery endpoints, per WABA; optional encrypted signing secret |
| `WebhookDelivery` | ✅ Live | The outbound outbox — payload, attempts, retry time, response |
| `Plan` | ✅ Live | The published price list; limits as columns, `razorpayPlanId` never leaves the API |
| `PlanFeature` | ✅ Live | One row per bullet on a plan card, ordered |
| `Organisation` | ❌ Removed | Managed entirely by Drasken SSO — no local table |
| `OrgMember` | ❌ Removed | Managed entirely by Drasken SSO — no local table |

---

## Test Coverage

| Suite | Tests | Status |
|-------|-------|--------|
| AuthMiddleware | 4 | ✅ |
| AuthService | — | ❌ Missing |
| SsoService | 7 | ✅ |
| UserService | — | ❌ Missing |
| ApiKeyService | 4 | ✅ |
| ApiKeyController | — | ❌ Missing |
| ApiKeyAuthMiddleware | — | ❌ Missing |
| WabaController | 8 | ✅ |
| WabaService | — | ❌ Missing |
| MessagingService | 6 | ✅ |
| MessagingController | — | ❌ Missing |
| ContactsService | — | ❌ Missing |
| ContactsController | — | ❌ Missing |
| TemplatesService | — | ❌ Missing |
| WebhooksService | — | ❌ Missing |
| OrgService | — | ❌ Missing |
| **Total** | **115 across 20 suites** | 🔄 In Progress |

---

## Critical Gaps

| Gap | Module | Priority |
|-----|--------|----------|
| Missing service-layer tests | Auth, WABA, Messaging, Contacts, Templates | 🟡 Medium |
| Analytics module | Analytics | 🟢 Low |
