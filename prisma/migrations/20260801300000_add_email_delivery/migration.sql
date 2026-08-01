-- Email delivery over Amazon SES.
--
-- The address is copied from SSO at sign-in and kept here: every notification
-- email is triggered by a webhook or a scheduled job, where there is no user
-- token to read the SSO profile with.
ALTER TABLE "User" ADD COLUMN "email" TEXT;
ALTER TABLE "User" ADD COLUMN "firstName" TEXT;
ALTER TABLE "User" ADD COLUMN "lastName" TEXT;

-- Email preferences sit beside the push ones. Separate columns rather than a
-- single switch: a person may want a push for every reply but only an email
-- when Meta rejects a template. Inbound-message email defaults off because a
-- busy account would otherwise mail all day; the rest follow what a person
-- would expect to be told about.
ALTER TABLE "NotificationPreference" ADD COLUMN "emailInboundMessage" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NotificationPreference" ADD COLUMN "emailTemplateStatus" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NotificationPreference" ADD COLUMN "emailMessageFailed" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NotificationPreference" ADD COLUMN "emailWeeklySummary" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NotificationPreference" ADD COLUMN "emailProductNews" BOOLEAN NOT NULL DEFAULT false;

-- Addresses SES told us to stop mailing (bounce/complaint), plus anyone who
-- unsubscribed. Checked before every send.
CREATE TABLE "MailSuppression" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailSuppression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MailSuppression_email_key" ON "MailSuppression"("email");
CREATE INDEX "MailSuppression_createdAt_idx" ON "MailSuppression"("createdAt");

-- One row per email, so "did we tell them?" has an answer.
CREATE TABLE "MailLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "email" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "messageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MailLog_userId_idx" ON "MailLog"("userId");
CREATE INDEX "MailLog_kind_createdAt_idx" ON "MailLog"("kind", "createdAt");
