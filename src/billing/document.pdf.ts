/**
 * The PDF engine: a page of text and shapes, and the file around it.
 *
 * Shared by every document this product issues — an invoice, a receipt — so
 * they are recognisably one family and, more practically, so their amount
 * columns line up: a column that aligns depends on `measure` being the same
 * function everywhere, and on `AMOUNT_RIGHT` being one number rather than
 * three that nearly agree.
 *
 * No PDF dependency. The file is a few hundred lines of content-stream
 * operators and an xref table, which is less code than configuring a library
 * would be, and it means a document can never fail to render because a
 * transitive dependency changed.
 */

/** A4, in points, which is the only unit PDF has. */
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;
export const MARGIN = 46;
export const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/**
 * One padding value, used by every panel and every table cell.
 *
 * The single most load-bearing constant here: every number on the page is
 * right-aligned to `AMOUNT_RIGHT`, so the line items, the tax rows and the
 * total form one edge instead of three that nearly agree.
 */
export const PAD = 16;
export const AMOUNT_RIGHT = PAGE_WIDTH - MARGIN - PAD;

export type Font = 'F1' | 'F2';
export const REGULAR: Font = 'F1';
export const BOLD: Font = 'F2';

/* -------------------------------------------------------------------- *
 * The page                                                              *
 * -------------------------------------------------------------------- */

export type Colour = [number, number, number];

/**
 * The console's own light-mode tokens, as PDF RGB.
 *
 * Light regardless of the reader's theme: a document is printed, filed and
 * forwarded, and dark mode on paper is a wasted cartridge. The names match
 * `app.css` so the two cannot drift without somebody noticing.
 */
const hex = (value: string): Colour => [
  parseInt(value.slice(1, 3), 16) / 255,
  parseInt(value.slice(3, 5), 16) / 255,
  parseInt(value.slice(5, 7), 16) / 255,
];

export const INK: Colour = hex('#0f1c17');
export const GREY: Colour = hex('#5a6b62');
export const FAINT: Colour = hex('#93a49b');
export const BAND: Colour = hex('#f0f4f1');
export const RULE: Colour = hex('#e4eae5');
export const BRAND: Colour = hex('#1faa59');
export const BRAND_DEEP: Colour = hex('#14663a');
export const SUCCESS: Colour = hex('#0e9f5a');
export const SUCCESS_BG: Colour = hex('#dff5e8');
export const WHITE: Colour = [1, 1, 1];

/** A content stream, built one operator at a time. */
export class Page {
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

  /** A vertical hairline, for dividing a strip into cells. */
  vrule(x: number, y1: number, y2: number): void {
    this.ops.push(
      `${stroke(RULE)} 0.7 w ${round(x)} ${round(y1)} m ${round(x)} ${round(y2)} l S`,
    );
  }

  /**
   * A rounded panel, which is what every surface in the console is.
   *
   * PDF has no rounded-rectangle operator, so the corners are cubic beziers
   * with the control points at the usual circle approximation — anything less
   * and the corner reads as a chamfer rather than a radius. `corners` lets a
   * band square off where it meets the panel it sits inside.
   */
  roundedRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    colour: Colour,
    border?: Colour,
    corners: { top?: boolean; bottom?: boolean } = {},
  ): void {
    const r = Math.min(radius, width / 2, height / 2);
    const k = r * 0.5523;
    const top = corners.top !== false;
    const bottom = corners.bottom !== false;
    const [x0, y0, x1, y1] = [x, y, x + width, y + height];
    const rb = bottom ? r : 0;
    const rt = top ? r : 0;
    const kb = bottom ? k : 0;
    const kt = top ? k : 0;

    this.ops.push(
      [
        fill(colour),
        ...(border ? [stroke(border), '0.7 w'] : []),
        `${round(x0 + rb)} ${round(y0)} m`,
        `${round(x1 - rb)} ${round(y0)} l`,
        `${round(x1 - rb + kb)} ${round(y0)} ${round(x1)} ${round(y0 + rb - kb)} ${round(x1)} ${round(y0 + rb)} c`,
        `${round(x1)} ${round(y1 - rt)} l`,
        `${round(x1)} ${round(y1 - rt + kt)} ${round(x1 - rt + kt)} ${round(y1)} ${round(x1 - rt)} ${round(y1)} c`,
        `${round(x0 + rt)} ${round(y1)} l`,
        `${round(x0 + rt - kt)} ${round(y1)} ${round(x0)} ${round(y1 - rt + kt)} ${round(x0)} ${round(y1 - rt)} c`,
        `${round(x0)} ${round(y0 + rb)} l`,
        `${round(x0)} ${round(y0 + rb - kb)} ${round(x0 + rb - kb)} ${round(y0)} ${round(x0 + rb)} ${round(y0)} c`,
        'h',
        border ? 'B' : 'f',
      ].join(' '),
    );
  }

  /** A badge, as the console draws one: a pill with a label inside it. */
  pill(
    x: number,
    y: number,
    label: string,
    background: Colour,
    foreground: Colour,
    size = 8,
  ): number {
    const width = pillWidth(label, size);
    const height = size + 11;
    this.roundedRect(x, y - 4, width, height, height / 2, background);
    // One baseline, derived from the box rather than nudged by eye.
    this.text(
      x + 10,
      y + height / 2 - 4 - size * 0.36,
      label,
      BOLD,
      size,
      foreground,
    );
    return width;
  }

  /** Letter-spaced small caps, for the section labels the console uses. */
  tracked(
    x: number,
    y: number,
    value: string,
    size: number,
    colour: Colour,
    tracking = 0.8,
  ): void {
    let cursor = x;
    for (const ch of value) {
      this.text(cursor, y, ch, BOLD, size, colour);
      cursor += measure(ch, BOLD, size) + tracking;
    }
  }

  stream(): string {
    return this.ops.join('\n');
  }
}

/** How wide a pill is, so a caller can right-align one before drawing it. */
export function pillWidth(label: string, size = 8): number {
  return measure(label, BOLD, size) + 20;
}

/** Cut a string to fit, with an ellipsis, rather than letting it overrun. */
export function truncate(
  value: string,
  font: Font,
  size: number,
  maxWidth: number,
): string {
  if (measure(value, font, size) <= maxWidth) return value;
  let cut = value;
  while (cut.length > 1 && measure(`${cut}...`, font, size) > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}...`;
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
export function assemble(contents: string | string[]): Buffer {
  const streams = Array.isArray(contents) ? contents : [contents];
  const count = streams.length;

  // Object numbering, fixed so the references below can be written by hand:
  //   1            catalog
  //   2            the page tree
  //   3 .. 2+n     one page per sheet
  //   3+n .. 2+2n  that page's content stream
  //   3+2n, 4+2n   the two fonts, shared by every page
  const pageId = (index: number) => 3 + index;
  const contentId = (index: number) => 3 + count + index;
  const regularId = 3 + count * 2;
  const boldId = regularId + 1;

  const kids = streams.map((_, i) => `${pageId(i)} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`,
    ...streams.map(
      (_, i) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 ${regularId} 0 R /F2 ${boldId} 0 R >> >> ` +
        `/Contents ${contentId(i)} 0 R >>`,
    ),
    ...streams.map(
      (stream) =>
        `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    ),
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

/* -------------------------------------------------------------------- *
 * Formatting                                                            *
 * -------------------------------------------------------------------- */

/** Minor units to a printed amount: 49900 paise is `INR 499.00`. */
export function formatAmount(minor: number, currency: string): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}${currency} ${group(major)}.${cents}`;
}

/** Indian digit grouping: 12,34,567 rather than 1,234,567. */
function group(value: number): string {
  const text = String(value);
  if (text.length <= 3) return text;
  const head = text.slice(0, -3);
  const tail = text.slice(-3);
  return `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
}

/** Basis points as a percentage: 1800 is `18%`, 1250 is `12.5%`. */
export function formatRate(bps: number): string {
  const percent = bps / 100;
  // Trailing zeros trimmed: a rate is read, not reconciled, and "12.50%" on a
  // line beside "18%" reads as two different kinds of number.
  const shown = Number.isInteger(percent)
    ? String(percent)
    : percent.toFixed(2).replace(/0+$/, '');
  return `${shown}%`;
}

/**
 * A date as a person writes it, in Indian local time.
 *
 * The zone matters on a document: a payment captured at 03:00 IST on 1 April
 * is dated 31 March in UTC, and an invoice dated a day before the financial
 * year its number claims is a question nobody wants to answer twice.
 */
export function formatDate(value: Date): string {
  return value.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

/** "Service period 1 Sep 2026 to 1 Oct 2026", or nothing if neither is known. */
export function formatPeriod(
  start: Date | null,
  end: Date | null,
): string | null {
  if (!start && !end) return null;
  if (start && end)
    return `Service period ${formatDate(start)} to ${formatDate(end)}`;
  return `Service period from ${formatDate((start ?? end) as Date)}`;
}

/* -------------------------------------------------------------------- *
 * The amount, spelled out                                               *
 * -------------------------------------------------------------------- */

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
];

function underHundred(n: number): string {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  const ones = ONES[n % 10];
  return ones ? `${tens} ${ones}` : tens;
}

function underThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const head = hundreds ? `${ONES[hundreds]} Hundred` : '';
  return [head, underHundred(rest)].filter(Boolean).join(' ');
}

/** Indian grouping: crore, lakh, thousand, hundred. */
function inWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;

  if (crore) parts.push(`${inWords(crore)} Crore`);
  if (lakh) parts.push(`${underHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${underHundred(thousand)} Thousand`);
  if (rest) parts.push(underThousand(rest));
  return parts.join(' ');
}

/**
 * The total in words, which an Indian tax invoice is expected to carry.
 *
 * Also the one line on the page a reader can check the figures against without
 * arithmetic — which is why it is worth the lakh/crore grouping rather than
 * reusing a Western thousands one.
 */
export function rupeesInWords(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const remainder = paise % 100;
  const head = `Rupees ${inWords(rupees)}`;
  return remainder
    ? `${head} and ${underHundred(remainder)} Paise only`
    : `${head} only`;
}
