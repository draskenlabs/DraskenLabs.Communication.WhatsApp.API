import {
  InvoiceDocument,
  InvoiceSeller,
  formatAmount,
  formatRate,
  measure,
  renderInvoicePdf,
  toWinAnsi,
} from './invoice.pdf';

const SELLER: InvoiceSeller = {
  name: 'Drasken Labs Private Limited',
  addressLines: ['4th Floor, MG Road', 'Bengaluru 560001'],
  email: 'billing@draskenlabs.com',
  gstin: '29AABCU9603R1ZM',
};

const INVOICE: InvoiceDocument = {
  number: 'INV-WAC-2627-0001',
  financialYearLabel: '2026-27',
  issuedAt: new Date('2026-09-01T06:30:00Z'),
  paidAt: new Date('2026-09-01T06:30:00Z'),
  billedToName: 'Ada Lovelace',
  billedToEmail: 'ada@example.com',
  organisationName: 'Acme Retail',
  summary: 'Growth',
  lines: [
    {
      description: 'Growth plan',
      detail: null,
      quantity: 1,
      unitAmount: 84_661,
      amount: 84_661,
    },
  ],
  periodStart: new Date('2026-09-01T00:00:00Z'),
  periodEnd: new Date('2026-10-01T00:00:00Z'),
  subtotal: 84_661,
  taxAmount: 15_239,
  taxRateBps: 1800,
  taxLabel: 'GST',
  total: 99_900,
  currency: 'INR',
  paymentMethod: 'Visa ···· 4242',
  paymentReference: 'pay_29QQoUBi66xm2f',
};

/** The stream is Latin-1, so this is what a reader would see. */
function asText(pdf: Buffer): string {
  return pdf.toString('latin1');
}

describe('renderInvoicePdf', () => {
  it('produces a file a reader will open', () => {
    const pdf = renderInvoicePdf(INVOICE, SELLER);
    const text = asText(pdf);

    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Page');
    expect(text).toContain('xref');
  });

  it('points the cross-reference table at where the objects actually are', () => {
    // The one part of a PDF a reader cannot recover from: a wrong offset and
    // the file will not open at all.
    const pdf = renderInvoicePdf(INVOICE, SELLER);
    const text = asText(pdf);

    const startxref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');

    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    expect(offsets).toHaveLength(6);
    offsets.forEach((offset, index) => {
      expect(text.slice(offset).startsWith(`${index + 1} 0 obj`)).toBe(true);
    });
  });

  it('declares the content stream at its true length', () => {
    const pdf = renderInvoicePdf(INVOICE, SELLER);
    const text = asText(pdf);

    const declared = Number(/\/Length (\d+) >>\nstream/.exec(text)?.[1]);
    const body = text.slice(
      text.indexOf('stream\n') + 'stream\n'.length,
      text.indexOf('\nendstream'),
    );
    expect(Buffer.byteLength(body, 'latin1')).toBe(declared);
  });

  it('prints what the customer needs to identify the document', () => {
    const text = asText(renderInvoicePdf(INVOICE, SELLER));

    expect(text).toContain('INV-WAC-2627-0001');
    expect(text).toContain('TAX INVOICE');
    expect(text).toContain('Acme Retail');
    expect(text).toContain('Growth plan');
    expect(text).toContain('29AABCU9603R1ZM');
    expect(text).toContain('INR 999.00');
    expect(text).toContain('GST @ 18%');
  });

  it('itemises an agency’s debit, naming every client it covered', () => {
    // One mandate, one payment, several clients. A document that showed only
    // the total would leave the agency unable to tell what it had paid for.
    const pdf = renderInvoicePdf(
      {
        ...INVOICE,
        summary: '3 client plans',
        lines: [
          {
            description: 'Growth — Kettle Coffee',
            detail: null,
            quantity: 1,
            unitAmount: 99_900,
            amount: 99_900,
          },
          {
            description: 'Growth — Loom & Thread',
            detail: null,
            quantity: 1,
            unitAmount: 99_900,
            amount: 99_900,
          },
          {
            description: 'Starter — Harbour Fitness',
            detail: null,
            quantity: 1,
            unitAmount: 49_900,
            amount: 49_900,
          },
        ],
      },
      SELLER,
    );
    const text = asText(pdf);

    expect(text).toContain('Kettle Coffee');
    expect(text).toContain('Loom & Thread');
    expect(text).toContain('Harbour Fitness');
  });

  it('runs a long roster onto further sheets rather than dropping any of it', () => {
    // An agency cannot rebill from a document that shows eight of its twenty
    // clients, so the table paginates. Every client billed for must appear.
    const lines = Array.from({ length: 30 }, (_, i) => ({
      description: `Growth plan for client ${i + 1}`,
      detail: null,
      quantity: 1,
      unitAmount: 99_900,
      amount: 99_900,
    }));
    const text = asText(renderInvoicePdf({ ...INVOICE, lines }, SELLER));

    for (const line of lines) {
      expect(text).toContain(line.description);
    }
    // And the reader is told which sheet of how many they are holding.
    expect(text).toContain('Page 1 of ');
  });

  it('keeps the totals and the footer off the line items', () => {
    // The failure this guards against is silent: a table long enough to reach
    // the footer used to print over it, so the document still opened and was
    // simply wrong.
    const lines = Array.from({ length: 40 }, (_, i) => ({
      description: `Growth plan for client ${i + 1}`,
      detail: 'Monthly plan',
      quantity: 1,
      unitAmount: 99_900,
      amount: 99_900,
    }));
    const pdf = renderInvoicePdf({ ...INVOICE, lines }, SELLER);
    const text = asText(pdf);

    // Nothing is drawn below the page margin, on any sheet.
    const baselines = [...text.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm/g)].map((m) =>
      Number(m[1]),
    );
    expect(Math.min(...baselines)).toBeGreaterThanOrEqual(46);

    // And the document still ends with what it is for.
    expect(text).toContain('Total paid');
    expect(text).toContain('Rupees');
  });

  it('prints a rate column only when something is charged more than once', () => {
    const one = asText(renderInvoicePdf(INVOICE, SELLER));
    expect(one).not.toContain('RATE');

    const many = asText(
      renderInvoicePdf(
        {
          ...INVOICE,
          lines: [
            {
              description: 'Growth',
              detail: '3 clients',
              quantity: 3,
              unitAmount: 99_900,
              amount: 299_700,
            },
          ],
        },
        SELLER,
      ),
    );
    expect(many).toContain('RATE');
  });

  it('calls itself an invoice, not a tax invoice, where no tax was charged', () => {
    const text = asText(
      renderInvoicePdf(
        { ...INVOICE, taxRateBps: 0, taxAmount: 0, taxLabel: null },
        SELLER,
      ),
    );

    expect(text).toContain('INVOICE');
    expect(text).not.toContain('TAX INVOICE');
    expect(text).not.toContain('GST @');
  });

  it('escapes a name that would otherwise close the string early', () => {
    // A PDF string ends at an unbalanced ")". An organisation called
    // "Bar) Tj (evil" would rewrite the page if it were written through.
    const text = asText(
      renderInvoicePdf(
        { ...INVOICE, organisationName: 'Bar) Tj (evil \\ Ltd' },
        SELLER,
      ),
    );

    expect(text).toContain('Bar\\) Tj \\(evil \\\\ Ltd');
  });

  it('survives a name it cannot encode', () => {
    const pdf = renderInvoicePdf(
      { ...INVOICE, organisationName: '株式会社テスト' },
      SELLER,
    );
    expect(asText(pdf).startsWith('%PDF-1.4')).toBe(true);
  });
});

describe('toWinAnsi', () => {
  it('keeps what the base-14 fonts can carry', () => {
    expect(toWinAnsi('Acme Retail')).toBe('Acme Retail');
    expect(toWinAnsi('Café')).toBe('Café');
  });

  it('translates the punctuation a copy-writer types', () => {
    expect(toWinAnsi('Drasken’s — “plan”')).toBe(`Drasken's - "plan"`);
    expect(toWinAnsi('₹499')).toBe('INR 499');
  });

  it('drops what it cannot represent rather than corrupting the stream', () => {
    expect(toWinAnsi('ok 株 ok')).toBe('ok  ok');
  });
});

describe('formatAmount', () => {
  it('turns minor units into an amount with its currency', () => {
    expect(formatAmount(49_900, 'INR')).toBe('INR 499.00');
    expect(formatAmount(0, 'INR')).toBe('INR 0.00');
    expect(formatAmount(1_234_567, 'INR')).toBe('INR 12,345.67');
  });

  it('keeps a refund readable', () => {
    expect(formatAmount(-49_900, 'INR')).toBe('-INR 499.00');
  });
});

describe('formatRate', () => {
  it('reads basis points back as a percentage', () => {
    expect(formatRate(1800)).toBe('18%');
    expect(formatRate(1250)).toBe('12.5%');
  });
});

describe('measure', () => {
  it('is what makes the amount column line up', () => {
    // Right alignment is subtraction from the column edge, so a width that is
    // wrong is a column that visibly is not straight.
    // Straight out of the Helvetica metrics: I+N+R+space+4+9+9+.+0+0.
    expect(measure('INR 499.00', 'F1', 10)).toBeCloseTo(50.58, 2);
    expect(measure('', 'F1', 10)).toBe(0);
    expect(measure('W', 'F2', 10)).toBeGreaterThan(measure('i', 'F2', 10));
  });
});
