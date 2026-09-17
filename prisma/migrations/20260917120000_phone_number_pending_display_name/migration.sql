-- A display name and a *rename* are two different reviews, and the console
-- was reading both off one column.
--
-- Meta keeps an approved name live while a newly requested one is reviewed:
-- `name_status` stays APPROVED and the requested name sits in
-- `new_display_name`/`new_name_status` until it is approved, declined or
-- expires. With only `nameStatus` to write to, a refused rename marked the
-- name that is actually in use as DECLINED, and a rename in review showed
-- nothing at all — the number looked settled while the customer waited.
--
-- Nullable, like `nameStatus`: no rename pending is the normal state, and
-- "we have not asked Meta" is not an answer worth inventing. Existing rows
-- fill in on the next sync or `phone_number_name_update` webhook.
ALTER TABLE "WabaPhoneNumber" ADD COLUMN "newDisplayName" TEXT;
ALTER TABLE "WabaPhoneNumber" ADD COLUMN "newNameStatus" TEXT;
