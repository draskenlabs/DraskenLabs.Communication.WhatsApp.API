-- What was actually taken, and how.
--
-- The console could say a subscription was active but not what it had cost or
-- which card paid for it, because nothing here recorded a charge — the amount
-- only ever existed in Razorpay's dashboard.

CREATE TABLE "SubscriptionPayment" (
    "id" SERIAL NOT NULL,
    "subscriptionId" INTEGER NOT NULL,
    "razorpayPaymentId" TEXT NOT NULL,
    "razorpayInvoiceId" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL,
    "method" TEXT,
    "methodDetail" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- Their webhooks retry; a replayed charge must not become a second row.
CREATE UNIQUE INDEX "SubscriptionPayment_razorpayPaymentId_key"
    ON "SubscriptionPayment"("razorpayPaymentId");

CREATE INDEX "SubscriptionPayment_subscriptionId_idx"
    ON "SubscriptionPayment"("subscriptionId");

ALTER TABLE "SubscriptionPayment"
    ADD CONSTRAINT "SubscriptionPayment_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
