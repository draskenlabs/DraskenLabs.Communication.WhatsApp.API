-- A phone number carries two Meta statuses, and the console had only one of
-- them. `codeVerificationStatus` is the number's own OTP registration;
-- `name_status` is where its *display name* stands with Meta's review, and it
-- is the one that decides whether recipients see a verified name.
--
-- Nullable rather than defaulted: "we have not asked Meta yet" is not the same
-- answer as "NONE", and Meta omits the field entirely for a number that has
-- not finished onboarding. Existing rows fill in on the next phone-number sync
-- or `phone_number_name_update` webhook.
ALTER TABLE "WabaPhoneNumber" ADD COLUMN "nameStatus" TEXT;
