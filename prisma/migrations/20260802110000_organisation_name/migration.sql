-- The organisation's display name, so an email can say which one it is about.
--
-- Organisations live in the SSO. Anything without a user's token to call it
-- with — a Meta webhook, the billing cron — had an id and no way to turn it
-- into a name, so every email named the account and never the organisation.
-- Nullable: rows written before this have no name until the next connect.

ALTER TABLE "WabaOrganisation" ADD COLUMN "orgName" TEXT;
