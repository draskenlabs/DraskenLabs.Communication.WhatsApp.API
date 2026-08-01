-- Subscriptions: a flat monthly fee per WhatsApp Business Account for calling
-- the Messaging API against it, collected by Razorpay auto-debit.
--
-- Per account rather than per organisation because API keys are already scoped
-- to one WABA: the account a key names is the account that has to be paid for,
-- which makes "is this request paid for" a lookup rather than an allocation.
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
  "wabaId"                 TEXT,
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

-- One per account. A second row would make "is this account paid for"
-- ambiguous, which is not a question that may have two answers. Postgres
-- allows repeated NULLs, so history for deleted accounts still accumulates.
CREATE UNIQUE INDEX "Subscription_wabaId_key" ON "Subscription"("wabaId");
CREATE UNIQUE INDEX "Subscription_razorpaySubscriptionId_key" ON "Subscription"("razorpaySubscriptionId");
CREATE INDEX "Subscription_ssoOrgId_idx" ON "Subscription"("ssoOrgId");
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");

-- Deleting a WABA leaves its billing history behind, unattached and granting
-- nothing. Cascading would erase what was charged, which is not ours to erase.
ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_wabaId_fkey"
  FOREIGN KEY ("wabaId") REFERENCES "Waba"("wabaId")
  ON DELETE SET NULL ON UPDATE CASCADE;

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
