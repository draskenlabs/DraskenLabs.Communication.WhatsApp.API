/**
 * The invoice, as a PDF.
 *
 * A solid brand masthead over a ledger body: the green appears twice on the
 * page and nowhere else — the head, and the figure the reader came for —
 * and everything between them is type and rules. A document is read once,
 * filed, and printed by somebody's accounts team, so it is built for a
 * monochrome laser as much as for a screen.
 *
 * Light regardless of the reader's theme, and no external dependency: the
 * layout is content-stream operators over the shared engine, so a document
 * can never fail to render because a transitive dependency changed.
 */
import {
  AMOUNT_RIGHT,
  BOLD,
  BRAND,
  CONTENT_WIDTH,
  Colour,
  FAINT,
  GREY,
  MARGIN,
  PAD,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  Page,
  REGULAR,
  WHITE,
  assemble,
  formatAmount,
  formatDate,
  formatPeriod,
  formatRate,
  rupeesInWords,
  truncate,
} from './document.pdf';

export { formatAmount, formatRate, measure, toWinAnsi } from './document.pdf';

export interface InvoiceDocumentLine {
  description: string;
  /** A second, quieter line under it — a period, or who it was for. */
  detail?: string | null;
  /** Printed only when it is more than one, so an ordinary line stays clean. */
  quantity: number;
  unitAmount: number;
  amount: number;
}

/** What the seller half of the document says. Every field is optional. */
export interface InvoiceSeller {
  name: string;
  addressLines: string[];
  email?: string;
  website?: string;
  /** Indian GST identification number, printed where a deployment has one. */
  gstin?: string;
  pan?: string;
  /** Company registration / CIN. */
  registrationNumber?: string;
}

/** Everything printed on the customer half and the body. */
export interface InvoiceDocument {
  number: string;
  /** "2026-27", as a person writes it. */
  financialYearLabel: string;
  issuedAt: Date;
  paidAt: Date | null;

  billedToName: string | null;
  billedToEmail: string | null;
  organisationName: string | null;
  /** The customer's registration, as stated at issue. */
  billedToGstin?: string | null;
  /** Their address, newline-separated, as they entered it. */
  billedToAddress?: string | null;
  /** What the money bought, in a few words: "Growth", "3 client plans". */
  summary: string | null;

  /**
   * What is being charged for.
   *
   * A list rather than one description, because an agency's debit covers
   * several clients at once — one mandate, one payment, N subscriptions. The
   * document has to name them, or the agency cannot tell what it paid for and
   * the client cannot be shown its own line.
   */
  lines: InvoiceDocumentLine[];
  periodStart: Date | null;
  periodEnd: Date | null;

  subtotal: number;
  taxAmount: number;
  taxRateBps: number;
  taxLabel: string | null;
  /**
   * How the tax divides. Inside our own state it is CGST and SGST at half the
   * rate each; across a state line it is IGST at the whole rate. Exactly one
   * of the two shapes is ever non-zero.
   */
  cgstAmount?: number;
  sgstAmount?: number;
  igstAmount?: number;

  total: number;
  currency: string;

  /** "Visa ···· 4242", "UPI", as recorded against the payment. */
  paymentMethod: string | null;
  /** Razorpay's payment id, so a query can be traced to their dashboard. */
  paymentReference: string | null;
  /** The state the supply was made to, printed as "Karnataka (29)". */
  placeOfSupply?: string | null;
  /** Service classification, printed against every line: 998314. */
  sacCode?: string | null;
}

/** One row of the tax summary. */
interface TaxRow {
  label: string;
  rateBps: number;
  amount: number;
}

/* -------------------------------------------------------------------- *
 * Public entry point                                                    *
 * -------------------------------------------------------------------- */

export function renderInvoicePdf(
  invoice: InvoiceDocument,
  seller: InvoiceSeller,
): Buffer {
  const taxes = taxRows(invoice);
  const sheets: Page[] = [];

  /** A fresh sheet, under a slim continuation head rather than the full one. */
  const continuation = (): { page: Page; y: number } => {
    const page = new Page();
    sheets.push(page);
    return { page, y: continuationHead(page, invoice, seller) };
  };

  let page = new Page();
  sheets.push(page);

  let y = masthead(page, invoice, seller, taxes);
  y = parties(page, invoice, seller);
  y = facts(page, invoice, y);

  // The table may run onto further sheets. What sits below it — the totals
  // block and the amount in words — is a known height, so the last sheet is
  // told to keep room for it, and a table that fills a sheet exactly pushes
  // the totals onto one of their own rather than printing over the footer.
  const placed = table(page, invoice, y, reserve(invoice, taxes), continuation);
  page = placed.page;
  y = placed.y;

  y = totals(page, invoice, taxes, y);
  words(page, invoice, y);

  // Every sheet is a page of the same document and has to say so on its own:
  // one sheet of three, separated from the rest, must still be identifiable.
  sheets.forEach((sheet, index) => {
    footer(sheet, invoice, index + 1, sheets.length);
  });

  return assemble(sheets.map((sheet) => sheet.stream()));
}

/**
 * The tax summary, as rows.
 *
 * Derived rather than stored as text: the split was decided once, when the
 * invoice was raised, and this only decides how to say it. CGST and SGST are
 * each half the rate — 18% GST is 9 and 9 — which is why the rate on a row is
 * not simply the invoice's rate.
 */
function taxRows(invoice: InvoiceDocument): TaxRow[] {
  const { taxRateBps, taxLabel } = invoice;
  if (taxRateBps <= 0 || invoice.taxAmount <= 0) return [];

  const igst = invoice.igstAmount ?? 0;
  if (igst > 0) {
    return [{ label: 'IGST', rateBps: taxRateBps, amount: igst }];
  }

  const cgst = invoice.cgstAmount ?? 0;
  const sgst = invoice.sgstAmount ?? 0;
  if (cgst > 0 || sgst > 0) {
    const half = taxRateBps / 2;
    return [
      { label: 'CGST', rateBps: half, amount: cgst },
      { label: 'SGST', rateBps: half, amount: sgst },
    ];
  }

  // A rate with no split — an invoice raised before the split existed, or a
  // deployment taxing outside India. Still stated, under whatever it is called.
  return [
    {
      label: taxLabel ?? 'Tax',
      rateBps: taxRateBps,
      amount: invoice.taxAmount,
    },
  ];
}

/* -------------------------------------------------------------------- *
 * Masthead                                                              *
 * -------------------------------------------------------------------- */

/** White at `amount`, over the brand green. */
function tint(amount: number): Colour {
  return [
    BRAND[0] + (1 - BRAND[0]) * amount,
    BRAND[1] + (1 - BRAND[1]) * amount,
    BRAND[2] + (1 - BRAND[2]) * amount,
  ];
}

/** A solid brand block, reversed out, carrying the mark and the title. */
function masthead(
  page: Page,
  invoice: InvoiceDocument,
  seller: InvoiceSeller,
  taxes: TaxRow[],
): number {
  const height = 104;
  const top = PAGE_HEIGHT;
  page.fillRect(0, top - height, PAGE_WIDTH, height, BRAND);

  const centre = top - 52;
  // A white tile on green, inverting the console's own sidebar mark.
  page.roundedRect(MARGIN, centre - 15, 30, 30, 9, WHITE);
  page.roundedRect(MARGIN + 7, centre - 7, 16, 13, 5, BRAND);
  page.fillRect(MARGIN + 10, centre - 10, 4, 4, BRAND);

  page.text(MARGIN + 42, centre + 3, seller.name, BOLD, 14, WHITE);
  page.text(
    MARGIN + 42,
    centre - 10,
    'WhatsApp Business Platform',
    REGULAR,
    9,
    tint(0.85),
  );

  // "Tax invoice" is a claim, not a decoration: a document calling itself one
  // while charging no tax is wrong, and one that charged tax and does not say
  // so is not the document the customer's accountant needs.
  const title = taxes.length > 0 ? 'TAX INVOICE' : 'INVOICE';
  page.textRight(PAGE_WIDTH - MARGIN, centre + 4, title, BOLD, 16, WHITE);
  page.textRight(
    PAGE_WIDTH - MARGIN,
    centre - 11,
    invoice.number,
    REGULAR,
    10,
    tint(0.85),
  );

  return top - height - 26;
}

/**
 * The head of a second or later sheet.
 *
 * A slim band rather than the full masthead: the letterhead has been stated,
 * and repeating it would push the rows it exists to make room for onto yet
 * another sheet. It still names the document, because a sheet separated from
 * the rest has to be identifiable on its own.
 */
function continuationHead(
  page: Page,
  invoice: InvoiceDocument,
  seller: InvoiceSeller,
): number {
  const height = 54;
  page.fillRect(0, PAGE_HEIGHT - height, PAGE_WIDTH, height, BRAND);

  const baseline = PAGE_HEIGHT - 32;
  page.text(MARGIN, baseline, seller.name, BOLD, 11, WHITE);
  page.textRight(
    PAGE_WIDTH - MARGIN,
    baseline,
    `${invoice.number} — continued`,
    REGULAR,
    9.5,
    tint(0.85),
  );

  return PAGE_HEIGHT - height - 34;
}

/* -------------------------------------------------------------------- *
 * Who                                                                   *
 * -------------------------------------------------------------------- */

function parties(
  page: Page,
  invoice: InvoiceDocument,
  seller: InvoiceSeller,
): number {
  const gap = 16;
  const colWidth = (CONTENT_WIDTH - gap) / 2;
  const top = PAGE_HEIGHT - 104 - 26;

  const from = [
    ...seller.addressLines,
    ...(seller.gstin ? [`GSTIN  ${seller.gstin}`] : []),
    ...(seller.pan ? [`PAN  ${seller.pan}`] : []),
    ...(seller.email ? [seller.email] : []),
  ];

  const to = [
    ...(invoice.billedToAddress
      ? invoice.billedToAddress.split('\n').filter(Boolean)
      : []),
    ...(invoice.billedToName ? [invoice.billedToName] : []),
    ...(invoice.billedToEmail ? [invoice.billedToEmail] : []),
    // Said either way. A customer who has not given one needs to know that is
    // why they cannot claim the tax, rather than finding out at their return.
    invoice.billedToGstin
      ? `GSTIN  ${invoice.billedToGstin}`
      : 'GSTIN  Not provided — no input credit',
  ];

  const rows = Math.max(from.length, to.length);
  const height = PAD + 10 + 16 + rows * 12 + PAD - 4;

  const column = (x: number, label: string, name: string, lines: string[]) => {
    let ly = top - PAD - 4;
    page.tracked(x, ly, label, 7, FAINT);
    ly -= 16;
    page.text(x, ly, truncate(name, BOLD, 11, colWidth), BOLD, 11);
    ly -= 15;
    for (const line of lines) {
      page.text(
        x,
        ly,
        truncate(line, REGULAR, 8.5, colWidth),
        REGULAR,
        8.5,
        GREY,
      );
      ly -= 12;
    }
  };

  column(MARGIN, 'FROM', seller.name, from);
  column(
    MARGIN + colWidth + gap,
    'BILLED TO',
    invoice.organisationName ?? invoice.billedToName ?? 'Customer',
    to,
  );

  const bottom = top - height + 6;
  page.rule(MARGIN, bottom, PAGE_WIDTH - MARGIN);
  return bottom - 22;
}

/* -------------------------------------------------------------------- *
 * The document's own facts                                              *
 * -------------------------------------------------------------------- */

function facts(page: Page, invoice: InvoiceDocument, top: number): number {
  const cells: [string, string][] = [
    ['INVOICE NUMBER', invoice.number],
    ['INVOICE DATE', formatDate(invoice.issuedAt)],
    ['FINANCIAL YEAR', invoice.financialYearLabel],
    ...(invoice.placeOfSupply
      ? ([['PLACE OF SUPPLY', invoice.placeOfSupply]] as [string, string][])
      : []),
  ];

  const height = 44;
  const cell = CONTENT_WIDTH / cells.length;
  cells.forEach(([label, value], index) => {
    const x = MARGIN + index * cell;
    page.tracked(x, top - 17, label, 6.5, FAINT);
    page.text(x, top - 31, truncate(value, BOLD, 9.5, cell - PAD), BOLD, 9.5);
  });

  page.rule(MARGIN, top - height + 6, PAGE_WIDTH - MARGIN);
  return top - height - 14;
}

/* -------------------------------------------------------------------- *
 * What the money bought                                                 *
 * -------------------------------------------------------------------- */

/** The footer's rule. Nothing in the body may cross it. */
const FOOTER_TOP = MARGIN + 46 + 24;
/** Clear air between the last row of the table and that rule. */
const GAP = 24;
/** Clear air between the amount in words and that rule. Tighter: it is the
 * last line of the document, and the rule is what separates it from the
 * footer rather than something it has to avoid. */
const TAIL_GAP = 8;

/** Height of one row of the totals panel, and of its emphasised total. */
const TOTALS_ROW = 17;
const TOTALS_BAND = 34;

/**
 * How much room the totals block and the amount in words will need.
 *
 * Computed rather than guessed, because it varies: an intra-state supply has
 * two tax rows where an inter-state one has a single IGST row, and a document
 * in a currency other than rupees prints no words at all.
 */
function reserve(invoice: InvoiceDocument, taxes: TaxRow[]): number {
  const rows = 1 + taxes.length;
  const totals = PAD - 2 + rows * TOTALS_ROW + TOTALS_BAND + 8;
  // The words block hangs 20 below the totals panel and is itself 14 tall.
  const words = invoice.currency === 'INR' ? 20 + 14 : 0;
  return totals + words;
}

/**
 * The table's vertical rhythm, named rather than sprinkled as bare numbers.
 *
 * A separator looks centred when the space above it is a little smaller than
 * the space below: under the rule the next row's cap-height eats ~7pt before
 * any ink appears, so equal gaps read as a rule sitting too low. 10 above and
 * 18 below is what makes the row pitch look even.
 */
const ROW_DETAIL = 13;
const ROW_PAD = 10;
const ROW_LEAD = 18;

/** The column geometry, shared by the header and every row under it. */
interface Columns {
  itemised: boolean;
  qtyRight: number;
  rateRight: number;
  sacRight: number;
  sac: string | null;
  room: number;
}

function columnsFor(invoice: InvoiceDocument): Columns {
  const itemised = invoice.lines.some((line) => line.quantity > 1);
  const qtyRight = AMOUNT_RIGHT - 168;
  const rateRight = AMOUNT_RIGHT - 84;
  const sacRight = AMOUNT_RIGHT - (itemised ? 240 : 150);
  const sac = invoice.sacCode ?? null;
  const rightmost = sac ? sacRight : itemised ? qtyRight : AMOUNT_RIGHT;
  return {
    itemised,
    qtyRight,
    rateRight,
    sacRight,
    sac,
    room: rightmost - MARGIN - PAD - 12,
  };
}

/** The column headings and the rule under them. Repeated on every sheet. */
function tableHead(page: Page, y: number, columns: Columns): number {
  page.tracked(MARGIN + PAD, y, 'DESCRIPTION', 6.5, GREY);
  if (columns.sac) {
    page.textRight(columns.sacRight + 34, y, 'SAC', BOLD, 6.5, GREY);
  }
  if (columns.itemised) {
    page.textRight(columns.qtyRight, y, 'QTY', BOLD, 6.5, GREY);
    page.textRight(columns.rateRight, y, 'RATE', BOLD, 6.5, GREY);
  }
  page.textRight(AMOUNT_RIGHT, y, 'AMOUNT', BOLD, 6.5, GREY);

  const next = y - ROW_PAD;
  page.rule(MARGIN + PAD, next, PAGE_WIDTH - MARGIN - PAD);
  return next - ROW_LEAD;
}

/**
 * One row, on the baseline it was given. Returns the baseline of whatever the
 * row's last line turned out to be — a row with a sub-caption is two lines
 * tall, and the separator has to hang off the bottom of the block rather than
 * off the description, or the pitch goes ragged wherever one row has a caption
 * and its neighbour does not.
 */
function tableRow(
  page: Page,
  invoice: InvoiceDocument,
  line: InvoiceDocumentLine,
  y: number,
  columns: Columns,
): number {
  page.text(
    MARGIN + PAD,
    y,
    truncate(line.description, REGULAR, 10, columns.room),
    REGULAR,
    10,
  );
  if (columns.sac) {
    page.textRight(columns.sacRight + 34, y, columns.sac, REGULAR, 8.5, GREY);
  }
  if (columns.itemised) {
    page.textRight(
      columns.qtyRight,
      y,
      String(line.quantity),
      REGULAR,
      10,
      GREY,
    );
    page.textRight(
      columns.rateRight,
      y,
      formatAmount(line.unitAmount, invoice.currency),
      REGULAR,
      10,
      GREY,
    );
  }
  page.textRight(
    AMOUNT_RIGHT,
    y,
    formatAmount(line.amount, invoice.currency),
    REGULAR,
    10,
  );

  if (line.detail) {
    const detailY = y - ROW_DETAIL;
    page.text(MARGIN + PAD, detailY, line.detail, REGULAR, 8.5, FAINT);
    return detailY;
  }
  return y;
}

/**
 * The line items, across as many sheets as they need.
 *
 * Every client on an agency's mandate gets a row: the agency cannot rebill
 * from a document that shows eight of its twenty clients, so the table runs
 * onto another sheet rather than truncating. The rows are placed greedily
 * against the footer, and only the sheet that ends up last has to keep room
 * for the totals — which is why the check for that comes after the loop.
 */
function table(
  page: Page,
  invoice: InvoiceDocument,
  top: number,
  needed: number,
  continuation: () => { page: Page; y: number },
): { page: Page; y: number } {
  const columns = columnsFor(invoice);
  const rowHeight = ROW_PAD + ROW_LEAD;
  const floor = FOOTER_TOP + GAP;

  let sheet = page;
  let y = tableHead(sheet, top, columns);

  invoice.lines.forEach((line, index) => {
    // What this row will actually occupy: the baseline, the separator and the
    // lead under it, plus a second line where it carries a sub-caption. A row
    // measured as if it had none would be placed with room for one line and
    // then draw two.
    const height = rowHeight + (line.detail ? ROW_DETAIL : 0);
    if (y - height < floor) {
      const next = continuation();
      sheet = next.page;
      y = tableHead(sheet, next.y, columns);
    }

    y = tableRow(sheet, invoice, line, y, columns);

    if (index < invoice.lines.length - 1) {
      y -= ROW_PAD;
      sheet.rule(MARGIN + PAD, y, PAGE_WIDTH - MARGIN - PAD);
      y -= ROW_LEAD;
    } else {
      y -= ROW_DETAIL;
    }
  });

  const period = formatPeriod(invoice.periodStart, invoice.periodEnd);
  if (period) {
    if (y - ROW_DETAIL < floor) {
      const next = continuation();
      sheet = next.page;
      y = next.y;
    }
    sheet.text(MARGIN + PAD, y, period, REGULAR, 8.5, GREY);
    y -= ROW_DETAIL;
  }

  // The rule that closes the table sits the same distance below the last line
  // as the separators do below theirs.
  y -= ROW_PAD - ROW_DETAIL + 6;
  sheet.rule(MARGIN, y, PAGE_WIDTH - MARGIN);
  y -= 26;

  // Only now is it known which sheet is last. If the totals will not fit on
  // it, they get one of their own rather than printing over the footer.
  if (y - needed < FOOTER_TOP + TAIL_GAP) {
    const next = continuation();
    sheet = next.page;
    y = next.y;
  }
  return { page: sheet, y };
}

/* -------------------------------------------------------------------- *
 * How much                                                              *
 * -------------------------------------------------------------------- */

function totals(
  page: Page,
  invoice: InvoiceDocument,
  taxes: TaxRow[],
  top: number,
): number {
  // The panel's right edge is the page's right edge, so the amounts inside it
  // land on `AMOUNT_RIGHT` — the same column the line items use.
  const width = 268;
  const x = PAGE_WIDTH - MARGIN - width;
  const labelX = x + PAD;

  const rows: [string, string][] = [
    ['Taxable value', formatAmount(invoice.subtotal, invoice.currency)],
    ...taxes.map(
      (tax) =>
        [
          `${tax.label} @ ${formatRate(tax.rateBps)}`,
          formatAmount(tax.amount, invoice.currency),
        ] as [string, string],
    ),
  ];

  const rowHeight = 17;
  const totalHeight = 34;
  const height = PAD - 2 + rows.length * rowHeight + totalHeight + 8;

  let y = top - PAD - 4;
  for (const [label, value] of rows) {
    page.text(labelX, y, label, REGULAR, 9.5, GREY);
    page.textRight(AMOUNT_RIGHT, y, value, REGULAR, 9.5);
    y -= rowHeight;
  }

  // Both halves of the total row sit on one baseline computed from the box,
  // rather than each being nudged into place separately.
  const bandTop = y + 6;
  const baseline = bandTop - totalHeight / 2 - 4;

  page.rule(labelX, bandTop, AMOUNT_RIGHT);
  page.text(labelX, baseline, 'Total paid', BOLD, 11);
  page.textRight(
    AMOUNT_RIGHT,
    baseline,
    formatAmount(invoice.total, invoice.currency),
    BOLD,
    14,
    // Under a brand masthead the page would otherwise be green at the top and
    // monochrome everywhere else. One accent, on the figure the reader came
    // for, ties the two halves of the page together.
    BRAND,
  );

  // The declarations sit opposite the panel, on the same top line.
  let noteY = top - PAD - 4;
  if (taxes.length > 0) {
    // "inclusive of CGST" is wrong on a split supply — the price is inclusive
    // of the whole of GST, of which CGST is one half.
    const name = taxes.length === 1 ? taxes[0].label : 'GST';
    for (const note of [
      `The price charged is inclusive of ${name}.`,
      'Tax payable under reverse charge: No.',
    ]) {
      page.text(MARGIN, noteY, note, REGULAR, 8.5, GREY);
      noteY -= 13;
    }
  }

  return Math.min(top - height, noteY) - 20;
}

/** The total in words, which an Indian tax invoice is expected to carry. */
function words(page: Page, invoice: InvoiceDocument, top: number): void {
  if (invoice.currency !== 'INR') return;
  page.tracked(MARGIN, top, 'AMOUNT IN WORDS', 6.5, FAINT);
  page.text(MARGIN, top - 14, rupeesInWords(invoice.total), BOLD, 9.5);
}

/* -------------------------------------------------------------------- *
 * Footer                                                                *
 * -------------------------------------------------------------------- */

function footer(
  page: Page,
  invoice: InvoiceDocument,
  sheet: number,
  sheets: number,
): void {
  const y = MARGIN + 46;
  page.rule(MARGIN, y + 24, PAGE_WIDTH - MARGIN);

  const paid = [
    invoice.paidAt ? `Paid on ${formatDate(invoice.paidAt)}` : null,
    invoice.paymentMethod ? `by ${invoice.paymentMethod}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  const left = [
    paid ? `${paid}. No amount is outstanding.` : null,
    invoice.paymentReference ? `Reference ${invoice.paymentReference}` : null,
  ].filter(Boolean) as string[];

  const right = [
    'This is a computer-generated invoice and needs no signature.',
    'WhatsApp is a trademark of Meta Platforms, Inc. Drasken Labs is an',
    'independent Tech Provider, not affiliated with or endorsed by Meta.',
  ];

  // Only where there is more than one. "Page 1 of 1" is noise on a document
  // that is obviously whole.
  if (sheets > 1) {
    page.textRight(
      PAGE_WIDTH - MARGIN,
      y + 32,
      `Page ${sheet} of ${sheets}`,
      REGULAR,
      8,
      FAINT,
    );
  }

  // One leading for both columns, so the two halves of the footer sit on the
  // same lines rather than drifting apart down the page.
  const leading = 11;
  left.forEach((line, i) => {
    page.text(MARGIN, y - i * leading, line, REGULAR, 8.5, GREY);
  });
  right.forEach((line, i) => {
    page.textRight(
      PAGE_WIDTH - MARGIN,
      y - i * leading,
      line,
      REGULAR,
      7.5,
      FAINT,
    );
  });
}
