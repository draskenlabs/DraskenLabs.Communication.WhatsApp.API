# Module: Account Management – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ✅ Complete |
| Completion | 100% |
| Blocking Issues | None |
| Last Updated | 2026-08-07 |

---

## Wave Status

| Wave | Name | Status | Notes |
|------|------|--------|-------|
| AM.1 | OAuth Connect Flow | ✅ Complete | Embedded Signup; the business id is derived from the WABA when Meta omits it |
| AM.2 | WABA Listing | ✅ Complete | `GET /wabas`, scoped through `WabaOrganisation` |
| AM.3 | WABA Detail & Sync | ✅ Complete | Meta failures are explained rather than returned as a bare `500` |
| AM.4 | Phone Number Listing | ✅ Complete | `GET /wabas/:wabaId/phone-numbers` |
| AM.5 | Phone Number Sync | ✅ Complete | Prunes numbers removed on Meta's side; tolerates pending-sync numbers |
| AM.6 | WABA Disconnect | ✅ Complete | `DELETE /wabas/:wabaId/connect` drops the stored token; `DELETE /wabas/:wabaId` removes the account for this organisation |
| AM.7 | Phone Number Registration | ✅ Complete | `POST …/:phoneNumberId/register` — Cloud API registration with a 6-digit PIN |
| AM.8 | Manual Connect (dev) | ✅ Complete | `POST /connect/manual`, gated on `ALLOW_MANUAL_CONNECT` |
| AM.9 | Webhook Subscription | ✅ Complete | The app subscribes to the account's webhook fields on connect |
| AM.10 | Deferred Provisioning | ✅ Complete | Connecting syncs nothing; numbers and templates are pulled when a subscription is first paid |

---

## Endpoint Status

| Method | Endpoint | Auth | Status |
|--------|----------|------|--------|
| POST | `/connect` | JWT | ✅ Live |
| POST | `/connect/manual` | JWT | ✅ Live — dev only, behind `ALLOW_MANUAL_CONNECT` |
| GET | `/wabas` | JWT | ✅ Live |
| GET | `/wabas/:wabaId` | JWT | ✅ Live |
| POST | `/wabas/:wabaId/sync` | JWT | ✅ Live |
| DELETE | `/wabas/:wabaId/connect` | JWT | ✅ Live |
| DELETE | `/wabas/:wabaId` | JWT | ✅ Live |
| GET | `/wabas/:wabaId/phone-numbers` | JWT | ✅ Live |
| POST | `/wabas/:wabaId/phone-numbers/sync` | JWT | ✅ Live |
| POST | `/wabas/:wabaId/phone-numbers/:phoneNumberId/register` | JWT | ✅ Live |

The Meta-facing helper routes this doc once listed (`/connect/businesses`,
`/connect/:businessId/ownedWABAs`, `/connect/:businessId/clientWABAs`,
`/connect/debugToken`) no longer exist — Embedded Signup returns what they were
used for, and they were unauthenticated.

---

## Test Coverage

| Component | Test File | Tests |
|-----------|-----------|-------|
| `ConnectService` | `connect.service.spec.ts` | 8 |
| `ConnectController` | `connect.controller.spec.ts` | 2 |
| `WabaService` | `waba.service.spec.ts` | 25 |
| `WabaController` | `waba.controller.spec.ts` | 11 |
| `WabaMembershipService` | `waba-membership.service.spec.ts` | 7 |
| `WabaPhoneNumberService` | `waba-phone-number.service.spec.ts` | 11 |
| `WabaPhoneNumberController` | `waba-phone-number.controller.spec.ts` | 4 |
| `WabaProvisioningService` | `waba-provisioning.service.spec.ts` | 8 |

---

## Issues & Risks

| Issue | Severity | Resolution |
|-------|----------|-----------|
| No de-register / re-register-PIN flow for a number | Low | Add the inverse Cloud API call when a customer needs it |
| A revoked Meta token surfaces as a sync failure, with no refresh | Medium | The account has to be reconnected; there is no refresh token to use |
| Deleting a disconnected account cannot unsubscribe the app from Meta's webhooks | Low | That call needs a live token; Meta keeps the subscription until the app is removed in Business Manager |
