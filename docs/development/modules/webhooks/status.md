# Module: Webhooks – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ✅ Built |
| Completion | 100% (inbound), 100% (outbound) |
| Blocking Issues | None |
| Last Updated | 2026-08-16 |

---

## Wave Status

| Wave | Name | Status | Notes |
|------|------|--------|-------|
| W.1 | DB Schema | ✅ Done | `WebhookEvent`, `InboundMessage` |
| W.2 | Webhook Verification | ✅ Done | `GET /webhooks` challenge |
| W.3 | Signature Validation | ✅ Done | `WebhookSignatureMiddleware`, HMAC over the raw body |
| W.4 | Event Ingestion | ✅ Done | Stored, then routed; 200 returned immediately |
| W.5 | Message Event Handler | ✅ Done | `InboundMessageHandler` |
| W.6 | Status Update Handler | ✅ Done | `StatusUpdateHandler` |
| W.7 | Template Event Handler | ✅ Done | `TemplateStatusHandler` |
| W.8 | Account Event Handler | ✅ Done | `AccountHandler` |
| W.9 | Read Receipt Trigger | ✅ Done | — |
| W.10 | Console read endpoints | ✅ Done | `GET /webhooks/config`, `GET /webhooks/events` |
| W.11 | Outbound endpoints (CRUD) | ✅ Done | `WebhookEndpointsService`, org-scoped, SSRF-guarded |
| W.12 | Outbound delivery + retry | ✅ Done | `WebhookDispatcherService` outbox + `@Cron` sweep |
| W.13 | Test ping + redelivery | ✅ Done | Synchronous test, never retried; manual requeue |

---

## Endpoint Status

| Method | Endpoint | Auth | Status |
|--------|----------|------|--------|
| GET | `/webhooks` | None (Meta) | ✅ Built |
| POST | `/webhooks` | None (HMAC) | ✅ Built |
| GET | `/webhooks/config` | JWT | ✅ Built |
| GET | `/webhooks/events` | JWT | ✅ Built |
| POST | `/webhooks/endpoints` | JWT | ✅ Built |
| GET | `/webhooks/endpoints` | JWT | ✅ Built |
| PATCH | `/webhooks/endpoints/:id` | JWT | ✅ Built |
| DELETE | `/webhooks/endpoints/:id` | JWT | ✅ Built |
| POST | `/webhooks/endpoints/:id/test` | JWT | ✅ Built |
| GET | `/webhooks/endpoints/:id/deliveries` | JWT | ✅ Built |
| POST | `/webhooks/deliveries/:id/redeliver` | JWT | ✅ Built |

---

## Test Coverage

| Component | Test File | Status |
|-----------|-----------|--------|
| `WebhooksService` | `webhooks.service.spec.ts` | ✅ Covered |
| `WebhooksController` | `webhooks.controller.spec.ts` | ✅ Covered |
| Signature validation middleware | `webhook-signature.middleware.spec.ts` | ✅ Covered |
| Event handlers | `handlers/*.spec.ts` | ✅ Covered |
| `WebhookEndpointsService` | `webhook-endpoints.service.spec.ts` | ✅ Covered |
| `WebhookDispatcherService` | `webhook-dispatcher.service.spec.ts` | ✅ Covered |
| Callback URL guard | `webhook-url.util.spec.ts` | ✅ Covered |
| `RetentionService` | `retention.service.spec.ts` | ✅ Covered |
| Delivery end to end | `test/integration/webhook-delivery.int-spec.ts` | ✅ Covered — real HTTP receiver: fan-out by kind, the envelope and its headers, HMAC over the raw bytes, the retry schedule, giving up, auto-disable, redirects refused, two sweeps racing, the test ping |
| Retention against Postgres | `test/integration/retention.int-spec.ts` | ✅ Covered — the raw-SQL sweep actually deletes |

The integration suite needs a database and is not part of `npm test`; see
[`test/integration/README.md`](../../../../test/integration/README.md).

---

## Configuration

| Variable | Required | Notes |
|----------|----------|-------|
| `WEBHOOK_VERIFY_TOKEN` | Yes | Meta's `GET /webhooks` challenge |
| `META_APP_SECRET` | Yes | Verifies `X-Hub-Signature-256` on inbound |
| `WEBHOOK_DELIVERY_TIMEOUT_MS` | No (10000) | How long to wait on a customer endpoint |
| `WEBHOOK_ALLOW_INSECURE_URLS` | No (false) | Local development only — permits http/loopback endpoints |

---

## Pending / not in scope

| Item | Notes |
|------|-------|
| Real-time WebSocket push to the console | The console polls on load and on action |
| Delivery-payload replay from another environment | Redelivery re-posts the stored envelope; there is no way to point it at a different URL for a staging test |
| Per-endpoint rate limiting | A busy account fans out one POST per event per endpoint |
| Delivery-payload viewer in the console | The log shows the response, not the request body |
