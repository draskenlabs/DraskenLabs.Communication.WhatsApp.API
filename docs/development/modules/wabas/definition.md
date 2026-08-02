# Module: WABAs – Definition

## Purpose

Connect WhatsApp Business Accounts to the console, list them, disconnect them
and — finally — erase what the console holds about one.

## An account is shared; a connection is not

`Waba` holds what Meta says about an account: its name, currency, timezone and
template namespace. That is the same answer whoever asks, so there is one row
per `wabaId`.

**`WabaOrganisation` is the membership** — which organisations have connected
that account, and who connected it for each. Everything org-scoped reads
through it:

```prisma
where: { wabaId, WabaOrganisation: { some: { ssoOrgId } } }
```

Before it existed the `Waba` row was doing both jobs. Because it is unique on
`wabaId`, a second organisation connecting the same account *updated the first
organisation's row*: the account appeared to reconnect over there and never
arrived here. Two organisations can now hold the same account, each with its
own connection, its own API keys and its own subscription.

## What is shared and what is not

| Thing | Scope | Why |
|-------|-------|-----|
| Account metadata (name, currency, timezone) | Shared | It is Meta's, and identical for everyone |
| Phone numbers | Shared | Also Meta's; both organisations send from the same numbers |
| Access token | Per user | Each connector authorises separately, and their token is used |
| Membership | Per organisation | `WabaOrganisation` |
| API keys | Per organisation | Already scoped to one WABA, and created within an org |
| Subscription | Per organisation | Each organisation pays for its own use of the account |
| Outbound messages | Per organisation | Stamped with `ssoOrgId` when sent |
| Inbound messages, templates | Shared | Meta reports them per account, with no organisation to attribute them to |

That last row is the honest consequence: two organisations sharing an account
see the same inbound messages and the same template list, because Meta has one
of each. If that is not wanted, the answer is not to connect one account twice.

## Connecting

`createOrUpdateWaba` upserts the shared row and upserts the membership.
Ownership is checked **per organisation**: someone else in *this* organisation
having connected it is a conflict; another organisation having it is not — the
same business may run two of ours, and Meta has already proved this user can
act for the account.

## Disconnecting vs deleting

- **Disconnect** removes this organisation's membership and this user's token.
  The account stays connected in any other organisation that has it, and the
  audit record stays here.
- **Delete** erases phone numbers, templates, inbound messages and events —
  none of which are per organisation. It is therefore **refused while another
  organisation still has the account connected**; disconnect leaves them alone.
  Only the person who first connected the account may delete it, and Meta's
  copy is never touched.
