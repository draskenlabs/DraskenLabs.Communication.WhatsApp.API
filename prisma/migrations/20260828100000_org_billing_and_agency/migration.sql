-- ---------------------------------------------------------------------------
-- Org-level billing, inclusion counts, and agency accounts.
--
-- Three things happen here, in this order because each depends on the last:
--
--   1. Plan limits stop being ceilings and become inclusion counts, so the
--      columns are renamed to say so. `maxWabas` meaning "how many you may
--      have" and "how many the price covers" are different products, and the
--      name is the only thing that keeps them apart in a call site.
--   2. New columns for the limits we did not have (API keys, contacts, send
--      rate), for the numbers a quoted deal needs (rank, ssoOrgId,
--      mandateCeiling), and for the WABA add-on price.
--   3. The price list is reseeded to the agreed figures, and every existing
--      per-WABA subscription is collapsed onto its organisation.
-- ---------------------------------------------------------------------------

-- 1 ------------------------------------------------------------------ rename
ALTER TABLE "Plan" RENAME COLUMN "maxWabas" TO "includedWabas";
ALTER TABLE "Plan" RENAME COLUMN "maxPhoneNumbersPerWaba" TO "includedPhoneNumbersPerWaba";

-- 2 ------------------------------------------------------------- new columns
ALTER TABLE "Plan"
    ADD COLUMN "additionalWabaPrice"  INTEGER,
    ADD COLUMN "includedClients"      INTEGER,
    ADD COLUMN "maxApiKeysPerWaba"    INTEGER,
    ADD COLUMN "maxContacts"          INTEGER,
    ADD COLUMN "maxMessagesPerMinute" INTEGER,
    ADD COLUMN "rank"                 INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "ssoOrgId"             TEXT,
    ADD COLUMN "mandateCeiling"       INTEGER;

CREATE INDEX "Plan_ssoOrgId_idx" ON "Plan"("ssoOrgId");

-- What this product knows about an organisation. The SSO owns organisations;
-- this is an annotation keyed by their id.
CREATE TABLE "OrganisationSettings" (
    "ssoOrgId"     TEXT NOT NULL,
    "agencyOrgId"  TEXT,
    "isAgency"     BOOLEAN NOT NULL DEFAULT false,
    "clientName"   TEXT,
    "convertedBy"  INTEGER,
    "convertedAt"  TIMESTAMP(3),
    "payerVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganisationSettings_pkey" PRIMARY KEY ("ssoOrgId")
);

CREATE INDEX "OrganisationSettings_agencyOrgId_idx" ON "OrganisationSettings"("agencyOrgId");

-- 3 ------------------------------------------------------------------ reseed
--
-- Every tier includes exactly one phone number per WABA now: the second onward
-- always bills, which is what makes the add-on sellable at all. Starter used to
-- cap at one, so its published ₹199 could never be charged.
--
-- `rank` is what `forOrg` sorts on. Quoted plans rank above every published
-- tier because that is what a customer is paying for; price cannot express it,
-- since a quoted plan has none.
UPDATE "Plan" SET
    "includedPhoneNumbersPerWaba" = 1,
    "additionalWabaPrice"         = 29900,
    "maxApiKeysPerWaba"           = 1,
    "maxWebhookEndpoints"         = 1,
    "maxMessagesPerMinute"        = 100,
    "maxContacts"                 = 1000,
    "rank"                        = 10
WHERE "code" = 'starter';

UPDATE "Plan" SET
    "includedPhoneNumbersPerWaba" = 1,
    "additionalWabaPrice"         = 29900,
    "maxApiKeysPerWaba"           = 5,
    "maxWebhookEndpoints"         = 5,
    "maxMessagesPerMinute"        = 500,
    "maxContacts"                 = 10000,
    "rank"                        = 20
WHERE "code" = 'growth';

UPDATE "Plan" SET
    "includedPhoneNumbersPerWaba" = 1,
    "additionalWabaPrice"         = 29900,
    "maxApiKeysPerWaba"           = 10,
    "maxWebhookEndpoints"         = 10,
    "maxMessagesPerMinute"        = 1000,
    "maxContacts"                 = 50000,
    "rank"                        = 30
WHERE "code" = 'business';

-- The two quoted cards. They carry no numbers on purpose: they are what a
-- visitor sees, and every real figure lives on the private plan row written
-- when a deal is signed.
UPDATE "Plan" SET "rank" = 40 WHERE "code" = 'agency';

INSERT INTO "Plan" (
    "code", "name", "audience", "price", "priceLabel", "currency", "unit",
    "additionalNumberPrice", "additionalWabaPrice",
    "includedWabas", "includedPhoneNumbersPerWaba", "includedClients",
    "maxTeamMembers", "maxWebhookEndpoints", "maxApiKeysPerWaba",
    "maxContacts", "maxMessagesPerMinute", "historyDays",
    "rank", "recommended", "ctaKind", "ctaLabel", "sortOrder", "updatedAt"
) VALUES (
    'custom', 'Custom',
    'One business with requirements the published tiers do not cover.',
    NULL, 'Custom', 'INR', 'Quoted for your volume',
    NULL, NULL,
    NULL, NULL, NULL,
    NULL, NULL, NULL,
    NULL, NULL, NULL,
    35, false, 'contact', 'Contact sales', 4, CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO NOTHING;

-- Agency sits last on the price list, after Custom.
UPDATE "Plan" SET "sortOrder" = 5 WHERE "code" = 'agency';

INSERT INTO "PlanFeature" ("planId", "label", "sortOrder")
SELECT p."id", f."label", f."sortOrder"
FROM "Plan" p
JOIN (VALUES
    ('custom', 'Negotiated WABA and number limits', 1),
    ('custom', 'Negotiated team and endpoint limits', 2),
    ('custom', 'Custom data retention', 3),
    ('custom', 'Advanced analytics', 4),
    ('custom', 'Priority support', 5)
) AS f("code", "label", "sortOrder") ON f."code" = p."code"
WHERE NOT EXISTS (
    SELECT 1 FROM "PlanFeature" pf WHERE pf."planId" = p."id"
);

-- 4 -------------------------------------------- subscriptions move to the org
--
-- One subscription per organisation from here on. Where an organisation holds
-- several, the one on the best-ranked plan survives and becomes the org's —
-- that is the tier they were already being given credit for, since `forOrg`
-- has always resolved organisation-wide limits from the best plan held.
--
-- The losers are not deleted. A subscription is a record of money, and one that
-- exists at Razorpay is not cancelled by dropping our row — it keeps trying to
-- debit. They are marked `superseded` so the sweep leaves them alone and a human
-- can reconcile them against Razorpay deliberately.
WITH ranked AS (
    SELECT
        s."id",
        s."ssoOrgId",
        ROW_NUMBER() OVER (
            PARTITION BY s."ssoOrgId"
            ORDER BY COALESCE(p."rank", 0) DESC, s."createdAt" ASC
        ) AS seat
    FROM "Subscription" s
    LEFT JOIN "Plan" p ON p."id" = s."planRefId"
    WHERE s."wabaId" IS NOT NULL
      AND s."status" NOT IN ('cancelled', 'expired', 'completed')
)
UPDATE "Subscription" s
SET "wabaId" = NULL
FROM ranked r
WHERE s."id" = r."id" AND r."seat" = 1;

WITH ranked AS (
    SELECT
        s."id",
        ROW_NUMBER() OVER (
            PARTITION BY s."ssoOrgId"
            ORDER BY COALESCE(p."rank", 0) DESC, s."createdAt" ASC
        ) AS seat
    FROM "Subscription" s
    LEFT JOIN "Plan" p ON p."id" = s."planRefId"
    WHERE s."wabaId" IS NOT NULL
      AND s."status" NOT IN ('cancelled', 'expired', 'completed')
)
UPDATE "Subscription" s
SET "status" = 'superseded'
FROM ranked r
WHERE s."id" = r."id" AND r."seat" > 1;
