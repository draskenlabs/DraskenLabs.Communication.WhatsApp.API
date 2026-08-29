import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { OrgDirectoryService } from 'src/org/org-directory.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import { mailNotificationsDouble } from 'src/mail/mail.test-doubles';
import {
  InvoiceRequest,
  InvoiceService,
  InvoiceWithLines,
} from './invoice.service';
import { ReceiptService } from './receipt.service';
import { firstArg } from 'src/common/utils/mock-args';

const mockTx = {
  $queryRaw: jest.fn(),
  invoice: { create: jest.fn() },
};

// The receipt is written by its own service inside the same transaction, and
// rendered beside the invoice when the pair are mailed.
const mockReceipts = {
  recordIn: jest.fn(),
  forInvoice: jest.fn(),
  pdf: jest.fn(() => Buffer.from('%PDF-receipt')),
};

const mockPrisma = {
  invoice: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  subscription: { findMany: jest.fn() },
  organisationSettings: { findMany: jest.fn(), findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  receipt: { update: jest.fn() },
  $transaction: jest.fn((cb: (tx: typeof mockTx) => unknown): unknown =>
    cb(mockTx),
  ) as jest.Mock,
};

const mockOrgDirectory = { name: jest.fn() };
// Rebuilt per test, not shared: `jest.clearAllMocks()` forgets calls but a
// `…Once` queued by one test would otherwise still be answering in the next.
let mockMail: ReturnType<typeof mailNotificationsDouble>;

/** Whatever the deployment has not configured falls back to a default. */
let settings: Record<string, string> = {};
const mockConfig = { get: jest.fn((key: string) => settings[key]) };

const REQUEST: InvoiceRequest = {
  paymentId: 7,
  razorpayPaymentId: 'pay_1',
  razorpayInvoiceId: 'inv_rzp_1',
  ssoOrgId: 'org_1',
  userId: 11,
  planCode: 'growth',
  planName: 'Growth',
  amount: 99_900,
  currency: 'INR',
  paidAt: new Date('2026-09-01T06:30:00Z'),
  method: 'card',
  methodDetail: 'Visa ···· 4242',
  periodStart: new Date('2026-09-01T00:00:00Z'),
  periodEnd: new Date('2026-10-01T00:00:00Z'),
};

/** A row as the database would hand it back. */
const row = (over: Partial<InvoiceWithLines> = {}): InvoiceWithLines =>
  ({
    id: 1,
    number: 'INV-WAC-2627-0001',
    financialYear: '2627',
    sequence: 1,
    razorpayPaymentId: 'pay_1',
    razorpayInvoiceId: 'inv_rzp_1',
    paymentId: 7,
    ssoOrgId: 'org_1',
    billingGroupId: null,
    billedToName: 'Ada Lovelace',
    billedToEmail: 'ada@example.com',
    organisationName: 'Acme Retail',
    summary: 'Growth',
    periodStart: new Date('2026-09-01T00:00:00Z'),
    periodEnd: new Date('2026-10-01T00:00:00Z'),
    subtotal: 99_900,
    taxAmount: 0,
    taxRateBps: 0,
    taxLabel: null,
    total: 99_900,
    currency: 'INR',
    paymentMethod: 'Visa ···· 4242',
    issuedAt: new Date('2026-09-01T06:30:00Z'),
    paidAt: new Date('2026-09-01T06:30:00Z'),
    emailedAt: null,
    emailedTo: null,
    lines: [
      {
        id: 1,
        invoiceId: 1,
        ssoOrgId: 'org_1',
        description: 'Growth plan',
        detail: null,
        planCode: 'growth',
        planName: 'Growth',
        quantity: 1,
        unitAmount: 99_900,
        amount: 99_900,
        position: 0,
      },
    ],
    ...over,
  }) as InvoiceWithLines;

/** What `invoice.create` was asked to write. */
const written = (): {
  number: string;
  sequence: number;
  subtotal: number;
  taxAmount: number;
  taxRateBps: number;
  taxLabel: string | null;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  placeOfSupply: string | null;
  placeOfSupplyCode: string | null;
  billedToGstin: string | null;
  billedToAddress: string | null;
  sacCode: string | null;
  total: number;
  summary: string | null;
  ssoOrgId: string;
  billingGroupId: number | null;
  billedToEmail: string | null;
  lines: { create: Prisma.InvoiceLineCreateWithoutInvoiceInput[] };
} => firstArg<{ data: never }>(mockTx.invoice.create).data;

describe('InvoiceService', () => {
  let service: InvoiceService;

  beforeEach(async () => {
    jest.clearAllMocks();
    settings = {};
    mockPrisma.invoice.findUnique.mockResolvedValue(null);
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.subscription.findMany.mockResolvedValue([]);
    mockPrisma.organisationSettings.findMany.mockResolvedValue([]);
    // No tax identity on file unless a test puts one there: the default
    // customer is unregistered and has entered no address.
    mockPrisma.organisationSettings.findUnique.mockResolvedValue(null);
    // A receipt is raised with every invoice; tests that care about it set
    // their own. By default there is one, so the pair travel together.
    mockReceipts.recordIn.mockResolvedValue({
      id: 5,
      number: 'RCT-WAC-2627-0001',
    });
    mockReceipts.forInvoice.mockResolvedValue({
      id: 5,
      number: 'RCT-WAC-2627-0001',
    });
    mockPrisma.user.findUnique.mockResolvedValue({
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    mockOrgDirectory.name.mockResolvedValue('Acme Retail');
    mockTx.$queryRaw.mockResolvedValue([{ sequence: 1 }]);
    mockMail = mailNotificationsDouble();
    // `create` takes a nested write for the lines and returns them as rows, so
    // the double has to unwrap it — a row whose `lines` is a create-payload
    // would break the PDF and every failure would look like something else.
    mockTx.invoice.create.mockImplementation(
      ({
        data,
      }: {
        data: Record<string, unknown> & {
          lines?: { create: Record<string, unknown>[] };
        };
      }) => {
        const { lines, ...rest } = data;
        return Promise.resolve(
          row({
            ...(rest as Partial<InvoiceWithLines>),
            lines: (lines?.create ?? []) as InvoiceWithLines['lines'],
          }),
        );
      },
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: OrgDirectoryService, useValue: mockOrgDirectory },
        { provide: MailNotifications, useValue: mockMail },
        { provide: ReceiptService, useValue: mockReceipts },
      ],
    }).compile();
    service = module.get(InvoiceService);
  });

  describe('the number', () => {
    it('is drawn from the counter, in this deployment’s series', async () => {
      mockTx.$queryRaw.mockResolvedValue([{ sequence: 42 }]);

      await service.issueFor(REQUEST);

      expect(written().number).toBe('INV-WAC-2627-0042');
      expect(written().sequence).toBe(42);
    });

    it('takes the series from configuration, and refuses a nonsense one', async () => {
      // A series that does not match the format would produce numbers our own
      // route parameter rejects — every invoice the deployment ever raised.
      settings.INVOICE_SERIES = 'not a series!';

      await service.issueFor(REQUEST);

      expect(written().number).toBe('INV-WAC-2627-0001');
    });

    it('files a charge by Indian local time, not the pod’s', async () => {
      // 03:00 IST on 1 April is the new year's first invoice. The same instant
      // is 21:30 on 31 March in UTC, which is the year that had already closed.
      await service.issueFor({
        ...REQUEST,
        paidAt: new Date('2027-03-31T21:30:00Z'),
      });

      expect(written().number).toBe('INV-WAC-2728-0001');
    });

    it('refuses to write an invoice the counter would not number', async () => {
      // Rather than a document numbered NaN, or one silently numbered zero.
      mockTx.$queryRaw.mockResolvedValue([]);

      const invoice = await service.issueFor(REQUEST);

      expect(invoice).toBeNull();
    });
  });

  describe('one debit, one invoice', () => {
    it('returns the invoice a replayed webhook already raised', async () => {
      // Razorpay retries under a fresh event id, so the event guard does not
      // catch this one. The payment id does.
      mockPrisma.invoice.findUnique.mockResolvedValue(row());

      const invoice = await service.issueFor(REQUEST);

      expect(invoice?.number).toBe('INV-WAC-2627-0001');
      expect(mockTx.invoice.create).not.toHaveBeenCalled();
      expect(mockTx.$queryRaw).not.toHaveBeenCalled();
    });

    it('resolves a race by reading the invoice the winner wrote', async () => {
      mockTx.invoice.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: '6',
        }),
      );
      mockPrisma.invoice.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(row({ number: 'INV-WAC-2627-0009' }));

      const invoice = await service.issueFor(REQUEST);

      expect(invoice?.number).toBe('INV-WAC-2627-0009');
    });
  });

  describe('what the money bought', () => {
    it('writes one line for a subscription somebody pays for themselves', async () => {
      await service.issueFor(REQUEST);

      const lines = written().lines.create;
      expect(lines).toHaveLength(1);
      expect(lines[0].description).toBe('Growth plan');
      expect(lines[0].ssoOrgId).toBe('org_1');
      expect(lines[0].amount).toBe(99_900);
    });

    it('writes a line per client for an agency’s mandate', async () => {
      // One debit, several clients. A single total would leave the agency
      // unable to tell what it had paid for.
      mockPrisma.subscription.findMany.mockResolvedValue([
        {
          ssoOrgId: 'org_kettle',
          plan: { code: 'growth', name: 'Growth', price: 99_900 },
        },
        {
          ssoOrgId: 'org_loom',
          plan: { code: 'growth', name: 'Growth', price: 99_900 },
        },
      ]);
      mockPrisma.organisationSettings.findMany.mockResolvedValue([
        { ssoOrgId: 'org_kettle', clientName: 'Kettle Coffee' },
        { ssoOrgId: 'org_loom', clientName: 'Loom & Thread' },
      ]);

      await service.issueFor({
        ...REQUEST,
        ssoOrgId: 'org_agency',
        billingGroupId: 9,
        amount: 199_800,
      });

      const lines = written().lines.create;
      expect(lines.map((l) => l.description)).toEqual([
        'Growth — Kettle Coffee',
        'Growth — Loom & Thread',
      ]);
      // Addressed to the agency: that is whose bank moved.
      expect(written().ssoOrgId).toBe('org_agency');
      // But each line says which client it bought for, which is what lets the
      // client be shown the line that paid for its own month.
      expect(lines.map((l) => l.ssoOrgId)).toEqual(['org_kettle', 'org_loom']);
    });

    it('prefers the agency’s own label for a client to the directory’s', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([
        {
          ssoOrgId: 'org_kettle',
          plan: { code: 'growth', name: 'Growth', price: 99_900 },
        },
      ]);
      mockPrisma.organisationSettings.findMany.mockResolvedValue([
        { ssoOrgId: 'org_kettle', clientName: 'Kettle Coffee' },
      ]);
      mockOrgDirectory.name.mockResolvedValue('Some Other Name Ltd');

      await service.issueFor({ ...REQUEST, billingGroupId: 9 });

      expect(written().lines.create[0].description).toContain('Kettle Coffee');
    });

    it('still raises a document for a mandate charged with no clients left', async () => {
      // It has taken money. Money that moved gets a document, whatever state
      // the roster was in when it did.
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      await service.issueFor({ ...REQUEST, billingGroupId: 9 });

      const lines = written().lines.create;
      expect(lines).toHaveLength(1);
      expect(lines[0].detail).toContain('No clients');
    });

    it('divides the money by list price, so tiers are not charged alike', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([
        {
          ssoOrgId: 'org_a',
          plan: { code: 'growth', name: 'Growth', price: 99_900 },
        },
        {
          ssoOrgId: 'org_b',
          plan: { code: 'starter', name: 'Starter', price: 49_900 },
        },
      ]);

      await service.issueFor({
        ...REQUEST,
        billingGroupId: 9,
        amount: 149_800,
      });

      const lines = written().lines.create;
      expect(lines[0].amount).toBe(99_900);
      expect(lines[1].amount).toBe(49_900);
    });

    it('makes the lines add up to the subtotal, whatever the rounding', async () => {
      // A document whose column does not sum to its own total is worse than
      // one with no column at all, so the last line absorbs the remainder.
      mockPrisma.subscription.findMany.mockResolvedValue([
        { ssoOrgId: 'org_a', plan: { code: 'p', name: 'P', price: 100 } },
        { ssoOrgId: 'org_b', plan: { code: 'p', name: 'P', price: 100 } },
        { ssoOrgId: 'org_c', plan: { code: 'p', name: 'P', price: 100 } },
      ]);

      await service.issueFor({ ...REQUEST, billingGroupId: 9, amount: 100 });

      const written_ = written();
      const sum = written_.lines.create.reduce((n, l) => n + l.amount, 0);
      expect(sum).toBe(written_.subtotal);
    });
  });

  describe('tax', () => {
    it('works the tax back out of the total rather than adding it on', async () => {
      // The price list is inclusive: what the customer authorised is what the
      // bank moved, and the document may not restate it.
      settings.INVOICE_TAX_RATE_BPS = '1800';

      await service.issueFor(REQUEST);

      const invoice = written();
      expect(invoice.total).toBe(99_900);
      expect(invoice.subtotal + invoice.taxAmount).toBe(99_900);
      expect(invoice.subtotal).toBe(84_661);
      expect(invoice.taxLabel).toBe('GST');
    });

    it('charges no tax, and names none, where no rate is configured', async () => {
      await service.issueFor(REQUEST);

      const invoice = written();
      expect(invoice.taxAmount).toBe(0);
      expect(invoice.taxRateBps).toBe(0);
      expect(invoice.taxLabel).toBeNull();
      expect(invoice.subtotal).toBe(invoice.total);
    });

    it('splits it into CGST and SGST for a customer in our own state', async () => {
      settings.INVOICE_TAX_RATE_BPS = '1800';
      settings.INVOICE_SELLER_GSTIN = '29AAPFU0939F1ZR';
      mockPrisma.organisationSettings.findUnique.mockResolvedValue({
        gstin: '29AAGCB7383J1Z1',
        legalName: 'Acme Retail Private Limited',
        billingAddress: '12 Residency Road',
        billingCity: 'Bengaluru',
        billingPostalCode: '560025',
        stateCode: '29',
      });

      await service.issueFor(REQUEST);

      const invoice = written();
      expect(invoice.cgstAmount + invoice.sgstAmount).toBe(invoice.taxAmount);
      expect(invoice.igstAmount).toBe(0);
      expect(invoice.placeOfSupply).toBe('Karnataka (29)');
      expect(invoice.placeOfSupplyCode).toBe('29');
      expect(invoice.billedToGstin).toBe('29AAGCB7383J1Z1');
      expect(invoice.sacCode).toBe('998314');
    });

    it('charges IGST whole for a customer in another state', async () => {
      settings.INVOICE_TAX_RATE_BPS = '1800';
      settings.INVOICE_SELLER_GSTIN = '29AAPFU0939F1ZR';
      mockPrisma.organisationSettings.findUnique.mockResolvedValue({
        gstin: null,
        legalName: null,
        billingAddress: null,
        billingCity: 'Mumbai',
        billingPostalCode: '400050',
        stateCode: '27',
      });

      await service.issueFor(REQUEST);

      const invoice = written();
      expect(invoice.igstAmount).toBe(invoice.taxAmount);
      expect(invoice.cgstAmount).toBe(0);
      expect(invoice.sgstAmount).toBe(0);
      expect(invoice.placeOfSupply).toBe('Maharashtra (27)');
    });

    it('reads the state off the customer’s registration where they gave no state', async () => {
      settings.INVOICE_TAX_RATE_BPS = '1800';
      settings.INVOICE_SELLER_GSTIN = '29AAPFU0939F1ZR';
      mockPrisma.organisationSettings.findUnique.mockResolvedValue({
        gstin: '27AAPFU0939F1ZV',
        legalName: null,
        billingAddress: null,
        billingCity: null,
        billingPostalCode: null,
        stateCode: null,
      });

      await service.issueFor(REQUEST);

      expect(written().placeOfSupplyCode).toBe('27');
      expect(written().igstAmount).toBeGreaterThan(0);
    });

    it('treats a customer of unknown state as local rather than guessing', async () => {
      // IGST wrongly charged on a local supply is the harder error to unwind:
      // the customer’s credit is refused and it takes a credit note to fix.
      settings.INVOICE_TAX_RATE_BPS = '1800';
      settings.INVOICE_SELLER_GSTIN = '29AAPFU0939F1ZR';

      await service.issueFor(REQUEST);

      const invoice = written();
      expect(invoice.igstAmount).toBe(0);
      expect(invoice.cgstAmount + invoice.sgstAmount).toBe(invoice.taxAmount);
      expect(invoice.placeOfSupply).toBeNull();
    });

    it('names no tax heads at all where the deployment charges no tax', async () => {
      settings.INVOICE_SELLER_GSTIN = '29AAPFU0939F1ZR';

      await service.issueFor(REQUEST);

      const invoice = written();
      expect(invoice.cgstAmount).toBe(0);
      expect(invoice.sgstAmount).toBe(0);
      expect(invoice.igstAmount).toBe(0);
      expect(invoice.sacCode).toBeNull();
    });
  });

  describe('the receipt', () => {
    it('is raised in the same transaction as the invoice', async () => {
      // An invoice without its receipt is a customer who cannot prove they
      // paid. The pair commit together or not at all.
      await service.issueFor(REQUEST);

      expect(mockReceipts.recordIn).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({ number: 'INV-WAC-2627-0001' }),
      );
    });

    it('travels in the same email as the invoice', async () => {
      await service.issueFor(REQUEST);

      // Read off the typed double rather than matched, so the assertion is
      // about the values and not about matcher shapes.
      const [mailed] = mockMail.invoiceIssued.mock.calls[0];
      expect(mailed.number).toBe('INV-WAC-2627-0001');
      expect(mailed.receiptNumber).toBe('RCT-WAC-2627-0001');
      expect(Buffer.isBuffer(mailed.receiptPdf)).toBe(true);
    });

    it('is stamped as sent alongside the invoice', async () => {
      // Stamping only the invoice would leave the sweep re-sending a receipt
      // that has already arrived.
      await service.issueFor(REQUEST);

      const stamped = firstArg<{
        where: { id: number };
        data: { emailedAt: Date; emailedTo: string };
      }>(mockPrisma.receipt.update);
      expect(stamped.where.id).toBe(5);
      expect(stamped.data.emailedTo).toBe('ada@example.com');
    });

    it('does not stop the invoice going out when there is none', async () => {
      // An invoice raised before receipts existed still has to be re-sendable.
      mockReceipts.forInvoice.mockResolvedValue(null);

      const sent = await service.deliver(row());

      expect(sent).toBe(true);
      expect(mockMail.invoiceIssued).toHaveBeenCalledWith(
        expect.objectContaining({ receiptNumber: null, receiptPdf: null }),
      );
      expect(mockPrisma.receipt.update).not.toHaveBeenCalled();
    });
  });

  describe('sending', () => {
    it('mails the document and stamps that it went', async () => {
      await service.issueFor(REQUEST);

      expect(mockMail.invoiceIssued).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'ada@example.com',
          number: 'INV-WAC-2627-0001',
        }),
      );
      const [{ data }] = mockPrisma.invoice.update.mock.calls[0] as [
        { data: { emailedAt: Date; emailedTo: string } },
      ];
      expect(data.emailedTo).toBe('ada@example.com');
    });

    it('leaves an invoice it could not send for the sweep to pick up', async () => {
      // The customer has been charged. Losing the document because SES was
      // down would be the worst of the available outcomes.
      (mockMail.invoiceIssued as jest.Mock).mockResolvedValueOnce(false);

      await service.issueFor(REQUEST);

      expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
    });

    it('raises the invoice even with nobody to send it to', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await service.issueFor(REQUEST);

      expect(mockTx.invoice.create).toHaveBeenCalled();
      expect(written().billedToEmail).toBeNull();
      expect(mockMail.invoiceIssued).not.toHaveBeenCalled();
    });

    it('resends what was raised while mail was down', async () => {
      mockPrisma.invoice.findMany.mockResolvedValue([row(), row({ id: 2 })]);

      const sent = await service.deliverPending();

      expect(sent).toBe(2);
    });

    it('carries on past one invoice it cannot resend', async () => {
      mockPrisma.invoice.findMany.mockResolvedValue([row(), row({ id: 2 })]);
      (mockMail.invoiceIssued as jest.Mock).mockRejectedValueOnce(
        new Error('SES refused'),
      );

      await expect(service.deliverPending()).resolves.toBe(1);
    });
  });

  describe('never failing the webhook that called it', () => {
    it('swallows a database failure rather than having the charge redelivered', async () => {
      // The money has already moved. Throwing would have Razorpay redeliver
      // the charge, which fixes nothing and re-applies everything.
      mockPrisma.user.findUnique.mockRejectedValue(new Error('database down'));

      await expect(service.issueFor(REQUEST)).resolves.toBeNull();
    });
  });

  describe('who may read one', () => {
    it('gives an organisation its own invoice', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(row());

      const invoice = await service.findForOrgs(['org_1'], 'INV-WAC-2627-0001');

      expect(invoice).not.toBeNull();
    });

    it('gives a client the invoice that bought its month, though it did not pay', async () => {
      // The document is addressed to the agency. The client is on it, and is
      // entitled to see the line that paid for it.
      mockPrisma.invoice.findUnique.mockResolvedValue(
        row({
          ssoOrgId: 'org_agency',
          lines: [
            {
              id: 1,
              invoiceId: 1,
              ssoOrgId: 'org_kettle',
              description: 'Growth — Kettle Coffee',
              detail: null,
              planCode: 'growth',
              planName: 'Growth',
              quantity: 1,
              unitAmount: 99_900,
              amount: 99_900,
              position: 0,
            },
          ],
        }),
      );

      const invoice = await service.findForOrgs(
        ['org_kettle'],
        'INV-WAC-2627-0001',
      );

      expect(invoice).not.toBeNull();
    });

    it('refuses somebody else’s number rather than answering it', async () => {
      // The numbers are sequential. An unscoped lookup would let anyone with a
      // session walk the whole series.
      mockPrisma.invoice.findUnique.mockResolvedValue(row());

      const invoice = await service.findForOrgs(
        ['org_stranger'],
        'INV-WAC-2627-0001',
      );

      expect(invoice).toBeNull();
    });
  });

  describe('what a client is shown of an agency’s invoice', () => {
    /** An agency's document, carrying two of its clients. */
    const agencyInvoice = () =>
      row({
        ssoOrgId: 'org_agency',
        organisationName: 'Northwind Digital',
        subtotal: 149_800,
        total: 149_800,
        taxAmount: 0,
        emailedTo: 'ops@northwind.example',
        lines: [
          {
            id: 1,
            invoiceId: 1,
            ssoOrgId: 'org_kettle',
            description: 'Growth — Kettle Coffee',
            detail: null,
            planCode: 'growth',
            planName: 'Growth',
            quantity: 1,
            unitAmount: 99_900,
            amount: 99_900,
            position: 0,
          },
          {
            id: 2,
            invoiceId: 1,
            ssoOrgId: 'org_loom',
            description: 'Starter — Loom & Thread',
            detail: null,
            planCode: 'starter',
            planName: 'Starter',
            quantity: 1,
            unitAmount: 49_900,
            amount: 49_900,
            position: 1,
          },
        ],
      } as Partial<InvoiceWithLines>);

    it('shows a client its own line and not its rivals’', () => {
      // The document names every client of the agency and what each costs.
      // None of that is this client's business.
      const dto = service.toDtoFor(agencyInvoice(), 'org_kettle');

      expect(dto.lines).toHaveLength(1);
      expect(dto.lines[0].description).toBe('Growth — Kettle Coffee');
      expect(JSON.stringify(dto)).not.toContain('Loom');
      expect(JSON.stringify(dto)).not.toContain('49900');
    });

    it('totals the client’s own share, not the whole debit', () => {
      const dto = service.toDtoFor(agencyInvoice(), 'org_kettle');

      expect(dto.total).toBe(99_900);
      expect(dto.extract).toBe(true);
      // The document's tax divides the whole debit, so restating it against a
      // partial total would be arithmetic nobody could check.
      expect(dto.taxAmount).toBe(0);
      expect(dto.taxRateBps).toBe(0);
    });

    it('does not offer the client the PDF, which is the agency’s whole debit', () => {
      const dto = service.toDtoFor(agencyInvoice(), 'org_kettle');

      expect(dto.downloadable).toBe(false);
      // Nor the address it was sent to, which is the agency's.
      expect(dto.emailedTo).toBeNull();
    });

    it('gives the agency its own document whole', () => {
      const dto = service.toDtoFor(agencyInvoice(), 'org_agency');

      expect(dto.lines).toHaveLength(2);
      expect(dto.total).toBe(149_800);
      expect(dto.extract).toBe(false);
      expect(dto.downloadable).toBe(true);
    });

    it('refuses the whole document to a client that is only on a line', () => {
      // What the PDF route asks. Answering it would hand the client every
      // other client's name and price as a file.
      mockPrisma.invoice.findUnique.mockResolvedValue(agencyInvoice());

      return expect(
        service.findAddressedTo(['org_kettle'], 'INV-WAC-2627-0001'),
      ).resolves.toBeNull();
    });

    it('gives the whole document to the organisation it is addressed to', () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(agencyInvoice());

      return expect(
        service.findAddressedTo(['org_agency'], 'INV-WAC-2627-0001'),
      ).resolves.not.toBeNull();
    });
  });

  describe('the document', () => {
    it('renders a PDF a reader will open', () => {
      const pdf = service.pdf(row());

      expect(pdf.toString('latin1').startsWith('%PDF-1.4')).toBe(true);
      expect(service.filename(row())).toBe('INV-WAC-2627-0001.pdf');
    });
  });

  describe('at boot', () => {
    let logged: { level: 'error' | 'log'; text: string }[] = [];

    /** What the logger was told at a given level. */
    const at = (level: 'error' | 'log'): string =>
      logged
        .filter((entry) => entry.level === level)
        .map((entry) => entry.text)
        .join(' ');

    beforeEach(() => {
      logged = [];
      jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((message: unknown) => {
          logged.push({ level: 'error', text: String(message) });
        });
      jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation((message: unknown) => {
          logged.push({ level: 'log', text: String(message) });
        });
    });

    afterEach(() => jest.restoreAllMocks());

    it('says nothing where the deployment charges no tax', () => {
      service.onModuleInit();

      expect(at('error')).toBe('');
    });

    it('shouts when tax is on and there is no registration to state it under', () => {
      // The quiet failure: nothing throws, and every invoice is wrong.
      settings.INVOICE_TAX_RATE_BPS = '1800';

      service.onModuleInit();

      expect(at('error')).toContain('INVOICE_SELLER_GSTIN is not set');
    });

    it('shouts when the registration cannot be read', () => {
      settings.INVOICE_TAX_RATE_BPS = '1800';
      settings.INVOICE_SELLER_GSTIN = 'NOT-A-GSTIN';

      service.onModuleInit();

      expect(at('error')).toContain('not a valid GSTIN');
    });

    it('is quiet, and says where it supplies from, when it is set up', () => {
      settings.INVOICE_TAX_RATE_BPS = '1800';
      settings.INVOICE_SELLER_GSTIN = '29AAPFU0939F1ZR';

      service.onModuleInit();

      expect(at('error')).toBe('');
      expect(at('log')).toContain('Karnataka (29)');
    });
  });
});
