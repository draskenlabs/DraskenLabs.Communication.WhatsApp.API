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
in Meta's review. Only an approved name is what recipients see, so the two are
stored and returned separately.

The two are also **independent, not sequential**. A display name is supplied
when the number is added to the WABA, and its review starts there — it does not
wait on the OTP. A number can be `PENDING_REVIEW` while unverified, or
`VERIFIED` while its name is still out. What needs both is `/register`: Meta
wants a verified number *and* a name in use before it will put the number on
the Cloud API.

| `nameStatus` | Meaning |
|--------------|---------|
| `APPROVED` | Reviewed and in use. |
| `AVAILABLE_WITHOUT_REVIEW` | Cleared with no manual review — the usual outcome for a name matching the verified business. In use exactly like `APPROVED`, and the reason approval is never assumed to imply a review happened. |
| `PENDING_REVIEW` | Out for review. |
| `DECLINED` | Refused. Not terminal — a new name resubmits and re-enters review. |
| `EXPIRED` | An approval that lapsed. |
| `NONE` / `NON_EXISTS` | Meta holds no name review for this number. Two spellings of one answer; `NON_EXISTS` is what the Graph API actually returns. |

`nameStatus` is nullable, and null means something different from all of the
above: Meta omits the field for a number that has not finished onboarding, and
"we have not asked yet" is not an answer Meta gave. It is also written by the
`phone_number_name_update` webhook, so a decision reaches the console without
waiting for the next sync.

**A rename is its own review.** Requesting a new name does not take the current
one out of service: Meta leaves `name_status` on the approved name and reports
the requested one in `new_display_name` / `new_name_status` until it clears,
is refused, or expires. Both are synced into `newDisplayName` / `newNameStatus`
and cleared when Meta stops reporting them. Folding a rename's verdict into
`nameStatus` reported the name customers are actually seeing as declined.

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
