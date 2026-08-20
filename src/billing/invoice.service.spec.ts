import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Invoice } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { OrgDirectoryService } from 'src/org/org-directory.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import { mailNotificationsDouble } from 'src/mail/mail.test-doubles';
import { InvoiceRequest, InvoiceService } from './invoice.service';

const mockTx = {
  $queryRaw: jest.fn(),
  invoice: { create: jest.fn() },
};

const mockPrisma = {
  invoice: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  user: { findUnique: jest.fn() },
  $transaction: jest.fn((cb: (tx: typeof mockTx) => unknown): unknown =>
    cb(mockTx),
  ) as jest.Mock,
};

const mockOrgDirectory = { name: jest.fn() };
const mockMail = mailNotificationsDouble();

/** Whatever the deployment has not configured falls back to a default. */
const settings: Record<string, string> = {};
const mockConfig = { get: jest.fn((key: string) => settings[key]) };

const REQUEST: InvoiceRequest = {
  paymentId: 7,
  razorpayPaymentId: 'pay_1',
  razorpayInvoiceId: 'inv_rzp_1',
  subscriptionId: 3,
  ssoOrgId: 'org_1',
  wabaId: 'waba_1',
  userId: 11,
  accountName: 'Acme Support',
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
const row = (over: Partial<Invoice> = {}): Invoice =>
  ({
    id: 1,
    number: 'INV-WAC-2627-0001',
    financialYear: '2627',
    sequence: 1,
    razorpayPaymentId: 'pay_1',
    razorpayInvoiceId: 'inv_rzp_1',
    paymentId: 7,
    ssoOrgId: 'org_1',
    wabaId: 'waba_1',
    billedToName: 'Ada Lovelace',
    billedToEmail: 'ada@example.com',
    organisationName: 'Acme Retail',
    accountName: 'Acme Support',
    planName: 'Growth',
    description: 'Growth plan — Acme Support',
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
    ...over,
  }) as Invoice;

describe('InvoiceService', () => {
  let service: InvoiceService;

  beforeEach(async () => {
    jest.clearAllMocks();
    for (const key of Object.keys(settings)) delete settings[key];

    mockPrisma.invoice.findUnique.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    mockOrgDirectory.name.mockResolvedValue('Acme Retail');
    // Restored per test: clearAllMocks empties the call log but leaves an
    // implementation a previous test set behind.
    mockMail.invoiceIssued.mockResolvedValue(true);
    mockTx.$queryRaw.mockResolvedValue([{ sequence: 1 }]);
    mockTx.invoice.create.mockImplementation(({ data }: { data: Invoice }) =>
      Promise.resolve(row(data)),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: OrgDirectoryService, useValue: mockOrgDirectory },
        { provide: MailNotifications, useValue: mockMail },
      ],
    }).compile();
    service = module.get<InvoiceService>(InvoiceService);
  });

  describe('issueFor', () => {
    it('numbers the invoice from the series, the financial year and the counter', async () => {
      mockTx.$queryRaw.mockResolvedValue([{ sequence: 4 }]);

      await service.issueFor(REQUEST);

      expect(mockTx.invoice.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            number: 'INV-WAC-2627-0004',
            financialYear: '2627',
            sequence: 4,
          }),
        }),
      );
    });

    it('files a payment taken in January under the year that began in April', async () => {
      await service.issueFor({
        ...REQUEST,
        paidAt: new Date('2027-01-15T06:30:00Z'),
      });

      expect(mockTx.invoice.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ financialYear: '2627' }),
        }),
      );
    });

    it('takes the number from the counter inside the transaction that writes the row', async () => {
      // The two have to move together, or a rollback leaves a hole in the
      // series and two webhooks racing get the same number.
      await service.issueFor(REQUEST);

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockTx.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('raises nothing a second time for a payment already invoiced', async () => {
      // Razorpay retries webhooks; a retry must not draw another number.
      mockPrisma.invoice.findUnique.mockResolvedValue(row());

      const invoice = await service.issueFor(REQUEST);

      expect(invoice?.number).toBe('INV-WAC-2627-0001');
      expect(mockTx.invoice.create).not.toHaveBeenCalled();
      expect(mockTx.$queryRaw).not.toHaveBeenCalled();
    });

    it('snapshots who it was billed to rather than pointing at the account', async () => {
      await service.issueFor(REQUEST);

      expect(mockTx.invoice.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            billedToName: 'Ada Lovelace',
            billedToEmail: 'ada@example.com',
            organisationName: 'Acme Retail',
            accountName: 'Acme Support',
            planName: 'Growth',
            description: 'Growth plan — Acme Support',
            paymentMethod: 'Visa ···· 4242',
          }),
        }),
      );
    });

    it('charges no tax where no rate is configured', async () => {
      await service.issueFor(REQUEST);

      expect(mockTx.invoice.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            subtotal: 99_900,
            taxAmount: 0,
            taxRateBps: 0,
            taxLabel: null,
            total: 99_900,
          }),
        }),
      );
    });

    it('works the tax back out of an inclusive price', async () => {
      settings.INVOICE_TAX_RATE_BPS = '1800';

      await service.issueFor(REQUEST);

      const { data } = mockTx.invoice.create.mock.calls[0][0] as {
        data: Invoice;
      };
      expect(data.subtotal).toBe(84_661);
      expect(data.taxAmount).toBe(15_239);
      expect(data.taxLabel).toBe('GST');
      // The one number that is not ours to restate: it is what the bank moved.
      expect(data.subtotal + data.taxAmount).toBe(REQUEST.amount);
      expect(data.total).toBe(REQUEST.amount);
    });

    it('honours the deployment’s own series', async () => {
      settings.INVOICE_SERIES = 'dlx';

      await service.issueFor(REQUEST);

      expect(mockTx.invoice.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ number: 'INV-DLX-2627-0001' }),
        }),
      );
    });

    it('falls back rather than issuing numbers its own routes would reject', async () => {
      settings.INVOICE_SERIES = 'not a series';

      await service.issueFor(REQUEST);

      expect(mockTx.invoice.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ number: 'INV-WAC-2627-0001' }),
        }),
      );
    });

    it('emails it, with the document attached, and records that it went', async () => {
      await service.issueFor(REQUEST);

      expect(mockMail.invoiceIssued).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'ada@example.com',
          number: 'INV-WAC-2627-0001',
          total: 'INR 999.00',
          pdf: expect.any(Buffer),
        }),
      );
      expect(mockPrisma.invoice.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { emailedAt: expect.any(Date), emailedTo: 'ada@example.com' },
      });
    });

    it('leaves the invoice unstamped when the send fails, so the sweep tries again', async () => {
      mockMail.invoiceIssued.mockResolvedValue(false);

      await service.issueFor(REQUEST);

      expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
    });

    it('still raises the invoice for a user with no address on file', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        email: null,
        firstName: 'Ada',
        lastName: null,
      });
      mockTx.invoice.create.mockResolvedValue(row({ billedToEmail: null }));

      const invoice = await service.issueFor(REQUEST);

      expect(invoice).not.toBeNull();
      expect(mockMail.invoiceIssued).not.toHaveBeenCalled();
    });

    it('never throws at the webhook that called it', async () => {
      // The money has already moved. Failing here would have Razorpay redeliver
      // the charge rather than fix the document.
      mockPrisma.$transaction.mockRejectedValueOnce(new Error('db down'));

      await expect(service.issueFor(REQUEST)).resolves.toBeNull();
    });
  });

  describe('deliverPending', () => {
    it('sends the invoices that were raised while mail was down', async () => {
      mockPrisma.invoice.findMany.mockResolvedValue([
        row({ id: 1, number: 'INV-WAC-2627-0001' }),
        row({ id: 2, number: 'INV-WAC-2627-0002' }),
      ]);

      await expect(service.deliverPending()).resolves.toBe(2);
      expect(mockMail.invoiceIssued).toHaveBeenCalledTimes(2);
    });

    it('carries on past one that will not send', async () => {
      mockPrisma.invoice.findMany.mockResolvedValue([
        row({ id: 1 }),
        row({ id: 2 }),
      ]);
      mockMail.invoiceIssued.mockRejectedValueOnce(new Error('SES down'));

      await expect(service.deliverPending()).resolves.toBe(1);
    });
  });

  describe('findForOrg', () => {
    it('finds an invoice belonging to the organisation asking', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(row());

      await expect(
        service.findForOrg('org_1', 'INV-WAC-2627-0001'),
      ).resolves.not.toBeNull();
    });

    it('refuses one belonging to somebody else', async () => {
      // The numbers are sequential, so an unscoped lookup would let anyone with
      // a session walk the whole series.
      mockPrisma.invoice.findUnique.mockResolvedValue(row());

      await expect(
        service.findForOrg('org_2', 'INV-WAC-2627-0001'),
      ).resolves.toBeNull();
    });
  });

  describe('pdf', () => {
    it('renders the stored snapshot, not a fresh read', async () => {
      const pdf = service.pdf(row({ organisationName: 'Renamed Since Ltd' }));

      expect(pdf.toString('latin1')).toContain('Renamed Since Ltd');
      expect(pdf.toString('latin1')).toContain('INV-WAC-2627-0001');
    });
  });
});
