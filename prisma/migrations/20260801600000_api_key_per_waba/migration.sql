-- API keys are scoped to one WABA rather than to the whole organisation.
--
-- A key used to reach every account in the org: the send handler resolved the
-- WABA from the phone number in the request, so nothing stopped a key issued
-- for one account from sending on another. The key now names the account it
-- may act on, and the send is checked against it.

ALTER TABLE "UserApiKey" ADD COLUMN "wabaId" TEXT;

-- Backfill the unambiguous case: an organisation with exactly one WABA has
-- only one account a key could have meant. Keys in multi-WABA organisations
-- are left null on purpose — guessing which account they belonged to is how
-- a key ends up sending from the wrong number. Those are refused at
-- authentication with a message telling the owner to issue a scoped key.
UPDATE "UserApiKey" k
SET "wabaId" = (
  SELECT w."wabaId" FROM "Waba" w WHERE w."ssoOrgId" = k."ssoOrgId"
)
WHERE (SELECT COUNT(*) FROM "Waba" w2 WHERE w2."ssoOrgId" = k."ssoOrgId") = 1;

CREATE INDEX "UserApiKey_wabaId_idx" ON "UserApiKey"("wabaId");

ALTER TABLE "UserApiKey"
  ADD CONSTRAINT "UserApiKey_wabaId_fkey"
  FOREIGN KEY ("wabaId") REFERENCES "Waba"("wabaId")
  ON DELETE SET NULL ON UPDATE CASCADE;
