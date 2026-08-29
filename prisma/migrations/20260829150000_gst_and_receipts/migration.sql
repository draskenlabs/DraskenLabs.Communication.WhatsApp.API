-- GST identity on the customer, the tax split on the invoice, and receipts.
--
-- Everything added here is nullable or defaulted, so an invoice raised before
-- this migration stays exactly as it was issued: no tax split, no place of
-- supply. A document is a record of what was stated at the time, and
-- backfilling one would be rewriting it.

-- The customer's tax identity. `stateCode` is the load-bearing column: it is
-- the place of supply, which decides CGST+SGST against IGST. An unregistered
-- customer still has a state, which is why it is separate from `gstin`.
ALTER TABLE "OrganisationSettings"
  ADD COLUMN "gstin"             TEXT,
  ADD COLUMN "legalName"         TEXT,
  ADD COLUMN "billingAddress"    TEXT,
  ADD COLUMN "billingCity"       TEXT,
  ADD COLUMN "billingPostalCode" TEXT,
  ADD COLUMN "stateCode"         TEXT;

-- How the tax on an invoice divides, and the customer identity it was divided
-- against. Defaulted to zero so every existing row still satisfies
-- cgst + sgst + igst = taxAmount, which for those rows is 0 = 0.
ALTER TABLE "Invoice"
  ADD COLUMN "cgstAmount"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "sgstAmount"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "igstAmount"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "billedToGstin"     TEXT,
  ADD COLUMN "billedToAddress"   TEXT,
  ADD COLUMN "placeOfSupply"     TEXT,
  ADD COLUMN "placeOfSupplyCode" TEXT,
  ADD COLUMN "sacCode"           TEXT;

-- The money acknowledged, as its own numbered document. One per invoice.
CREATE TABLE "Receipt" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "razorpayPaymentId" TEXT NOT NULL,
    "ssoOrgId" TEXT NOT NULL,
    "billedToName" TEXT,
    "billedToEmail" TEXT,
    "organisationName" TEXT,
    "summary" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "paymentMethod" TEXT,
    "paymentReference" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedAt" TIMESTAMP(3),
    "emailedAt" TIMESTAMP(3),
    "emailedTo" TEXT,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- Its own counter, never the invoice's. A gap in the invoice series is what an
-- auditor reads for; a receipt must not be able to punch one.
CREATE TABLE "ReceiptCounter" (
    "financialYear" TEXT NOT NULL,
    "nextSequence" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptCounter_pkey" PRIMARY KEY ("financialYear")
);

CREATE UNIQUE INDEX "Receipt_number_key" ON "Receipt"("number");
-- One receipt per invoice, and one per debit: a replayed webhook cannot raise
-- a second any more than it can raise a second invoice.
CREATE UNIQUE INDEX "Receipt_invoiceId_key" ON "Receipt"("invoiceId");
CREATE UNIQUE INDEX "Receipt_razorpayPaymentId_key" ON "Receipt"("razorpayPaymentId");
CREATE UNIQUE INDEX "Receipt_financialYear_sequence_key" ON "Receipt"("financialYear", "sequence");
CREATE INDEX "Receipt_ssoOrgId_issuedAt_idx" ON "Receipt"("ssoOrgId", "issuedAt");

ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
