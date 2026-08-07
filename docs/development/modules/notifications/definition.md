# Module: Notifications – Definition

## Purpose

Tell a user that something happened on their account while they were not
looking at the console: a customer replied, or Meta decided on a template. The
same event reaches them two ways — a browser push to every device they have
registered, and a feed entry that survives the push being missed.

Email is a separate concern and lives in the [Mail](../mail/) module; this
module only owns the in-app feed, the devices and the preference switches
(including the email ones, because one screen has to own them).

---

## Data

| Model | Purpose |
|-------|---------|
| `DeviceToken` | One FCM token per browser, with `platform`, `userAgent` and `lastSeenAt`. Unique on `token`, so re-registering the same browser updates rather than duplicates |
| `Notification` | One feed entry: `kind`, `title`, `body`, optional `link`, `readAt`, and the `ssoOrgId` it belongs to |
| `NotificationPreference` | One row per user — `inboundMessage`, `templateStatus`, `emailTemplateStatus`, `emailDailySummary`, `emailWeeklySummary`, `emailProductNews` |

`NotificationKind` is `'inboundMessage' | 'templateStatus'`. Defaults: both
in-app kinds on, `emailTemplateStatus` and `emailDailySummary` on, weekly
summary and product news off — nothing marketing-shaped until it is asked for.

---

## Service Methods

| Method | Purpose |
|--------|---------|
| `registerToken` | Register or refresh this browser's FCM token |
| `removeToken` | Forget a device — on sign-out, or when FCM reports the token dead |
| `getPreferences` / `updatePreferences` | Read and write the switches, falling back to the defaults for a user with no row |
| `sendToUser` | Push + record for one user |
| `notifyWaba` | Everyone in the organisations holding an account — how an inbound message reaches its owners |
| `notifyUsers` | An explicit list of users |
| `list` / `unreadCount` / `markRead` | The feed behind the bell and the full page |

The preference governs the interruption, not the record: the feed entry is
always written, and the push is skipped for a user who turned that kind off.
Recipients of an account's activity are the users who connected it, and a feed
entry is written once per organisation holding it — so the second organisation
does not stare at an empty bell for its own messages.

---

## Endpoints

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/notifications/tokens` | JWT | Register this device for push |
| DELETE | `/notifications/tokens` | JWT | Forget a device |
| GET | `/notifications` | JWT | Feed for the current organisation |
| GET | `/notifications/unread-count` | JWT | Bell badge count |
| POST | `/notifications/read` | JWT | Mark entries read |
| GET | `/notifications/preferences` | JWT | Which notifications this user receives |
| PATCH | `/notifications/preferences` | JWT | Turn one kind on or off |
| POST | `/notifications/test` | JWT | Send a test notification to this user's devices |

---

## Business Rules

| Rule | Why |
|------|-----|
| The feed is scoped to the organisation in the token, plus entries belonging to none | A user in three organisations should not see all three feeds at once, but an account-level notice must not vanish with the selection |
| A push failure never fails the caller's request | A webhook must still be acknowledged inside Meta's 20s |
| A token FCM rejects is deleted | A dead device otherwise costs a failed send on every notification |
| Notifications are best-effort; the feed is the record | Push depends on the browser, permission and the device being reachable |
