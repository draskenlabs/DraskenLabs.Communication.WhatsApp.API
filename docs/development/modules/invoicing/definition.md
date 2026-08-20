# Module: Invoicing – Definition

## Purpose

Every captured subscription payment raises a **numbered tax invoice** in this
deployment's own series and emails it, as a PDF, to the person who took the
subscription out.

Before this, a customer who paid us had a row in Razorpay's dashboard and an
email from Razorpay quoting `pay_29QQoUBi66xm2f`. That is a receipt, not an
invoice: it carries a payment gateway's identifier rather than a document
number, it is a series we do not control, and it lives for as long as a
Razorpay account does — which is shorter than the seven or eight years tax law
expects an invoice to be produceable for.

---

## The series

```
INV-WAC-2627-0001
 │   │    │    └── position in that year's book, restarting at 1 each 1 April
 │   │    └─────── Indian financial year: 1 April 2026 to 31 March 2027
 │   └──────────── the book — one deployment, one series (`INVOICE_SERIES`)
 └──────────────── what the document is
```

- **The financial year is decided in Indian local time**, not the pod's. A
  payment captured at 03:00 IST on 1 April is the new year's first invoice; the
  same instant is 21:30 on 31 March in UTC, and numbering it from UTC would
  file it in a year that had already closed. `INVOICE_TIMEZONE` moves the
  boundary for a deployment invoicing from elsewhere.
- **The sequence has no gaps and no reuse.** It comes from `InvoiceCounter`,
  incremented by a single `INSERT … ON CONFLICT DO UPDATE … RETURNING` inside
  the same transaction that writes the invoice. Two webhooks arriving in the
  same second cannot be handed the same number, and a transaction that rolls
  back takes its number with it.
- **The sequence pads to four digits and then grows.** The ten-thousandth
  invoice of a year is `10000`, not a wrapped `0000` colliding with the first.
- **`INVOICE_SERIES` must not change once a deployment has issued invoices.**
  Two books under one name is the one thing a statutory series may not be.

---

## Scope

| Area | Included | Excluded |
|------|----------|---------|
| One invoice per captured payment | ✅ Yes | — |
| Our own gapless series, per financial year | ✅ Yes | — |
| PDF, emailed on issue | ✅ Yes | — |
| Listing and re-downloading in the console | ✅ Yes | — |
| Tax line, worked back out of an inclusive price | ✅ Yes | Multiple tax components (CGST/SGST split) |
| Backfilling invoices for payments taken before this shipped | ❌ No | Would number history out of order |
| Credit notes and refunds | ❌ No | Handled manually in Razorpay |
| Per-customer billing address, or a GSTIN from the customer | ❌ No | We hold no such field |
| Multiple line items | ❌ No | One charge, one line |

---

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/billing/invoices` | JWT | Every invoice for the organisation, newest first |
| GET | `/billing/invoices/:number` | JWT | One invoice |
| GET | `/billing/invoices/:number/pdf` | JWT | The same document that was emailed |

`SubscriptionPaymentDto` also carries `invoiceNumber`, so the console's payment
history can name and link the invoice for each debit.

All three are scoped to the organisation on the session, and a number belonging
to somebody else answers **404**, not 403 — the numbers are sequential, and any
other answer would make the whole series enumerable from one session. The route
parameter is checked against the series format before it reaches the database.

---

## Where it happens

```
POST /billing/webhook  (subscription.charged)
  └─ BillingService.handleWebhook
       ├─ recordPayment            → SubscriptionPayment row
       └─ InvoiceService.issueFor  → only when status is `captured`
            ├─ record()            → number + snapshot, one transaction
            └─ deliver()           → MailNotifications.invoiceIssued (PDF attached)
                                     → stamps emailedAt
```

An authorised-but-uncaptured payment is money the bank has held, not moved, and
a failed one is money that never will: neither is invoiced.

`BillingService.reconcile()` (hourly) also calls `InvoiceService.deliverPending()`,
which sends the invoices that were raised while mail was down.

---

## Business rules

1. **One debit, one invoice.** `Invoice.razorpayPaymentId` is unique. Razorpay
   retries webhooks — sometimes with a fresh event id, which the event table's
   own idempotency does not cover — and a retry must never draw a second
   number.
2. **The total is not derived.** It is what the bank moved. `subtotal` and
   `taxAmount` are how that total divides at the rate configured when the
   invoice was raised, and they always add back up to it.
3. **The price is inclusive.** The tax is worked back out of what was charged
   rather than added on top: the customer authorised a mandate for the listed
   price, and that is what is taken.
4. **Everything printed is snapshotted.** A plan renamed, an organisation
   renamed or an account disconnected next month cannot rewrite a document
   already sent.
5. **An invoice outlives what it invoiced.** `Invoice.paymentId` is
   `ON DELETE SET NULL`, so closing an account removes the subscription and its
   payments but leaves the documents, as the Privacy Policy's retention table
   promises.
6. **Nothing here fails a webhook.** An invoice is raised on the back of money
   that has already moved; throwing would have Razorpay redeliver the charge
   rather than fix the document.
7. **The email is transactional.** It goes whether or not other notification
   preferences are on — a suppressed address is still honoured.

---

## The document

`invoice.pdf.ts` writes the PDF by hand: a single A4 page of text and rules
using the base-14 fonts every reader carries. No dependency, because an invoice
is a header, a table and three totals, and a layout engine would be a large
amount of new supply chain for that.

Two consequences of the base-14 fonts:

- Text is WinAnsi-encoded, so amounts read `INR 499.00` rather than carrying a
  rupee sign — U+20B9 is not in that encoding, and a symbol that renders as a
  box on somebody's reader is worse than the ISO code an accountant reads
  anyway.
- A name outside Latin-1 is transliterated where it can be and dropped where it
  cannot, rather than corrupting the stream.

Attachments are the one thing SES's simple content cannot carry, so a message
with a file on it is assembled as MIME by `SesService.raw()` and handed over
raw. Everything else stays on the simple form.

---

## Configuration

All optional. A deployment that configures none of it still raises numbered
invoices and still emails them; it prints no seller address and shows no tax
line.

| Variable | Default | What it does |
|---|---|---|
| `INVOICE_SERIES` | `WAC` | The book. Set once, never change |
| `INVOICE_TIMEZONE` | `Asia/Kolkata` | Which local midnight the financial year turns at |
| `INVOICE_TAX_RATE_BPS` | `0` | Basis points — 1800 is 18% GST. Zero prints no tax line |
| `INVOICE_TAX_LABEL` | `GST` | What the tax is called on the document |
| `INVOICE_PLACE_OF_SUPPLY` | — | Printed under the customer's address |
| `INVOICE_SELLER_NAME` | `Drasken Labs Private Limited` | Who the invoice is from |
| `INVOICE_SELLER_ADDRESS` | — | Pipe-separated: one line per segment |
| `INVOICE_SELLER_EMAIL` | `SES_REPLY_TO` | — |
| `INVOICE_SELLER_WEBSITE` | — | — |
| `INVOICE_SELLER_GSTIN` / `_PAN` / `_CIN` | — | Printed where set |

---

## Data model

`Invoice` — the document: number, financial year, sequence, the Razorpay
payment it invoices, the organisation and account, the snapshot of everything
printed, the amounts, and when it was emailed and to where.

`InvoiceCounter` — one row per financial year, holding the next number.
