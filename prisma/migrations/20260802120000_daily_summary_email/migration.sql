-- A daily summary replaces telling people about failures as they happen.
--
-- A failed send used to raise a push immediately and an email on the hour,
-- and a bad campaign turned that into a stream of interruptions about
-- something nobody can act on message by message. Failures now arrive once a
-- day, in a summary that also carries what was sent and what came back.
--
-- The three columns that drove the old behaviour go with it: the failure push,
-- the failed-send email, and the hourly inbound digest whose content the daily
-- summary now covers. Dropping them loses each user's switch for mail that no
-- longer exists.
--
-- The new column defaults to true so that everyone who was being told about
-- failures still is — once a day instead of hourly — rather than going quiet.

ALTER TABLE "NotificationPreference"
  ADD COLUMN "emailDailySummary" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "NotificationPreference" DROP COLUMN "messageFailed";
ALTER TABLE "NotificationPreference" DROP COLUMN "emailMessageFailed";
ALTER TABLE "NotificationPreference" DROP COLUMN "emailInboundMessage";
