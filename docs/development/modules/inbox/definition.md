# Module: Inbox – Definition

## Purpose

Turns the replies that were already being stored into conversations that can be
read and answered. Before this module, inbound messages were persisted by the
messages webhook and never surfaced by any endpoint: the only reader was the
analytics count and the account-deletion sweep.

The inbox adds three things the messaging module cannot provide on its own:

1. **A thread.** A conversation is one customer, on one number, for one
   organisation — sent and received messages interleaved in time order across
   two tables.
2. **State per thread.** Unread counts, a read marker, open/closed and an
   assignee. None of this is derivable from the messages themselves.
3. **The 24-hour window, before the send.** Meta refuses a free-form message
   more than 24 hours after the customer's last one. That refusal used to be
   learned afterwards, as error 131047 on a message already recorded as failed.

---

## Scope

| Area | Included | Excluded |
|------|----------|----------|
| List conversations, newest activity first | ✅ Yes | — |
| Read a thread, both directions, paginated | ✅ Yes | — |
| Unread counts and a read marker, per organisation | ✅ Yes | — |
| Reply in a thread | ✅ Yes | Sends via `MessagingService` |
| 24-hour customer service window, enforced before the send | ✅ Yes | — |
| Close / reopen / assign a thread | ✅ Yes | — |
| Fetch inbound media back from Meta | ✅ Yes | — |
| Search by customer name or number | ✅ Yes | Message bodies — needs a text index |
| Real-time delivery (WebSocket / SSE) | ❌ No | Clients poll; see *Deferred* |
| Per-user unread (rather than per-organisation) | ❌ No | See *Decisions* |

---

## Data model

### `Conversation` (new)

One row per **organisation** per number per customer.

| Column | Why |
|--------|-----|
| `ssoOrgId`, `phoneNumberId`, `contactPhone` | The thread's identity. Unique together. |
| `wabaId` | Denormalised, so the WABA filter and an API key's scope need no join through `WabaPhoneNumber`. |
| `contactName` | WhatsApp profile name from the last reply. |
| `lastMessageAt`, `lastDirection`, `lastPreview` | The list row, written once per message instead of derived per read. |
| `lastInboundAt` | What the 24-hour window is measured from — **not** `lastMessageAt`, because our own sends must not extend it. |
| `unreadCount`, `lastReadAt` | The badge, and what it is counted from. |
| `status`, `assigneeUserId` | How a team marks a thread up. |

Keyed per organisation rather than per WABA because an account can be connected
by several organisations (`WabaOrganisation`), and each has its own unread
count, its own assignment and its own idea of whether a thread is dealt with —
the same reason the notification feed writes a row per organisation.

`contactPhone` is stored as **digits only**. Meta reports `from` bare, callers
send `to` however their records hold it, and comparing those as strings would
open a thread per spelling.

### Indexes added

| Index | For |
|-------|-----|
| `InboundMessage(phoneNumberId, from, timestamp)` | The inbound half of a thread. |
| `Message(ssoOrgId, phoneNumberId, to, createdAt)` | The outbound half. |

### Not added: `ssoOrgId` on `InboundMessage`

A WABA can be held by more than one organisation, so a single `ssoOrgId` column
on a received message would be wrong for exactly the accounts where it matters.
The thread query matches on `(phoneNumberId, from)` instead, and authorisation
comes from the `Conversation` row, which is already scoped.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/inbox` | JWT / API Key | List conversations. `page`, `limit`, `status`, `unread`, `search`, `phoneNumberId`, `wabaId`. |
| GET | `/inbox/:id/messages` | JWT / API Key | One thread, oldest first. `before` (cursor), `limit`. |
| POST | `/inbox/:id/read` | JWT / API Key | Clear the unread count for the calling organisation. |
| POST | `/inbox/:id/messages` | JWT / API Key | Reply. Recipient and number come from the thread. |
| PATCH | `/inbox/:id` | JWT / API Key | `status`, `assigneeUserId`. |
| GET | `/inbox/media/:messageId` | JWT / API Key | Stream a received message's media. Returns bytes, not JSON. |

An API key scoped to one WABA sees only that account's conversations, the same
way it sees only that account's messages.

---

## Business rules

### The 24-hour window

`window: { open, expiresAt }` is computed server-side from `lastInboundAt` and
returned on every conversation. `POST /inbox/:id/messages` refuses anything but
`type: template` when it is closed, with a message that distinguishes a lapsed
window from a customer who has never written (who cannot be sent a free-form
message at all).

Computed on the server because the browser's clock is not reliably right, and
being wrong means either a refused send or a disabled box on an open thread.

### Replying reuses the send path

`InboxService.reply` calls `MessagingService.sendMessage`. Membership, the API
key's WABA scope, the subscription and the recipient's opt-out are all checked
there and nowhere else. The inbox adds the window and nothing more.

Replying is **sending**, so it is gated by the subscription like any other send.
Reading the inbox is not.

### Answering does not mark a thread read

`recordOutbound` leaves `unreadCount` and `lastInboundAt` alone. Someone else on
the team may still need to see the customer's messages, and a reply certainly
does not extend a window measured from the customer's own last word.

### A reply reopens a closed thread

Closing means "dealt with". The customer writing again is evidence that it is
not.

### Media

Inbound payloads carry a Meta **media id**, not a URL. Resolving it needs the
account's access token and the resolved URL expires, so the browser cannot fetch
it — `GET /inbox/media/:messageId` does it server-side and streams the bytes
back.

Addressed by **inbound message id**, not by media id: an id on its own says
nothing about which account it arrived on, so nothing could check who may see
it. Resolved URLs are cached in Redis for five minutes, well inside Meta's own
expiry.

Meta drops media after 30 days, which is inside the history some plans keep — an
old thread with an unfetchable photo is expected, and says so.

### History is bounded by the plan

`RetentionService` deletes messages past the plan's `historyDays`. The thread
response carries `historyDays` so a thread that starts abruptly can say why
instead of looking broken.

---

## Write path

`ConversationWriterService` lives in this module but is exported by its own
`ConversationWriterModule`, imported by:

- `WebhooksModule` → `InboundMessageHandler`, after the reply is stored
- `MessagingModule` → `MessagingService`, after the send is recorded

Kept separate because `InboxModule` imports `MessagingModule` (to send), so a
writer inside the inbox module proper would make that a cycle.

Both methods are **best-effort and never throw**. A conversation row is a
derived summary of messages that are already stored; failing to write it must
not fail a reply that was received or a send that has already reached Meta.

---

## Migration

`20260823120000_inbox_conversations` creates the table, the enums and the two
indexes, then backfills conversations from the existing `Message` and
`InboundMessage` rows so the inbox opens with the history that already exists.

Backfilled threads are marked **read**. The alternative is every existing
customer opening the inbox to a badge counting years of replies nobody was ever
shown.

---

## Decisions

**Per-organisation, not per-user.** Everyone in an organisation sees every
conversation and shares one unread count. Per-user unread needs a join table and
roughly doubles the write path; a shared inbox is the right default for a
business WhatsApp product.

**Beside `/messages`, not replacing it.** They answer different questions —
"what did we send, and did it land" versus "who is talking to us". Messages
stays the outbound audit log with delivery analytics.

---

## Deferred

| Item | Why not now |
|------|-------------|
| WebSocket / SSE | No realtime transport exists in the API at all. Clients poll; this is honest and ships. |
| Search over message bodies | Needs a Postgres text index over a JSON column — its own piece of work. |
| Per-user read state | See *Decisions*. |
