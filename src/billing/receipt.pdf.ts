/**
 * The receipt, as a PDF.
 *
 * The invoice's sibling and deliberately its plainer one. An invoice has to
 * carry a tax summary, a taxable value and a classification, because it is the
 * document a return is filed from. A receipt answers one question — was this
 * paid, and by whom — so it says that in as few lines as it can, and points at
 * the invoice for everything else.
 *
 * Same masthead, same amount column, same footer rhythm, so the pair read as
 * two documents from one company rather than two from two.
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
  SUCCESS,
  SUCCESS_BG,
  WHITE,
  assemble,
  formatAmount,
  formatDate,
  rupeesInWords,
  truncate,
} from './document.pdf';
import type { InvoiceSeller } from './invoice.pdf';

export interface ReceiptDocument {
  number: string;
  /** "2026-27", as a person writes it. */
  financialYearLabel: string;
  issuedAt: Date;
  /** When the money actually arrived, which is what this acknowledges. */
  receivedAt: Date | null;

  /** The invoice this settles, named so the pair can be filed together. */
  invoiceNumber: string;

  billedToName: string | null;
  billedToEmail: string | null;
  organisationName: string | null;
  billedToAddress?: string | null;
  billedToGstin?: string | null;
  /** What the payment settled, in a few words. */
  summary: string | null;

  amount: number;
  currency: string;

  paymentMethod: string | null;
  paymentReference: string | null;
}

export function renderReceiptPdf(
  receipt: ReceiptDocument,
  seller: InvoiceSeller,
): Buffer {
  const page = new Page();

  let y = masthead(page, receipt, seller);
  y = parties(page, receipt, seller, y);
  y = facts(page, receipt, y);
  acknowledgement(page, receipt, y);
  footer(page, receipt);

  return assemble(page.stream());
}

/** White at `amount`, over the brand green. */
function tint(amount: number): Colour {
  return [
    BRAND[0] + (1 - BRAND[0]) * amount,
    BRAND[1] + (1 - BRAND[1]) * amount,
    BRAND[2] + (1 - BRAND[2]) * amount,
  ];
}

function masthead(
  page: Page,
  receipt: ReceiptDocument,
  seller: InvoiceSeller,
): number {
  const height = 104;
  const top = PAGE_HEIGHT;
  page.fillRect(0, top - height, PAGE_WIDTH, height, BRAND);

  const centre = top - 52;
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

  page.textRight(PAGE_WIDTH - MARGIN, centre + 4, 'RECEIPT', BOLD, 16, WHITE);
  page.textRight(
    PAGE_WIDTH - MARGIN,
    centre - 11,
    receipt.number,
    REGULAR,
    10,
    tint(0.85),
  );

  return top - height - 26;
}

function parties(
  page: Page,
  receipt: ReceiptDocument,
  seller: InvoiceSeller,
  top: number,
): number {
  const gap = 16;
  const colWidth = (CONTENT_WIDTH - gap) / 2;

  const from = [
    ...seller.addressLines,
    ...(seller.gstin ? [`GSTIN  ${seller.gstin}`] : []),
    ...(seller.email ? [seller.email] : []),
  ];

  const to = [
    ...(receipt.billedToAddress
      ? receipt.billedToAddress.split('\n').filter(Boolean)
      : []),
    ...(receipt.billedToName ? [receipt.billedToName] : []),
    ...(receipt.billedToEmail ? [receipt.billedToEmail] : []),
    ...(receipt.billedToGstin ? [`GSTIN  ${receipt.billedToGstin}`] : []),
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

  column(MARGIN, 'RECEIVED BY', seller.name, from);
  column(
    MARGIN + colWidth + gap,
    'RECEIVED FROM',
    receipt.organisationName ?? receipt.billedToName ?? 'Customer',
    to,
  );

  const bottom = top - height + 6;
  page.rule(MARGIN, bottom, PAGE_WIDTH - MARGIN);
  return bottom - 22;
}

function facts(page: Page, receipt: ReceiptDocument, top: number): number {
  const cells: [string, string][] = [
    ['RECEIPT NUMBER', receipt.number],
    ['RECEIPT DATE', formatDate(receipt.receivedAt ?? receipt.issuedAt)],
    ['FINANCIAL YEAR', receipt.financialYearLabel],
    // The whole reason a receipt is worth issuing separately: it points at the
    // document that says what the money was for and what tax it carried.
    ['AGAINST INVOICE', receipt.invoiceNumber],
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

/**
 * The sentence the document exists to say, and the figure it says it about.
 *
 * Set as a statement rather than a table: there is one amount on a receipt, and
 * ruling it into a column of one would be borrowing the invoice's furniture for
 * something that does not need it.
 */
function acknowledgement(
  page: Page,
  receipt: ReceiptDocument,
  top: number,
): void {
  let y = top - 8;

  page.tracked(MARGIN, y, 'RECEIVED WITH THANKS', 7, FAINT);
  y -= 26;

  const paid = receipt.receivedAt ? formatDate(receipt.receivedAt) : null;
  const sentence = [
    'Received from',
    receipt.organisationName ?? receipt.billedToName ?? 'the customer',
    paid ? `on ${paid}` : null,
    receipt.paymentMethod ? `by ${receipt.paymentMethod}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  page.text(
    MARGIN,
    y,
    truncate(sentence, REGULAR, 10, CONTENT_WIDTH),
    REGULAR,
    10,
    GREY,
  );
  y -= 18;

  if (receipt.summary) {
    page.text(
      MARGIN,
      y,
      truncate(`Towards ${receipt.summary}`, REGULAR, 10, CONTENT_WIDTH),
      REGULAR,
      10,
      GREY,
    );
    y -= 18;
  }

  y -= 10;
  page.rule(MARGIN, y, PAGE_WIDTH - MARGIN);
  y -= 30;

  page.text(MARGIN, y, 'Amount received', BOLD, 11);
  page.textRight(
    AMOUNT_RIGHT,
    y - 3,
    formatAmount(receipt.amount, receipt.currency),
    BOLD,
    18,
    BRAND,
  );
  y -= 26;

  // The pill says the thing a receipt is produced to prove, in the one form
  // somebody scanning the page will not miss.
  page.pill(MARGIN, y - 4, 'PAID IN FULL', SUCCESS_BG, SUCCESS);
  y -= 30;

  if (receipt.currency === 'INR') {
    page.tracked(MARGIN, y, 'AMOUNT IN WORDS', 6.5, FAINT);
    page.text(MARGIN, y - 14, rupeesInWords(receipt.amount), BOLD, 9.5);
    y -= 34;
  }
}

function footer(page: Page, receipt: ReceiptDocument): void {
  const y = MARGIN + 46;
  page.rule(MARGIN, y + 24, PAGE_WIDTH - MARGIN);

  const left = [
    `This receipt acknowledges payment against invoice ${receipt.invoiceNumber}.`,
    receipt.paymentReference ? `Reference ${receipt.paymentReference}` : null,
    // A receipt is not a tax document. Said plainly, because somebody will
    // otherwise file it as one and find the tax summary missing.
    'Tax details are stated on the invoice, not on this receipt.',
  ].filter(Boolean) as string[];

  const right = [
    'This is a computer-generated receipt and needs no signature.',
    'WhatsApp is a trademark of Meta Platforms, Inc. Drasken Labs is an',
    'independent Tech Provider, not affiliated with or endorsed by Meta.',
  ];

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
