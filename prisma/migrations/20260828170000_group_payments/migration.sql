-- A debit on an agency's group covers several clients at once, so the payment
-- belongs to the group rather than to any one of their subscriptions.
ALTER TABLE "SubscriptionPayment"
    ALTER COLUMN "subscriptionId" DROP NOT NULL,
    ADD COLUMN "billingGroupId" INTEGER;

CREATE INDEX "SubscriptionPayment_billingGroupId_idx"
    ON "SubscriptionPayment"("billingGroupId");

ALTER TABLE "SubscriptionPayment"
    ADD CONSTRAINT "SubscriptionPayment_billingGroupId_fkey"
    FOREIGN KEY ("billingGroupId") REFERENCES "AgencyBillingGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
