# Module: Templates – Definition

## Purpose

Manages WhatsApp message templates for WABAs. Provides the ability to create, list, retrieve, and delete message templates via Meta's Graph API, and track their approval status. Templates are required for sending messages outside the 24-hour customer service window and for initiating conversations.

---

## Scope

| Area | Included | Excluded |
|------|----------|----------|
| List templates for a WABA | ✅ Yes | — |
| Create/submit new template | ✅ Yes | — |
| Get template detail | ✅ Yes | — |
| Delete template | ✅ Yes | — |
| Sync template status from Meta | ✅ Yes | — |
| Template approval status tracking | ✅ Yes | — |
| Template localisation (multi-language) | ✅ Yes | — |
| Template analytics (sent/delivered/read counts) | ❌ No | Analytics module |
| Template A/B testing | ❌ No | Future |

---

## Template Categories

| Category | Use Case |
|----------|---------|
| `MARKETING` | Promotions, offers, announcements |
| `UTILITY` | Order updates, account alerts, confirmations |
| `AUTHENTICATION` | OTP and verification codes |

---

## Template Status Lifecycle

| Status | Description |
|--------|-------------|
| `PENDING` | Submitted, awaiting Meta review |
| `APPROVED` | Live and usable for sending |
| `REJECTED` | Rejected by Meta — reason provided |
| `FLAGGED` | Flagged by Meta for a policy concern |
| `DISABLED` | Disabled by Meta due to quality issues |
| `PAUSED` | Temporarily paused by Meta (low quality) |
| `IN_APPEAL` | Under appeal after rejection |
| `PENDING_DELETION` | Deletion requested, awaiting Meta |
| `DELETED` | Deleted by user or Meta (soft-deleted locally) |

---

## Template Component Types

| Component | Description |
|-----------|-------------|
| `HEADER` | Optional — text, image, video, or document |
| `BODY` | Required — text with `{{n}}` variables |
| `FOOTER` | Optional — static text |
| `BUTTONS` | Optional — quick reply, call-to-action, or OTP |

---

## Endpoints

Routes are flat under `/templates`. Authorisation is by JWT/API key with the
org (`orgId`) and user resolved by `AuthMiddleware`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/templates/sync/:wabaId` | JWT | Sync template statuses from Meta |
| POST | `/templates/:wabaId` | JWT | Create/submit a new template |
| GET | `/templates` | JWT / API Key | List templates (filters + optional pagination) |
| GET | `/templates/:id` | JWT / API Key | Get template detail |
| PATCH | `/templates/:id` | JWT | Edit a template (components/category) |
| DELETE | `/templates/:id` | JWT | Delete a template (soft delete, 204) |

---

## Meta API Integration

Graph API version is pinned to `v21.0` (`metaApiVersion` in `templates.service.ts`).

| Operation | Meta Endpoint | Notes |
|-----------|--------------|-------|
| List templates | `GET /{wabaId}/message_templates` | Used by sync |
| Create template | `POST /{wabaId}/message_templates` | Returns template ID |
| Edit template | `POST /{message-template-id}` | Components/category only |
| Delete template | `DELETE /{wabaId}/message_templates?hsm_id=&name=` | By id + name |

Approval status updates arrive asynchronously via the
`message_template_status_update` webhook (`TemplateStatusHandler`).

---

## Data Model

### `MessageTemplate` Table

| Field | Type | Notes |
|-------|------|-------|
| `id` | Int | PK, autoincrement |
| `metaTemplateId` | String | Meta-assigned template ID |
| `wabaId` | String | FK → Waba (`wabaId`) |
| `name` | String | Template name |
| `category` | Enum | `MARKETING`, `UTILITY`, `AUTHENTICATION` |
| `language` | String | BCP-47 language code (e.g., `en_US`) |
| `status` | Enum | Approval status (default `PENDING`) |
| `components` | JSON | Header, body, footer, buttons |
| `rejectedReason` | String? | Populated on rejection |
| `createdAt` | DateTime | — |
| `updatedAt` | DateTime | — |

Unique constraint: `@@unique([wabaId, name, language])`.
