# Module: Organisation – Definition

## Purpose

Provides organisation and member management for the platform by proxying requests directly to the Drasken SSO API. No local organisation data is stored — the SSO is the single source of truth for organisations, members, roles, and invitations.

---

## Design Pattern

**BFF Proxy** — every request to `/organisation/*` authenticates the caller's **app JWT** (session or org-scoped), looks up the cached SSO access token from the Redis BFF session (`ssosession:{sessionId}`), and calls `SSO_API_URL/organizations` with **that** token. The response is passed back unchanged. The browser never handles the SSO token. There is no local DB interaction.

This means:
- The frontend must pass the **SSO access token** (not the internal JWT) for these endpoints
- Organisation data is always fresh — no cache staleness
- No DB migration needed when org structure changes in SSO

---

## Scope

| Area | Included | Excluded |
|------|----------|----------|
| List user's organisations | ✅ Yes | — |
| Get org details | ✅ Yes | — |
| Update org (name, slug) | ✅ Yes | — |
| List org members | ✅ Yes | — |
| Invite member by email | ✅ Yes | — |
| Update member role | ✅ Yes | — |
| Remove member | ✅ Yes | — |
| List pending invitations | ✅ Yes | — |
| Create new organisation | ❌ No | Handled directly in SSO UI |
| Delete organisation | ❌ No | Handled directly in SSO UI |
| Local org storage / caching | ❌ No | By design |

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/organisation` | List organisations for the authenticated SSO user |
| GET | `/organisation/:orgId` | Get organisation details |
| PATCH | `/organisation/:orgId` | Update organisation name or slug (admin only) |
| GET | `/organisation/:orgId/members` | List members |
| POST | `/organisation/:orgId/members/invite` | Invite a user by email |
| PATCH | `/organisation/:orgId/members/:userId/role` | Update a member's role |
| DELETE | `/organisation/:orgId/members/:userId` | Remove a member |
| GET | `/organisation/:orgId/invitations` | List pending invitations |

---

## Auth

All endpoints require the **app JWT** (session or org-scoped) in the `Authorization` header:
```
Authorization: Bearer <app_jwt>
```

The controller verifies the JWT, then swaps it for the user's cached SSO access
token (from the Redis BFF session keyed by the JWT's `sessionId`) before calling
the SSO. Callers never send the SSO token directly.

---

## Response Shapes (from SSO)

**OrganisationDto**
```json
{
  "id": "sso_org_uuid",
  "name": "Acme Corp",
  "slug": "acme-corp",
  "imageUrl": "https://...",
  "membersCount": 5,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

**MemberDto**
```json
{
  "userId": "sso_user_uuid",
  "email": "alice@acme.com",
  "firstName": "Alice",
  "lastName": "Smith",
  "role": "admin",
  "joinedAt": "2026-01-01T00:00:00.000Z"
}
```

**InvitationDto**
```json
{
  "id": "invite_uuid",
  "email": "bob@acme.com",
  "role": "member",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

---

## Multi-tenancy Impact

All other modules (WABA, Messaging, Contacts, etc.) use `ssoOrgId: String` for data scoping. This value comes from the **internal JWT payload** (`orgId` claim), which is set during `POST /auth/callback` from the SSO token's active org field. The organisation module itself does not affect this — it is purely for managing org membership in the SSO.
