-- A phone number that hasn't finished onboarding ("Pending sync") has no
-- last_onboarded_time in Meta's response. Allow the column to be null so the
-- connect flow can persist such numbers instead of failing on an Invalid Date.
ALTER TABLE "WabaPhoneNumber" ALTER COLUMN "lastOnboardedTime" DROP NOT NULL;
