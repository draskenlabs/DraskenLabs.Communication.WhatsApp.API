-- Meta's full account of why a send failed.
--
-- The status webhook reports a failure as a code, a short title and a sentence
-- of detail: 131047 / "Re-engagement message" / "Message failed to send because
-- more than 24 hours have passed since the customer last replied to this
-- number." Only the title was kept, so the console had nothing specific to show
-- and fell back to guessing at the cause.
--
-- The title stays in `failureReason` — short labels are what the analytics
-- ranking groups by — and the two new columns carry the rest.
-- Nullable: messages that failed before this have no code or detail recorded.

ALTER TABLE "Message" ADD COLUMN "failureCode" INTEGER;
ALTER TABLE "Message" ADD COLUMN "failureDetail" TEXT;
