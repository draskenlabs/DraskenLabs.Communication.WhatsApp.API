# Module: Messaging – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ❌ Not Started |
| Completion | 0% |
| Blocking Issues | Auth module API key strategy must be complete first |
| Last Updated | 2026-05-01 |

---

## Wave Status

| Wave | Name | Status | Notes |
|------|------|--------|-------|
| M.1 | DB Schema | ❌ Not Started | `Message` model not in schema |
| M.2 | Message DTOs | ❌ Not Started | — |
| M.3 | Text Messaging | ❌ Not Started | — |
| M.4 | Media Messaging | ❌ Not Started | — |
| M.5 | Template Messaging | ❌ Not Started | — |
| M.6 | Interactive Messaging | ❌ Not Started | — |
| M.7 | Other Message Types | ❌ Not Started | — |
| M.8 | Message Status | ❌ Not Started | — |
| M.9 | Message Listing | ❌ Not Started | — |
| M.10 | Read Receipts | ❌ Not Started | — |

---

## Endpoint Status

| Method | Endpoint | Auth | Status |
|--------|----------|------|--------|
| POST | `/messages` | API Key / JWT | ❌ Not built |
| GET | `/messages/:messageId` | API Key / JWT | ❌ Not built |
| GET | `/messages` | API Key / JWT | ❌ Not built |

---

## Test Coverage

| Component | Test File | Status |
|-----------|-----------|--------|
| `MessagingService` | — | ❌ Not started |
| `MessagingController` | — | ❌ Not started |

---

## Prerequisites

| Prerequisite | Status | Notes |
|-------------|--------|-------|
| Auth module API key strategy (Wave A.5) | ❌ Not started | Required for API key auth on messaging endpoints |
| Account management WABA/phone number sync | ✅ Complete | Access tokens available |
| Webhooks module (for status updates) | ❌ Not started | Can be built in parallel |

---

## 2026-08-28 — a send rate per API key

`SendRateGuard` caps sends at `maxMessagesPerMinute` — 100 / 500 / 1,000 by
tier — in a fixed one-minute window in Redis.

Keyed on the **API key**, not the caller's address. Nest's own throttler tracks
by IP, which is wrong in both directions for server-to-server traffic: a
customer's whole fleet behind one address shares a bucket, two customers can
share an address, and the number cannot vary by what they pay. The API-key
middleware has already resolved the key, its organisation and its account, so
the identity is there to use.

The console is deliberately not limited: someone clicking send is bounded by how
fast they can click, and the number on the price list is sold as an API rate.

Refusal is **429** with a `Retry-After` naming the seconds until the window
turns — a bare 429 gets retried immediately, which makes the problem worse. A
plan that names no rate is not limited, and a send is **allowed** when Redis is
unreachable: refusing every send because the counter is down would turn a cache
outage into an outage of the product.

---

## Issues & Risks

| Issue | Severity | Notes |
|-------|----------|-------|
| Core product feature not yet built | Critical | This is the primary value-add of the platform |
| Meta rate limits not handled | High | Plan rate-limit middleware before launch |
| No message persistence schema | High | DB migration needed before any development |
