# Module: Webhooks – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ✅ Implemented |
| Completion | 100% of the defined scope |
| Blocking Issues | None |
| Last Updated | 2026-08-07 |

---

## Wave Status

| Wave | Name | Status | Notes |
|------|------|--------|-------|
| W.1 | DB Schema | ✅ Complete | `WebhookEvent` (raw log, `processed` / `error`), `InboundMessage` (unique on `metaMessageId`), `PhoneQualityEvent` |
| W.2 | Webhook Verification | ✅ Complete | `GET /webhooks` answers Meta's challenge against `WEBHOOK_VERIFY_TOKEN` |
| W.3 | Signature Validation | ✅ Complete | `WebhookSignatureMiddleware` — HMAC-SHA256 over the raw body |
| W.4 | Event Ingestion | ✅ Complete | Every event is logged first, then handled, then marked `processed`; a handler failure leaves the error on the row |
| W.5 | Message Event Handler | ✅ Complete | `inbound-message.handler` — idempotent on `metaMessageId`, records sender name and payload |
| W.6 | Status Update Handler | ✅ Complete | `status-update.handler` — writes `delivered`/`read`/`failed` and the failure reason onto the matching `Message` |
| W.7 | Template Event Handler | ✅ Complete | `template-status.handler` — approval, rejection and `PAUSED`; Meta's `"NONE"` rejected-reason sentinel is not stored |
| W.8 | Account Event Handler | ✅ Complete | `account.handler` — quality rating and messaging-limit changes, keyed by `wabaId` as well as the number |
| W.9 | Console Read Endpoints | ✅ Complete | `GET /webhooks/config` and `GET /webhooks/events` (paginated) behind the JWT |
| W.10 | Webhook Subscription | ✅ Complete | Connecting an account subscribes this app to its webhook fields, so statuses arrive without manual setup in Business Manager |

---

## Endpoint Status

| Method | Endpoint | Auth | Status |
|--------|----------|------|--------|
| GET | `/webhooks` | None (Meta challenge) | ✅ Built |
| POST | `/webhooks` | HMAC-SHA256 | ✅ Built |
| GET | `/webhooks/config` | JWT | ✅ Built |
| GET | `/webhooks/events` | JWT | ✅ Built |

---

## Business Rules

| Rule | Where |
|------|-------|
| An unsigned or wrongly signed POST is rejected before any handler runs | `WebhookSignatureMiddleware` |
| The same Meta message delivered twice creates one `InboundMessage` | `metaMessageId` unique |
| A handler that throws marks the event with its error rather than losing it | `WebhooksService` |
| Quality events are keyed by account as well as number — a display number is not unique across WABAs | `account.handler` |

---

## Test Coverage

| Component | Test File | Tests |
|-----------|-----------|-------|
| `WebhooksService` | `webhooks.service.spec.ts` | 11 |
| `WebhooksController` | `webhooks.controller.spec.ts` | 4 |
| Signature middleware | `webhook-signature.middleware.spec.ts` | 5 |
| Inbound handler | `inbound-message.handler.spec.ts` | 8 |
| Status handler | `status-update.handler.spec.ts` | 9 |
| Template handler | `template-status.handler.spec.ts` | 11 |
| Account handler | `account.handler.spec.ts` | 8 |

Statement coverage for the module: 90.3%.

---

## Issues & Risks

| Issue | Severity | Notes |
|-------|----------|-------|
| Events are handled inline, inside the request | Medium | Meta times out at 20s; a heavy handler would need a queue |
| Inbound STOP does not set a contact's opt-out | Medium | Opt-out is a deliberate write today, not inferred from message text |
| No replay tool for events left with an error | Low | The raw payload is kept, so a replay is possible but manual |
| The callback URL is derived from the request host | Low | No override for deployments behind an unusual proxy |
