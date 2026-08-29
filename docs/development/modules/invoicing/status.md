# Module: Invoicing – Status

| Field | Value |
|-------|-------|
| Status | ✅ Implemented |
| Last Updated | 2026-08-29 |

## Implemented

- `Invoice`, `InvoiceLine` and `InvoiceCounter` — migration
  `20260829100000_invoices`.
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
- **Addressed to whoever was charged.** For an agency that is the agency: one
  mandate covers several clients and only one account was debited. The
  document then carries a line per client — `InvoiceLine.ssoOrgId` — which is
  what lets a client be shown the line that bought its month on an invoice it
  did not pay.
- **A client sees its own line and nobody else's.** The agency's document names
  every client on the mandate and what each costs, so a client reads it as an
  *extract*: its own lines, their total, and who paid. No tax breakdown (that
  divides the whole debit), no recipient address, and no PDF — the file cannot
  be partially rendered, and `findAddressedTo` refuses it. This was the one
  thing that had to be got right before shipping the feature.
- **The lines add up.** The taxable value is divided between clients by list
  price, and the last line absorbs the rounding remainder, so the column always
  sums to the document's own subtotal.
- **The PDF**, written by hand in `invoice.pdf.ts` — one A4 page, base-14
  fonts, real Helvetica metrics so the amount column is actually right-aligned.
  It grew a quantity/rate column that appears only when something is charged
  more than once, and says "and 8 more" rather than silently truncating a
  roster too long for the page. The cross-reference table and declared stream
  length are asserted in the unit suite, because those are the two things a
  reader cannot recover from.
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
- **Three scopes**: `/billing/invoices` (what bought *this* organisation a
  month, its own and the agency lines carrying it), `/agency/invoices` (its own
  and its clients'), `/admin/invoices` (unscoped, searchable, with a re-send).
- `SubscriptionPaymentDto.invoiceNumber`, so the console's payment history
  names and links the invoice for each debit.
- Configuration: series, time zone, tax rate and label, place of supply and the
  seller block — every one optional, every default safe.

## Tested

- `invoice.number.spec.ts` (10) — the year boundary from both sides, in IST and
  in UTC, the century roll, padding and growth past four digits, and the format
  check against an injection attempt.
- `invoice.pdf.spec.ts` (17) — the file opens (header, xref offsets pointing at
  the real objects, declared stream length), it prints what identifies the
  document, it itemises an agency's clients, it says how much of a long roster
  it is not showing, it shows a rate column only when something is charged more
  than once, it says "INVOICE" rather than "TAX INVOICE" where no tax was
  charged, an unbalanced `)` in a customer name cannot rewrite the page, and a
  name in a script the fonts cannot carry does not corrupt the stream.
- `invoice.service.spec.ts` (30) — numbering, the series fallback, the year
  decided in Indian local time, the retry that raises nothing, one line for a
  self-paid debit and one per client for an agency's, the agency's own label
  preferred to the directory's, a mandate charged with no clients left, the
  division by list price, the lines summing to the subtotal, the
  inclusive-tax division adding back to the total, the delivery stamp, the
  unsent invoice left for the sweep, who may read one, what a client is shown
  of an agency's document, and never throwing at the webhook that called it.
- `ses.service.spec.ts` — the MIME: CRLF throughout, both bodies in the
  alternative part, the attachment named and disposed, every boundary closed,
  base64 wrapped at 76, and a header-injection attempt in a filename staying
  inside its quotes.
- `invoicing.int-spec.ts` (13) — the whole path against real Postgres and a
  real HTTP exchange: a charge raises a numbered invoice joined to its debit,
  consecutive charges number in order, three concurrent charges do not collide,
  a replayed webhook invoices once, the email goes with a real PDF attached, an
  agency's debit raises one document itemised by client, a client sees the
  invoice that bought its month though it paid nothing, an agency sees its own
  and its clients', a client sees its own line and not its rivals', another
  organisation gets nothing for a number it does not own, and the sweep
  resends.

## Pending / not in scope

- **No backfill.** Payments taken before this shipped have no invoice.
  Numbering them now would put the series out of chronological order, which is
  worse than the gap in coverage.
- **One line on a self-paid charge.** The add-on for additional phone numbers
  is charged by Razorpay on the next invoice and arrives inside the same total;
  we do not receive it broken out, so the document does not break it out
  either. An agency's debit *is* itemised, because we know its composition.
- **One tax line.** A CGST/SGST split — the same rate shown as two components
  for an intra-state supply — is what a registered Indian seller will want
  next, and is a rendering change plus two more columns rather than a rework.
- **No credit notes.** A refund is done in Razorpay's dashboard and leaves the
  invoice standing.
- **No customer billing address or GSTIN.** We hold neither, so a B2B customer
  cannot claim input credit against these invoices. Collecting them is the
  obvious next step, and would want them on the organisation rather than the
  user.
- **`INVOICE_SERIES` is not enforced as immutable.** Changing it after invoices
  exist splits one statutory series in two; nothing stops a deployment doing
  that except the warning in `.env.example`.
- **A client sees an extract, not a per-client PDF.** It gets its own line and
  its own total; the file itself is the agency's whole debit and is not
  offered. Rendering a genuine per-client document is the next step if anybody
  asks for one — the lines already carry everything it would need.

## Blockers

None.
