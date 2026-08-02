-- A subscription belongs to an organisation's use of an account, not to the
-- account.
--
-- `wabaId` alone was unique, which was right while an account could only be
-- connected once. Now that two organisations can hold the same account, that
-- constraint told the second one "this account already has a subscription" —
-- and, worse, the first organisation's payment would have granted the second
-- one access to the API for nothing.

DROP INDEX "Subscription_wabaId_key";

CREATE UNIQUE INDEX "Subscription_wabaId_ssoOrgId_key" ON "Subscription"("wabaId", "ssoOrgId");
