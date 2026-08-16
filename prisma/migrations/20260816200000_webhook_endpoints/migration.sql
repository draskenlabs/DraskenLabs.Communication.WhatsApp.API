-- Outbound webhooks: forwarding events to the integrator's own backend.
--
-- Everything before this was inbound — Meta posts to us, we store the event and
-- the console reads it. An integration that wants to know the moment a customer
-- replies had to poll for it. These two tables are the other direction: a
-- customer registers an endpoint, and every event for that account is posted to
-- it and retried until it lands.

-- The endpoint itself. Scoped to one WABA the way an API key is, so an endpoint
-- hears about one account rather than everything the organisation connected.
CREATE TABLE "WebhookEndpoint" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "ssoOrgId" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "label" TEXT,
    -- Encrypted (AES-256-GCM), and nullable: signing is opt-in. Without a
    -- secret we post the body unsigned and send no signature header.
    "secret" TEXT,
    -- Event kinds subscribed to. Empty means every kind. Left nullable to
    -- match what Prisma generates for a scalar list, so a drift check on this
    -- table comes back clean.
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" BOOLEAN NOT NULL DEFAULT true,
    -- Consecutive give-ups; reset by any delivery that succeeds. An endpoint
    -- that reaches the limit is switched off rather than retried forever.
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- The console's list: one organisation's endpoints.
CREATE INDEX "WebhookEndpoint_ssoOrgId_idx" ON "WebhookEndpoint"("ssoOrgId");
-- The fan-out query: who is listening to this account right now.
CREATE INDEX "WebhookEndpoint_wabaId_status_idx" ON "WebhookEndpoint"("wabaId", "status");

ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Disconnecting the account takes its endpoints with it: they address events
-- that will never be delivered again.
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_wabaId_fkey"
    FOREIGN KEY ("wabaId") REFERENCES "Waba"("wabaId") ON DELETE CASCADE ON UPDATE CASCADE;

-- The outbox. Meta's POST has to be answered in milliseconds, so a row is
-- written here and the sweep does the posting — a customer's slow endpoint
-- cannot hold Meta's request open.
CREATE TABLE "WebhookDelivery" (
    "id" SERIAL NOT NULL,
    "endpointId" INTEGER NOT NULL,
    -- Null for a test ping, which has no stored event behind it.
    "eventId" INTEGER,
    "eventType" TEXT NOT NULL,
    -- Exactly what was posted, so a redelivery sends the same bytes.
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "retryAt" TIMESTAMP(3),
    "responseCode" INTEGER,
    "error" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- The delivery log for one endpoint, newest first.
CREATE INDEX "WebhookDelivery_endpointId_createdAt_idx" ON "WebhookDelivery"("endpointId", "createdAt");
-- The sweep's query: rows due for an attempt.
CREATE INDEX "WebhookDelivery_status_retryAt_idx" ON "WebhookDelivery"("status", "retryAt");

ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey"
    FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- The event may be pruned before the log is; the delivery record stands on its
-- own payload, so the link is dropped rather than the row.
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "WebhookEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
