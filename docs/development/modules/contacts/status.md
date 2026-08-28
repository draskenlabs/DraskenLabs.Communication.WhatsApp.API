# Module: Contacts – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ❌ Not Started |
| Completion | 0% |
| Blocking Issues | None |
| Last Updated | 2026-05-01 |

---

## Wave Status

| Wave | Name | Status | Notes |
|------|------|--------|-------|
| C.1 | DB Schema | ❌ Not Started | `Contact` model not in schema |
| C.2 | Contact DTOs | ❌ Not Started | — |
| C.3 | Contact CRUD | ❌ Not Started | — |
| C.4 | Contact Listing | ❌ Not Started | — |
| C.5 | Opt-Out Management | ❌ Not Started | — |
| C.6 | Number Validation | ❌ Not Started | — |
| C.7 | Bulk Import | ❌ Not Started | — |
| C.8 | Tag Management | ❌ Not Started | — |

---

## Endpoint Status

| Method | Endpoint | Auth | Status |
|--------|----------|------|--------|
| POST | `/contacts` | JWT / API Key | ❌ Not built |
| GET | `/contacts` | JWT / API Key | ❌ Not built |
| GET | `/contacts/:id` | JWT / API Key | ❌ Not built |
| PUT | `/contacts/:id` | JWT / API Key | ❌ Not built |
| DELETE | `/contacts/:id` | JWT | ❌ Not built |
| POST | `/contacts/import` | JWT | ❌ Not built |
| POST | `/contacts/:id/opt-out` | JWT / API Key | ❌ Not built |
| DELETE | `/contacts/:id/opt-out` | JWT | ❌ Not built |
| GET | `/contacts/:id/validate` | JWT | ❌ Not built |

---

## Test Coverage

| Component | Test File | Status |
|-----------|-----------|--------|
| `ContactsService` | — | ❌ Not started |
| `ContactsController` | — | ❌ Not started |

---

## Prerequisites

| Prerequisite | Status | Notes |
|-------------|--------|-------|
| `Contact` DB schema | ❌ Not started | Required before any development |
| Webhooks module (for opt-out automation) | ❌ Not started | Can be built in parallel |
| Messaging module (opt-out guard) | ❌ Not started | Contacts integrates as a dependency |

---

## 2026-08-28 — a limit on how many

`maxContacts` caps an organisation's contacts at 1,000 / 10,000 / 50,000 by
tier. `ContactsService.assertRoomFor(ssoOrgId, adding)` is batch-aware, so an
import of 500 into an organisation with 900 of a 1,000 limit is refused as a
whole rather than half-applied.

Contacts are the organisation's own data, so this is a cap on storage rather
than a paywall: reads and exports are never gated.

---

## Issues & Risks

| Issue | Severity | Notes |
|-------|----------|-------|
| No opt-out tracking means potential policy violations | High | WhatsApp requires honoring STOP requests |
| No contact deduplication logic planned | Medium | Define merge strategy before bulk import |
| Number validation calls Meta API per contact | Low | Consider batch validation endpoint |
