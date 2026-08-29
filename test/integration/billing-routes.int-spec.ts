import * as request from 'supertest';
import type { Server } from 'http';
import { Harness, ORG, seedAccount, startHarness } from './harness';

/**
 * Every route on the billing controller, reached over HTTP with a real session.
 *
 * This suite exists because of a bug it would have caught. `AuthMiddleware` was
 * bound to an enumerated list of paths, and the controller reads `req.orgId`,
 * which only that middleware sets. Five routes were added without adding them
 * to the list, so each answered **401** — and the console treats a 401 as a
 * dead session, so opening the billing page signed the customer out.
 *
 * Nothing in the unit suite could see it: the controller was right, the service
 * was right, and the wiring between them was what was wrong. So this asserts
 * the one property that catches the whole class — **no billing route answers
 * 401 to somebody who is signed in** — rather than testing each route's body.
 */
describe('Billing routes (integration)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.reset();
  });

  const http = () => request(h.app.getHttpServer() as Server);

  /** Somebody with an account and an organisation, holding a real token. */
  async function signedIn(): Promise<string> {
    const { userId } = await seedAccount(h.prisma);
    return h.signIn(userId, ORG);
  }

  /**
   * Every GET the console calls, and what it may answer.
   *
   * 404 is legitimate — a document that does not exist — and so is 200. What
   * none of them may answer is 401, which is the failure this suite is for.
   */
  const READS = [
    '/billing/subscription',
    '/billing/invoices',
    '/billing/invoices/INV-WAC-2627-0001',
    '/billing/invoices/INV-WAC-2627-0001/pdf',
    '/billing/receipts',
    '/billing/receipts/RCT-WAC-2627-0001/pdf',
    '/billing/tax-details',
    '/billing/gst-states',
  ];

  describe('a signed-in customer', () => {
    it.each(READS)('is not signed out by %s', async (path) => {
      const token = await signedIn();

      const res = await http()
        .get(path)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).not.toBe(401);
    });

    it('is not signed out by saving tax details', async () => {
      const token = await signedIn();

      const res = await http()
        .put('/billing/tax-details')
        .set('Authorization', `Bearer ${token}`)
        .send({ stateCode: '29' });

      expect(res.status).not.toBe(401);
    });

    it('reads the page the console actually loads, in one go', async () => {
      // The three calls the billing page fires on mount. Any one of them
      // answering 401 is what logged the customer out.
      const token = await signedIn();
      const auth = (path: string) =>
        http().get(path).set('Authorization', `Bearer ${token}`);

      const [invoices, receipts, tax, states] = await Promise.all([
        auth('/billing/invoices'),
        auth('/billing/receipts'),
        auth('/billing/tax-details'),
        auth('/billing/gst-states'),
      ]);

      expect(invoices.status).toBe(200);
      expect(receipts.status).toBe(200);
      expect(tax.status).toBe(200);
      expect(states.status).toBe(200);
    });
  });

  describe('somebody with no session', () => {
    it.each(READS)('is refused %s', async (path) => {
      // The other half: the middleware has to still be doing its job. Bound to
      // the controller rather than a list, it is easy to imagine excluding too
      // much and leaving a route open.
      const res = await http().get(path);

      expect(res.status).toBe(401);
    });
  });

  describe('the webhook', () => {
    it('still reaches the handler on a valid signature', async () => {
      // The other way the middleware change could have gone wrong: excluding
      // too little, so the JWT middleware rejects every charge Razorpay tells
      // us about. A signed request carries no session and must still land.
      const body = { event: 'subscription.pending', payload: {} };

      const res = await http()
        .post('/billing/webhook')
        .set('x-razorpay-event-id', 'evt_route_check')
        .set('x-razorpay-signature', h.webhookSignature(body))
        .send(body);

      expect(res.status).toBe(200);
    });

    it('is still refused without a signature, and for that reason', async () => {
      // It answers 401 either way, so the status alone proves nothing about
      // which middleware refused it. The message is what distinguishes a
      // missing signature from a missing session.
      const res = await http().post('/billing/webhook').send({});

      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).toContain('X-Razorpay-Signature');
    });
  });
});
