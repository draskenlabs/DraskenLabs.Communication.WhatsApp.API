# Module: Organisation – Status

## Summary

| Field | Value |
|-------|-------|
| Status | ✅ Complete |
| Completion | 100% |
| Blocking Issues | None |
| Last Updated | 2026-08-07 |

---

## Wave Status

| Wave | Name | Status | Notes |
|------|------|--------|-------|
| O.1 | OrgService SSO proxy | ✅ Complete | Forwards every call to the SSO with an `Authorization` header built server-side |
| O.2 | OrgController | ✅ Complete | 8 endpoints. **The caller sends the app JWT, not the SSO token**: the controller verifies it, reads `sessionId`, and fetches the SSO access token from the Redis session |
| O.3 | Swagger docs | ✅ Complete | `jwt` and `sso-token` schemes are both declared; the org endpoints take the app JWT |
| O.4 | DTO definitions | ✅ Complete | `OrganisationDto`, `MemberDto`, `InvitationDto`, `InviteMemberDto`, `UpdateMemberRoleDto`, `UpdateOrganisationDto` |
| O.5 | Org directory | ✅ Complete | `OrgDirectoryService` resolves organisation names for notifications, mail and the WABA membership rows |

---

## Endpoint Status

| Method | Endpoint | Auth | Status |
|--------|----------|------|--------|
| GET | `/organisation` | App JWT → SSO | ✅ Live |
| GET | `/organisation/:orgId` | App JWT → SSO | ✅ Live |
| PATCH | `/organisation/:orgId` | App JWT → SSO | ✅ Live |
| GET | `/organisation/:orgId/members` | App JWT → SSO | ✅ Live |
| POST | `/organisation/:orgId/members/invite` | App JWT → SSO | ✅ Live |
| PATCH | `/organisation/:orgId/members/:userId/role` | App JWT → SSO | ✅ Live |
| DELETE | `/organisation/:orgId/members/:userId` | App JWT → SSO | ✅ Live |
| GET | `/organisation/:orgId/invitations` | App JWT → SSO | ✅ Live |

Organisation selection, creation and switching live in the Auth module
(`/auth/organisations`, `/auth/select-org`).

---

## Test Coverage

| Component | Test File | Tests |
|-----------|-----------|-------|
| `OrgDirectoryService` | `org-directory.service.spec.ts` | 11 |
| `OrgService` | — | ❌ Missing |
| `OrgController` | — | ❌ Missing |

Statement coverage for the module: 62.9% — the proxy itself is the untested
part.

---

## Issues & Risks

| Issue | Severity | Notes |
|-------|----------|-------|
| The proxy has no tests of its own | Medium | Every call is a pass-through, but the session→SSO token lookup and its `401` paths are not covered |
| An expired SSO session surfaces as `401 Session expired — please sign in again` | Low | Expected behaviour; the console redirects to sign-in |
