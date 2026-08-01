# Module: Analytics – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ✅ Built |
| Completion | 100% of the defined scope, except template CTR (see below) |
| Blocking Issues | None |
| Last Updated | 2026-08-01 |

---

## Wave Status

| Wave | Name | Status | Notes |
|------|------|--------|-------|
| AN.0 | Capture | ✅ Done | `Message.templateName / deliveredAt / readAt / failedAt / failureReason`, `Contact.optedOutAt`, `PhoneQualityEvent`. None of it is backfillable, which is why it landed first |
| AN.1 | Query Layer | ✅ Done | `AnalyticsService`, shared range/scope resolution |
| AN.2 | Overview Endpoint | ✅ Done | Stats with previous-period comparison, daily series, delivery funnel |
| AN.3 | Message Analytics | ✅ Done | Series, type mix, failure reasons, weekday×hour heatmap, median time to delivery/read |
| AN.4 | Template Analytics | ✅ Done | Per-template rates, approval funnel, category mix, rejection reasons. CTR still out — no click data is captured |
| AN.5 | Contact Analytics | ✅ Done | Growth, running total, opt-out rate, undated opt-outs reported separately |
| AN.6 | Phone Number Analytics | ✅ Done | Per-number volume and failure rate, quality history |
| AN.7 | Export | ✅ Done | CSV for every dataset |
| AN.8 | Performance Optimization | ⏳ Partial | Indexes added (`ssoOrgId+createdAt`, `phoneNumberId`, `ssoOrgId+templateName`); aggregation is still in-process rather than in SQL |

---

## Endpoint Status

| Method | Endpoint | Auth | Status |
|--------|----------|------|--------|
| GET | `/analytics/overview` | JWT | ✅ Built |
| GET | `/analytics/messages` | JWT | ✅ Built |
| GET | `/analytics/templates` | JWT | ✅ Built |
| GET | `/analytics/contacts` | JWT | ✅ Built |
| GET | `/analytics/phone-numbers` | JWT | ✅ Built |
| GET | `/analytics/export` | JWT | ✅ Built |

Console JWT only, not API keys: reporting reads across the whole organisation,
which is a different authority from the per-phone-number send an API key
grants.

All five reporting endpoints accept the same filters: `days` (1–90, default
14), `wabaId` and `phoneNumberId`. A WABA filter is resolved into that
account's phone numbers first, because `Message` carries a `phoneNumberId` and
not a `wabaId`.

---

## Test Coverage

| Component | Test File | Status |
|-----------|-----------|--------|
| `AnalyticsService` | `src/analytics/analytics.service.spec.ts` | ✅ 20 tests |
| `AnalyticsController` | — | Thin: reads the org off the request and delegates |

---

## Prerequisites

| Prerequisite | Status | Notes |
|-------------|--------|-------|
| Messaging module — `Message` table | ❌ Not started | Core data source |
| Webhooks module — `InboundMessage` table | ❌ Not started | Inbound volume data |
| Contacts module — `Contact` table | ❌ Not started | Opt-out data |
| Templates module — `MessageTemplate` table | ❌ Not started | Template performance data |

---

## Issues & Risks

| Issue | Severity | Notes |
|-------|----------|-------|
| All upstream modules must be built first | High | This is the last module to build |
| On-demand SQL aggregation may be slow at scale | Medium | Plan for caching or materialized views |
| No data exists yet to test against | Low | Use seed data in development |

---

## Known limits

- **Template CTR is not implemented and cannot be**, because no button-click
  data is captured. It needs interactive-reply webhook handling first; the
  metric was left out rather than approximated.
- **Median time to delivery / read is null until enough messages carry the new
  timestamps.** Rows that reached a terminal status before the migration were
  backfilled from `updatedAt`, which is the best available answer but not an
  exact one; rows still at "sent" got nothing, which is correct.
- **Opt-outs from before `optedOutAt` existed have no date.** They are counted
  in the total and reported as `optedOutUndated`, deliberately outside the
  series — dating them to today would draw a spike that never happened.
- **Quality history starts from the first `phone_number_quality_update` webhook
  after the migration.** The rating column is overwritten on each sync, so
  nothing earlier is recoverable.
- Aggregation happens in Node rather than in SQL. Fine at the current row
  counts; the date-bucketing is the first thing to push into the database if a
  range starts to feel slow.
