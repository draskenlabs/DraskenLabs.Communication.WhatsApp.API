-- Retry state for a failed email.
--
-- A send that failed was logged and abandoned: a support request, a template
-- decision or a daily summary lost to a network blip or an SES throttle was
-- visible in MailLog and never tried again. The sweep now picks those rows up,
-- so `attempts` counts how many deliveries have been made, `retryAt` says when
-- the next one is due, and `payload` carries what the message was made of so it
-- can be rebuilt.
--
-- `payload` holds the message content and is cleared the moment a row settles —
-- delivered, given up on, or suppressed — so nobody's support message sits in
-- the log after it has been delivered.
--
-- `updatedAt` needs a default for the rows already here; new rows get it from
-- Prisma on every write.

ALTER TABLE "MailLog" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "MailLog" ADD COLUMN "retryAt" TIMESTAMP(3);
ALTER TABLE "MailLog" ADD COLUMN "payload" JSONB;
ALTER TABLE "MailLog" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- The sweep asks for failed rows whose retry is due.
CREATE INDEX "MailLog_status_retryAt_idx" ON "MailLog"("status", "retryAt");
