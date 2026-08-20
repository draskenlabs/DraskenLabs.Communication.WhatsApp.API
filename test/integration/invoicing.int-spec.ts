import * as request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { Server } from 'http';
import { BillingService } from 'src/billing/billing.service';
import { InvoiceService } from 'src/billing/invoice.service';
import { financialYear } from 'src/billing/invoice.number';
import {
  chargedEvent,
  Harness,
  ORG,
  PLAN_IDS,
  seedAccount,
  startHarness,
} from './harness';

let h: Harness;

function api(): TestAgent<request.Test> {
  return request(h.app.getHttpServer() as Server);
}

function envelope<T>(res: request.Response): { data: T } {
  return res.body as { data: T };
}

/** The year the run itself falls in — the same rule the service applies. */
const YEAR = financialYear(new Date(), 'Asia/Kolkata');

interface InvoiceView {
  number: string;
  financialYear: string;
  organisationName: string | null;
  accountName: string | null;
  planName: string | null;
  description: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  currency: string;
  emailedAt: string | null;
}

interface SubscriptionView {
  payments: { razorpayPaymentId: string; invoiceNumber: string | null }[];
}

/**
 * Invoicing, end to end.
 *
 * The parts a mock cannot check are all here: the counter is one raw SQL
 * statement against Postgres, the "one invoice per debit" rule is a unique
 * index, the scoping is a real HTTP request with a real JWT, and the document
 * is a file that either parses as a PDF or does not.
 */
describe('Invoicing (integration)', () => {
  let billing: BillingService;
  let invoices: InvoiceService;
  let seeded: { userId: number; wabaId: string; ssoOrgId: string };

  beforeAll(async () => {
    h = await startHarness();
    billing = h.app.get(BillingService);
    invoices = h.app.get(InvoiceService);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.reset();
    seeded = await seedAccount(h.prisma);
  });

  /**
   * Subscribe the seeded account and hand back its Razorpay id.
   *
   * Through the service rather than the route: subscribing is throttled at
   * five a minute, and every test here needs a subscription before it can
   * charge one. The routes that this file is actually about are still called
   * over HTTP.
   */
  async function subscribe(): Promise<string> {
    const registered = await billing.register(
      seeded.userId,
      seeded.ssoOrgId,
      seeded.wabaId,
      'growth',
    );
    return registered.subscriptionId;
  }

  /** Deliver a captured charge for that subscription. */
  async function charge(
    subscriptionId: string,
    options: { eventId: string; paymentId: string; amount?: number },
  ): Promise<void> {
    const body = chargedEvent({
      subscriptionId,
      planId: PLAN_IDS.growth,
      paymentId: options.paymentId,
      amount: options.amount,
    });
    await api()
      .post('/billing/webhook')
      .set('X-Razorpay-Event-Id', options.eventId)
      .set('X-Razorpay-Signature', h.webhookSignature(body))
      .send(body)
      .expect(200);
  }

  /* ---------------------------------------------------------------- *
   * Raising                                                           *
   * ---------------------------------------------------------------- */

  it('raises a numbered invoice for a captured debit', async () => {
    const subscriptionId = await subscribe();

    await charge(subscriptionId, { eventId: 'evt_1', paymentId: 'pay_1' });

    const invoice = await h.prisma.invoice.findUnique({
      where: { razorpayPaymentId: 'pay_1' },
    });

    expect(invoice).not.toBeNull();
    expect(invoice?.number).toBe(`INV-WAC-${YEAR}-0001`);
    expect(invoice?.financialYear).toBe(YEAR);
    expect(invoice?.sequence).toBe(1);
    expect(invoice?.ssoOrgId).toBe(ORG);
    // The tier lists 99,900 and the charge was 49,900: an invoice records what
    // the bank actually moved, not what the price list says it should have.
    expect(invoice?.total).toBe(49_900);
    // No rate configured in the harness, so the whole charge is the taxable
    // value and there is no tax line.
    expect(invoice?.subtotal).toBe(49_900);
    expect(invoice?.taxAmount).toBe(0);
  });

  it('snapshots what the document says, rather than pointing at live rows', async () => {
    const subscriptionId = await subscribe();
    await charge(subscriptionId, { eventId: 'evt_2', paymentId: 'pay_2' });

    const invoice = await h.prisma.invoice.findUnique({
      where: { razorpayPaymentId: 'pay_2' },
    });

    expect(invoice?.accountName).toBe('Integration Account');
    expect(invoice?.planName).toBe('Growth');
    expect(invoice?.description).toBe('Growth plan — Integration Account');
    expect(invoice?.billedToEmail).toBe('integration@example.test');
    expect(invoice?.billedToName).toBe('Inte Gration');
    expect(invoice?.paymentMethod).toBeTruthy();

    // Renaming the account afterwards must not change an invoice already sent.
    await h.prisma.waba.update({
      where: { wabaId: seeded.wabaId },
      data: { name: 'Renamed Since' },
    });
    const after = await h.prisma.invoice.findUnique({
      where: { razorpayPaymentId: 'pay_2' },
    });
    expect(after?.accountName).toBe('Integration Account');
  });

  it('numbers consecutive debits in order', async () => {
    const subscriptionId = await subscribe();

    await charge(subscriptionId, { eventId: 'evt_3a', paymentId: 'pay_3a' });
    await charge(subscriptionId, { eventId: 'evt_3b', paymentId: 'pay_3b' });
    await charge(subscriptionId, { eventId: 'evt_3c', paymentId: 'pay_3c' });

    const raised = await h.prisma.invoice.findMany({
      orderBy: { sequence: 'asc' },
      select: { number: true },
    });

    expect(raised.map((i) => i.number)).toEqual([
      `INV-WAC-${YEAR}-0001`,
      `INV-WAC-${YEAR}-0002`,
      `INV-WAC-${YEAR}-0003`,
    ]);
  });

  it('gives one debit one invoice, however many times the webhook arrives', async () => {
    // Razorpay retries with a fresh event id after a timeout, so the event
    // table's own idempotency does not cover this — the invoice's unique
    // payment id is what does.
    const subscriptionId = await subscribe();

    await charge(subscriptionId, { eventId: 'evt_4a', paymentId: 'pay_4' });
    await charge(subscriptionId, { eventId: 'evt_4b', paymentId: 'pay_4' });

    await expect(h.prisma.invoice.count()).resolves.toBe(1);
  });

  it('allocates numbers without collision when charges land together', async () => {
    // The counter is one INSERT … ON CONFLICT DO UPDATE … RETURNING, and this
    // is the case it exists for: two webhooks in flight at the same moment.
    const subscriptionId = await subscribe();

    await Promise.all([
      charge(subscriptionId, { eventId: 'evt_5a', paymentId: 'pay_5a' }),
      charge(subscriptionId, { eventId: 'evt_5b', paymentId: 'pay_5b' }),
      charge(subscriptionId, { eventId: 'evt_5c', paymentId: 'pay_5c' }),
    ]);

    const raised = await h.prisma.invoice.findMany({
      select: { number: true, sequence: true },
    });
    expect(raised).toHaveLength(3);
    expect(new Set(raised.map((i) => i.sequence)).size).toBe(3);
    expect(new Set(raised.map((i) => i.number)).size).toBe(3);
  });

  it('invoices nothing until a payment is captured', async () => {
    const subscriptionId = await subscribe();
    const body = chargedEvent({
      subscriptionId,
      planId: PLAN_IDS.growth,
      paymentId: 'pay_6',
    });
    // Authorised, not captured: the bank has held the money, not moved it.
    (
      (body.payload as Record<string, { entity: Record<string, unknown> }>)
        .payment.entity as Record<string, unknown>
    ).status = 'authorized';

    await api()
      .post('/billing/webhook')
      .set('X-Razorpay-Event-Id', 'evt_6')
      .set('X-Razorpay-Signature', h.webhookSignature(body))
      .send(body)
      .expect(200);

    await expect(h.prisma.invoice.count()).resolves.toBe(0);
  });

  /* ---------------------------------------------------------------- *
   * Sending                                                           *
   * ---------------------------------------------------------------- */

  it('emails the invoice to the person who took the subscription out', async () => {
    const subscriptionId = await subscribe();

    await charge(subscriptionId, { eventId: 'evt_7', paymentId: 'pay_7' });

    const sent = h.mail.find((m) => m.template === 'billing.invoice');
    expect(sent?.to).toBe('integration@example.test');
    expect(sent?.subject).toBe(`Invoice INV-WAC-${YEAR}-0001`);
    expect(sent?.attachments).toEqual([
      {
        filename: `INV-WAC-${YEAR}-0001.pdf`,
        contentType: 'application/pdf',
      },
    ]);

    const invoice = await h.prisma.invoice.findUnique({
      where: { razorpayPaymentId: 'pay_7' },
    });
    expect(invoice?.emailedAt).not.toBeNull();
    expect(invoice?.emailedTo).toBe('integration@example.test');
  });

  it('sends again the invoices that were raised while mail was down', async () => {
    const subscriptionId = await subscribe();
    await charge(subscriptionId, { eventId: 'evt_8', paymentId: 'pay_8' });

    // As if the send had failed at the time.
    await h.prisma.invoice.updateMany({
      data: { emailedAt: null, emailedTo: null },
    });
    h.mail.length = 0;

    await expect(invoices.deliverPending()).resolves.toBe(1);
    expect(h.mail.map((m) => m.template)).toEqual(['billing.invoice']);

    // And having gone, it is not sent a third time.
    await expect(invoices.deliverPending()).resolves.toBe(0);
  });

  /* ---------------------------------------------------------------- *
   * Reading                                                           *
   * ---------------------------------------------------------------- */

  describe('the console', () => {
    let token: string;

    beforeEach(async () => {
      const subscriptionId = await subscribe();
      await charge(subscriptionId, { eventId: 'evt_9', paymentId: 'pay_9' });
      token = await h.signIn(seeded.userId, seeded.ssoOrgId);
    });

    it('lists the organisation’s invoices', async () => {
      const res = await api()
        .get('/billing/invoices')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const listed = envelope<InvoiceView[]>(res).data;
      expect(listed).toHaveLength(1);
      expect(listed[0].number).toBe(`INV-WAC-${YEAR}-0001`);
      expect(listed[0].accountName).toBe('Integration Account');
      expect(listed[0].total).toBe(49_900);
    });

    it('names the invoice on the debit it was raised for', async () => {
      const res = await api()
        .get('/billing/subscriptions')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const [account] = envelope<SubscriptionView[]>(res).data;
      expect(account.payments[0].razorpayPaymentId).toBe('pay_9');
      expect(account.payments[0].invoiceNumber).toBe(`INV-WAC-${YEAR}-0001`);
    });

    it('serves the document as a PDF', async () => {
      const res = await api()
        .get(`/billing/invoices/INV-WAC-${YEAR}-0001/pdf`)
        .set('Authorization', `Bearer ${token}`)
        .buffer()
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['content-disposition']).toContain(
        `filename="INV-WAC-${YEAR}-0001.pdf"`,
      );
      const body = res.body as Buffer;
      expect(body.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
      expect(body.toString('latin1')).toContain(`INV-WAC-${YEAR}-0001`);
    });

    it('will not hand an invoice to another organisation', async () => {
      // The numbers are sequential. If "not yours" answered anything other
      // than 404, the whole series would be enumerable from one session.
      const other = await seedAccount(h.prisma, {
        wabaId: 'waba_other',
        ssoOrgId: 'org_other',
      });
      const theirs = await h.signIn(other.userId, other.ssoOrgId);

      await api()
        .get(`/billing/invoices/INV-WAC-${YEAR}-0001`)
        .set('Authorization', `Bearer ${theirs}`)
        .expect(404);
      await api()
        .get(`/billing/invoices/INV-WAC-${YEAR}-0001/pdf`)
        .set('Authorization', `Bearer ${theirs}`)
        .expect(404);

      const res = await api()
        .get('/billing/invoices')
        .set('Authorization', `Bearer ${theirs}`)
        .expect(200);
      expect(envelope<InvoiceView[]>(res).data).toEqual([]);
    });

    it('refuses a number that is not one of ours before it reaches the database', async () => {
      await api()
        .get("/billing/invoices/' OR 1=1 --")
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('needs a session', async () => {
      await api().get('/billing/invoices').expect(401);
    });
  });
});
