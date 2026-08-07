# Module: Notifications – Status

| Field | Value |
|-------|-------|
| Status | ✅ Implemented |
| Completion | 100% of the defined scope |
| Blocking Issues | None — Firebase credentials are a deployment concern, and their absence disables push rather than breaking anything |
| Last Updated | 2026-08-07 |

## Implemented

- `DeviceToken`, `Notification` and `NotificationPreference`, added by
  migrations `20260801200000_add_push_notifications`,
  `20260801400000_add_notification_feed` and `20260802120000_daily_summary_email`.
- Firebase Admin push through a shared service that reports itself disabled
  when no credentials are configured, so a deployment without them still boots.
- The feed: `GET /notifications` (paginated, org-scoped),
  `GET /notifications/unread-count`, `POST /notifications/read`.
- Devices: `POST` / `DELETE /notifications/tokens`, plus automatic pruning of
  any token Firebase reports stale on a send.
- Preferences: `GET` / `PATCH /notifications/preferences`, covering the two
  in-app kinds and the four email switches the Mail module reads.
- `POST /notifications/test` — sends to this user's own devices, so a person
  can prove push works from their own browser.
- Producers: the webhook handlers call `notifyWaba` for inbound messages and
  template decisions.
- The feed is written per organisation holding an account while the push fires
  once per person, so an account two organisations hold shows in both bells and
  buzzes one phone once.

## Test Coverage

| Component | Test File | Tests |
|-----------|-----------|-------|
| `NotificationsService` | `notifications.service.spec.ts` | 20 |
| `NotificationsController` | — | ❌ Missing |

Statement coverage for the module: 67.5% — the controller and the Firebase
adapter are the untested part.

## Pending / not in scope

| Item | Notes |
|------|-------|
| Controller tests | The service is covered; the routes are not |
| More notification kinds | Only `inboundMessage` and `templateStatus` exist; quality drops and billing events go by email only |
| Digest or throttling | A busy account pushes once per inbound message |
| Native mobile push | Tokens carry a `platform`, but only `web` is issued today |
