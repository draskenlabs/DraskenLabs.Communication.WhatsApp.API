# Module: Account Management – Definition

## Purpose

Manages the onboarding and lifecycle of WhatsApp Business Accounts (WABAs) and their associated phone numbers. Covers the Meta Embedded Signup OAuth flow for connecting accounts, syncing WABA metadata and phone number details from Meta's Graph API into the local database, and providing users visibility into their connected WhatsApp assets.

---

## Scope

| Area | Included | Excluded |
|------|----------|----------|
| Meta Embedded Signup OAuth flow | ✅ Yes | — |
| WABA listing and detail retrieval | ✅ Yes | — |
| WABA sync from Meta to DB | ✅ Yes | — |
| Phone number listing and sync | ✅ Yes | — |
| Phone number registration / deregistration | ❌ No | Future |
| WABA subscription management | ❌ No | Future |
| Business verification status | ❌ No | Future |
| Multiple user WABA sharing | ❌ No | Future |

---

## Key Entities

| Entity | Description |
|--------|-------------|
| `Waba` | A WhatsApp Business Account (Meta resource) |
| `WabaPhoneNumber` | A phone number registered under a WABA |
| `UserWhatsapp` | Association between a platform user and a WABA, holding encrypted access token |

---

## Sub-Areas

### 1. OAuth Connect

Implements the Meta Embedded Signup flow. Users authorize the platform via Meta OAuth, receive a short-lived code, which is exchanged for a long-lived access token and stored encrypted.

| Flow Step | Description |
|-----------|-------------|
| Initiate | Client redirects user to Meta with app credentials |
| Callback | Platform receives `code`, exchanges for access token |
| State | Redis holds temporary OAuth state (300s TTL) |
| Persist | `UserWhatsapp` record created with encrypted token |

### 2. WABA Management

| Operation | Endpoint | Source |
|-----------|----------|--------|
| List WABAs | `GET /wabas` | Local DB |
| Get WABA detail | `GET /wabas/:wabaId` | Meta Graph API |
| Sync WABA | `POST /wabas/:wabaId/sync` | Meta → DB upsert |

### 3. Phone Number Management

| Operation | Endpoint | Source |
|-----------|----------|--------|
| List phone numbers | `GET /wabas/:wabaId/phone-numbers` | Local DB |
| Sync phone numbers | `POST /wabas/:wabaId/phone-numbers/sync` | Meta → DB upsert |

**Two statuses, never folded together.** `codeVerificationStatus` is the
number's own OTP registration — whether it can send. `nameStatus` (Meta's
`name_status`, synced alongside it) is where the number's *display name* stands
in Meta's review: `APPROVED`, `PENDING_REVIEW`, `DECLINED`, `EXPIRED`,
`AVAILABLE_WITHOUT_REVIEW` or `NONE`. A number can be registered and sending
while its name is still in review, and only an approved name is what recipients
see, so the two are stored and returned separately.

`nameStatus` is nullable: Meta omits the field for a number that has not
finished onboarding, and "we have not asked yet" is not the same answer as
`NONE`. It is also written by the `phone_number_name_update` webhook, so a
decision reaches the console without waiting for the next sync.

---

## Meta API Integration

| Operation | Meta Endpoint | Notes |
|-----------|--------------|-------|
| Token exchange | `POST /oauth/access_token` | Code → access token |
| Token debug | `GET /debug_token` | Inspect token metadata |
| Business lookup | `GET /{businessId}` | Business name, ID |
| Owned WABAs | `GET /{businessId}/owned_whatsapp_business_accounts` | WABAs owned by business |
| Client WABAs | `GET /{businessId}/client_whatsapp_business_accounts` | Solution provider WABAs |
| WABA detail | `GET /{wabaId}` | Currency, timezone, namespace |
| Phone numbers | `GET /{wabaId}/phone_numbers` | All phone numbers for WABA |

---

## Sync Strategy

| Resource | Strategy | Conflict Resolution |
|----------|----------|---------------------|
| `Waba` | Upsert by `wabaId` | Meta is source of truth |
| `WabaPhoneNumber` | Upsert by `phoneNumberId` | Meta is source of truth |
