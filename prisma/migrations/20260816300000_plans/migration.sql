-- The price list, as data.
--
-- Plans were a single Razorpay plan id in an environment variable: one price,
-- no limits, and nothing the console could render as a price list. This makes
-- them rows — four published tiers, their limits as columns because "how many
-- numbers may this account have" is a query rather than a document to parse,
-- and their feature bullets as a child table so a line can be reordered or
-- withdrawn without rewriting the plan.
--
-- Amounts are in paise, like every other amount in this schema.

CREATE TABLE "Plan" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "price" INTEGER,
    "priceLabel" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "unit" TEXT NOT NULL,
    "additionalNumberPrice" INTEGER,
    "maxWabas" INTEGER,
    "maxPhoneNumbersPerWaba" INTEGER,
    "maxTeamMembers" INTEGER,
    "maxWebhookEndpoints" INTEGER,
    "historyDays" INTEGER,
    "razorpayPlanId" TEXT,
    "inheritsPlanId" INTEGER,
    "recommended" BOOLEAN NOT NULL DEFAULT false,
    "ctaKind" TEXT NOT NULL DEFAULT 'subscribe',
    "ctaLabel" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");
-- One Razorpay plan backs at most one tier; two tiers sharing one would bill
-- the same amount whatever the price list said.
CREATE UNIQUE INDEX "Plan_razorpayPlanId_key" ON "Plan"("razorpayPlanId");
-- The pricing page's query: what is on offer, in order.
CREATE INDEX "Plan_active_sortOrder_idx" ON "Plan"("active", "sortOrder");

-- Self-reference: "Everything in Growth, plus:". RESTRICT, because deleting a
-- tier out from under the one above it would leave that card mid-sentence.
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_inheritsPlanId_fkey"
    FOREIGN KEY ("inheritsPlanId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PlanFeature" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PlanFeature_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlanFeature_planId_sortOrder_idx" ON "PlanFeature"("planId", "sortOrder");

ALTER TABLE "PlanFeature" ADD CONSTRAINT "PlanFeature_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Which published plan a subscription was sold from.
--
-- Nullable and RESTRICT on delete: `Subscription.planId` remains the Razorpay
-- plan actually charged, so an existing subscription keeps billing exactly as
-- agreed whatever happens to the price list, and a plan cannot be deleted
-- while somebody is still on it.
ALTER TABLE "Subscription" ADD COLUMN "planRefId" INTEGER;
CREATE INDEX "Subscription_planRefId_idx" ON "Subscription"("planRefId");
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planRefId_fkey"
    FOREIGN KEY ("planRefId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The published price list.
--
-- Seeded here rather than in a script: the console renders whatever is in this
-- table, so an empty one is a pricing page with no prices on it. Razorpay plan
-- ids are left null and filled in per deployment — they differ between test
-- and live accounts, and a plan id from the wrong account bills nothing.
-- ---------------------------------------------------------------------------

INSERT INTO "Plan" (
    "code", "name", "audience", "price", "priceLabel", "currency", "unit",
    "additionalNumberPrice", "maxWabas", "maxPhoneNumbersPerWaba",
    "maxTeamMembers", "maxWebhookEndpoints", "historyDays",
    "recommended", "ctaKind", "ctaLabel", "sortOrder", "updatedAt"
) VALUES
    ('starter', 'Starter',
     'Small businesses getting started with the WhatsApp Business API.',
     49900, NULL, 'INR', '/WABA/month', 19900,
     1, 1, 2, 2, 30,
     false, 'subscribe', 'Get started', 1, CURRENT_TIMESTAMP),
    ('growth', 'Growth',
     'Growing businesses and teams.',
     99900, NULL, 'INR', '/WABA/month', 19900,
     3, 3, 5, 10, 90,
     true, 'subscribe', 'Choose Growth', 2, CURRENT_TIMESTAMP),
    ('business', 'Business',
     'Businesses operating WhatsApp at scale.',
     199900, NULL, 'INR', '/WABA/month', 19900,
     10, 5, 15, NULL, 365,
     false, 'subscribe', 'Choose Business', 3, CURRENT_TIMESTAMP),
    ('agency', 'Agency',
     'Agencies, SaaS platforms and organisations managing multiple customer WABAs.',
     NULL, 'Custom', 'INR', 'Quoted for your volume', NULL,
     NULL, NULL, NULL, NULL, NULL,
     false, 'contact', 'Contact sales', 4, CURRENT_TIMESTAMP);

-- Each tier builds on the one below it, so a card lists only what is new.
UPDATE "Plan" SET "inheritsPlanId" = (SELECT "id" FROM "Plan" WHERE "code" = 'starter')
    WHERE "code" = 'growth';
UPDATE "Plan" SET "inheritsPlanId" = (SELECT "id" FROM "Plan" WHERE "code" = 'growth')
    WHERE "code" = 'business';

INSERT INTO "PlanFeature" ("planId", "label", "sortOrder")
SELECT p."id", f."label", f."sortOrder"
FROM "Plan" p
JOIN (VALUES
    ('starter', '1 WABA', 1),
    ('starter', '1 phone number per WABA', 2),
    ('starter', '2 team members', 3),
    ('starter', 'Unlimited message templates', 4),
    ('starter', 'API access', 5),
    ('starter', '2 webhook endpoints', 6),
    ('starter', '30-day message/event history', 7),
    ('starter', 'Basic analytics', 8),
    ('starter', 'Standard support', 9),

    ('growth', 'Up to 3 WABAs', 1),
    ('growth', '3 phone numbers per WABA', 2),
    ('growth', '5 team members', 3),
    ('growth', '10 webhook endpoints', 4),
    ('growth', '90-day message/event history', 5),
    ('growth', 'Advanced analytics', 6),
    ('growth', 'Multi-WABA management', 7),
    ('growth', 'Priority support', 8),

    ('business', 'Up to 10 WABAs', 1),
    ('business', '5 phone numbers per WABA', 2),
    ('business', '15 team members', 3),
    ('business', 'Unlimited webhook endpoints', 4),
    ('business', '1-year message/event history', 5),
    ('business', 'Advanced analytics', 6),
    ('business', 'Priority support', 7),

    ('agency', 'Custom WABA limits', 1),
    ('agency', 'Custom phone-number limits', 2),
    ('agency', 'Unlimited team members', 3),
    ('agency', 'Unlimited webhook endpoints', 4),
    ('agency', 'Extended/custom data retention', 5),
    ('agency', 'Advanced analytics', 6),
    ('agency', 'Multi-client/multi-WABA management', 7),
    ('agency', 'White-label options', 8),
    ('agency', 'Dedicated support', 9),
    ('agency', 'Custom integrations', 10)
) AS f("code", "label", "sortOrder") ON f."code" = p."code";
