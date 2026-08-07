# Module: Mail – Status

| Field | Value |
|-------|-------|
| Status | ✅ Implemented |
| Completion | 100% of the defined scope |
| Blocking Issues | None — SES credentials are a deployment concern; without them the module reports itself disabled and the app still boots |
| Last Updated | 2026-08-07 |

## Implemented

- `MailSuppression` and `MailLog` (migration `20260801300000_add_email_delivery`),
  plus the summary preferences in `20260802120000_daily_summary_email`.
- `SesService` over `@aws-sdk/client-sesv2`, and a shared HTML `layout()` so
  every message looks like the same product.
- `MailNotifications` — 16 messages covering account, API key, WABA, Meta token,
  template, phone quality, display name, subscription and support events.
- `MailScheduler` — daily summary (08:00), weekly summary (Mondays 08:00) and a
  stalled-onboarding nudge (09:00).
- Failed sends are reported in the daily summary rather than one email per
  failure.
- Public `POST /mail/support`, routing by topic to the support, privacy,
  security, abuse or legal mailbox, with an acknowledgement to the sender.
- `POST /mail/unsubscribe` for one kind or all of them, and
  `POST /mail/events` for SES bounce and complaint feedback via SNS.
- `POST /mail/broadcast` for operator notices, off unless `MAIL_ADMIN_TOKEN`
  is set.

## Test Coverage

| Component | Test File | Tests |
|-----------|-----------|-------|
| `MailService` | `mail.service.spec.ts` | 16 |
| `MailNotifications` | `mail.notifications.spec.ts` | 6 |
| `MailScheduler` | `mail.scheduler.spec.ts` | 6 |
| `MailController` | — | ❌ Missing |
| `SesService` | — | ❌ Missing |

Statement coverage for the module: 59.5% — the lowest of the shipped modules.
The controller (support routing, unsubscribe, SNS parsing, broadcast) and the
SES client are what is uncovered.

## Pending / not in scope

| Item | Notes |
|------|-------|
| Controller and SES tests | The largest single coverage gap in the API |
| Inbound mail | We send and receive feedback events; there is no inbound mailbox handling |
| Per-locale templates | English only |
| Send-rate awareness | No throttling against the SES sending quota; a large broadcast is sent as fast as SES accepts it |
