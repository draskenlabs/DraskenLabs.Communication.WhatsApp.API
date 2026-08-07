# Module: Mail – Definition

## Purpose

Everything the platform sends by email: the transactional notices a person must
receive, the opt-in summaries, the support mailboxes, and the machinery that
keeps a sending domain healthy — unsubscribe, suppression and a log of what was
sent.

Provider is Amazon SES v2. Bounces and complaints arrive back through SNS.

---

## Kinds

`MailKind` decides whether a message may be suppressed by preference:

| Kind | Preference column | Unsubscribable |
|------|-------------------|---------------|
| `transactional` | — | ❌ No — it reports something the account holder did or must know about |
| `emailTemplateStatus` | `emailTemplateStatus` | ✅ Yes |
| `emailDailySummary` | `emailDailySummary` | ✅ Yes |
| `emailWeeklySummary` | `emailWeeklySummary` | ✅ Yes |
| `emailProductNews` | `emailProductNews` | ✅ Yes |

---

## Data

| Model | Purpose |
|-------|---------|
| `MailSuppression` | Addresses that permanently bounced or complained. Checked before every send |
| `MailLog` | One row per send: user, address, kind, subject, status, provider message id, error |

---

## Services

| Service | Responsibility |
|---------|---------------|
| `SesService` | The SES v2 client. Reports itself disabled when unconfigured, so a deployment without credentials still boots |
| `MailService` | Recipient resolution, preference and suppression checks, the shared HTML layout, send, log, suppress, unsubscribe |
| `MailNotifications` | One method per message the product sends — account deleted, API key created/revoked, WABA connected/disconnected/deleted, Meta token rejected, WABA banned, template decision, phone quality change, display-name decision, subscription charged / payment failed / cancelled, support acknowledgement and the support request itself |
| `MailScheduler` | Cron jobs: daily summary at 08:00, weekly summary Mondays at 08:00, stalled-onboarding nudge at 09:00 |

---

## Endpoints

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/mail/support` | None | Support, privacy, security, abuse or legal mailbox. Public by design — someone locked out still has to reach us |
| POST | `/mail/unsubscribe` | Unsubscribe token | Turn off one kind of email, or all of them |
| POST | `/mail/events` | SNS envelope | SES bounce and complaint feedback |
| POST | `/mail/broadcast` | `x-mail-admin-token` | Operator broadcast for policy, sub-processor and breach notices. Disabled unless the token is configured |

---

## Business Rules

| Rule | Why |
|------|-----|
| A suppressed address is never mailed again | An unrecorded permanent bounce is what wrecks a domain's reputation |
| Only permanent bounces suppress | A full mailbox resolves itself |
| `/mail/events` always answers `200` | SNS retries anything else, and a malformed event is not something a retry fixes |
| SNS subscription confirmations are logged, never auto-confirmed | Otherwise anyone could subscribe us to their topic |
| Failed sends are reported once a day, not as they happen | A bad campaign fails hundreds in a row; per-failure alerts were a stream of interruptions nobody could act on one message at a time |
| A user with no preference row still gets the daily summary | It carries the failure report, and the schema's default is on |
| Every message names the organisation it is about | Somebody in three of them cannot act on "your subscription renewed" |
