import {
  financialYear,
  financialYearLabel,
  invoiceNumber,
  isInvoiceNumber,
} from './invoice.number';

const IST = 'Asia/Kolkata';

describe('financialYear', () => {
  it('files April to December under the year that started in April', () => {
    expect(financialYear(new Date('2026-04-01T00:00:00+05:30'), IST)).toBe(
      '2627',
    );
    expect(financialYear(new Date('2026-12-31T23:59:00+05:30'), IST)).toBe(
      '2627',
    );
  });

  it('files January to March under the year that started the previous April', () => {
    expect(financialYear(new Date('2027-01-01T00:00:00+05:30'), IST)).toBe(
      '2627',
    );
    expect(financialYear(new Date('2027-03-31T23:59:00+05:30'), IST)).toBe(
      '2627',
    );
  });

  it('turns the year at midnight on 1 April', () => {
    expect(financialYear(new Date('2027-03-31T23:59:59+05:30'), IST)).toBe(
      '2627',
    );
    expect(financialYear(new Date('2027-04-01T00:00:00+05:30'), IST)).toBe(
      '2728',
    );
  });

  it('turns it in the configured zone, not in UTC', () => {
    // 20:00 UTC on 31 March is already 01:30 on 1 April in India: the same
    // instant belongs to different financial years depending on where the
    // question is asked, and the customer's answer is the one that counts.
    const instant = new Date('2027-03-31T20:00:00Z');
    expect(financialYear(instant, IST)).toBe('2728');
    expect(financialYear(instant, 'UTC')).toBe('2627');
  });

  it('pads a year that turns the century', () => {
    expect(financialYear(new Date('2099-05-01T00:00:00+05:30'), IST)).toBe(
      '9900',
    );
  });
});

describe('financialYearLabel', () => {
  it('spells the year out the way a person writes it', () => {
    expect(financialYearLabel('2627')).toBe('2026-27');
  });
});

describe('invoiceNumber', () => {
  it('is the series, the financial year and the position in it', () => {
    expect(invoiceNumber('WAC', '2627', 1)).toBe('INV-WAC-2627-0001');
    expect(invoiceNumber('WAC', '2627', 42)).toBe('INV-WAC-2627-0042');
  });

  it('grows past four digits rather than wrapping onto an existing number', () => {
    expect(invoiceNumber('WAC', '2627', 10_000)).toBe('INV-WAC-2627-10000');
  });
});

describe('isInvoiceNumber', () => {
  it('accepts our own numbers', () => {
    expect(isInvoiceNumber('INV-WAC-2627-0001')).toBe(true);
    expect(isInvoiceNumber('INV-WAC-2627-12345')).toBe(true);
  });

  it('rejects anything that is not one', () => {
    // The route parameter is checked with this, so a lookup cannot be turned
    // into a scan of the series.
    expect(isInvoiceNumber('INV-WAC-2627-0001 OR 1=1')).toBe(false);
    expect(isInvoiceNumber('pay_29QQoUBi66xm2f')).toBe(false);
    expect(isInvoiceNumber('INV-WAC-2627')).toBe(false);
    expect(isInvoiceNumber('')).toBe(false);
  });
});
