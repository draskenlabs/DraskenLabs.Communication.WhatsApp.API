-- Subscriptions: a flat monthly fee per organisation for calling the Messaging
-- API with an API key, collected by Razorpay auto-debit.
--
-- `currentEnd` is the load-bearing column. Access is granted while it is in the
-- future regardless of status, which is what lets a customer cancel at any
-- moment and keep the month they have already paid for.

CREATE TYPE "SubscriptionStatus" AS ENUM (
  'created',
  'authenticated',
  'active',
  'pending',
  'halted',
  'cancelled',
  'completed',
  'expired'
);

CREATE TABLE "Subscription" (
  "id"                     SERIAL NOT NULL,
  "ssoOrgId"               TEXT NOT NULL,
  "razorpayCustomerId"     TEXT,
  "razorpaySubscriptionId" TEXT NOT NULL,
  "planId"                 TEXT NOT NULL,
  "status"                 "SubscriptionStatus" NOT NULL DEFAULT 'created',
  "currentStart"           TIMESTAMP(3),
  "currentEnd"             TIMESTAMP(3),
  "cancelAtCycleEnd"       BOOLEAN NOT NULL DEFAULT false,
  "cancelledAt"            TIMESTAMP(3),
  "shortUrl"               TEXT,
  "createdByUserId"        INTEGER NOT NULL,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- One per organisation. A second row would make "does this org have access"
-- ambiguous, which is not a question that may have two answers.
CREATE UNIQUE INDEX "Subscription_ssoOrgId_key" ON "Subscription"("ssoOrgId");
CREATE UNIQUE INDEX "Subscription_razorpaySubscriptionId_key" ON "Subscription"("razorpaySubscriptionId");
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");

CREATE TABLE "SubscriptionEvent" (
  "id"                     SERIAL NOT NULL,
  "eventId"                TEXT NOT NULL,
  "event"                  TEXT NOT NULL,
  "ssoOrgId"               TEXT,
  "razorpaySubscriptionId" TEXT,
  "payload"                JSONB NOT NULL,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SubscriptionEvent_pkey" PRIMARY KEY ("id")
);

-- Razorpay retries webhooks. The unique event id is what stops one charge
-- being applied twice.
CREATE UNIQUE INDEX "SubscriptionEvent_eventId_key" ON "SubscriptionEvent"("eventId");
CREATE INDEX "SubscriptionEvent_ssoOrgId_createdAt_idx" ON "SubscriptionEvent"("ssoOrgId", "createdAt");
