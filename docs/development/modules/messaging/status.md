# Module: Messaging – Status

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
| M.1 | DB Schema | ✅ Complete | `Message` — `metaMessageId` unique, status timestamps, `failureReason`, `templateName`, `ssoOrgId` |
| M.2 | Message DTOs | ✅ Complete | `SendMessageDto` with a discriminated payload per type; `templateComponents` typed so button/OTP fields survive the validation pipe |
| M.3 | Text Messaging | ✅ Complete | — |
| M.4 | Media Messaging | ✅ Complete | Image, video, audio, document |
| M.5 | Template Messaging | ✅ Complete | Header, body and URL-button variables; the template used is recorded on the message |
| M.6 | Interactive Messaging | ✅ Complete | Reply buttons, list with sections/rows, `cta_url` |
| M.7 | Other Message Types | 🔄 Partial | Location shipped; `reaction` and `contacts` are not exposed |
| M.8 | Message Status | ✅ Complete | `delivered`/`read`/`failed` timestamps written by the webhook status handler |
| M.9 | Message Listing | ✅ Complete | Org-scoped; `page`/`limit` turn on pagination; narrowed to one account when an API key is used |
| M.10 | Read Receipts | 🔄 Partial | `read` status on our own outbound messages is recorded by the webhook handler; marking an inbound message read at Meta is not exposed |

---

## Endpoint Status

| Method | Endpoint | Auth | Status |
|--------|----------|------|--------|
| POST | `/messages` | JWT **or** API Key, subscription required | ✅ Built |
| GET | `/messages` | JWT **or** API Key, subscription required | ✅ Built |
| GET | `/messages/analytics` | JWT **or** API Key, subscription required | ✅ Built |
| GET | `/messages/:id` | JWT **or** API Key, subscription required | ✅ Built — returns the sent payload |

`MessagingAuthMiddleware` picks the API-key path when `x-access-key` /
`x-secret-key` are present and the JWT path otherwise; both populate `req.user`
and `req.orgId` identically. `SubscriptionMiddleware` runs second because it
reads the `authType` the first one sets.

---

## Business Rules

| Rule | Where |
|------|-------|
| A contact who has opted out is refused with a `400`, not silently dropped | `MessagingService.send` |
| Sending requires a paid subscription for that organisation's use of that account | `SubscriptionMiddleware`, `requireAccess()` |
| An API key may only send from a number belonging to its own WABA | `ApiKeyAuthMiddleware` → `403` |
| Meta's error is returned to the caller rather than crashing the request | `MessagingService` |

---

## Test Coverage

| Component | Test File | Tests |
|-----------|-----------|-------|
| `MessagingService` | `messaging.service.spec.ts` | 19 |
| `MessagingController` | `messaging.controller.spec.ts` | 6 |
| `SendMessageDto` | `dto/send-message.dto.spec.ts` | 2 |

Statement coverage for the module: 83.0%.

---

## Pending / Not in Scope

| Item | Notes |
|------|-------|
| `reaction` and `contacts` message types | Payload builder does not cover them |
| Marking inbound messages read at Meta | No endpoint |
| Rate-limit handling for Meta's own limits | Errors are surfaced, not retried or queued |
| Outbound queue | Sends are synchronous; a slow Meta call is a slow request |
