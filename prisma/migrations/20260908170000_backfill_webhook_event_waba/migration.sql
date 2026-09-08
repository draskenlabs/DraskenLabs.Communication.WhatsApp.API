-- Repairs the rows the WABA-resolution bug misfiled.
--
-- `processPayload` used to take the WABA from `entry.id`, which is the WABA for
-- the `messages` field but is the *business* id for `account_update` — there
-- Meta names the account inside the change, in `waba_info.waba_id`. Every
-- account event across every tenant was therefore stored against one id that
-- belongs to none of them.
--
-- The payload was stored verbatim, so the right id is still in each row. This
-- moves the row to the account its own payload names, and touches nothing else:
-- rows that already agree, rows with no `waba_info`, and rows whose payload is
-- not an object are all left exactly as they are.
UPDATE "WebhookEvent"
SET "wabaId" = "payload" -> 'waba_info' ->> 'waba_id'
WHERE jsonb_typeof("payload") = 'object'
  AND jsonb_typeof("payload" -> 'waba_info') = 'object'
  AND "payload" -> 'waba_info' ->> 'waba_id' IS NOT NULL
  AND btrim("payload" -> 'waba_info' ->> 'waba_id') <> ''
  AND "payload" -> 'waba_info' ->> 'waba_id' <> "wabaId";
