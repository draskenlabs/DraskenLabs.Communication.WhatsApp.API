import {
  gstinCheckDigit,
  isGstin,
  placeOfSupplyLabel,
  selectableStates,
  splitTax,
  stateCodeOfGstin,
  stateName,
} from './gst';

/** Real-shaped registrations, both with a correct check digit. */
const KARNATAKA = '29AAPFU0939F1ZR';
const MAHARASHTRA = '27AAPFU0939F1ZV';

describe('GSTIN', () => {
  it('accepts a well-formed registration', () => {
    expect(isGstin(MAHARASHTRA)).toBe(true);
  });

  it('rejects one whose check digit does not follow from the rest', () => {
    // The character an auditor would catch and a regex would not.
    const wrong = MAHARASHTRA.slice(0, 14) + 'X';
    expect(isGstin(wrong)).toBe(false);
  });

  it('rejects a transposition, which is the mistake people actually make', () => {
    // Two characters swapped: right shape, right length, wrong number.
    const swapped = '27AAPFU9039F1ZV';
    expect(isGstin(swapped)).toBe(false);
  });

  it('rejects a state code that does not exist', () => {
    const body = MAHARASHTRA.slice(2, 14);
    expect(isGstin(`88${body}${gstinCheckDigit(`88${body}`)}`)).toBe(false);
  });

  it.each([
    ['too short', '27AAPFU0939F1Z'],
    ['lower case', MAHARASHTRA.toLowerCase()],
    ['not a GSTIN at all', 'AAPFU0939F'],
    ['empty', ''],
    ['missing', null],
  ])('rejects %s', (_label, value) => {
    expect(isGstin(value)).toBe(false);
  });

  it('reads the state off the front of a registration', () => {
    expect(stateCodeOfGstin(KARNATAKA)).toBe('29');
    expect(stateName(stateCodeOfGstin(KARNATAKA))).toBe('Karnataka');
  });

  it('reads no state off a registration that names none', () => {
    expect(stateCodeOfGstin('88AAPFU0939F1ZV')).toBeNull();
    expect(stateCodeOfGstin(null)).toBeNull();
  });
});

describe('place of supply', () => {
  it('prints the name and the code, because a return needs both', () => {
    expect(placeOfSupplyLabel('29')).toBe('Karnataka (29)');
  });

  it('prints nothing where the state is unknown', () => {
    expect(placeOfSupplyLabel(null)).toBeNull();
    expect(placeOfSupplyLabel('88')).toBeNull();
  });

  it('offers current states in a chooser but still resolves retired ones', () => {
    const codes = selectableStates().map((s) => s.code);
    expect(codes).toContain('29');
    // Retired at the Andhra Pradesh bifurcation, but still on registrations.
    expect(codes).not.toContain('28');
    expect(stateName('28')).toBe('Andhra Pradesh');
  });
});

describe('splitting the tax', () => {
  it('halves it inside our own state', () => {
    const split = splitTax(15_282, '29', '29');

    expect(split.interState).toBe(false);
    expect(split.cgstAmount).toBe(7_641);
    expect(split.sgstAmount).toBe(7_641);
    expect(split.igstAmount).toBe(0);
  });

  it('charges it whole across a state line', () => {
    const split = splitTax(15_282, '29', '27');

    expect(split.interState).toBe(true);
    expect(split.igstAmount).toBe(15_282);
    expect(split.cgstAmount).toBe(0);
    expect(split.sgstAmount).toBe(0);
  });

  it('never loses or invents a paisa on an odd amount', () => {
    // 7181 does not halve. The document still has to add up.
    const split = splitTax(7_181, '29', '29');

    expect(split.cgstAmount + split.sgstAmount).toBe(7_181);
    expect(split.cgstAmount).toBe(3_590);
    expect(split.sgstAmount).toBe(3_591);
  });

  it('treats an unknown customer state as local rather than guessing', () => {
    // IGST wrongly charged on a local supply is the harder error to unwind.
    const split = splitTax(1_000, '29', null);

    expect(split.interState).toBe(false);
    expect(split.cgstAmount + split.sgstAmount).toBe(1_000);
  });

  it('charges nothing where nothing was charged', () => {
    const split = splitTax(0, '29', '27');

    expect(split).toEqual({
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount: 0,
      interState: false,
    });
  });
});
