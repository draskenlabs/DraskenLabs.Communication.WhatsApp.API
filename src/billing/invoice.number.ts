/**
 * The document series: `INV-WAC-2627-0001`, `RCT-WAC-2627-0001`.
 *
 * Four parts, and each one is load-bearing:
 *
 *   INV   what the document is, so a number is recognisable out of context
 *   WAC   which book it came from — one deployment, one series
 *   2627  the Indian financial year: 1 April 2026 to 31 March 2027
 *   0001  where it sits in that year's book, restarting each 1 April
 *
 * Pure functions, deliberately: the numbering rule is the part an auditor
 * checks and the part a bug is most expensive in, so it is testable without a
 * database, a clock or a Nest context.
 */

/** Digits in the sequence before it is allowed to grow. */
const SEQUENCE_WIDTH = 4;

/**
 * The financial year a date falls in, as the number spells it.
 *
 * India's year runs 1 April to 31 March, so the same calendar day is in two
 * different books depending on the side of 1 April it lands — and that is
 * decided in Indian local time, not in whatever zone the pod happens to run in.
 * A payment captured at 03:00 IST on 1 April is the new year's first invoice;
 * the same instant is 21:30 on 31 March in UTC, and numbering it from UTC would
 * file it in the year that had already closed.
 */
export function financialYear(date: Date, timeZone: string): string {
  const { year, month } = localParts(date, timeZone);
  // January to March still belong to the year that began the previous April.
  const startYear = month >= 4 ? year : year - 1;
  return `${two(startYear)}${two(startYear + 1)}`;
}

/** A financial year as a person would say it: "2026-27". */
export function financialYearLabel(financialYear: string): string {
  const start = financialYear.slice(0, 2);
  const end = financialYear.slice(2);
  // Assumes this century, which is what a two-digit year has always assumed.
  return `20${start}-${end}`;
}

/**
 * The printed number, for any kind of document.
 *
 * Zero-padded to four digits, and allowed to grow past them rather than
 * wrapping: the ten-thousandth invoice of a year is `10000`, which sorts and
 * reads fine, where a truncated `0000` would collide with the first.
 */
export function documentNumber(
  kind: string,
  series: string,
  financialYear: string,
  sequence: number,
): string {
  const position = String(sequence).padStart(SEQUENCE_WIDTH, '0');
  return `${kind}-${series}-${financialYear}-${position}`;
}

/** `INV-WAC-2627-0001` — what is owed. */
export function invoiceNumber(
  series: string,
  financialYear: string,
  sequence: number,
): string {
  return documentNumber('INV', series, financialYear, sequence);
}

/**
 * `RCT-WAC-2627-0001` — what was received.
 *
 * Its own kind and its own counter. An invoice and the receipt acknowledging
 * it are raised together and share every fact on them, but never a number:
 * one series is the statutory one, and a document withdrawn from the other
 * must not leave a gap in it.
 */
export function receiptNumber(
  series: string,
  financialYear: string,
  sequence: number,
): string {
  return documentNumber('RCT', series, financialYear, sequence);
}

/**
 * Whether a string is one of our numbers, of a given kind.
 *
 * Used on the route parameter, so a lookup by number cannot be turned into a
 * search: the parameter either matches the series or the request never reaches
 * the database.
 */
function isDocumentNumber(kind: string, value: string): boolean {
  return new RegExp(`^${kind}-[A-Z0-9]{2,8}-\\d{4}-\\d{4,}$`).test(value);
}

export function isInvoiceNumber(value: string): boolean {
  return isDocumentNumber('INV', value);
}

export function isReceiptNumber(value: string): boolean {
  return isDocumentNumber('RCT', value);
}

/** Year and 1-indexed month of an instant, in a named time zone. */
function localParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
} {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(date);

  const value = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  return { year: value('year'), month: value('month') };
}

/** The last two digits of a year, padded — 2026 is "26", 2100 is "00". */
function two(year: number): string {
  return String(year % 100).padStart(2, '0');
}
