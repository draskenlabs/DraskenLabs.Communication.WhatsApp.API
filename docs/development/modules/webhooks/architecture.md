# Webhooks Module — Architecture & Payload Reference

**Source:** Meta WhatsApp Cloud API documentation (v21.0)

---

## Table of Contents

| # | Section |
|---|---------|
| 1 | [Overview](#1-overview) |
| 2 | [Verification Flow (GET /webhooks)](#2-verification-flow-get-webhooks) |
| 3 | [Signature Validation](#3-signature-validation) |
| 4 | [Payload Envelope Structure](#4-payload-envelope-structure) |
| 5 | [Notification Types](#5-notification-types) |
| 6 | [Inbound Message Payloads](#6-inbound-message-payloads) |
| 7 | [Status Update Payloads](#7-status-update-payloads) |
| 8 | [Other Notification Types](#8-other-notification-types) |
| 9 | [Processing Architecture](#9-processing-architecture) |
| 10 | [Database Models](#10-database-models) |
| 11 | [Environment Variables](#11-environment-variables) |
| 12 | [Files to Create](#12-files-to-create) |

---

## 1. Overview

The Webhooks module receives real-time events from Meta. It has two endpoints:

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| `GET` | `/webhooks` | None | Meta verification challenge |
| `POST` | `/webhooks` | HMAC-SHA256 | All lifecycle events |

**Design rule:** `POST /webhooks` must always respond `200 OK` immediately. All processing (DB writes, business logic) happens asynchronously via `setImmediate()` after the response is sent. Meta retries if it receives anything other than `200` or if the response times out (~5 seconds).

---

## 2. Verification Flow (GET /webhooks)

When a webhook subscription is created or updated in the Meta App Dashboard, Meta sends a one-time `GET` request to verify our endpoint.

```
Meta                                        Our Server
  │                                              │
  │  GET /webhooks                               │
  │  ?hub.mode=subscribe                         │
  │  &hub.verify_token=<configured_token>        │
  │  &hub.challenge=<random_integer>             │
  │ ────────────────────────────────────────────►│
  │                                              │
  │                                              │ 1. Assert hub.mode === 'subscribe'
  │                                              │ 2. Assert hub.verify_token === WEBHOOK_VERIFY_TOKEN
  │                                              │ 3. Respond with hub.challenge as plain text
  │                                              │
  │  200 OK                                      │
  │  Content-Type: text/plain                    │
  │  Body: <hub.challenge integer>               │
  │ ◄────────────────────────────────────────────│
```

| Query Param | Expected Value | Failure |
|-------------|---------------|---------|
| `hub.mode` | `"subscribe"` | `403 Forbidden` |
| `hub.verify_token` | Must match `WEBHOOK_VERIFY_TOKEN` env var | `403 Forbidden` |
| `hub.challenge` | Any integer | Echo it back as-is |

---

## 3. Signature Validation

Every `POST` from Meta includes:

```
X-Hub-Signature-256: sha256=<hex_digest>
```

**Algorithm:**

```
expected = HMAC-SHA256(rawRequestBodyBytes, META_APP_SECRET)
actual   = X-Hub-Signature-256 header value (strip "sha256=" prefix)

if timingSafeEqual(expected, actual) → proceed
else → 401 Unauthorized
```

**Critical implementation detail:** NestJS's built-in JSON body parser parses the body before any middleware runs, destroying the raw bytes needed for HMAC. The `json()` parser must be configured with a `verify` callback in `main.ts` to save the raw buffer before parsing:

```typescript
// main.ts — before app.listen()
import { json } from 'express';

app.use(
  json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf; // Buffer of raw bytes, available in middleware
    },
  }),
);
```

The `WebhookSignatureMiddleware` then reads `req.rawBody` for HMAC computation. Never use the parsed `req.body` string — it may differ from the raw bytes if there is any whitespace or encoding difference.

| Property | Value |
|----------|-------|
| Algorithm | HMAC-SHA256 |
| Key | `META_APP_SECRET` env var |
| Input | `req.rawBody` (Buffer, not string) |
| Comparison | `crypto.timingSafeEqual()` — prevents timing attacks |
| Failure response | `401 Unauthorized` |

---

## 4. Payload Envelope Structure

All `POST` bodies from Meta share the same outer envelope:

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "<WABA_ID>",
      "changes": [
        {
          "field": "messages",
          "value": { ... }
        }
      ]
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `object` | string | Always `"whatsapp_business_account"` for WhatsApp |
| `entry` | array | One entry per WABA in the notification — may have multiple |
| `entry[].id` | string | WABA ID |
| `entry[].changes` | array | One or more change objects |
| `changes[].field` | string | Subscription field that fired — determines `value` structure |
| `changes[].value` | object | The notification payload — differs by `field` |

### Value object for `field: "messages"`

The `value` object when `field = "messages"` contains both inbound messages **and** status updates:

```json
{
  "messaging_product": "whatsapp",
  "metadata": {
    "display_phone_number": "16505551111",
    "phone_number_id": "123456123"
  },
  "contacts": [
    {
      "profile": { "name": "Sender Name" },
      "wa_id": "16315551181"
    }
  ],
  "messages": [ ...inbound messages... ],
  "statuses": [ ...delivery/read receipts... ],
  "errors":   [ ...error objects... ]
}
```

| Field | Present When |
|-------|-------------|
| `metadata` | Always — identifies which of our phone numbers received the event |
| `contacts` | Only with inbound messages — sender profile info |
| `messages` | Inbound message received |
| `statuses` | Delivery or read receipt |
| `errors` | Processing error |

**`metadata.phone_number_id`** is the key field — it identifies which WABA phone number the event belongs to and is used to look up the user/WABA from the phone cache.

---

## 5. Notification Types

| `changes[].field` | When Fired | Handler |
|------------------|-----------|---------|
| `messages` | Inbound message received **or** delivery/read status update | `handleMessagesField()` |
| `message_template_status_update` | Template APPROVED / REJECTED / FLAGGED / DELETED / DISABLED | `handleTemplateStatusUpdate()` |
| `account_update` | WABA account restriction or ban | `handleAccountUpdate()` |
| `phone_number_quality_update` | Phone number quality tier changed | `handlePhoneQualityUpdate()` |
| `phone_number_name_update` | Display name review result | `handlePhoneNameUpdate()` (log only) |

---

## 6. Inbound Message Payloads

All inbound messages share a common wrapper inside `messages[]`:

```json
{
  "from": "16315551181",
  "id": "wamid.HBgNMTYzMTU1NTExODEV...",
  "timestamp": "1669233778",
  "type": "<message_type>",
  ...type-specific fields...
}
```

| Field | Type | Notes |
|-------|------|-------|
| `from` | string | Sender phone number — E.164 format **without** `+` |
| `id` | string | Unique Meta message ID — always starts with `wamid.` |
| `timestamp` | string | Unix timestamp as **string** — convert to `Date` via `new Date(Number(ts) * 1000)` |
| `type` | string | See type list below |

### 6.1 Text

```json
{
  "type": "text",
  "text": {
    "body": "Hello, world!",
    "preview_url": false
  }
}
```

### 6.2 Image

```json
{
  "type": "image",
  "image": {
    "id": "<MEDIA_ID>",
    "mime_type": "image/jpeg",
    "sha256": "<hash>",
    "caption": "optional caption"
  }
}
```

Media must be downloaded separately using `GET /media/{id}` with the WABA access token before it expires (typically 5 minutes after delivery).

### 6.3 Video

```json
{
  "type": "video",
  "video": {
    "id": "<MEDIA_ID>",
    "mime_type": "video/mp4",
    "sha256": "<hash>",
    "caption": "optional caption"
  }
}
```

### 6.4 Audio

```json
{
  "type": "audio",
  "audio": {
    "id": "<MEDIA_ID>",
    "mime_type": "audio/ogg; codecs=opus",
    "sha256": "<hash>",
    "voice": false
  }
}
```

`voice: true` means the audio was recorded in-app as a voice note.

### 6.5 Document

```json
{
  "type": "document",
  "document": {
    "id": "<MEDIA_ID>",
    "mime_type": "application/pdf",
    "sha256": "<hash>",
    "filename": "invoice.pdf",
    "caption": "optional caption"
  }
}
```

### 6.6 Sticker

```json
{
  "type": "sticker",
  "sticker": {
    "id": "<MEDIA_ID>",
    "mime_type": "image/webp",
    "sha256": "<hash>",
    "animated": false
  }
}
```

### 6.7 Location

```json
{
  "type": "location",
  "location": {
    "latitude": 37.45697,
    "longitude": -122.06323,
    "name": "Pablo Morales Library",
    "address": "2380 Montecito Ave, San Jose, CA 95116"
  }
}
```

`name` and `address` are optional — present only when the user shares a named place.

### 6.8 Contacts (vCard)

```json
{
  "type": "contacts",
  "contacts": [
    {
      "name": {
        "formatted_name": "John Smith",
        "first_name": "John",
        "last_name": "Smith"
      },
      "phones": [
        { "phone": "+1 555 555 5555", "type": "CELL", "wa_id": "15555555555" }
      ],
      "emails": [
        { "email": "john@example.com", "type": "WORK" }
      ],
      "addresses": [],
      "urls": []
    }
  ]
}
```

### 6.9 Interactive — Button Reply

Sent when a user taps a quick-reply button in a message sent by the business:

```json
{
  "type": "interactive",
  "interactive": {
    "type": "button_reply",
    "button_reply": {
      "id": "unique-button-id",
      "title": "Yes"
    }
  }
}
```

### 6.10 Interactive — List Reply

Sent when a user selects an item from a list message:

```json
{
  "type": "interactive",
  "interactive": {
    "type": "list_reply",
    "list_reply": {
      "id": "list-item-id",
      "title": "Option 1",
      "description": "Optional description"
    }
  }
}
```

### 6.11 Reaction

```json
{
  "type": "reaction",
  "reaction": {
    "message_id": "wamid.original_message_id",
    "emoji": "👍"
  }
}
```

`emoji` is an empty string when the user removes a reaction.

### 6.12 Order (Product Catalog)

```json
{
  "type": "order",
  "order": {
    "catalog_id": "<catalog_id>",
    "text": "optional order note from customer",
    "product_items": [
      {
        "product_retailer_id": "sku-123",
        "quantity": 2,
        "item_price": 1500,
        "currency": "USD"
      }
    ]
  }
}
```

---

## 7. Status Update Payloads

Status updates appear in `statuses[]` inside the same `field: "messages"` value object. They are **not** separate entries — the same webhook call can contain both `messages[]` and `statuses[]`.

```json
{
  "id": "wamid.HBgNMTYzMTU1NTExODE...",
  "status": "delivered",
  "timestamp": "1669233778",
  "recipient_id": "16315551181",
  "conversation": {
    "id": "<conversation_id>",
    "expiration_timestamp": "1669842000",
    "origin": {
      "type": "business_initiated"
    }
  },
  "pricing": {
    "billable": true,
    "pricing_model": "CBP",
    "category": "business_initiated"
  }
}
```

| `status` | Meaning | Transition |
|----------|---------|-----------|
| `sent` | Accepted by Meta, sent to carrier | Initial state on send |
| `delivered` | Device received the message | `sent → delivered` |
| `read` | User opened the message | `delivered → read` |
| `failed` | Could not deliver | `sent → failed` |

**Note:** Status updates reference outbound messages by `id` = the `wamid.xxx` returned by Meta when the message was sent (stored in `Message.metaMessageId`).

### Failed status — errors object

```json
{
  "id": "wamid.xxx",
  "status": "failed",
  "timestamp": "...",
  "recipient_id": "...",
  "errors": [
    {
      "code": 130472,
      "title": "Message undeliverable",
      "message": "More than 24 hours have passed since the customer last replied.",
      "error_data": {
        "details": "..."
      }
    }
  ]
}
```

Common error codes:

| Code | Meaning |
|------|---------|
| `130472` | Message outside 24-hour window (non-template) |
| `131026` | Recipient phone number not on WhatsApp |
| `131047` | Re-engagement message blocked (quality) |
| `131056` | Pair rate limit hit |

### Conversation origin types

| Type | Description |
|------|-------------|
| `business_initiated` | Business opened conversation outside 24h window (billed) |
| `user_initiated` | Customer sent first message — 24h window open |
| `referral_conversion` | Customer came via Click-to-WhatsApp ad |
| `authentication` | Authentication template used |
| `marketing` | Marketing template used |
| `utility` | Utility template used |
| `service` | Service conversation (billed differently) |

---

## 8. Other Notification Types

### 8.1 Template Status Update

`changes[].field = "message_template_status_update"`

```json
{
  "event": "APPROVED",
  "message_template_id": 123456789,
  "message_template_name": "order_confirmation",
  "message_template_language": "en_US",
  "reason": "NONE"
}
```

| `event` | Meaning | Action |
|---------|---------|--------|
| `APPROVED` | Ready to use | Set `MessageTemplate.status = APPROVED` |
| `REJECTED` | Failed review — `reason` explains why | Set status, store reason |
| `FLAGGED` | Quality warning | Set status |
| `DELETED` | Removed | Set status |
| `DISABLED` | Paused for performance | Set status |
| `IN_APPEAL` | User appealed rejection | Set status |

### 8.2 Account Update

`changes[].field = "account_update"`

```json
{
  "phone_number": "16505551111",
  "event": "ACCOUNT_RESTRICTION"
}
```

| `event` | Meaning |
|---------|---------|
| `ACCOUNT_RESTRICTION` | Restricted from sending messages |
| `ACCOUNT_BANNED` | Permanently banned |

Action: Log the event. No automated DB update in first pass.

### 8.3 Phone Number Quality Update

`changes[].field = "phone_number_quality_update"`

```json
{
  "display_phone_number": "16505551111",
  "event": "FLAGGED",
  "current_limit": "TIER_50K"
}
```

| `event` | Meaning |
|---------|---------|
| `FLAGGED` | Quality dropped — risk of restriction |
| `UNFLAGGED` | Quality restored |

| `current_limit` | Messages/24h |
|----------------|-------------|
| `TIER_1K` | 1,000 |
| `TIER_10K` | 10,000 |
| `TIER_50K` | 50,000 |
| `TIER_250K` | 250,000 |
| `UNLIMITED` | Unlimited |

Action: Update `WabaPhoneNumber.qualityRating`.

---

## 9. Processing Architecture

```
Meta Platform
     │
     │  POST /webhooks
     │  X-Hub-Signature-256: sha256=<hmac>
     │  body: { object, entry: [...] }
     │
     ▼
┌──────────────────────────────────────────────┐
│  WebhookSignatureMiddleware                  │
│                                              │
│  1. Extract X-Hub-Signature-256 header       │
│     Missing → 401                           │
│  2. HMAC-SHA256(req.rawBody, APP_SECRET)     │
│  3. crypto.timingSafeEqual(computed, header) │
│     Mismatch → 401                          │
│     Match → next()                          │
└────────────────────┬─────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────┐
│  WebhooksController                          │
│                                              │
│  POST /webhooks                              │
│  1. setImmediate(() =>                       │
│       webhooksService.processPayload(body))  │
│  2. return  ← 200 OK immediately             │
└────────────────────┬─────────────────────────┘
                     │ (async, after response sent)
                     ▼
┌──────────────────────────────────────────────┐
│  WebhooksService.processPayload(body)        │
│                                              │
│  for each entry in body.entry:              │
│    for each change in entry.changes:        │
│      wabaId = value.waba_info.waba_id       │
│               ?? entry.id                   │
│                                              │
│      1. INSERT WebhookEvent (raw log)        │
│         { eventType: change.field,           │
│           wabaId, payload: change.value,     │
│           processed: false }                 │
│                                              │
│      2. Route by change.field:               │
│         ┌──────────────────────────────────┐ │
│         │ "messages"                       │ │
│         │   value.messages[] → each →     │ │
│         │     handleInboundMessage()       │ │
│         │   value.statuses[] → each →     │ │
│         │     handleStatusUpdate()         │ │
│         └──────────────────────────────────┘ │
│         ┌──────────────────────────────────┐ │
│         │ "message_template_status_update" │ │
│         │   → handleTemplateStatusUpdate() │ │
│         └──────────────────────────────────┘ │
│         ┌──────────────────────────────────┐ │
│         │ "account_update"                 │ │
│         │   → handleAccountUpdate()        │ │
│         └──────────────────────────────────┘ │
│         ┌──────────────────────────────────┐ │
│         │ "phone_number_quality_update"    │ │
│         │   → handlePhoneQualityUpdate()   │ │
│         └──────────────────────────────────┘ │
│                                              │
│      3. UPDATE WebhookEvent SET              │
│            processed = true                  │
│         (or error = <message> on throw)      │
└──────────────────────────────────────────────┘
     │               │                │
     ▼               ▼                ▼
handleInbound   handleStatus    handleTemplate
 Message()       Update()        StatusUpdate()
     │               │                │
     ▼               ▼                ▼
 INSERT          UPDATE           UPDATE
 InboundMessage  Message.status   MessageTemplate
 (idempotent)    by metaMsgId     .status
```

### Idempotency

- **Inbound messages:** `upsert` on `metaMessageId` — safe if Meta delivers the same event twice
- **Status updates:** `updateMany` on `metaMessageId` with status ordering (`delivered` can't overwrite `read`)
- **Template updates:** `updateMany` on `metaTemplateId`

---

## 10. Database Models

### New: `InboundMessage`

```prisma
model InboundMessage {
  id            Int      @id @default(autoincrement())
  metaMessageId String   @unique
  wabaId        String
  phoneNumberId String
  from          String
  senderName    String?
  type          String
  payload       Json
  timestamp     DateTime
  createdAt     DateTime @default(now())

  waba Waba @relation(fields: [wabaId], references: [wabaId])
}
```

| Field | Source in webhook payload |
|-------|--------------------------|
| `metaMessageId` | `message.id` |
| `wabaId` | `entry[].id` |
| `phoneNumberId` | `value.metadata.phone_number_id` |
| `from` | `message.from` |
| `senderName` | `value.contacts[0].profile.name` |
| `type` | `message.type` |
| `payload` | The full type-specific sub-object (e.g. `message.text`, `message.image`) |
| `timestamp` | `new Date(Number(message.timestamp) * 1000)` |

### New: `WebhookEvent`

```prisma
model WebhookEvent {
  id        Int      @id @default(autoincrement())
  eventType String
  wabaId    String
  payload   Json
  processed Boolean  @default(false)
  error     String?
  createdAt DateTime @default(now())
}
```

### Existing model updates (no schema change — data written by handlers)

| Model | Field Updated | Updated By |
|-------|-------------|-----------|
| `Message` | `status` | `handleStatusUpdate()` |
| `WabaPhoneNumber` | `qualityRating` | `handlePhoneQualityUpdate()` |
| `MessageTemplate` | `status`, `rejectedReason` | `handleTemplateStatusUpdate()` (Templates module must exist). The reason is taken from `other_info.description`, then `other_info.title`, then `reason` — Meta puts the sentence in `other_info` and often sends `reason: "NONE"` with a rejection |
| `WabaPhoneNumber` | `nameStatus`, `verifiedName` | `handlePhoneNameUpdate()` — Meta's verdict on a requested display name, recorded rather than only emailed. An approval also promotes `requested_verified_name` to the name in use |

### Which WABA a change is about

`entry.id` is the WABA for the `messages` field, and the service used to trust
it for every field. It is **not** the WABA for `account_update`: there Meta
sends the *business* id in `entry.id` and names the account inside the change,
in `value.waba_info.waba_id`.

Every account event across every tenant was therefore filed under one id
belonging to none of them — so any WABA but the accidental match went
un-updated, its customers' endpoints never received the event, and the stored
`WebhookEvent` rows all pointed at the wrong account. `resolveWabaId()` takes
the id the change names and falls back to `entry.id` for the fields that carry
no `waba_info`.

Rows written before that fix are repaired by migration
`20260908170000_backfill_webhook_event_waba`: the payload was stored verbatim,
so each misfiled row still carries the right id and is moved to the account it
names. Rows that already agree, rows with no `waba_info`, and rows whose payload
is not an object are left untouched, and re-running it updates nothing.

---

## 11. Environment Variables

Add to `.env.example`:

| Variable | Description |
|----------|-------------|
| `WEBHOOK_VERIFY_TOKEN` | Arbitrary secret string — configured in Meta App Dashboard; validated on `GET /webhooks` |
| `META_APP_SECRET` | App secret from Meta App Dashboard (Settings → Basic) — used for HMAC-SHA256 signature validation on `POST /webhooks` |

---

## 12. Files to Create

```
src/webhooks/
  webhooks.module.ts
  webhooks.controller.ts
  webhooks.service.ts
  middleware/
    webhook-signature.middleware.ts
  dto/
    webhook-payload.dto.ts       ← outer envelope: object, entry[], changes[]
    webhook-value.dto.ts         ← value: metadata, messages[], statuses[]
  handlers/
    inbound-message.handler.ts   ← handleInboundMessage() per message type
    status-update.handler.ts     ← handleStatusUpdate() with error handling
    template-status.handler.ts   ← handleTemplateStatusUpdate()
    account.handler.ts           ← handleAccountUpdate() + handlePhoneQualityUpdate()
```

### main.ts patch (rawBody preservation)

```typescript
import { json } from 'express';

// Before app.listen() — must come before NestJS initialisation
app.use(
  json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
```

### Key design decisions

| Decision | Reason |
|----------|--------|
| Return `200` before processing | Meta retries on any non-200 or timeout — never block |
| `setImmediate()` for async | Defers processing to next event loop tick — after response is sent |
| Log every event to `WebhookEvent` | Audit trail; allows reprocessing failed events manually |
| Idempotent handlers | Meta can deliver the same event more than once — upsert/updateMany prevents duplicates |
| Raw body for HMAC | Parsed JSON may differ from raw bytes if encoding varies — always use the buffer |
| `timingSafeEqual` | Prevents timing attacks where comparison short-circuits on first differing byte |
