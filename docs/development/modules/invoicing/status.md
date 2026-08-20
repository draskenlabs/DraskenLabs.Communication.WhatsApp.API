# Module: Invoicing – Status

| Field | Value |
|-------|-------|
| Status | ✅ Implemented |
| Last Updated | 2026-08-20 |

## Implemented

- `Invoice` and `InvoiceCounter` — migration `20260820100000_invoices`.
- **The series.** `invoice.number.ts` holds the whole numbering rule as pure
  functions: the Indian financial year of an instant in a named time zone, the
  printed number, and the format check the route parameter is validated with.
  Pure because this is the part an auditor checks and the part a bug is most
  expensive in — it is tested without a database, a clock or a Nest context.
- **The counter.** One `INSERT … ON CONFLICT DO UPDATE … RETURNING` inside the
  transaction that writes the invoice. Proven against real Postgres: three
  charges delivered concurrently get three distinct numbers.
- **One debit, one invoice.** `Invoice.razorpayPaymentId` is unique, and the
  race between two deliveries of the same charge is caught as P2002 and
  resolved by reading the invoice the winner wrote.
- **The PDF**, written by hand in `invoice.pdf.ts` — one A4 page, base-14
  fonts, real Helvetica metrics so the amount column is actually right-aligned.
  The cross-reference table and declared stream length are asserted in the unit
  suite, because those are the two things a reader cannot recover from.
- **The email.** `MailNotifications.invoiceIssued` sends it as a transactional
  message with the PDF attached. `SesService.raw()` assembles the MIME —
  multipart/mixed holding a multipart/alternative, base64 bodies, RFC 2047
  subject encoding — because SES's simple content cannot carry attachments.
  `MailService` takes attachments as base64 so a failed send still replays
  correctly from the stored payload.
- **Delivery is recorded**, and `deliverPending()` (called from the hourly
  billing reconciliation) sends the invoices raised while mail was down. A
  deployment that had SES unconfigured when a customer was charged still gets
  the document out.
- `GET /billing/invoices`, `/billing/invoices/:number` and
  `/billing/invoices/:number/pdf`, all scoped to the session's organisation,
  all answering 404 rather than 403 for somebody else's number.
- `SubscriptionPaymentDto.invoiceNumber`, so the console's payment history
  names and links the invoice for each debit.
- Configuration: series, time zone, tax rate and label, place of supply and the
  seller block — every one optional, every default safe.

## Tested

- `invoice.number.spec.ts` — the year boundary from both sides, in IST and in
  UTC, the century roll, padding and growth past four digits, and the format
  check against an injection attempt.
- `invoice.pdf.spec.ts` — the file opens (header, xref offsets pointing at the
  real objects, declared stream length), it prints what identifies the
  document, it says "INVOICE" rather than "TAX INVOICE" where no tax was
  charged, an unbalanced `)` in a customer name cannot rewrite the page, and a
  name in a script the fonts cannot carry does not corrupt the stream.
- `invoice.service.spec.ts` — numbering, the retry that raises nothing,
  the inclusive-tax division adding back to the total, the snapshot, the
  delivery stamp, the unsent invoice left for the sweep, and never throwing at
  the webhook that called it.
- `ses.service.spec.ts` — the MIME: CRLF throughout, both bodies in the
  alternative part, the attachment named and disposed, every boundary closed,
  base64 wrapped at 76, and a header-injection attempt in a filename staying
  inside its quotes.
- `invoicing.int-spec.ts` — the whole path against real Postgres and a real
  HTTP exchange: a charge raises a numbered invoice, consecutive charges number
  in order, concurrent charges do not collide, a replayed webhook invoices
  once, an uncaptured payment invoices not at all, the email goes with the PDF
  attached, the sweep resends, and another organisation gets 404 for a number
  it does not own.

## Pending / not in scope

- **No backfill.** Payments taken before this shipped have no invoice.
  Numbering them now would put the series out of chronological order, which is
  worse than the gap in coverage.
- **One line item.** The add-on for additional phone numbers is charged by
  Razorpay on the next invoice and arrives inside the same total; we do not
  receive it broken out, so the document does not break it out either.
- **One tax line.** A CGST/SGST split — the same rate shown as two components
  for an intra-state supply — is what a registered Indian seller will want
  next, and is a rendering change plus two more columns rather than a rework.
- **No credit notes.** A refund is done in Razorpay's dashboard and leaves the
  invoice standing.
- **No customer billing address or GSTIN.** We hold neither, so a B2B customer
  cannot claim input credit against these invoices. Collecting them is the
  obvious next step, and would want them on the organisation rather than the
  user.
- **`INVOICE_SERIES` is not enforced as immutable.** Changing it after
  invoices exist splits one statutory series in two; nothing stops a deployment
  doing that except the warning in `.env.example`.

## Blockers

None.
