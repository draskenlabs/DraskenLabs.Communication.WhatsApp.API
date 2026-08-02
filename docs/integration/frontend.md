# Frontend Integration Guide

Complete reference for integrating a frontend application with the DraskenLabs WhatsApp Communication API.

---

## Table of Contents

1. [Base URL & Headers](#1-base-url--headers)
2. [Authentication Overview](#2-authentication-overview)
3. [Login Flow (PKCE SSO)](#3-login-flow-pkce-sso)
4. [Token Storage](#4-token-storage)
5. [Making Authenticated Requests](#5-making-authenticated-requests)
6. [Organisation Management](#6-organisation-management)
7. [WhatsApp Connect Flow](#7-whatsapp-connect-flow)
8. [WABA & Phone Numbers](#8-waba--phone-numbers)
9. [API Key Management](#9-api-key-management)
10. [Messaging](#10-messaging)
11. [Templates](#11-templates)
12. [Contacts](#12-contacts)
13. [Webhooks](#13-webhooks)
14. [Error Handling](#14-error-handling)
15. [Response Envelope](#15-response-envelope)

---

## 1. Base URL & Headers

```
Base URL:  https://api.drasken.dev   (or http://localhost:3000 locally)
Swagger:   <base>/swagger/docs   (only where SWAGGER_ENABLED=true)
JSON spec: <base>/swagger/json   (only where SWAGGER_ENABLED=true)
```

All requests that send a body must include:
```
Content-Type: application/json
```

---

## 2. Authentication Overview

| Token | What it is | Where to use |
|-------|-----------|--------------|
| **Internal JWT** | Issued by `POST /auth/callback`; encodes `{ sub, orgId, role }` | All JWT-protected endpoints (`Authorization: Bearer <jwt>`) |
| **SSO Access Token** | Issued by Drasken SSO during PKCE login | `/organisation/*` endpoints only (`Authorization: Bearer <sso_token>`) |
| **API Key pair** | `ak_...` + `sk_...` created via `POST /api-keys` | Messaging endpoints (`x-access-key` + `x-secret-key` headers) |

> **Key distinction**: the internal JWT and the SSO access token are different tokens. Store both separately.

---

## 3. Login Flow (PKCE SSO)

### Step 1 — Generate PKCE code verifier and challenge

```typescript
// Generate a cryptographically secure code verifier
const codeVerifier = generateRandomString(64); // base64url, 43–128 chars
const codeChallenge = base64url(sha256(codeVerifier));
```

### Step 2 — Get the SSO redirect URL

```
GET /auth/authorize?redirectUri=<encoded>&codeChallenge=<challenge>
```

**Query params:**

| Param | Required | Description |
|-------|----------|-------------|
| `redirectUri` | ✅ | The URL Drasken SSO will redirect back to after login |
| `codeChallenge` | ✅ | SHA-256 hash of `codeVerifier`, base64url-encoded |

**Response:**
```json
{
  "success": true,
  "data": {
    "url": "https://accounts.drasken.dev/authorize?clientId=...&state=...&codeChallenge=...&redirectUri=...",
    "state": "019501f0-uuid-v7"
  }
}
```

Store `state` locally. Redirect the user to `url`.

### Step 3 — Handle SSO callback

After the user authenticates, Drasken SSO redirects to your `redirectUri` with:
```
?code=<auth_code>&state=<state>
```

Verify that `state` matches what you stored. Then:

```
POST /auth/callback
Content-Type: application/json

{
  "code": "<auth_code>",
  "codeVerifier": "<original_code_verifier>",
  "redirectUri": "<same_redirectUri_used_in_step_2>",
  "state": "<state>"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "access_token": "<internal_jwt>",
    "user": {
      "id": 1,
      "ssoId": "sso_user_uuid",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

Store `access_token` as your **internal JWT** and the SSO access token you received during the callback (from the `Authorization` header the SSO used, if available) separately.

> **Note**: The SSO access token is the one you need for `/organisation/*` endpoints. If your SSO client flow provides it, store it. Otherwise, the internal JWT covers all other endpoints.

---

## 4. Token Storage

| Token | Recommended storage | Notes |
|-------|--------------------|----|
| Internal JWT | `localStorage` or `sessionStorage` | Short-lived; rotate on expiry |
| SSO Access Token | `sessionStorage` | Needed only for org management calls |
| API Key secret (`sk_...`) | Never store client-side | Return once on creation; store server-side only |

---

## 5. Making Authenticated Requests

### JWT-protected endpoints

```typescript
const response = await fetch('/wabas', {
  headers: {
    'Authorization': `Bearer ${internalJwt}`,
    'Content-Type': 'application/json',
  },
});
```

### Organisation endpoints (SSO token)

```typescript
const response = await fetch('/organisation', {
  headers: {
    'Authorization': `Bearer ${ssoAccessToken}`,
  },
});
```

### Messaging endpoints (API Key)

```typescript
const response = await fetch('/messages', {
  method: 'POST',
  headers: {
    'x-access-key': accessKey,   // ak_...
    'x-secret-key': secretKey,   // sk_...
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ ... }),
});
```

---

## 6. Organisation Management

> Use the **SSO access token** for all `/organisation` calls.

### List user's organisations

```
GET /organisation
Authorization: Bearer <sso_token>
```

### Get organisation details

```
GET /organisation/:orgId
Authorization: Bearer <sso_token>
```

### Update organisation

```
PATCH /organisation/:orgId
Authorization: Bearer <sso_token>

{ "name": "New Name", "slug": "new-slug" }
```

### List members

```
GET /organisation/:orgId/members
Authorization: Bearer <sso_token>
```

### Invite member

```
POST /organisation/:orgId/members/invite
Authorization: Bearer <sso_token>

{ "email": "alice@example.com", "role": "member" }
```

Roles: `owner | admin | member`

### Update member role

```
PATCH /organisation/:orgId/members/:userId/role
Authorization: Bearer <sso_token>

{ "role": "admin" }
```

### Remove member

```
DELETE /organisation/:orgId/members/:userId
Authorization: Bearer <sso_token>
```

Returns `204 No Content`.

### List pending invitations

```
GET /organisation/:orgId/invitations
Authorization: Bearer <sso_token>
```

---

## 7. WhatsApp Connect Flow

This connects a user's WhatsApp Business Account to the platform using Meta's Embedded Signup.

### Step 1 — Launch Meta Embedded Signup

Use Meta's JavaScript SDK to open the Embedded Signup dialog. On success you receive a `code`.

### Step 2 — Send the code to the API

```
POST /connect
Authorization: Bearer <internal_jwt>

{
  "code": "<meta_auth_code>"
}
```

This exchanges the code for a Meta access token, stores it encrypted, syncs all WABAs and phone numbers, and populates the phone cache in Redis.

---

## 8. WABA & Phone Numbers

### List WABAs for current org

```
GET /wabas
Authorization: Bearer <internal_jwt>
```

### Get WABA details (live from Meta)

```
GET /wabas/:wabaId
Authorization: Bearer <internal_jwt>
```

### Sync WABA to database

```
POST /wabas/:wabaId/sync
Authorization: Bearer <internal_jwt>
```

### Disconnect a WABA

```
DELETE /wabas/:wabaId/connect
Authorization: Bearer <internal_jwt>
```

Removes the access token and invalidates all associated phone caches. WABA and phone records are preserved.

### List phone numbers for a WABA

```
GET /wabas/:wabaId/phone-numbers
Authorization: Bearer <internal_jwt>
```

### Sync phone numbers from Meta

```
POST /wabas/:wabaId/phone-numbers/sync
Authorization: Bearer <internal_jwt>
```

---

## 9. API Key Management

API keys enable server-to-server messaging without user sessions.

### Create an API key

```
POST /api-keys
Authorization: Bearer <internal_jwt>

{ "name": "My Integration Key" }
```

**Response:**
```json
{
  "success": true,
  "data": {
    "accessKey": "ak_...",
    "secretKey": "sk_...",
    "name": "My Integration Key",
    "createdAt": "..."
  }
}
```

> **The `secretKey` is returned only once.** Store it securely on the server. It cannot be retrieved again.

### List API keys

```
GET /api-keys
Authorization: Bearer <internal_jwt>
```

Secret keys are never returned in list responses.

### Revoke an API key

```
DELETE /api-keys/:id
Authorization: Bearer <internal_jwt>
```

---

## 10. Messaging

> Messaging uses **API Key** auth, not JWT.

### Send a message

```
POST /messages
x-access-key: ak_...
x-secret-key: sk_...

{
  "phoneNumberId": "phone_number_id_from_meta",
  "to": "447911111111",
  "type": "text",
  "text": "Hello from DraskenLabs!"
}
```

**Message types:**

| Type | Required fields |
|------|----------------|
| `text` | `text` |
| `image` | `mediaUrl` |
| `video` | `mediaUrl` |
| `audio` | `mediaUrl` |
| `document` | `mediaUrl`, optionally `filename` |
| `template` | `templateName`, `templateLanguage`, optionally `templateComponents` |

**Template example:**
```json
{
  "phoneNumberId": "phone_number_id",
  "to": "447911111111",
  "type": "template",
  "templateName": "hello_world",
  "templateLanguage": "en_US",
  "templateComponents": []
}
```

### List messages

```
GET /messages
x-access-key: ak_...
x-secret-key: sk_...
```

### Get a message

```
GET /messages/:id
x-access-key: ak_...
x-secret-key: sk_...
```

### Opt-out behaviour

If a contact has `optedOut: true`, sending to them returns `400 Bad Request`. Update the contact's opt-out status via `PATCH /contacts/:id`.

---

## 11. Templates

### Sync templates from Meta

```
POST /templates/sync/:wabaId
Authorization: Bearer <internal_jwt>
```

Fetches all templates from Meta for the given WABA and upserts them in the database.

### List templates

```
GET /templates
Authorization: Bearer <internal_jwt>
```

### Get a template

```
GET /templates/:id
Authorization: Bearer <internal_jwt>
```

Template statuses: `PENDING | APPROVED | REJECTED | FLAGGED | DELETED | DISABLED | IN_APPEAL`

---

## 12. Contacts

### Create a contact

```
POST /contacts
Authorization: Bearer <internal_jwt>

{
  "phone": "447911111111",
  "name": "Alice Smith",
  "email": "alice@example.com",
  "optedOut": false,
  "metadata": {}
}
```

`phone` is unique per organisation.

### List contacts

```
GET /contacts
Authorization: Bearer <internal_jwt>
```

### Get a contact

```
GET /contacts/:id
Authorization: Bearer <internal_jwt>
```

### Update a contact

```
PATCH /contacts/:id
Authorization: Bearer <internal_jwt>

{ "optedOut": true }
```

### Delete a contact

```
DELETE /contacts/:id
Authorization: Bearer <internal_jwt>
```

---

## 13. Webhooks

Webhooks are configured in your Meta app settings. Point the webhook URL to:

```
POST https://api.drasken.dev/webhooks
```

### Verification

When you save the webhook URL in Meta, it sends a `GET` challenge:
```
GET /webhooks?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>
```

The API responds with the challenge value if `hub.verify_token` matches `WEBHOOK_VERIFY_TOKEN`.

### Events handled

| Event | Action |
|-------|--------|
| Inbound message | Stored in `InboundMessage` table |
| Message status update | Updates `Message.status` in DB |
| Phone number quality update | Updates `WabaPhoneNumber.qualityRating` |
| Account update | Logged in `WebhookEvent` |

### Security

All `POST /webhooks` requests are validated using HMAC-SHA256 with `META_APP_SECRET`. Requests with invalid signatures are rejected with `403`.

---

## 14. Error Handling

All errors follow a consistent envelope:

```json
{
  "success": false,
  "statusCode": 401,
  "message": "Unauthorized",
  "errors": []
}
```

For validation errors (`422`):
```json
{
  "success": false,
  "statusCode": 422,
  "message": "Unprocessable Entity",
  "errors": [
    { "field": "email", "message": "email must be an email" }
  ]
}
```

| Status | Meaning |
|--------|---------|
| `400` | Bad request — missing or invalid body |
| `401` | Unauthorized — missing or invalid token |
| `403` | Forbidden — valid token but insufficient permission |
| `404` | Not found — resource doesn't exist or belongs to another org |
| `409` | Conflict — duplicate resource (e.g. contact phone already exists) |
| `422` | Validation error — field-level errors returned |
| `429` | Rate limited — 5 requests per minute per IP |
| `500` | Internal server error |

---

## 15. Response Envelope

All successful responses are wrapped:

```json
{
  "success": true,
  "statusCode": 200,
  "data": { ... }
}
```

Array responses:
```json
{
  "success": true,
  "statusCode": 200,
  "data": [ ... ]
}
```

`204 No Content` responses (e.g. `DELETE`) return no body.
