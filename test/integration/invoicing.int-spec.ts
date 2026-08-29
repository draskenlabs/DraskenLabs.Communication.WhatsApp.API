import * as request from 'supertest';
import { Server } from 'http';
import { AgencyBillingService } from 'src/billing/agency-billing.service';
import { AgencyService } from 'src/agency/agency.service';
import { BillingService } from 'src/billing/billing.service';
import { InvoiceService } from 'src/billing/invoice.service';
import {
  Harness,
  ORG,
  PLAN_IDS,
  chargedEvent,
  mail,
  seedAccount,
  startHarness,
} from './harness';

/**
 * Invoicing, against a real database and the provider stand-in over real HTTP.
 *
 * The unit suite proves each decision in isolation. This proves the three
 * things it cannot: that the counter really is safe against two webhooks
 * arriving together, that a charge end to end leaves a numbered document
 * behind, and that one organisation cannot read another's — which is the only
 * thing standing between a sequential series and anybody with a session.
 */
describe('Invoicing (integration)', () => {
  let h: Harness;
  let invoices: InvoiceService;
  let agency: AgencyService;
  let agencyBilling: AgencyBillingService;
  let billing: BillingService;

  beforeAll(async () => {
    h = await startHarness();
    invoices = h.app.get(InvoiceService);
    agency = h.app.get(AgencyService);
    agencyBilling = h.app.get(AgencyBillingService);
    billing = h.app.get(BillingService);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.reset();
  });

  /** Deliver a `subscription.charged` webhook the way Razorpay would. */
  async function charge(input: {
    subscriptionId: string;
    paymentId: string;
    amount?: number;
    eventId?: string;
  }): Promise<void> {
    const body = chargedEvent({
      subscriptionId: input.subscriptionId,
      planId: PLAN_IDS.growth,
      paymentId: input.paymentId,
      amount: input.amount ?? 99_900,
    });
    await request(h.app.getHttpServer() as Server)
      .post('/billing/webhook')
      .set('x-razorpay-event-id', input.eventId ?? `evt_${input.paymentId}`)
      .set('x-razorpay-signature', h.webhookSignature(body))
      .send(body)
      .expect(200);
  }

  /** An organisation paying for itself, and the mandate it is paying on. */
  async function selfPaid(): Promise<string> {
    const { userId } = await seedAccount(h.prisma);
    const registered = await billing.register(userId, ORG, 'growth');
    h.razorpay.reset();
    return registered.subscriptionId;
  }

  describe('a charge on a subscription somebody pays for themselves', () => {
    it('leaves a numbered document behind', async () => {
      const sub = await selfPaid();

      await charge({ subscriptionId: sub, paymentId: 'pay_1' });

      const invoice = await h.prisma.invoice.findFirst({
        where: { ssoOrgId: ORG },
        include: { lines: true },
      });
      expect(invoice?.number).toBe('INV-WAC-2627-0001');
      expect(invoice?.total).toBe(99_900);
      expect(invoice?.lines).toHaveLength(1);
      // Joined to the debit it was raised for, which is what lets the payment
      // history link the document.
      expect(invoice?.paymentId).not.toBeNull();
    });

    it('numbers consecutive charges in order', async () => {
      const sub = await selfPaid();

      await charge({ subscriptionId: sub, paymentId: 'pay_1' });
      await charge({ subscriptionId: sub, paymentId: 'pay_2' });

      const numbers = await h.prisma.invoice.findMany({
        orderBy: { sequence: 'asc' },
        select: { number: true },
      });
      expect(numbers.map((i) => i.number)).toEqual([
        'INV-WAC-2627-0001',
        'INV-WAC-2627-0002',
      ]);
    });

    it('invoices a replayed charge once, however the event id differs', async () => {
      // Razorpay retries under a fresh event id, so the event guard does not
      // catch this. The payment id does.
      const sub = await selfPaid();

      await charge({
        subscriptionId: sub,
        paymentId: 'pay_1',
        eventId: 'evt_a',
      });
      await charge({
        subscriptionId: sub,
        paymentId: 'pay_1',
        eventId: 'evt_b',
      });

      expect(await h.prisma.invoice.count()).toBe(1);
    });

    it('emails the document, with the PDF on it', async () => {
      const sub = await selfPaid();

      await charge({ subscriptionId: sub, paymentId: 'pay_1' });

      const sent = mail.find((m) => m.options.template === 'billing.invoice');
      expect(sent).toBeDefined();
      const attachment = sent?.options.attachments?.[0];
      expect(attachment?.filename).toBe('INV-WAC-2627-0001.pdf');
      expect(attachment?.contentType).toBe('application/pdf');
      // A real PDF, not an empty attachment nobody would notice was empty.
      expect(
        Buffer.from(attachment?.content ?? '', 'base64')
          .toString('latin1')
          .startsWith('%PDF-'),
      ).toBe(true);

      const invoice = await h.prisma.invoice.findFirstOrThrow({});
      expect(invoice.emailedAt).not.toBeNull();
    });
  });

  describe('the receipt', () => {
    it('is raised with the invoice, in its own series', async () => {
      const sub = await selfPaid();

      await charge({ subscriptionId: sub, paymentId: 'pay_1' });

      const receipt = await h.prisma.receipt.findFirstOrThrow({});
      expect(receipt.number).toBe('RCT-WAC-2627-0001');
      // Its own counter: both documents are the first of their kind, and
      // neither took a number from the other's book.
      const invoice = await h.prisma.invoice.findFirstOrThrow({});
      expect(invoice.number).toBe('INV-WAC-2627-0001');
      expect(receipt.invoiceId).toBe(invoice.id);
      expect(receipt.amount).toBe(invoice.total);
    });

    it('rides the same email as the invoice, as a second attachment', async () => {
      const sub = await selfPaid();

      await charge({ subscriptionId: sub, paymentId: 'pay_1' });

      const sent = mail.find((m) => m.options.template === 'billing.invoice');
      const names = (sent?.options.attachments ?? []).map((a) => a.filename);
      expect(names).toEqual([
        'INV-WAC-2627-0001.pdf',
        'RCT-WAC-2627-0001.pdf',
      ]);

      const receiptPdf = sent?.options.attachments?.[1];
      expect(
        Buffer.from(receiptPdf?.content ?? '', 'base64')
          .toString('latin1')
          .startsWith('%PDF-'),
      ).toBe(true);
    });

    it('is stamped as sent alongside the invoice', async () => {
      const sub = await selfPaid();

      await charge({ subscriptionId: sub, paymentId: 'pay_1' });

      const receipt = await h.prisma.receipt.findFirstOrThrow({});
      expect(receipt.emailedAt).not.toBeNull();
      expect(receipt.emailedTo).toBe('integration@example.test');
    });

    it('is not raised twice for a replayed charge', async () => {
      const sub = await selfPaid();

      await charge({ subscriptionId: sub, paymentId: 'pay_1', eventId: 'evt_a' });
      await charge({ subscriptionId: sub, paymentId: 'pay_1', eventId: 'evt_b' });

      expect(await h.prisma.receipt.count()).toBe(1);
    });
  });

  describe('the series', () => {
    it('hands three concurrent charges three distinct numbers', async () => {
      // The whole reason the counter is one INSERT … ON CONFLICT … RETURNING
      // inside the writing transaction. A read-then-increment would hand two
      // of these the same number, and a statutory series would be broken by
      // the first busy minute.
      const sub = await selfPaid();

      await Promise.all([
        charge({ subscriptionId: sub, paymentId: 'pay_a' }),
        charge({ subscriptionId: sub, paymentId: 'pay_b' }),
        charge({ subscriptionId: sub, paymentId: 'pay_c' }),
      ]);

      const rows = await h.prisma.invoice.findMany({
        select: { number: true, sequence: true },
      });
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.number)).size).toBe(3);
      expect(rows.map((r) => r.sequence).sort()).toEqual([1, 2, 3]);
    });
  });

  describe('an agency’s mandate', () => {
    /** An agency with two clients on one plan, and its mandate authorised. */
    async function anAgencyWithClients(): Promise<{
      userId: number;
      razorpaySubscriptionId: string;
    }> {
      const { userId } = await seedAccount(h.prisma);
      await agency.convert(ORG, true, userId);
      await agency.attachClient(ORG, 'org_kettle', 'Kettle Coffee');
      await agency.attachClient(ORG, 'org_loom', 'Loom & Thread');
      await agencyBilling.subscribeClient({
        agencyOrgId: ORG,
        ssoOrgId: 'org_kettle',
        planCode: 'growth',
        userId,
      });
      const group = await h.prisma.agencyBillingGroup.findFirstOrThrow({
        where: { agencyOrgId: ORG },
      });
      await agencyBilling.applyToGroup(group.razorpaySubscriptionId, {
        status: 'active',
        current_start: Math.floor(Date.now() / 1000),
        current_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      });
      await agencyBilling.subscribeClient({
        agencyOrgId: ORG,
        ssoOrgId: 'org_loom',
        planCode: 'growth',
        userId,
      });

      const live = await h.prisma.agencyBillingGroup.findFirstOrThrow({
        where: { agencyOrgId: ORG },
      });
      return { userId, razorpaySubscriptionId: live.razorpaySubscriptionId };
    }

    it('raises one document for the debit, addressed to the agency', async () => {
      const { razorpaySubscriptionId } = await anAgencyWithClients();

      await charge({
        subscriptionId: razorpaySubscriptionId,
        paymentId: 'pay_group',
        amount: 199_800,
      });

      const invoices_ = await h.prisma.invoice.findMany({
        include: { lines: { orderBy: { position: 'asc' } } },
      });
      expect(invoices_).toHaveLength(1);
      // The agency's bank moved, so the agency is the customer.
      expect(invoices_[0].ssoOrgId).toBe(ORG);
      expect(invoices_[0].total).toBe(199_800);
    });

    it('names every client the debit bought for, on its own line', async () => {
      const { razorpaySubscriptionId } = await anAgencyWithClients();

      await charge({
        subscriptionId: razorpaySubscriptionId,
        paymentId: 'pay_group',
        amount: 199_800,
      });

      const invoice = await h.prisma.invoice.findFirstOrThrow({
        include: { lines: { orderBy: { position: 'asc' } } },
      });
      expect(invoice.lines.map((l) => l.description)).toEqual([
        'Growth — Kettle Coffee',
        'Growth — Loom & Thread',
      ]);
      expect(invoice.lines.map((l) => l.ssoOrgId)).toEqual([
        'org_kettle',
        'org_loom',
      ]);
      // The column adds up to the document's own subtotal.
      expect(invoice.lines.reduce((n, l) => n + l.amount, 0)).toBe(
        invoice.subtotal,
      );
    });

    it('shows a client the invoice that bought its month, though it paid nothing', async () => {
      // A client holds no mandate. Without this its billing history would be
      // empty for every month somebody else was paying for it.
      const { razorpaySubscriptionId } = await anAgencyWithClients();
      await charge({
        subscriptionId: razorpaySubscriptionId,
        paymentId: 'pay_group',
        amount: 199_800,
      });

      const own = await invoices.listCoveringOrg('org_kettle');

      expect(own).toHaveLength(1);
      expect(own[0].ssoOrgId).toBe(ORG);
    });

    it('shows a client its own line only, not the agency’s other clients', async () => {
      // The document names every client on the mandate and what each costs.
      // A client reading its own billing history must not read theirs.
      const { razorpaySubscriptionId } = await anAgencyWithClients();
      await charge({
        subscriptionId: razorpaySubscriptionId,
        paymentId: 'pay_group',
        amount: 199_800,
      });

      const [seen] = await invoices.listCoveringOrg('org_kettle');
      const dto = invoices.toDtoFor(seen, 'org_kettle');

      expect(dto.lines).toHaveLength(1);
      expect(JSON.stringify(dto)).not.toContain('Loom');
      expect(dto.extract).toBe(true);
      expect(dto.downloadable).toBe(false);
      // And it cannot fetch the file either.
      await expect(
        invoices.findAddressedTo(['org_kettle'], seen.number),
      ).resolves.toBeNull();
    });

    it('gives the agency its own and its clients’ together', async () => {
      const { razorpaySubscriptionId } = await anAgencyWithClients();
      await charge({
        subscriptionId: razorpaySubscriptionId,
        paymentId: 'pay_group',
        amount: 199_800,
      });

      const listed = await agency.invoices(ORG);

      expect(listed.map((i) => i.number)).toEqual(['INV-WAC-2627-0001']);
    });
  });

  describe('who may read one', () => {
    async function anInvoice(): Promise<string> {
      const sub = await selfPaid();
      await charge({ subscriptionId: sub, paymentId: 'pay_1' });
      const invoice = await h.prisma.invoice.findFirstOrThrow({});
      return invoice.number;
    }

    it('answers the organisation the document belongs to', async () => {
      const number = await anInvoice();

      const invoice = await invoices.findForOrgs([ORG], number);

      expect(invoice?.number).toBe(number);
    });

    it('refuses another organisation the same number', async () => {
      // The numbers are sequential. Without the scope, one session could walk
      // the whole series and read every customer's billing history.
      const number = await anInvoice();

      const invoice = await invoices.findForOrgs(['org_stranger'], number);

      expect(invoice).toBeNull();
    });
  });

  describe('an invoice raised while mail was down', () => {
    it('is picked up by the sweep and sent', async () => {
      const sub = await selfPaid();
      await charge({ subscriptionId: sub, paymentId: 'pay_1' });

      // As it would look had SES been unconfigured when the charge landed.
      await h.prisma.invoice.updateMany({ data: { emailedAt: null } });
      mail.length = 0;

      const sent = await invoices.deliverPending();

      expect(sent).toBe(1);
      expect(mail.some((m) => m.options.template === 'billing.invoice')).toBe(
        true,
      );
      const invoice = await h.prisma.invoice.findFirstOrThrow({});
      expect(invoice.emailedAt).not.toBeNull();
    });
  });
});
