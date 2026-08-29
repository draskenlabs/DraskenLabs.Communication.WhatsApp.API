# Module: Invoicing – Definition

## Purpose

Every captured subscription payment raises a **numbered tax invoice** in this
deployment's own series and emails it, as a PDF, to the person who took the
mandate out.

The invoice is addressed to whoever was **charged**. For an organisation paying
for itself that is itself. For an agency it is the agency — one mandate covers
several clients and only one account was debited — and the document carries a
line per client saying what the money bought.

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
| A line per client on an agency's debit | ✅ Yes | — |
| Multiple line items on a self-paid charge | ❌ No | One charge, one line: the add-on for extra numbers arrives inside the same total and is not broken out to us |

---

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/billing/invoices` | JWT | Every invoice that bought this organisation a month, newest first |
| GET | `/billing/invoices/:number` | JWT | One invoice |
| GET | `/billing/invoices/:number/pdf` | JWT | The same document that was emailed |
| GET | `/agency/invoices` | JWT (agency) | The agency's own, and its clients' |
| GET | `/agency/invoices/:number/pdf` | JWT (agency) | One of those |
| GET | `/admin/invoices` | Admin | Every invoice raised, searchable, with the undelivered count |
| GET | `/admin/invoices/:number/pdf` | Admin | Any document |
| POST | `/admin/invoices/:number/resend` | Admin | Send it again, to the address on it |

`SubscriptionPaymentDto` also carries `invoiceNumber`, so the console's payment
history can name and link the invoice for each debit.

Every customer-facing route is scoped, and a number belonging to somebody else
answers **404**, not 403 — the numbers are sequential, and any other answer
would make the whole series enumerable from one session. The route parameter is
checked against the series format before it reaches the database.

Three scopes, and the difference matters:

- **`/billing/invoices`** answers what bought *this* organisation a month: the
  invoices charged to it, plus the agency invoices carrying a line for it. A
  client holds no mandate, so without the second half its billing history would
  be empty for every month somebody else paid for it.
- **`/agency/invoices`** answers the agency's own plus its clients' — the
  clients' being what they paid for themselves before they were taken on, or
  after they were let go. An agency asked to explain a client's history needs
  the whole of it, and the client may have nobody left who can sign in.
- **`/admin/invoices`** is unscoped, which is the point: it is the only place a
  document can be found without knowing whose it is.

---

## Where it happens

```
POST /billing/webhook  (subscription.charged)
  └─ BillingService.handleWebhook
       ├─ a subscription of its own?
       │    ├─ recordPayment            → SubscriptionPayment row
       │    └─ InvoiceService.issueFor  → one line, addressed to the organisation
       └─ an agency's mandate?
            ├─ AgencyBillingService.applyToGroup → payment row on the group
            └─ InvoiceService.issueFor          → a line per client, addressed
                                                  to the agency

  issueFor (either path), only when status is `captured`
    ├─ drafts()   → what the debit was for
    ├─ apportion()→ divides the taxable value across it, by list price
    ├─ record()   → number + snapshot + lines, one transaction
    └─ deliver()  → MailNotifications.invoiceIssued (PDF attached)
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
   renamed or a client released next month cannot rewrite a document already
   sent — the client's name is on the line as it stood when the money moved.
5. **The lines add up to the subtotal, exactly.** An agency's debit is divided
   between clients by list price, and the last line absorbs the rounding
   remainder. A document whose column does not sum to its own total is worse
   than one with no column at all.
6. **An invoice outlives what it invoiced.** `Invoice.paymentId` is
   `ON DELETE SET NULL`, so closing an account removes the subscription and its
   payments but leaves the documents, as the Privacy Policy's retention table
   promises.
7. **Nothing here fails a webhook.** An invoice is raised on the back of money
   that has already moved; throwing would have Razorpay redeliver the charge
   rather than fix the document.
8. **The email is transactional.** It goes whether or not other notification
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
payment it invoices, the organisation charged (and the agency group, where it
was one), the snapshot of everything printed, the amounts, and when it was
emailed and to where.

`InvoiceLine` — what was charged for, one row per thing, each naming the
organisation it bought for. One line for a self-paid debit; one per client for
an agency's. This is what lets a client be shown the line that paid for its own
month on a document addressed to somebody else.

`InvoiceCounter` — one row per financial year, holding the next number.
