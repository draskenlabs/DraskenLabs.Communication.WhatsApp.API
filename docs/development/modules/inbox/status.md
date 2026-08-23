# Module: Inbox – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ✅ Complete |
| Completion | 100% |
| Blocking Issues | None |
| Last Updated | 2026-08-23 |

---

## Wave Status

| Wave | Name | Status | Notes |
|------|------|--------|-------|
| I.1 | DB schema + backfill migration | ✅ Complete | `Conversation`, two thread indexes, history backfilled and marked read |
| I.2 | Conversation write path | ✅ Complete | Webhook and send path both upsert; best-effort, never fails its caller |
| I.3 | Conversation list | ✅ Complete | Paged, filtered, searched by name or number |
| I.4 | Thread read | ✅ Complete | Both directions merged, cursor-paged backwards |
| I.5 | Read marker | ✅ Complete | Per organisation |
| I.6 | Reply + 24-hour window | ✅ Complete | Refused before the send, not after Meta's 131047 |
| I.7 | Close / reopen / assign | ✅ Complete | A customer reply reopens a closed thread |
| I.8 | Inbound media proxy | ✅ Complete | Addressed by message id; resolved URL cached 5 min |
| I.9 | Tests | ✅ Complete | 87 unit + 17 integration |
| I.10 | Realtime (SSE / WebSocket) | ⏸️ Deferred | No transport in the API; clients poll |

---

## Endpoint Status

| Method | Endpoint | Auth | Status |
|--------|----------|------|--------|
| GET | `/inbox` | JWT / API Key | ✅ Built |
| GET | `/inbox/:id/messages` | JWT / API Key | ✅ Built |
| POST | `/inbox/:id/read` | JWT / API Key | ✅ Built |
| POST | `/inbox/:id/messages` | JWT / API Key | ✅ Built |
| PATCH | `/inbox/:id` | JWT / API Key | ✅ Built |
| GET | `/inbox/media/:messageId` | JWT / API Key | ✅ Built |

---

## Test Coverage

| Suite | Tests | Covers |
|-------|-------|--------|
| `preview.spec.ts` | 13 | Both preview vocabularies, truncation, missing payloads |
| `phone.spec.ts` | 4 | Normalisation — the spellings of one number collapse to one key |
| `conversation-writer.service.spec.ts` | 13 | Fan-out per organisation, unread arithmetic, reopen, swallowed failures |
| `inbox.service.spec.ts` | 33 | Window arithmetic, list filters, thread merge and paging, reply gating, scoping |
| `inbox-media.service.spec.ts` | 11 | Two-step Meta fetch, URL cache, expiry, authorisation |
| `inbox.controller.spec.ts` | 14 | Auth context, filter passing, media headers |
| `inbox.int-spec.ts` | 17 | Real Postgres + Redis + `AppModule`: webhook → conversation → thread → reply |

---

## Changes to existing modules

| File | Change |
|------|--------|
| `webhooks/handlers/inbound-message.handler.ts` | Records the conversation; preview moved to `inbox/preview.ts`; push now deep-links to `/inbox` instead of `/messages` |
| `messaging/messaging.service.ts` | Records the conversation after a send |
| `messaging/messaging.module.ts` | Exports `MessagingService` so the inbox can send through it |
| `redis/redis.service.ts` | `setMediaUrl` / `getMediaUrl` |
| `test/integration/harness.ts` | `Conversation` added to the truncated tables |

One behaviour change outside the module: the inbound push notification's
truncation length moved from 118 to 120 characters, because the push body and
the stored conversation preview are now the same string. One summary, one
length.

---

## Known Limitations

| Limitation | Impact | Mitigation |
|-----------|--------|-----------|
| No realtime push to the client | New replies appear on the next poll | Clients poll `/inbox` every ~10s; FCM push still fires per reply |
| Search does not cover message bodies | Finding "the thread where they mentioned an invoice" is manual | Deferred — needs a text index |
| Unread is per organisation, not per user | Two people reading the same inbox share one badge | Deliberate; see the definition |
| Backfilled threads have no per-message history beyond the plan's window | Old threads start abruptly | `historyDays` returned on the thread so the client can explain it |
