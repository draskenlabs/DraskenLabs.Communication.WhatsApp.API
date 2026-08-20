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
CREATE TABLE "Invoice" (
    "id"                SERIAL       NOT NULL,
    "number"            TEXT         NOT NULL,
    "financialYear"     TEXT         NOT NULL,
    "sequence"          INTEGER      NOT NULL,
    "razorpayPaymentId" TEXT         NOT NULL,
    "razorpayInvoiceId" TEXT,
    "paymentId"         INTEGER,
    "ssoOrgId"          TEXT         NOT NULL,
    "wabaId"            TEXT,
    "billedToName"      TEXT,
    "billedToEmail"     TEXT,
    "organisationName"  TEXT,
    "accountName"       TEXT,
    "planName"          TEXT,
    "description"       TEXT         NOT NULL,
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

-- The number is the identity of the document; the payment id is what stops a
-- retried webhook raising a second one for the same debit.
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");
CREATE UNIQUE INDEX "Invoice_razorpayPaymentId_key" ON "Invoice"("razorpayPaymentId");
CREATE UNIQUE INDEX "Invoice_paymentId_key" ON "Invoice"("paymentId");
-- Two invoices in one financial year may not share a position in it, whatever
-- goes wrong upstream of the counter.
CREATE UNIQUE INDEX "Invoice_financialYear_sequence_key" ON "Invoice"("financialYear", "sequence");
CREATE INDEX "Invoice_ssoOrgId_issuedAt_idx" ON "Invoice"("ssoOrgId", "issuedAt");

-- ON DELETE SET NULL, not CASCADE: an invoice outlives what it invoiced. The
-- payment row goes with its subscription; the document has to stay for as long
-- as tax law says, which is years after an account is closed.
ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "SubscriptionPayment"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- The next number in each year's series.
--
-- A counter rather than MAX(sequence) + 1, because two webhooks arriving in the
-- same second would read the same maximum and be handed the same number. This
-- is incremented and read in one statement, inside the transaction that writes
-- the invoice: a rollback takes the number back with it, so the series has no
-- holes either.
CREATE TABLE "InvoiceCounter" (
    "financialYear" TEXT         NOT NULL,
    "nextSequence"  INTEGER      NOT NULL DEFAULT 1,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("financialYear")
);
