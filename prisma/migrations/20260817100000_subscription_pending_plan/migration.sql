-- A tier chosen but not yet in force.
--
-- A downgrade takes effect at the end of the month already paid for rather
-- than cutting it short, so between the request and the renewal a subscription
-- has two tiers: the one it is charged and limited by, and the one it is
-- moving to. `planRefId` stays the first; these are the second.
ALTER TABLE "Subscription" ADD COLUMN "pendingPlanRefId" INTEGER;
ALTER TABLE "Subscription" ADD COLUMN "pendingPlanAt" TIMESTAMP(3);

CREATE INDEX "Subscription_pendingPlanRefId_idx" ON "Subscription"("pendingPlanRefId");

-- RESTRICT, like `planRefId`: a plan a subscription is moving onto must not be
-- deletable out from under it.
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_pendingPlanRefId_fkey"
    FOREIGN KEY ("pendingPlanRefId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
