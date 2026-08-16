# Module: Webhooks – Definition

## Purpose

Handles inbound events from Meta's WhatsApp Business API webhooks. Processes incoming messages from users, message delivery status updates (sent, delivered, read, failed), and account-level notifications (WABA quality updates, template status changes). Acts as the real-time event pipeline that keeps the platform in sync with Meta's state.

It also runs the other direction: customers register their own HTTPS endpoints, and every event for their account is forwarded to them as JSON, signed when they supply a secret, retried with backoff until it is accepted.

---

## Scope

| Area | Included | Excluded |
|------|----------|----------|
| Webhook verification (GET challenge) | ✅ Yes | — |
| Incoming message events | ✅ Yes | — |
| Message status update events (delivered, read, failed) | ✅ Yes | — |
| Template status change events | ✅ Yes | — |
| WABA quality rating change events | ✅ Yes | — |
| Phone number quality events | ✅ Yes | — |
| Webhook signature verification (HMAC-SHA256) | ✅ Yes | — |
| Webhook event forwarding (to client systems) | ✅ Yes | — |
| Outbound delivery queuing / retry with backoff | ✅ Yes | — |
| Optional HMAC signing of outbound deliveries | ✅ Yes | — |
| Test ping + manual redelivery | ✅ Yes | — |
| Real-time WebSocket push to frontend | ❌ No | Future |
| Per-endpoint delivery rate limiting | ❌ No | Future |

---

## Event Types

| Event Category | Event Type | Description |
|---------------|-----------|-------------|
| Messages | `messages` | New inbound message from a WhatsApp user |
| Messages | `statuses` | Delivery/read status update for an outbound message |
| Account | `message_template_status_update` | Template approved, rejected, or disabled |
| Account | `account_update` | WABA quality rating or restriction changes |
| Account | `phone_number_quality_update` | Phone number quality tier change |
| Account | `phone_number_name_update` | Verified name change |

---

## Inbound Message Types Handled

| Type | Description |
|------|-------------|
| `text` | Plain text from user |
| `image` | Image attachment |
| `video` | Video attachment |
| `audio` | Audio/voice note |
| `document` | Document attachment |
| `location` | Location coordinates |
| `contacts` | Contact card(s) |
| `interactive` | Button reply or list reply |
| `reaction` | Emoji reaction |
| `sticker` | Sticker message |
| `order` | WhatsApp catalog order |
| `referral` | Click-to-WhatsApp referral data |

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/webhooks` | None (Meta) | Webhook verification challenge |
| POST | `/webhooks` | None (HMAC) | Receive Meta webhook events |
| GET | `/webhooks/config` | JWT | Callback URL, signature header, subscribed fields |
| GET | `/webhooks/events` | JWT | Stored Meta events for a WABA the org owns (paginated) |
| POST | `/webhooks/endpoints` | JWT | Register an outbound endpoint. `secret` and `events` optional |
| GET | `/webhooks/endpoints` | JWT | List the organisation's endpoints, optionally by WABA |
| PATCH | `/webhooks/endpoints/:id` | JWT | URL, label, events, enabled state; `secret: ""` removes signing |
| DELETE | `/webhooks/endpoints/:id` | JWT | Delete, cascading the delivery log |
| POST | `/webhooks/endpoints/:id/test` | JWT | Post a synthetic `endpoint.test` event and return the answer |
| GET | `/webhooks/endpoints/:id/deliveries` | JWT | Delivery log for one endpoint (paginated) |
| POST | `/webhooks/deliveries/:id/redeliver` | JWT | Queue the stored payload again, unchanged |

---

## Outbound delivery

| Concern | Decision |
|---------|----------|
| Queueing | An outbox (`WebhookDelivery`), written by `processPayload` and posted by a `@Cron(EVERY_MINUTE)` sweep. Meta's POST is answered in milliseconds and cannot wait on a customer's server |
| Envelope | `{ id, event, wabaId, occurredAt, data }` — `data` carries the named fields (`kind`, `title`, `detail`, `status`, `recipient`, `messageId`, `reason`) plus `metaField` and the raw Meta `value` |
| Idempotency | `id` is the delivery row id and is identical on every retry, and is repeated in `X-Drasken-Delivery-Id` |
| Signing | Optional. With a secret: `X-Drasken-Signature-256: sha256=<HMAC-SHA256 of `{timestamp}.{body}`>`, timestamp in `X-Drasken-Timestamp`. Without: posted unsigned, no header |
| Retries | 1, 5, 15, 60, 180 minutes, then `abandoned`. Claimed with a compare-and-set lease so two replicas cannot post the same row |
| Auto-disable | 10 consecutive give-ups switches the endpoint off and emails its owner. Re-enabling clears the count |
| SSRF | HTTPS only, no credentials in the URL, no private/loopback/link-local literals, and redirects are never followed (`webhook-url.util.ts`). `WEBHOOK_ALLOW_INSECURE_URLS=true` relaxes this for local development only |
| Secret at rest | AES-256-GCM via `EncryptionService`, never returned by any endpoint — a row exposes only `hasSecret` |

---

## Security

| Mechanism | Details |
|-----------|---------|
| Verification token | `GET /webhooks?hub.verify_token=...` matches `WEBHOOK_VERIFY_TOKEN` env var |
| Payload signature | `X-Hub-Signature-256` header verified with `META_APP_SECRET` via HMAC-SHA256 |
| HTTPS required | Meta only sends to HTTPS endpoints |

---

## Data Model

### `WebhookEvent` Table

| Field | Type | Notes |
|-------|------|-------|
| `id` | Int | PK, autoincrement |
| `eventType` | String | `messages`, `statuses`, etc. |
| `payload` | JSON | Full raw event payload |
| `processed` | Boolean | Processing status |
| `phoneNumberId` | String | Receiving phone number |
| `createdAt` | DateTime | — |

### `WebhookEndpoint` Table

| Field | Type | Notes |
|-------|------|-------|
| `id` | Int | PK, autoincrement |
| `userId` | Int | Creator — the address the auto-disable email goes to |
| `ssoOrgId` | String | Owning organisation; every read is scoped by it |
| `wabaId` | String | The account whose events this endpoint receives |
| `url` | String | HTTPS callback, normalised at write |
| `label` | String? | For the reader |
| `secret` | String? | Encrypted signing secret. Null = deliveries are unsigned |
| `events` | String[] | Subscribed kinds. Empty = every kind |
| `status` | Boolean | Enabled |
| `failureCount` | Int | Consecutive give-ups; reset by any success |
| `disabledAt` | DateTime? | Set when *we* switched it off |
| `lastSuccessAt` | DateTime? | — |

### `WebhookDelivery` Table

| Field | Type | Notes |
|-------|------|-------|
| `id` | Int | PK — also the idempotency key sent to the receiver |
| `endpointId` | Int | FK, cascade delete |
| `eventId` | Int? | FK to `WebhookEvent`, null for a test ping, `SET NULL` on prune |
| `eventType` | String | Event kind, or `endpoint.test` |
| `payload` | JSON | Exactly what was posted, so a redelivery sends the same bytes |
| `status` | String | `pending` \| `sent` \| `failed` (retrying) \| `abandoned` |
| `attempts` | Int | — |
| `retryAt` | DateTime? | When the sweep may try again; also the claim lease |
| `responseCode` | Int? | What the endpoint answered |
| `error` | String? | Transport error, or the first 500 chars of a failing body |
| `durationMs` | Int? | Round trip |

### `InboundMessage` Table

| Field | Type | Notes |
|-------|------|-------|
| `id` | Int | PK, autoincrement |
| `metaMessageId` | String | Meta message ID (unique) |
| `from` | String | Sender's WhatsApp number |
| `phoneNumberId` | String | Receiving phone number |
| `type` | String | Message type |
| `payload` | JSON | Type-specific message content |
| `timestamp` | DateTime | Meta-provided timestamp |
| `createdAt` | DateTime | — |
