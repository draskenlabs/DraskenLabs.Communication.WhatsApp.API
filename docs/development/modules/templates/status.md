# Module: Templates – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ✅ Implemented |
| Completion | 100% |
| Blocking Issues | None |
| Last Updated | 2026-07-23 |

---

## Wave Status

| Wave | Name | Status | Notes |
|------|------|--------|-------|
| T.1 | DB Schema | ✅ Complete | `MessageTemplate` model + `TemplateStatus`/`TemplateCategory` enums |
| T.2 | Template DTOs | ✅ Complete | `CreateTemplateDto`, `UpdateTemplateDto`, `TemplateResponseDto`, `TemplateSyncResponseDto` |
| T.3 | Template Listing | ✅ Complete | `GET /templates` with `wabaId`/`status`/`category` filters + `page`/`limit` pagination |
| T.4 | Template Creation | ✅ Complete | `POST /templates/:wabaId` proxies to Meta, stores PENDING |
| T.5 | Template Detail | ✅ Complete | `GET /templates/:id` |
| T.6 | Template Deletion | ✅ Complete | `DELETE /templates/:id` — Meta delete + soft delete (`status = DELETED`) |
| T.7 | Status Sync | ✅ Complete | `POST /templates/sync/:wabaId` + `message_template_status_update` webhook |
| T.8 | Template Edit | ✅ Complete | `PATCH /templates/:id` proxies an edit to Meta |

---

## Endpoint Status

Routes are flat under `/templates` (not nested under `/wabas`).

| Method | Endpoint | Auth | Status |
|--------|----------|------|--------|
| POST | `/templates/sync/:wabaId` | JWT | ✅ Built |
| POST | `/templates/:wabaId` | JWT | ✅ Built |
| GET | `/templates` | JWT / API Key | ✅ Built |
| GET | `/templates/:id` | JWT / API Key | ✅ Built |
| PATCH | `/templates/:id` | JWT | ✅ Built |
| DELETE | `/templates/:id` | JWT | ✅ Built (soft delete, 204) |

### `GET /templates` query params

| Param | Type | Notes |
|-------|------|-------|
| `wabaId` | string | Scope to one WABA (ownership verified against the org) |
| `status` | `TemplateStatus` | Optional filter; invalid values are ignored |
| `category` | `TemplateCategory` | Optional filter; invalid values are ignored |
| `page` | number | 1-based; presence enables pagination (adds `meta`) |
| `limit` | number | 1–100; presence enables pagination |

Without `page`/`limit` the full list is returned (no `meta`) — backward compatible.

---

## Test Coverage

| Component | Test File | Status |
|-----------|-----------|--------|
| `TemplatesService` | `templates.service.spec.ts` | ✅ sync / findAll (filters, pagination, ownership) / findOne / update / delete |
| `TemplatesController` | `templates.controller.spec.ts` | ✅ all handlers |
| `TemplateStatusHandler` | `webhooks/handlers/template-status.handler.spec.ts` | ✅ APPROVED / REJECTED / PAUSED / PENDING_DELETION / unknown |

---

## Notes & Risks

| Item | Severity | Notes |
|------|----------|-------|
| Delete is a soft delete | Info | Record kept for audit; Meta also emits a delete webhook |
| Template approval takes 24–48 hours | Medium | Approval status arrives asynchronously via webhook |
| Meta Graph API version pinned to `v21.0` | Low | Defined as `metaApiVersion` in `templates.service.ts` |
| `PAUSED` / `PENDING_DELETION` statuses | Info | Added to the enum + webhook map (migration `20260723000000_add_template_paused_pending_deletion`) |
