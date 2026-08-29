/**
 * Indian GST: who the supply is to, and how the tax on it divides.
 *
 * Two facts decide everything on the tax half of an invoice, and both are
 * about *place* rather than money:
 *
 *   **Place of supply** is the customer's state, not ours. It is what the law
 *   asks, and it is why a customer's address is a billing input rather than a
 *   nicety.
 *
 *   **Intra-state or inter-state.** A supply inside our own state is taxed as
 *   CGST plus SGST, half each; a supply to any other state is taxed as IGST at
 *   the full rate. The rate is the same either way — 18% is 9+9 or 18 — so
 *   this changes how the tax is *presented*, not what anybody pays. Presented
 *   wrongly, though, the customer cannot claim it, which makes it their problem
 *   rather than a cosmetic one.
 *
 * Pure functions with no Nest context, for the same reason the numbering rules
 * are: this is the arithmetic an auditor checks.
 */

/**
 * GST state codes — the two digits every GSTIN begins with.
 *
 * Includes the codes that no longer issue registrations but still appear on
 * existing ones. A customer whose GSTIN starts `28` predates the Andhra
 * Pradesh bifurcation; refusing to resolve it would reject a real registration.
 */
export const GST_STATES: Readonly<Record<string, string>> = Object.freeze({
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
});

/**
 * Codes that still resolve but are no longer issued, so a chooser can leave
 * them out without a lookup failing on somebody's existing registration.
 */
const SUPERSEDED = new Set(['25', '28']);

/** The codes worth offering in a form, in the order they are numbered. */
export function selectableStates(): { code: string; name: string }[] {
  return Object.entries(GST_STATES)
    .filter(([code]) => !SUPERSEDED.has(code))
    .map(([code, name]) => ({ code, name }));
}

/** The state a code names, or null if it names none. */
export function stateName(code: string | null | undefined): string | null {
  if (!code) return null;
  return GST_STATES[code] ?? null;
}

/**
 * How a place of supply is printed: `Karnataka (29)`.
 *
 * Both halves, because the name is what a person reads and the code is what a
 * return is filed against.
 */
export function placeOfSupplyLabel(
  code: string | null | undefined,
): string | null {
  const name = stateName(code);
  return name && code ? `${name} (${code})` : null;
}

/** The state code a GSTIN carries, without validating the rest of it. */
export function stateCodeOfGstin(
  gstin: string | null | undefined,
): string | null {
  if (!gstin || gstin.length < 2) return null;
  const code = gstin.slice(0, 2);
  return GST_STATES[code] ? code : null;
}

/** Shape only: 22AAAAA0000A1Z5 — two digits, PAN, entity, Z, checksum. */
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

/** `0`–`9` then `A`–`Z`, which is the alphabet the checksum counts in. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Whether a string is a well-formed GSTIN.
 *
 * Shape, a state code that exists, and the check digit. The check digit is the
 * point: shape alone accepts a transposed pair of characters, which is the
 * mistake somebody actually makes copying fifteen characters off a
 * registration certificate, and a wrong GSTIN on an issued invoice cannot be
 * corrected by reissuing it.
 */
export function isGstin(value: string | null | undefined): boolean {
  if (!value || !GSTIN_SHAPE.test(value)) return false;
  if (!GST_STATES[value.slice(0, 2)]) return false;
  return value[14] === gstinCheckDigit(value.slice(0, 14));
}

/**
 * The fifteenth character, from the first fourteen.
 *
 * Weights alternate 1 and 2 across the string; each product is folded by
 * dividing and remaindering in base 36, and the check digit is what brings the
 * total up to a multiple of 36.
 */
export function gstinCheckDigit(first14: string): string {
  let sum = 0;
  for (let i = 0; i < first14.length; i++) {
    const value = ALPHABET.indexOf(first14[i]);
    if (value < 0) return '';
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return ALPHABET[(36 - (sum % 36)) % 36];
}

/** How one document's tax divides. The three always sum to the tax charged. */
export interface TaxSplit {
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  /** True where the supply crossed a state line and IGST applies. */
  interState: boolean;
}

/**
 * Divide tax already charged into its heads.
 *
 * The total is not recomputed here — it has already been worked out of what
 * the bank moved, and restating it from a rate would let the document disagree
 * with the payment. This only says which columns it goes in.
 *
 * On an intra-state supply the halves are floored and remaindered rather than
 * both rounded, so an odd number of paise lands on SGST instead of vanishing or
 * doubling. CGST + SGST is exactly the tax charged, every time.
 *
 * Where the buyer's state is unknown the supply is treated as intra-state.
 * IGST wrongly charged on a local supply is the harder error to unwind: the
 * customer's credit is refused and the fix is a credit note and a fresh
 * invoice, where the reverse at least leaves them holding a document they can
 * act on.
 */
export function splitTax(
  taxAmount: number,
  sellerStateCode: string | null,
  buyerStateCode: string | null,
): TaxSplit {
  if (taxAmount <= 0) {
    return { cgstAmount: 0, sgstAmount: 0, igstAmount: 0, interState: false };
  }

  const interState =
    !!sellerStateCode && !!buyerStateCode && sellerStateCode !== buyerStateCode;

  if (interState) {
    return {
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount: taxAmount,
      interState: true,
    };
  }

  const cgstAmount = Math.floor(taxAmount / 2);
  return {
    cgstAmount,
    sgstAmount: taxAmount - cgstAmount,
    igstAmount: 0,
    interState: false,
  };
}
