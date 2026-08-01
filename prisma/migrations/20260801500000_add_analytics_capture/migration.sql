-- Capture for the analytics module.
--
-- None of this is backfillable: every column here records something at the
-- moment it happens. A status timestamp cannot be recovered from a row that
-- only kept `updatedAt`, and an opt-out that already happened has no date.
-- That is why these land before the reporting that reads them.

-- Which template a message used. It sits inside `payload` today, and a JSON
-- scan is not a basis for per-template reporting.
ALTER TABLE "Message" ADD COLUMN "templateName" TEXT;

-- When each status landed. `updatedAt` holds only the most recent change, so
-- it can answer neither "when was it delivered" nor "how long until it was read".
ALTER TABLE "Message" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN "readAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN "failedAt" TIMESTAMP(3);

-- Meta's reason for a failure, so causes can be ranked rather than counted.
ALTER TABLE "Message" ADD COLUMN "failureReason" TEXT;

-- Every analytics query is "this organisation, this date range".
CREATE INDEX "Message_ssoOrgId_createdAt_idx" ON "Message"("ssoOrgId", "createdAt");
-- Per-number breakdowns, and the WABA filter, which joins through the number.
CREATE INDEX "Message_phoneNumberId_idx" ON "Message"("phoneNumberId");
CREATE INDEX "Message_ssoOrgId_templateName_idx" ON "Message"("ssoOrgId", "templateName");

-- When an opt-out happened. The boolean says what is true now, not when it
-- became true, so opt-out rate cannot be trended without this.
ALTER TABLE "Contact" ADD COLUMN "optedOutAt" TIMESTAMP(3);
CREATE INDEX "Contact_ssoOrgId_createdAt_idx" ON "Contact"("ssoOrgId", "createdAt");

-- Inbound volume per WABA over a date range.
CREATE INDEX "InboundMessage_wabaId_createdAt_idx" ON "InboundMessage"("wabaId", "createdAt");

-- Quality ratings as a series. WabaPhoneNumber.qualityRating is overwritten on
-- every sync, so the history disappears exactly when it becomes interesting.
CREATE TABLE "PhoneQualityEvent" (
    "id" SERIAL NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "qualityRating" TEXT NOT NULL,
    "limitTier" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhoneQualityEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PhoneQualityEvent_phoneNumberId_createdAt_idx" ON "PhoneQualityEvent"("phoneNumberId", "createdAt");
CREATE INDEX "PhoneQualityEvent_wabaId_createdAt_idx" ON "PhoneQualityEvent"("wabaId", "createdAt");

-- Backfill what CAN be inferred: a message that reached a terminal status
-- before this migration has its `updatedAt` as the best available timestamp.
-- Rows still at "sent" get nothing, which is correct — nothing happened to them.
UPDATE "Message" SET "deliveredAt" = "updatedAt" WHERE "status" IN ('delivered', 'read');
UPDATE "Message" SET "readAt" = "updatedAt" WHERE "status" = 'read';
UPDATE "Message" SET "failedAt" = "updatedAt" WHERE "status" = 'failed';
