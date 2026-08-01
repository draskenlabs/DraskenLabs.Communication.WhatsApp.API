-- Meta's Graph API returns the string "NONE" rather than null for templates
-- that were never rejected, and the sync wrote it through verbatim. Clients
-- that render `rejectedReason` when it is truthy therefore showed "NONE" in an
-- error box on every approved template.
--
-- The sync and the status webhook now normalise the sentinel to NULL; this
-- clears the rows written before that fix. Rejection reasons are re-supplied by
-- Meta on the next status webhook or template sync, so no real data is lost.
UPDATE "MessageTemplate"
SET "rejectedReason" = NULL
WHERE "rejectedReason" IS NOT NULL
  AND upper(trim("rejectedReason")) = 'NONE';
