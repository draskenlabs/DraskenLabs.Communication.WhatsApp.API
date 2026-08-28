-- ---------------------------------------------------------------------------
-- The bullets stop restating the numbers.
--
-- Every limit on a plan card is already a column — `includedWabas`,
-- `maxApiKeysPerWaba`, `maxMessagesPerMinute` and the rest — and those columns
-- are what enforcement reads. Publishing the same figures again as sentences
-- gave the card two sources for one fact, and the console rendered both: nine
-- lines that read as prose, with every number buried mid-sentence where
-- nothing could line them up between one tier and the next.
--
-- So the numeric bullets go and the console renders the columns instead. What
-- is left is what a column cannot say. Every label below was already published
-- on its own plan before this migration — nothing new is claimed here, and
-- "Multi-WABA management" goes with the numeric ones because the account count
-- beside it now says the same thing better.
-- ---------------------------------------------------------------------------

DELETE FROM "PlanFeature"
WHERE "planId" IN (
    SELECT "id" FROM "Plan" WHERE "code" IN ('starter', 'growth', 'business')
);

INSERT INTO "PlanFeature" ("planId", "label", "sortOrder")
SELECT p."id", f."label", f."sortOrder"
FROM "Plan" p
JOIN (VALUES
    ('starter',  'API access',                  1),
    ('starter',  'Unlimited message templates', 2),
    ('starter',  'Basic analytics',             3),
    ('starter',  'Standard support',            4),

    ('growth',   'Advanced analytics',          1),
    ('growth',   'Priority support',            2),

    ('business', 'Advanced analytics',          1),
    ('business', 'Priority support',            2)
) AS f("code", "label", "sortOrder") ON f."code" = p."code";
