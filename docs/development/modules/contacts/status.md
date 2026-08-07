# Module: Contacts – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ✅ Implemented |
| Completion | 100% of the shipped scope — bulk import, tags and number validation were never built |
| Blocking Issues | None |
| Last Updated | 2026-08-07 |

---

## Wave Status

| Wave | Name | Status | Notes |
|------|------|--------|-------|
| C.1 | DB Schema | ✅ Complete | `Contact` — `ssoOrgId + phone` unique, `optedOut` / `optedOutAt`, free-form `metadata` |
| C.2 | Contact DTOs | ✅ Complete | Create, update and list DTOs with Swagger annotations |
| C.3 | Contact CRUD | ✅ Complete | Create, get, update, delete — all org-scoped |
| C.4 | Contact Listing | ✅ Complete | `page`/`limit` pagination |
| C.5 | Opt-Out Management | ✅ Complete | `optedOut` set through `PATCH /contacts/:id`; enforced at send time |
| C.6 | Number Validation | ❌ Not built | No validation endpoint; numbers are taken as given |
| C.7 | Bulk Import | ❌ Not built | — |
| C.8 | Tag Management | ❌ Not built | `metadata` carries arbitrary fields instead |

---

## Endpoint Status

| Method | Endpoint | Auth | Status |
|--------|----------|------|--------|
| POST | `/contacts` | JWT | ✅ Built |
| GET | `/contacts` | JWT | ✅ Built — paginated |
| GET | `/contacts/:id` | JWT | ✅ Built |
| PATCH | `/contacts/:id` | JWT | ✅ Built — name, email, opt-out, metadata |
| DELETE | `/contacts/:id` | JWT | ✅ Built |

Contacts are console-only: an API key buys sending on one account, not the
organisation's address book.

---

## Business Rules

| Rule | Where |
|------|-------|
| One contact per phone number per organisation | `ssoOrgId + phone` unique index |
| An opted-out contact is refused at send time | `MessagingService.send` → `ContactsService.isOptedOut` |
| Every read and write is scoped to the caller's organisation | `ContactsService` |

---

## Test Coverage

| Component | Test File | Tests |
|-----------|-----------|-------|
| `ContactsService` | `contacts.service.spec.ts` | 13 |
| `ContactsController` | `contacts.controller.spec.ts` | 7 |

Statement coverage for the module: 96.1%.

---

## Issues & Risks

| Issue | Severity | Notes |
|-------|----------|-------|
| No bulk import | Medium | Contacts are added one at a time or by the sending integration |
| No deduplication beyond the unique index | Low | Two spellings of the same number are two contacts; normalise before create |
| Inbound STOP is not automated | Medium | Opt-out is set through the API or the console, not inferred from an inbound message |
