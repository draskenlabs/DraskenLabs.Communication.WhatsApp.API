-- Phone numbers are priced, not rationed.
--
-- The price list said both things at once: every tier published a per-number
-- price *and* a hard cap on numbers per account. On Starter the two could not
-- both be true — the cap was one, so the ₹199 could never be charged — and on
-- the tiers where it could, the customer paid for the same capacity twice:
-- once in a tier price that exists to allow more numbers, and again per number.
--
-- A number now costs what the price list says a number costs, on every tier.
-- What separates the tiers is what actually differs between them: how many
-- accounts, how large a team, how many endpoints, how much history.
UPDATE "Plan"
   SET "maxPhoneNumbersPerWaba" = NULL
 WHERE code IN ('starter', 'growth', 'business');

-- The bullets quoted the cap, so they have to go with it. Starter carries the
-- one line every tier inherits; the others repeated a number that no longer
-- distinguishes them.
UPDATE "PlanFeature"
   SET label = 'Unlimited phone numbers — the first on each account is included'
 WHERE label = '1 phone number per WABA';

DELETE FROM "PlanFeature"
 WHERE label IN ('3 phone numbers per WABA', '5 phone numbers per WABA');

-- Agency is quoted, so its line is about the rate rather than a ceiling.
UPDATE "PlanFeature"
   SET label = 'Volume pricing on phone numbers'
 WHERE label = 'Custom phone-number limits';
