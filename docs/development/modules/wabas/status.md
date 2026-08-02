# Module: WABAs – Status

| Field | Value |
|-------|-------|
| Status | ✅ Implemented |
| Last Updated | 2026-08-01 |

## Implemented

- Connect (Embedded Signup + manual), list, disconnect and delete.
- **An account can be connected by more than one organisation**
  (`20260801800000_waba_per_organisation`). `WabaOrganisation` holds the
  membership; the `Waba` row went back to being Meta's shared metadata. Every
  org-scoped query — WABAs, templates, analytics, search, API keys, billing,
  webhook config — reads through the membership.
- Ownership is per organisation on connect; deleting is refused while another
  organisation still holds the account, since the data it erases is shared.
- Disconnecting removes the membership and the token, and leaves other
  organisations untouched.

## Migration notes

Every existing account keeps exactly the membership it has today: the migration
backfills one row per `Waba`, from its own `ssoOrgId` and `userId`. Nothing
changes for an account that only one organisation has.

`Waba.ssoOrgId` and `Waba.userId` are kept — they record who first connected
the account, which is what the delete check uses — but they no longer decide
which organisations can see it.

## Pending / not in scope

- Inbound messages and templates stay shared between organisations that share
  an account, because Meta reports one of each. Attributing an inbound message
  to one organisation would mean guessing.
- The phone cache is keyed by `phoneNumberId` alone, so the token used to send
  is whichever connector's the sync last wrote. Fine while both organisations
  are entitled to send; it would need an org-keyed cache if that ever stops
  being true.
- A second organisation connecting an account does not re-sync templates or
  numbers automatically — they are already there, shared.

## Blockers

None.
