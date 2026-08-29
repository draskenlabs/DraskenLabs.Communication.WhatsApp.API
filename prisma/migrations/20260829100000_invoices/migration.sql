-- Give a payment a document.
--
-- The console could say a subscription was charged, and Razorpay could say the
-- same, but neither produced anything a customer could file: their dashboard
-- emails a receipt against an id no accountant can put in a return, and it is
-- their series, not ours, kept for as long as they choose to keep an account.
--
-- So every captured debit now raises an invoice of our own, numbered
-- INV-WAC-2627-0001 — a series per Indian financial year, starting again at 1
-- each 1 April, gapless and in order because that is what a statutory series
-- means.
--
-- The invoice is addressed to whoever was *charged*. For an agency that is the
-- agency: one mandate covers several clients, and the money left one account.
-- Which clients it bought for is what the lines say.
CREATE TABLE "Invoice" (
    "id"                SERIAL       NOT NULL,
    "number"            TEXT         NOT NULL,
    "financialYear"     TEXT         NOT NULL,
    "sequence"          INTEGER      NOT NULL,
    "razorpayPaymentId" TEXT         NOT NULL,
    "razorpayInvoiceId" TEXT,
    "paymentId"         INTEGER,
    "ssoOrgId"          TEXT         NOT NULL,
    "billingGroupId"    INTEGER,
    "billedToName"      TEXT,
    "billedToEmail"     TEXT,
    "organisationName"  TEXT,
    "summary"           TEXT,
    "paymentMethod"     TEXT,
    "periodStart"       TIMESTAMP(3),
    "periodEnd"         TIMESTAMP(3),
    "subtotal"          INTEGER      NOT NULL,
    "taxAmount"         INTEGER      NOT NULL DEFAULT 0,
    "taxRateBps"        INTEGER      NOT NULL DEFAULT 0,
    "taxLabel"          TEXT,
    "total"             INTEGER      NOT NULL,
    "currency"          TEXT         NOT NULL DEFAULT 'INR',
    "issuedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt"            TIMESTAMP(3),
    "emailedAt"         TIMESTAMP(3),
    "emailedTo"         TEXT,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- The number is the document's identity, so nothing may share one.
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- A statutory series is gapless *and* unique within its year.
CREATE UNIQUE INDEX "Invoice_financialYear_sequence_key"
    ON "Invoice"("financialYear", "sequence");

-- One debit, one invoice. This is what makes a webhook Razorpay retries under
-- a fresh event id invoice once rather than twice.
CREATE UNIQUE INDEX "Invoice_razorpayPaymentId_key"
    ON "Invoice"("razorpayPaymentId");

CREATE UNIQUE INDEX "Invoice_paymentId_key" ON "Invoice"("paymentId");
CREATE INDEX "Invoice_ssoOrgId_issuedAt_idx" ON "Invoice"("ssoOrgId", "issuedAt");
CREATE INDEX "Invoice_billingGroupId_idx" ON "Invoice"("billingGroupId");

-- SET NULL, not CASCADE: an invoice outlives what it invoiced. Closing an
-- account takes the subscription and its payments and leaves the documents,
-- which is what the retention policy already promises.
ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "SubscriptionPayment"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- What was charged for, one row per thing.
--
-- An agency's debit covers several clients on one payment, so a single
-- description could not say what the money bought. These can — and they are
-- also what lets a client be shown the line that paid for its own month.
CREATE TABLE "InvoiceLine" (
    "id"          SERIAL  NOT NULL,
    "invoiceId"   INTEGER NOT NULL,
    "ssoOrgId"    TEXT,
    "description" TEXT    NOT NULL,
    "detail"      TEXT,
    "planCode"    TEXT,
    "planName"    TEXT,
    "quantity"    INTEGER NOT NULL DEFAULT 1,
    "unitAmount"  INTEGER NOT NULL,
    "amount"      INTEGER NOT NULL,
    "position"    INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InvoiceLine_invoiceId_position_idx"
    ON "InvoiceLine"("invoiceId", "position");
CREATE INDEX "InvoiceLine_ssoOrgId_idx" ON "InvoiceLine"("ssoOrgId");

-- CASCADE here, unlike the payment above: a line is part of its document
-- rather than something the document points at.
ALTER TABLE "InvoiceLine"
    ADD CONSTRAINT "InvoiceLine_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The next number in each year's series.
--
-- Incremented by one INSERT ... ON CONFLICT ... RETURNING inside the
-- transaction that writes the invoice, so two webhooks arriving together
-- cannot be handed the same number and a rollback takes its number with it.
-- A counter derived from MAX(sequence) could do neither.
CREATE TABLE "InvoiceCounter" (
    "financialYear" TEXT         NOT NULL,
    "nextSequence"  INTEGER      NOT NULL DEFAULT 1,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("financialYear")
);
