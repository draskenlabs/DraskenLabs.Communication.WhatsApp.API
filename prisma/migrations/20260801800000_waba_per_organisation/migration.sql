-- A WhatsApp Business Account can be connected by more than one organisation.
--
-- The Waba row is unique on `wabaId`, and it was also standing in for "this
-- organisation has this account". Connecting an account a second organisation
-- already had therefore updated *that* organisation's row: the account looked
-- like it reconnected over there, and never appeared here.
--
-- The account stays shared — its name, currency and phone numbers are Meta's,
-- and are the same whoever looks. What becomes per organisation is the
-- connection, which is what this table holds.

CREATE TABLE "WabaOrganisation" (
  "id"        SERIAL NOT NULL,
  "wabaId"    TEXT NOT NULL,
  "ssoOrgId"  TEXT NOT NULL,
  "userId"    INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WabaOrganisation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WabaOrganisation_wabaId_ssoOrgId_key" ON "WabaOrganisation"("wabaId", "ssoOrgId");
CREATE INDEX "WabaOrganisation_ssoOrgId_idx" ON "WabaOrganisation"("ssoOrgId");

ALTER TABLE "WabaOrganisation"
  ADD CONSTRAINT "WabaOrganisation_wabaId_fkey"
  FOREIGN KEY ("wabaId") REFERENCES "Waba"("wabaId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Every account already connected keeps exactly the membership it has today:
-- the organisation on its Waba row, connected by whoever onboarded it.
INSERT INTO "WabaOrganisation" ("wabaId", "ssoOrgId", "userId", "createdAt")
SELECT "wabaId", "ssoOrgId", "userId", "createdAt" FROM "Waba";
