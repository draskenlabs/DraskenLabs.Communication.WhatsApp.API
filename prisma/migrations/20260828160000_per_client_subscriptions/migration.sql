-- Who pays, separated from who it is for.
--
-- An agency buying for its clients means a subscription whose entitlement and
-- whose money belong to different organisations. `ssoOrgId` was both; it stays
-- the organisation entitled, and the payer moves to its own column. Null there
-- means self-paid, which is every row that exists today.

ALTER TABLE "Subscription"
    ADD COLUMN "payerOrgId"     TEXT,
    ADD COLUMN "billingGroupId" INTEGER;

-- A client an agency pays for has no provider subscription of its own: it is a
-- quantity on a shared one. Postgres treats NULLs as distinct in a unique
-- index, so the constraint still holds for every row that names one.
ALTER TABLE "Subscription"
    ALTER COLUMN "razorpaySubscriptionId" DROP NOT NULL;

CREATE INDEX "Subscription_payerOrgId_idx"     ON "Subscription"("payerOrgId");
CREATE INDEX "Subscription_billingGroupId_idx" ON "Subscription"("billingGroupId");

-- One mandate an agency holds, for one plan, covering several clients.
--
-- A subscription per client would be an authorisation per client. This is one
-- per plan the agency uses, with the quantity moving as clients come and go.
CREATE TABLE "AgencyBillingGroup" (
    "id"                     SERIAL             NOT NULL,
    "agencyOrgId"            TEXT               NOT NULL,
    "planRefId"              INTEGER            NOT NULL,
    "razorpayCustomerId"     TEXT,
    "razorpaySubscriptionId" TEXT               NOT NULL,
    "planId"                 TEXT               NOT NULL,
    "quantity"               INTEGER            NOT NULL DEFAULT 0,
    "status"                 "SubscriptionStatus" NOT NULL DEFAULT 'created',
    "currentStart"           TIMESTAMP(3),
    "currentEnd"             TIMESTAMP(3),
    "cancelAtCycleEnd"       BOOLEAN            NOT NULL DEFAULT false,
    "cancelledAt"            TIMESTAMP(3),
    "shortUrl"               TEXT,
    "createdByUserId"        INTEGER            NOT NULL,
    "createdAt"              TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3)       NOT NULL,

    CONSTRAINT "AgencyBillingGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgencyBillingGroup_razorpaySubscriptionId_key"
    ON "AgencyBillingGroup"("razorpaySubscriptionId");

-- One group per agency and plan. A second would be a second mandate for the
-- same thing.
CREATE UNIQUE INDEX "AgencyBillingGroup_agencyOrgId_planRefId_key"
    ON "AgencyBillingGroup"("agencyOrgId", "planRefId");

CREATE INDEX "AgencyBillingGroup_agencyOrgId_idx" ON "AgencyBillingGroup"("agencyOrgId");
CREATE INDEX "AgencyBillingGroup_status_idx"      ON "AgencyBillingGroup"("status");

ALTER TABLE "AgencyBillingGroup"
    ADD CONSTRAINT "AgencyBillingGroup_planRefId_fkey"
    FOREIGN KEY ("planRefId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Subscription"
    ADD CONSTRAINT "Subscription_billingGroupId_fkey"
    FOREIGN KEY ("billingGroupId") REFERENCES "AgencyBillingGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
