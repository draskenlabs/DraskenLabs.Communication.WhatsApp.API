# Development Phases

Overview of all development phases for the DraskenLabs WhatsApp Communication API.

Phases 6–9 and 11–14 were delivered without their own phase folder; their
detail lives in the per-module docs under [`modules/`](./modules/) and in
[`status.md`](./status.md). Only the phases with a folder are linked below.

**Last verified: 2026-08-07.**

---

## Phase Summary

| # | Phase | Status | Description |
|---|-------|--------|-------------|
| 1 | [Foundation & Infrastructure](./phases/phase-1-foundation/) | ✅ Complete | Project bootstrap, PostgreSQL/Prisma, Redis, AES-256-GCM encryption, shared utilities |
| 2 | [WhatsApp OAuth Connect](./phases/phase-2-connect/) | ✅ Complete | Meta Embedded Signup, token exchange, state management |
| 3 | [User Management & SSO Auth](./phases/phase-3-user/) | ✅ Complete | Drasken SSO PKCE login, slim User model, JWT middleware with Redis cache |
| 4 | [WABA & Phone Numbers](./phases/phase-4-waba/) | ✅ Complete | WABA sync from Meta, phone number management, disconnect, Cloud API register |
| 5 | [API Key Management](./phases/phase-5-api-keys/) | ✅ Complete | API key generation, Redis caching, revocation, auth middleware |
| 6 | Messaging | ✅ Complete | Send text/media/template/location/interactive, message history, opt-out enforcement |
| 7 | Templates & Contacts | ✅ Complete | Template sync, create/edit/delete, Meta Template Library, contact CRUD, opt-out flag |
| 8 | Webhooks | ✅ Complete | Meta verification, HMAC validation, inbound/status/template/quality events, console read endpoints |
| 9 | Organisation Proxy | ✅ Complete | SSO organisation and member management proxied behind the app JWT |
| 10 | [Testing & Documentation](./phases/phase-10-testing-docs/) | 🔄 Ongoing | 53 suites / 518 tests green, 82.65% statements; Swagger (gated on `SWAGGER_ENABLED`); frontend integration guide |
| 11 | Analytics & Search | ✅ Complete | Five analytics endpoints plus CSV export, and one search across every console domain |
| 12 | Notifications & Email | ✅ Complete | FCM push, notification feed and preferences, Amazon SES mail, SNS suppression, daily summary |
| 13 | Billing & Subscriptions | ✅ Complete | Razorpay monthly subscription per organisation per account, Checkout mandates, signed webhook, hourly reconciliation |
| 14 | Multi-organisation Accounts & Provisioning | ✅ Complete | `WabaOrganisation` join, API keys scoped to one account, org-scoped entities, sync deferred until first payment |

Phase 10 is ongoing by design: it tracks the test suite and the docs, both of
which move with every feature phase.

---

## Phase Dependencies

| Phase | Depends On | Reason |
|-------|-----------|--------|
| Phase 2 (Connect) | Phase 1 (Foundation) | Requires Prisma, Redis, encryption |
| Phase 3 (User/SSO) | Phase 1 (Foundation) | Requires Prisma and JWT |
| Phase 4 (WABA) | Phase 2, 3 | Requires OAuth tokens and user context |
| Phase 5 (API Keys) | Phase 3 (User) | Requires authenticated user context |
| Phase 6 (Messaging) | Phase 4, 5 | Requires phone numbers and API key auth |
| Phase 7 (Templates/Contacts) | Phase 3, 4 | Requires JWT auth and WABA context |
| Phase 8 (Webhooks) | Phase 4, 7 | Requires WABA, templates, and inbound message storage |
| Phase 9 (Org Proxy) | Phase 3 (SSO) | Proxies the SSO token held in the session; no local org tables |
| Phase 10 (Testing) | All Phases | Tests all implemented functionality |
| Phase 11 (Analytics/Search) | Phase 6, 7, 8 | Reads messages, templates, contacts and webhook-derived status |
| Phase 12 (Notifications/Email) | Phase 3, 8 | Needs a user to notify and webhook events worth notifying about |
| Phase 13 (Billing) | Phase 5, 6 | The paywall gates API keys and sending |
| Phase 14 (Multi-org) | Phase 9, 13 | An account shared by two organisations only makes sense once each pays for its own use |

---

## Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| SSO PKCE over Clerk | Drasken's own identity platform; reduces vendor dependency |
| No local Organisation/OrgMember tables | Organisation data lives in SSO; `ssoOrgId: String` used for scoping |
| SSO token held server-side in the Redis session | The browser carries only the app JWT; `/organisation` proxies with the cached SSO token |
| API Key auth for messaging | Programmatic/server-to-server access without per-request SSO calls |
| API keys scoped to one WABA | A key is what a subscription is sold against, so it cannot span accounts |
| AES-256-GCM for stored tokens | Meta access tokens are long-lived and sensitive |
| Redis caches for auth, keys and subscription access | Zero DB hit on the hot path for sending messages |
| `WabaOrganisation` join table | Two organisations may connect the same account; `Waba.ssoOrgId` alone could not express that |
| Subscription is one organisation's use of one account | A per-account subscription would have let the second organisation ride on the first one's payment |
| Provisioning deferred to first payment | Connecting an account syncs nothing; numbers and templates are pulled when a subscription is paid |
| Paywall on the operation, not the key | `requireAccess()` gates sending and template sync/create whoever asks, so the console cannot do for free what a key is charged for |
| Swagger behind `SWAGGER_ENABLED` | The schema map is useful in development and not something to publish by default |
| SES bounce/complaint suppression | An unrecorded permanent bounce is what wrecks a sending domain's reputation |
