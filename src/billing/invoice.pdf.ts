/**
 * The invoice as a PDF, written by hand.
 *
 * An invoice that only exists as a row in our database is not an invoice; it
 * has to arrive as a file the customer can file, forward to an accountant and
 * still open in seven years. That argues for a real document rather than an
 * HTML email, and for the one format every operating system opens without
 * asking.
 *
 * No dependency, because none is needed: this draws text and rules on a single
 * A4 page using the base-14 fonts every PDF reader carries, which is the whole
 * of what an invoice is. A layout engine would be a large amount of new supply
 * chain for a document that is a header, a table and three totals.
 *
 * Two consequences of the base-14 fonts, both deliberate:
 *   - Text is encoded as WinAnsi, so amounts are written `INR 499.00` rather
 *     than with a rupee sign — U+20B9 is not in that encoding, and a currency
 *     symbol that renders as a box on somebody's reader is worse than the ISO
 *     code an accountant reads anyway.
 *   - Anything outside Latin-1 in a name is transliterated where it can be and
 *     dropped where it cannot, rather than corrupting the stream.
 */

/** A4, in points, which is the only unit PDF has. */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/** Font names as the page resources declare them. */
type Font = 'F1' | 'F2';
const REGULAR: Font = 'F1';
const BOLD: Font = 'F2';

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
  accountName: string | null;

  description: string;
  periodStart: Date | null;
  periodEnd: Date | null;

  subtotal: number;
  taxAmount: number;
  taxRateBps: number;
  taxLabel: string | null;
  total: number;
  currency: string;

  /** "Visa ···· 4242", "UPI", as recorded against the payment. */
  paymentMethod: string | null;
  /** Razorpay's payment id, so a query can be traced to their dashboard. */
  paymentReference: string | null;
  placeOfSupply?: string | null;
}

/* -------------------------------------------------------------------- *
 * Public entry point                                                    *
 * -------------------------------------------------------------------- */

export function renderInvoicePdf(
  invoice: InvoiceDocument,
  seller: InvoiceSeller,
): Buffer {
  const page = new Page();
  let y = PAGE_HEIGHT - MARGIN;

  y = drawHeader(page, invoice, seller, y);
  y = drawParties(page, invoice, seller, y);
  y = drawLineItems(page, invoice, y);
  drawTotals(page, invoice, y);
  // The footer anchors itself to the bottom of the page, so it needs no `y`.
  drawPaymentAndFooter(page, invoice);

  return assemble(page.stream());
}

/* -------------------------------------------------------------------- *
 * Sections                                                              *
 * -------------------------------------------------------------------- */

function drawHeader(
  page: Page,
  invoice: InvoiceDocument,
  seller: InvoiceSeller,
  top: number,
): number {
  let y = top;

  page.text(MARGIN, y, seller.name, BOLD, 15);
  // The title sits on the same line as the seller's name, hard right: it is
  // the first thing a person scanning a stack of documents looks for.
  const title = invoice.taxRateBps > 0 ? 'TAX INVOICE' : 'INVOICE';
  page.textRight(PAGE_WIDTH - MARGIN, y, title, BOLD, 15);
  y -= 18;

  const sellerLines = [
    ...seller.addressLines,
    ...(seller.gstin ? [`GSTIN: ${seller.gstin}`] : []),
    ...(seller.pan ? [`PAN: ${seller.pan}`] : []),
    ...(seller.registrationNumber ? [`CIN: ${seller.registrationNumber}`] : []),
    ...(seller.email ? [seller.email] : []),
    ...(seller.website ? [seller.website] : []),
  ];

  // The two columns are drawn together so the block ends below whichever ran
  // longer — a seller with a five-line address must not run into the table.
  const facts: [string, string][] = [
    ['Invoice number', invoice.number],
    ['Invoice date', formatDate(invoice.issuedAt)],
    ['Financial year', invoice.financialYearLabel],
  ];

  let leftY = y;
  for (const line of sellerLines) {
    page.text(MARGIN, leftY, line, REGULAR, 9, GREY);
    leftY -= 12;
  }

  let rightY = y;
  for (const [label, value] of facts) {
    page.textRight(
      PAGE_WIDTH - MARGIN - 150,
      rightY,
      `${label}`,
      REGULAR,
      9,
      GREY,
    );
    page.textRight(PAGE_WIDTH - MARGIN, rightY, value, BOLD, 9);
    rightY -= 13;
  }

  y = Math.min(leftY, rightY) - 12;
  page.rule(MARGIN, y, PAGE_WIDTH - MARGIN);
  return y - 24;
}

function drawParties(
  page: Page,
  invoice: InvoiceDocument,
  seller: InvoiceSeller,
  top: number,
): number {
  let y = top;

  page.text(MARGIN, y, 'BILLED TO', BOLD, 8, GREY);
  page.text(MARGIN + 280, y, 'FOR', BOLD, 8, GREY);
  y -= 15;

  const billed = [
    invoice.organisationName ?? invoice.billedToName ?? 'Customer',
    ...(invoice.organisationName && invoice.billedToName
      ? [invoice.billedToName]
      : []),
    ...(invoice.billedToEmail ? [invoice.billedToEmail] : []),
    ...(invoice.placeOfSupply
      ? [`Place of supply: ${invoice.placeOfSupply}`]
      : []),
  ];

  const forLines = [
    invoice.accountName ?? 'WhatsApp Business Account',
    ...(invoice.paymentReference ? [`Ref: ${invoice.paymentReference}`] : []),
  ];

  let leftY = y;
  billed.forEach((line, index) => {
    page.text(
      MARGIN,
      leftY,
      line,
      index === 0 ? BOLD : REGULAR,
      10,
      index === 0 ? INK : GREY,
    );
    leftY -= 13;
  });

  let rightY = y;
  forLines.forEach((line, index) => {
    page.text(
      MARGIN + 280,
      rightY,
      line,
      index === 0 ? BOLD : REGULAR,
      10,
      index === 0 ? INK : GREY,
    );
    rightY -= 13;
  });

  // `seller` is not printed again here; it is in the header. The parameter is
  // kept so the section signature matches the others and a future "supplier
  // address" block has somewhere obvious to go.
  void seller;

  return Math.min(leftY, rightY) - 18;
}

function drawLineItems(
  page: Page,
  invoice: InvoiceDocument,
  top: number,
): number {
  let y = top;
  const amountX = PAGE_WIDTH - MARGIN;

  page.fillRect(MARGIN, y - 6, CONTENT_WIDTH, 22, BAND);
  page.text(MARGIN + 8, y, 'DESCRIPTION', BOLD, 8, GREY);
  page.textRight(amountX - 8, y, 'AMOUNT', BOLD, 8, GREY);
  y -= 26;

  page.text(MARGIN + 8, y, invoice.description, REGULAR, 10);
  page.textRight(
    amountX - 8,
    y,
    formatAmount(invoice.subtotal, invoice.currency),
    REGULAR,
    10,
  );
  y -= 13;

  const period = formatPeriod(invoice.periodStart, invoice.periodEnd);
  if (period) {
    page.text(MARGIN + 8, y, period, REGULAR, 9, GREY);
    y -= 13;
  }

  y -= 6;
  page.rule(MARGIN, y, PAGE_WIDTH - MARGIN);
  return y - 20;
}

function drawTotals(page: Page, invoice: InvoiceDocument, top: number): void {
  let y = top;
  const labelX = PAGE_WIDTH - MARGIN - 130;
  const valueX = PAGE_WIDTH - MARGIN;

  const rows: [string, string][] = [
    ['Subtotal', formatAmount(invoice.subtotal, invoice.currency)],
  ];

  if (invoice.taxRateBps > 0) {
    const label = `${invoice.taxLabel ?? 'Tax'} @ ${formatRate(invoice.taxRateBps)}`;
    rows.push([label, formatAmount(invoice.taxAmount, invoice.currency)]);
  }

  for (const [label, value] of rows) {
    page.textRight(labelX, y, label, REGULAR, 10, GREY);
    page.textRight(valueX, y, value, REGULAR, 10);
    y -= 16;
  }

  y -= 2;
  page.rule(labelX - 60, y + 8, valueX);
  y -= 8;

  page.textRight(labelX, y, 'Total paid', BOLD, 11);
  page.textRight(
    valueX,
    y,
    formatAmount(invoice.total, invoice.currency),
    BOLD,
    11,
  );
  y -= 20;

  if (invoice.taxRateBps > 0) {
    // Stated rather than left to arithmetic: "was the price inclusive" is the
    // single most common question an invoice with tax on it gets asked.
    page.textRight(
      valueX,
      y,
      `The price charged is inclusive of ${invoice.taxLabel ?? 'tax'}.`,
      REGULAR,
      8,
      GREY,
    );
    y -= 14;
  }
}

function drawPaymentAndFooter(page: Page, invoice: InvoiceDocument): void {
  // Anchored to the bottom of the page rather than flowing after the totals:
  // the payment block is a footer, and a one-line invoice should not leave it
  // floating in the middle of an empty page.
  let y = MARGIN + 96;

  page.rule(MARGIN, y + 24, PAGE_WIDTH - MARGIN);

  const paid = invoice.paidAt
    ? `Paid on ${formatDate(invoice.paidAt)}`
    : 'Paid';
  const method = invoice.paymentMethod ? ` by ${invoice.paymentMethod}` : '';
  page.text(
    MARGIN,
    y,
    `${paid}${method}. No amount is outstanding.`,
    REGULAR,
    9,
    GREY,
  );
  y -= 13;

  if (invoice.paymentReference) {
    page.text(
      MARGIN,
      y,
      `Payment reference ${invoice.paymentReference}.`,
      REGULAR,
      9,
      GREY,
    );
    y -= 13;
  }

  y -= 8;
  page.text(
    MARGIN,
    y,
    'This is a computer-generated invoice and needs no signature.',
    REGULAR,
    8,
    FAINT,
  );
  y -= 11;
  page.text(
    MARGIN,
    y,
    'WhatsApp is a trademark of Meta Platforms, Inc. Drasken Labs is an independent Tech',
    REGULAR,
    8,
    FAINT,
  );
  y -= 10;
  page.text(
    MARGIN,
    y,
    'Provider and is not affiliated with or endorsed by Meta.',
    REGULAR,
    8,
    FAINT,
  );
}

/* -------------------------------------------------------------------- *
 * Formatting                                                            *
 * -------------------------------------------------------------------- */

/**
 * Minor units to a printed amount: 49900 paise is `INR 499.00`.
 *
 * Two decimal places for every currency Razorpay charges in, and the ISO code
 * rather than a symbol — see the note at the top of the file.
 */
export function formatAmount(minor: number, currency: string): string {
  const negative = minor < 0;
  const units = Math.abs(minor) / 100;
  const [whole, fraction] = units.toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${currency.toUpperCase()} ${grouped}.${fraction}`;
}

/** Basis points as a percentage: 1800 is "18%", 1250 is "12.5%". */
export function formatRate(bps: number): string {
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0+$/, '')}%`;
}

/** A date the way a customer would write it, not an ISO string. */
function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatPeriod(start: Date | null, end: Date | null): string | null {
  if (!start && !end) return null;
  if (start && end)
    return `Service period ${formatDate(start)} to ${formatDate(end)}`;
  return `Service period from ${formatDate((start ?? end) as Date)}`;
}

/* -------------------------------------------------------------------- *
 * The page                                                              *
 * -------------------------------------------------------------------- */

type Colour = [number, number, number];
const INK: Colour = [0.06, 0.09, 0.16];
const GREY: Colour = [0.4, 0.45, 0.5];
const FAINT: Colour = [0.6, 0.64, 0.69];
const BAND: Colour = [0.96, 0.97, 0.96];
const RULE: Colour = [0.89, 0.91, 0.93];

/** A content stream, built one operator at a time. */
class Page {
  private readonly ops: string[] = [];

  text(
    x: number,
    y: number,
    value: string,
    font: Font = REGULAR,
    size = 10,
    colour: Colour = INK,
  ): void {
    const encoded = escapeText(value);
    this.ops.push(
      `${fill(colour)} BT /${font} ${size} Tf 1 0 0 1 ${round(x)} ${round(y)} Tm (${encoded}) Tj ET`,
    );
  }

  /** Draw `value` so that it ends at `x`. Needs the font metrics to know where to start. */
  textRight(
    x: number,
    y: number,
    value: string,
    font: Font = REGULAR,
    size = 10,
    colour: Colour = INK,
  ): void {
    this.text(x - measure(value, font, size), y, value, font, size, colour);
  }

  rule(x1: number, y: number, x2: number): void {
    this.ops.push(
      `${stroke(RULE)} 0.7 w ${round(x1)} ${round(y)} m ${round(x2)} ${round(y)} l S`,
    );
  }

  fillRect(
    x: number,
    y: number,
    width: number,
    height: number,
    colour: Colour,
  ): void {
    this.ops.push(
      `${fill(colour)} ${round(x)} ${round(y)} ${round(width)} ${round(height)} re f`,
    );
  }

  stream(): string {
    return this.ops.join('\n');
  }
}

function fill([r, g, b]: Colour): string {
  return `${r} ${g} ${b} rg`;
}

function stroke([r, g, b]: Colour): string {
  return `${r} ${g} ${b} RG`;
}

function round(value: number): string {
  return value.toFixed(2);
}

/* -------------------------------------------------------------------- *
 * Text encoding and metrics                                             *
 * -------------------------------------------------------------------- */

/** Characters a copy-writer or a customer name is likely to carry in. */
const TRANSLITERATE: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  ' ': ' ',
  '₹': 'INR ',
  '•': '-',
  '·': '-',
};

/**
 * A string as the base-14 fonts can carry it.
 *
 * Anything outside Latin-1 is dropped rather than written raw: a stray byte
 * above 255 does not survive the stream, and a corrupt PDF is a worse outcome
 * than a name missing an accent it never had in our database anyway.
 */
export function toWinAnsi(value: string): string {
  let out = '';
  for (const char of value) {
    const replacement = TRANSLITERATE[char];
    if (replacement !== undefined) {
      out += replacement;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code >= 32 && code <= 255) out += char;
    else if (code === 9) out += ' ';
  }
  return out;
}

/** Escapes what PDF's string syntax treats as structure. */
function escapeText(value: string): string {
  return toWinAnsi(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/**
 * Helvetica and Helvetica-Bold advance widths, in 1/1000 em, for the printable
 * ASCII range. Straight out of the Adobe font metrics.
 *
 * Needed only so an amount column can be right-aligned: without real widths
 * every total would be a guess, and a column of guesses is what makes a
 * generated document look generated.
 */
const HELVETICA_WIDTHS: Record<Font, number[]> = {
  F1: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
    278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
    584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
    833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
    278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
    500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
    500, 334, 260, 334, 584,
  ],
  F2: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
    278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
    584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
    833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
    278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
    556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
    500, 389, 280, 389, 584,
  ],
};

/** Width of a character not in the table — an accented letter, mostly. */
const FALLBACK_WIDTH = 556;

/** How wide `value` renders, in points. */
export function measure(value: string, font: Font, size: number): number {
  const widths = HELVETICA_WIDTHS[font];
  let total = 0;
  for (const char of toWinAnsi(value)) {
    const code = char.charCodeAt(0);
    const width =
      code >= 32 && code <= 126 ? widths[code - 32] : FALLBACK_WIDTH;
    total += width;
  }
  return (total * size) / 1000;
}

/* -------------------------------------------------------------------- *
 * The file                                                              *
 * -------------------------------------------------------------------- */

/**
 * Wrap a content stream in the smallest valid PDF that can hold it: a catalog,
 * one page, the stream and the two fonts, followed by the cross-reference table
 * that says where each of them starts.
 */
function assemble(content: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(body, 'latin1');
  // Entry 0 is always the free-list head; the rest are 10-digit byte offsets,
  // and a reader that cannot trust them cannot open the file at all.
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, 'latin1');
}
