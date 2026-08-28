import * as request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { Server } from 'http';
import { BillingService } from 'src/billing/billing.service';
import { SubscriptionAccessService } from 'src/billing/subscription-access.service';
import { object } from './fake-razorpay';
import {
  chargedEvent,
  Harness,
  KEY_ID,
  KEY_SECRET,
  ORG,
  PLAN_IDS,
  seedAccount,
  startHarness,
} from './harness';

/** One plan as the API publishes it. */
interface PlanView {
  code: string;
  price: number | null;
  [key: string]: unknown;
}

let h: Harness;

/** The HTTP server, typed — supertest's own parameter is not `any`. */
function api(): TestAgent<request.Test> {
  return request(h.app.getHttpServer() as Server);
}

/** supertest answers `any`; every response here is the standard envelope. */
function envelope<T>(res: request.Response): { data: T; message?: string } {
  return res.body as { data: T; message?: string };
}

/**
 * Payment, end to end.
 *
 * Every assertion here is against a real Postgres and a real HTTP exchange
 * with the Razorpay stand-in — what was actually sent, and what was actually
 * written. The unit suite proves the branches; this proves the money: which
 * plan is charged, what an add-on costs, that a mandate cannot be faked, and
 * that a webhook delivered twice bills once.
 */
describe('Payment (integration)', () => {
  let billing: BillingService;
  let access: SubscriptionAccessService;

  beforeAll(async () => {
    h = await startHarness();
    billing = h.app.get(BillingService);
    access = h.app.get(SubscriptionAccessService);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.reset();
  });

  /* ---------------------------------------------------------------- *
   * Wiring the price list to Razorpay                                 *
   * ---------------------------------------------------------------- */

  describe('plan wiring', () => {
    it('applies RAZORPAY_PLAN_IDS to the seeded price list at boot', async () => {
      // The harness boots AppModule, so PlanSyncService has already run.
      const plans = await h.prisma.plan.findMany({
        orderBy: { sortOrder: 'asc' },
      });

      expect(plans.map((p) => [p.code, p.razorpayPlanId])).toEqual([
        ['starter', PLAN_IDS.starter],
        ['growth', PLAN_IDS.growth],
        ['business', PLAN_IDS.business],
        // Custom and Agency are quoted cards; nothing charges for either. The
        // rows a signed deal writes are private and carry their own plan id.
        ['custom', null],
        ['agency', null],
      ]);
    });

    it('publishes the seeded prices and limits exactly as the pricing page shows them', async () => {
      const res = await api().get('/plans').expect(200);
      const [starter, growth, business, custom, agency] =
        envelope<PlanView[]>(res).data;

      expect(starter).toMatchObject({
        price: 49900,
        currency: 'INR',
        // Not "/WABA/month". One subscription covers the organisation, and a
        // card that priced per account beside an organisation-wide inclusion
        // count was the incoherence this replaced.
        unit: '/month',
        additionalNumberPrice: 19900,
        additionalWabaPrice: 29900,
        available: true,
        limits: {
          // What the price covers, not a ceiling: an account past this is
          // sold at ₹299 rather than refused.
          wabas: 1,
          phoneNumbersPerWaba: 1,
          teamMembers: 2,
          webhookEndpoints: 1,
          apiKeysPerWaba: 1,
          contacts: 1000,
          messagesPerMinute: 100,
        },
      });
      expect(growth.price).toBe(99900);
      expect(business.price).toBe(199900);
      for (const quoted of [custom, agency]) {
        expect(quoted).toMatchObject({
          price: null,
          priceLabel: 'Custom',
          available: false,
        });
      }
      // The provider's identifier never leaves the API.
      expect(JSON.stringify(res.body)).not.toContain('plan_growth');
    });
  });

  /* ---------------------------------------------------------------- *
   * Buying a tier                                                     *
   * ---------------------------------------------------------------- */

  describe('subscribing', () => {
    it('creates the subscription against the chosen tier, with our credentials', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);

      const registered = await billing.register(userId, ORG, 'growth');

      const created = h.razorpay.only('POST', /^\/subscriptions$/);
      expect(created.body).toMatchObject({
        plan_id: PLAN_IDS.growth,
        total_count: 120,
        customer_notify: 1,
        notes: { ssoOrgId: ORG, planCode: 'growth' },
      });
      // Basic auth, from the configured key pair.
      expect(created.auth).toEqual({ keyId: KEY_ID, keySecret: KEY_SECRET });

      const stored = await h.prisma.subscription.findFirstOrThrow({
        where: { ssoOrgId: ORG },
        include: { plan: true },
      });
      // The organisation's, not an account's: that is what `wabaId: null`
      // means, and what the partial unique index keys on.
      expect(stored.wabaId).toBeNull();
      expect(stored.razorpaySubscriptionId).toBe(registered.subscriptionId);
      expect(stored.planId).toBe(PLAN_IDS.growth);
      expect(stored.plan?.code).toBe('growth');
      expect(stored.status).toBe('created');
      // Nothing is charged before the mandate is authorised.
      expect(stored.currentEnd).toBeNull();
      expect(await access.hasAccess(ORG, wabaId)).toBe(false);
    });

    it('covers every account the organisation has with the one subscription', async () => {
      const first = await seedAccount(h.prisma, { wabaId: 'waba_a' });
      await h.prisma.waba.create({
        data: {
          wabaId: 'waba_b',
          userId: first.userId,
          ssoOrgId: ORG,
          name: 'B',
        },
      });
      await h.prisma.wabaOrganisation.create({
        data: { wabaId: 'waba_b', ssoOrgId: ORG, userId: first.userId },
      });

      await billing.register(first.userId, ORG, 'growth');
      await h.prisma.subscription.updateMany({
        where: { ssoOrgId: ORG },
        data: {
          status: 'active',
          currentEnd: new Date(Date.now() + 20 * 24 * 3600 * 1000),
        },
      });

      // One customer, one subscription, both accounts open. Under per-account
      // billing the second was locked out until it was paid for separately.
      expect(h.razorpay.received('POST', /^\/customers$/)).toHaveLength(1);
      expect(h.razorpay.received('POST', /^\/subscriptions$/)).toHaveLength(1);
      expect(await access.hasAccess(ORG, 'waba_a')).toBe(true);
      expect(await access.hasAccess(ORG, 'waba_b')).toBe(true);
    });

    it('refuses a quoted tier without touching Razorpay at all', async () => {
      const { userId } = await seedAccount(h.prisma);

      await expect(billing.register(userId, ORG, 'agency')).rejects.toThrow(
        /priced individually/,
      );

      expect(h.razorpay.requests).toHaveLength(0);
      expect(await h.prisma.subscription.count()).toBe(0);
    });

    it('refuses a tier this deployment has not wired up', async () => {
      await h.prisma.plan.update({
        where: { code: 'business' },
        data: { razorpayPlanId: null },
      });
      const { userId } = await seedAccount(h.prisma);

      await expect(billing.register(userId, ORG, 'business')).rejects.toThrow(
        /not available for checkout/,
      );
      expect(h.razorpay.requests).toHaveLength(0);
    });

    it('refuses a second subscription while one is running', async () => {
      const { userId } = await seedAccount(h.prisma);
      await billing.register(userId, ORG, 'starter');
      h.razorpay.reset();

      await expect(billing.register(userId, ORG, 'growth')).rejects.toThrow(
        /already has a subscription/,
      );
      // Two mandates on one organisation would be two debits a month.
      expect(h.razorpay.received('POST', /^\/subscriptions$/)).toHaveLength(0);
      expect(await h.prisma.subscription.count()).toBe(1);
    });

    describe('a tier negotiated for one organisation', () => {
      // `h.reset()` leaves the price list alone — it is seeded by migration,
      // not per test — so a row written here has to be taken away again.
      const CODE = 'agency-brightreach';

      const writePrivatePlan = (ssoOrgId: string) =>
        h.prisma.plan.create({
          data: {
            code: CODE,
            name: 'Bright Reach',
            audience: 'A signed deal.',
            price: 499900,
            currency: 'INR',
            unit: '/month',
            ssoOrgId,
            rank: 50,
            ctaKind: 'subscribe',
            ctaLabel: 'Subscribe',
            razorpayPlanId: 'plan_brightreach',
            sortOrder: 99,
          },
        });

      afterEach(async () => {
        // Subscriptions first: `planRefId` points at it, and the price list
        // survives `h.reset()` because migrations seed it, not the harness.
        await h.prisma.subscriptionPayment.deleteMany();
        await h.prisma.subscription.deleteMany();
        await h.prisma.plan.deleteMany({ where: { code: CODE } });
      });

      it('is not sold to anybody else, however well they know the code', async () => {
        const { userId } = await seedAccount(h.prisma);
        await writePrivatePlan('org_bright_reach');

        await expect(billing.register(userId, ORG, CODE)).rejects.toThrow(
          /not on offer/,
        );
        expect(h.razorpay.requests).toHaveLength(0);
      });

      it('is sold to the organisation it was written for', async () => {
        const { userId } = await seedAccount(h.prisma);
        await writePrivatePlan(ORG);

        const registered = await billing.register(userId, ORG, CODE);

        expect(registered.planCode).toBe(CODE);
        expect(h.razorpay.only('POST', /^\/subscriptions$/).body.plan_id).toBe(
          'plan_brightreach',
        );
      });

      it('stays off the public price list', async () => {
        await writePrivatePlan(ORG);

        const res = await api().get('/plans').expect(200);

        expect(envelope<PlanView[]>(res).data.map((p) => p.code)).not.toContain(
          CODE,
        );
      });

      it('is on the price list the organisation itself asks for', async () => {
        const { userId } = await seedAccount(h.prisma);
        await writePrivatePlan(ORG);
        const token = await h.signIn(userId, ORG);

        const res = await api()
          .get('/plans/mine')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        expect(envelope<PlanView[]>(res).data.map((p) => p.code)).toContain(
          CODE,
        );
      });
    });
  });

  describe('subscribing over HTTP', () => {
    it('takes the tier from the request and answers with what Checkout needs', async () => {
      const { userId } = await seedAccount(h.prisma);
      const token = await h.signIn(userId, ORG);

      const res = await api()
        .post('/billing/subscription')
        .set('Authorization', `Bearer ${token}`)
        .send({ planCode: 'business' })
        .expect(201);

      expect(envelope<Record<string, unknown>>(res).data).toMatchObject({
        keyId: KEY_ID,
        status: 'created',
        planCode: 'business',
      });
      expect(h.razorpay.only('POST', /^\/subscriptions$/).body.plan_id).toBe(
        PLAN_IDS.business,
      );
    });

    it('refuses an unauthenticated request before anything is created', async () => {
      await seedAccount(h.prisma);

      await api()
        .post('/billing/subscription')
        .send({ planCode: 'growth' })
        .expect(401);

      expect(h.razorpay.requests).toHaveLength(0);
      expect(await h.prisma.subscription.count()).toBe(0);
    });

    it('will not sell without a tier to sell', async () => {
      // There is no deployment-wide default plan to fall back on any more.
      const { userId } = await seedAccount(h.prisma);
      const token = await h.signIn(userId, ORG);

      await api()
        .post('/billing/subscription')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(400);

      expect(h.razorpay.requests).toHaveLength(0);
    });

    it('names the tier it will not sell', async () => {
      const { userId } = await seedAccount(h.prisma);
      const token = await h.signIn(userId, ORG);

      const res = await api()
        .post('/billing/subscription')
        .set('Authorization', `Bearer ${token}`)
        .send({ planCode: 'agency' })
        .expect(400);

      expect(envelope<unknown>(res).message).toMatch(/priced individually/);
      expect(h.razorpay.requests).toHaveLength(0);
    });
  });

  /* ---------------------------------------------------------------- *
   * Authorising the mandate                                           *
   * ---------------------------------------------------------------- */

  describe('confirming what Checkout hands back', () => {
    it('refuses a forged signature and changes nothing', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      const registered = await billing.register(userId, ORG, 'starter');

      await expect(
        billing.confirm(ORG, {
          razorpayPaymentId: 'pay_forged',
          razorpaySubscriptionId: registered.subscriptionId,
          razorpaySignature: 'deadbeef'.repeat(8),
        }),
      ).rejects.toThrow();

      const after = await h.prisma.subscription.findFirstOrThrow({
        where: { ssoOrgId: ORG },
      });
      // The browser reports its own success; without a valid signature that
      // report is worth nothing.
      expect(after.status).toBe('created');
      expect(await access.hasAccess(ORG, wabaId)).toBe(false);
    });

    it('records a genuine mandate and opens the account', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      const registered = await billing.register(userId, ORG, 'growth');

      // Razorpay's own state is what counts, so the stand-in reports the
      // subscription active with a month paid for.
      const now = Math.floor(Date.now() / 1000);
      h.razorpay.subscriptions.set(registered.subscriptionId, {
        id: registered.subscriptionId,
        plan_id: PLAN_IDS.growth,
        status: 'active',
        current_start: now,
        current_end: now + 30 * 24 * 3600,
      });

      const state = await billing.confirm(ORG, {
        razorpayPaymentId: 'pay_real',
        razorpaySubscriptionId: registered.subscriptionId,
        razorpaySignature: h.checkoutSignature(
          'pay_real',
          registered.subscriptionId,
        ),
      });

      expect(state.active).toBe(true);
      expect(state.planCode).toBe('growth');
      // The price the customer is told is the one their tier charges.
      expect(state.plan?.amount).toBe(99900);

      const stored = await h.prisma.subscription.findFirstOrThrow({
        where: { ssoOrgId: ORG },
      });
      expect(stored.status).toBe('active');
      expect(stored.currentEnd!.getTime()).toBeGreaterThan(Date.now());
      expect(await access.hasAccess(ORG, wabaId)).toBe(true);
    });

    it('refuses a signature that belongs to another subscription', async () => {
      const { userId } = await seedAccount(h.prisma);
      await billing.register(userId, ORG, 'starter');

      await expect(
        billing.confirm(ORG, {
          razorpayPaymentId: 'pay_x',
          razorpaySubscriptionId: 'sub_somebody_else',
          razorpaySignature: h.checkoutSignature('pay_x', 'sub_somebody_else'),
        }),
      ).rejects.toThrow(/another subscription/);
    });
  });

  /* ---------------------------------------------------------------- *
   * Being charged                                                     *
   * ---------------------------------------------------------------- */

  describe('a cycle being charged', () => {
    async function subscribed(
      numbers: number,
      plan: 'starter' | 'growth' = 'growth',
    ) {
      const seeded = await seedAccount(h.prisma, { numbers });
      const registered = await billing.register(seeded.userId, ORG, plan);
      h.razorpay.reset();
      return { ...seeded, subscriptionId: registered.subscriptionId };
    }

    it('accepts a signed webhook over HTTP, records the debit and moves the paid month', async () => {
      const { wabaId, subscriptionId } = await subscribed(1);
      const body = chargedEvent({
        subscriptionId,
        planId: PLAN_IDS.growth,
        amount: 99900,
      });

      await api()
        .post('/billing/webhook')
        .set('x-razorpay-event-id', 'evt_charged_1')
        .set('x-razorpay-signature', h.webhookSignature(body))
        .send(body)
        .expect(200);

      const payment = await h.prisma.subscriptionPayment.findFirstOrThrow({});
      expect(payment).toMatchObject({
        razorpayPaymentId: 'pay_integration_1',
        amount: 99900,
        currency: 'INR',
        status: 'captured',
        method: 'upi',
        // Enough of the instrument to recognise it, and no more.
        methodDetail: 'integration@upi',
      });

      const sub = await h.prisma.subscription.findFirstOrThrow({
        where: { ssoOrgId: ORG },
      });
      expect(sub.status).toBe('active');
      expect(sub.currentEnd!.getTime()).toBeGreaterThan(Date.now());
      expect(await access.hasAccess(ORG, wabaId)).toBe(true);
    });

    it('refuses an unsigned webhook', async () => {
      const { subscriptionId } = await subscribed(1);
      const body = chargedEvent({ subscriptionId, planId: PLAN_IDS.growth });

      await api()
        .post('/billing/webhook')
        .set('x-razorpay-event-id', 'evt_unsigned')
        .send(body)
        .expect(401);

      expect(await h.prisma.subscriptionPayment.count()).toBe(0);
      expect(await h.prisma.subscriptionEvent.count()).toBe(0);
    });

    it('refuses a webhook whose body was altered after signing', async () => {
      const { subscriptionId } = await subscribed(1);
      const body = chargedEvent({ subscriptionId, planId: PLAN_IDS.growth });
      const signature = h.webhookSignature(body);

      // Same signature, a bigger amount: exactly what a forged debit notice
      // would look like.
      const tampered = chargedEvent({
        subscriptionId,
        planId: PLAN_IDS.growth,
        amount: 1,
      });

      await api()
        .post('/billing/webhook')
        .set('x-razorpay-event-id', 'evt_tampered')
        .set('x-razorpay-signature', signature)
        .send(tampered)
        .expect(401);

      expect(await h.prisma.subscriptionPayment.count()).toBe(0);
    });

    it('charges ₹199 a month for every number after the first', async () => {
      // 1 WABA + 3 numbers on Starter is ₹499 + 2 × ₹199 = ₹897 a month.
      const { subscriptionId } = await subscribed(3, 'starter');
      const body = chargedEvent({
        subscriptionId,
        planId: PLAN_IDS.starter,
        amount: 49900,
      });

      await api()
        .post('/billing/webhook')
        .set('x-razorpay-event-id', 'evt_extras')
        .set('x-razorpay-signature', h.webhookSignature(body))
        .send(body)
        .expect(200);

      const addon = h.razorpay.only('POST', /\/addons$/);
      expect(addon.path).toBe(`/subscriptions/${subscriptionId}/addons`);
      expect(addon.body).toEqual({
        item: {
          name: 'Additional phone numbers',
          amount: 19900,
          currency: 'INR',
        },
        quantity: 2,
      });

      // The arithmetic the pricing page publishes, from the same figures.
      const plan = await h.prisma.plan.findFirstOrThrow({
        where: { code: 'starter' },
      });
      const item = object(addon.body, 'item');
      const monthly =
        plan.price! + Number(addon.body.quantity) * Number(item.amount);
      expect(monthly).toBe(89700);
    });

    it('charges nothing extra for the number the plan includes', async () => {
      const { subscriptionId } = await subscribed(1, 'starter');
      const body = chargedEvent({ subscriptionId, planId: PLAN_IDS.starter });

      await api()
        .post('/billing/webhook')
        .set('x-razorpay-event-id', 'evt_one_number')
        .set('x-razorpay-signature', h.webhookSignature(body))
        .send(body)
        .expect(200);

      expect(h.razorpay.received('POST', /\/addons$/)).toHaveLength(0);
    });

    it('counts only numbers live on the Cloud API', async () => {
      const { wabaId, subscriptionId } = await subscribed(2, 'growth');
      // A number Meta lists but nobody registered: it cannot send, so it is
      // not what the price list charges for.
      await h.prisma.wabaPhoneNumber.create({
        data: {
          phoneNumberId: 'phone_unregistered',
          wabaId,
          verifiedName: 'Spare',
          codeVerificationStatus: 'NOT_VERIFIED',
          displayPhoneNumber: '+919822010299',
          qualityRating: 'UNKNOWN',
          platformType: 'NOT_APPLICABLE',
          throughputLevel: 'STANDARD',
        },
      });
      const body = chargedEvent({ subscriptionId, planId: PLAN_IDS.growth });

      await api()
        .post('/billing/webhook')
        .set('x-razorpay-event-id', 'evt_cloud_only')
        .set('x-razorpay-signature', h.webhookSignature(body))
        .send(body)
        .expect(200);

      // Two registered, one included: one extra, not two.
      expect(h.razorpay.only('POST', /\/addons$/).body.quantity).toBe(1);
    });

    it('bills once when Razorpay delivers the same event twice', async () => {
      const { subscriptionId } = await subscribed(3, 'starter');
      const body = chargedEvent({ subscriptionId, planId: PLAN_IDS.starter });
      const signature = h.webhookSignature(body);

      for (let attempt = 0; attempt < 3; attempt++) {
        await api()
          .post('/billing/webhook')
          .set('x-razorpay-event-id', 'evt_retried')
          .set('x-razorpay-signature', signature)
          .send(body)
          .expect(200);
      }

      // The event id is unique in the database; that constraint is what makes
      // a retry idempotent, and it has now actually been exercised.
      expect(await h.prisma.subscriptionEvent.count()).toBe(1);
      expect(await h.prisma.subscriptionPayment.count()).toBe(1);
      expect(h.razorpay.received('POST', /\/addons$/)).toHaveLength(1);
    });

    it('keeps the payment when the add-on cannot be raised', async () => {
      const { subscriptionId } = await subscribed(2, 'starter');
      h.razorpay.on('POST', /\/addons$/, () => ({
        status: 500,
        body: { error: { description: 'add-on service unavailable' } },
      }));
      const body = chargedEvent({ subscriptionId, planId: PLAN_IDS.starter });

      await api()
        .post('/billing/webhook')
        .set('x-razorpay-event-id', 'evt_addon_down')
        .set('x-razorpay-signature', h.webhookSignature(body))
        .send(body)
        // Failing the webhook would have Razorpay retry a charge already
        // recorded.
        .expect(200);

      expect(await h.prisma.subscriptionPayment.count()).toBe(1);
    });

    it('never shortens a paid month when events arrive out of order', async () => {
      const { subscriptionId } = await subscribed(1);
      const now = Math.floor(Date.now() / 1000);

      const later = chargedEvent({
        subscriptionId,
        planId: PLAN_IDS.growth,
        paymentId: 'pay_second',
        currentEnd: now + 60 * 24 * 3600,
      });
      const earlier = chargedEvent({
        subscriptionId,
        planId: PLAN_IDS.growth,
        paymentId: 'pay_first',
        currentEnd: now + 30 * 24 * 3600,
      });

      for (const [id, body] of [
        ['evt_later', later],
        ['evt_earlier', earlier],
      ] as const) {
        await api()
          .post('/billing/webhook')
          .set('x-razorpay-event-id', id)
          .set('x-razorpay-signature', h.webhookSignature(body))
          .send(body)
          .expect(200);
      }

      const sub = await h.prisma.subscription.findFirstOrThrow({
        where: { ssoOrgId: ORG },
      });
      // A month already paid for is not taken back by a late delivery.
      expect(sub.currentEnd!.getTime()).toBeGreaterThan(
        Date.now() + 45 * 24 * 3600 * 1000,
      );
    });
  });

  /* ---------------------------------------------------------------- *
   * Cancelling                                                        *
   * ---------------------------------------------------------------- */

  describe('cancelling', () => {
    it('asks Razorpay to stop at the end of the paid month, and keeps access until then', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      const registered = await billing.register(userId, ORG, 'growth');
      const end = new Date(Date.now() + 20 * 24 * 3600 * 1000);
      await h.prisma.subscription.updateMany({
        where: { ssoOrgId: ORG },
        data: { status: 'active', currentEnd: end },
      });
      h.razorpay.reset();

      const state = await billing.cancel(ORG);

      const cancelled = h.razorpay.only('POST', /\/cancel$/);
      expect(cancelled.path).toBe(
        `/subscriptions/${registered.subscriptionId}/cancel`,
      );
      expect(cancelled.body).toEqual({ cancel_at_cycle_end: 1 });

      expect(state.cancelAtCycleEnd).toBe(true);
      // The month already paid for is not cut short.
      expect(await access.hasAccess(ORG, wabaId)).toBe(true);

      const stored = await h.prisma.subscription.findFirstOrThrow({
        where: { ssoOrgId: ORG },
      });
      expect(stored.cancelledAt).not.toBeNull();
      expect(stored.shortUrl).toBeNull();
    });

    it('stops immediately when no month has been paid for', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      await billing.register(userId, ORG, 'starter');
      h.razorpay.reset();

      await billing.cancel(ORG);

      expect(h.razorpay.only('POST', /\/cancel$/).body).toEqual({
        cancel_at_cycle_end: 0,
      });
      expect(await access.hasAccess(ORG, wabaId)).toBe(false);
    });

    it('leaves our record alone when Razorpay refuses the cancellation', async () => {
      const { userId } = await seedAccount(h.prisma);
      await billing.register(userId, ORG, 'growth');
      await h.prisma.subscription.updateMany({
        where: { ssoOrgId: ORG },
        data: {
          status: 'active',
          currentEnd: new Date(Date.now() + 86_400_000),
        },
      });
      h.razorpay.on('POST', /\/cancel$/, () => ({
        status: 400,
        body: { error: { description: 'cannot cancel' } },
      }));

      await expect(billing.cancel(ORG)).rejects.toThrow();

      // Marked cancelled here while still being debited there is the one
      // outcome that must be impossible.
      const stored = await h.prisma.subscription.findFirstOrThrow({
        where: { ssoOrgId: ORG },
      });
      expect(stored.cancelAtCycleEnd).toBe(false);
      expect(stored.cancelledAt).toBeNull();
    });
  });

  /* ---------------------------------------------------------------- *
   * Reconciliation                                                    *
   * ---------------------------------------------------------------- */

  describe('reconciliation', () => {
    it('re-reads a subscription whose paid month has run out', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      const registered = await billing.register(userId, ORG, 'growth');
      await h.prisma.subscription.updateMany({
        where: { ssoOrgId: ORG },
        data: { status: 'active', currentEnd: new Date(Date.now() - 3600_000) },
      });

      // A charge whose webhook never arrived: Razorpay knows, we do not.
      const now = Math.floor(Date.now() / 1000);
      h.razorpay.subscriptions.set(registered.subscriptionId, {
        id: registered.subscriptionId,
        plan_id: PLAN_IDS.growth,
        status: 'active',
        current_start: now,
        current_end: now + 30 * 24 * 3600,
      });
      h.razorpay.reset();
      h.razorpay.subscriptions.set(registered.subscriptionId, {
        id: registered.subscriptionId,
        plan_id: PLAN_IDS.growth,
        status: 'active',
        current_start: now,
        current_end: now + 30 * 24 * 3600,
      });

      await billing.reconcile();

      expect(h.razorpay.received('GET', /^\/subscriptions\//)).toHaveLength(1);
      const stored = await h.prisma.subscription.findFirstOrThrow({
        where: { ssoOrgId: ORG },
      });
      expect(stored.currentEnd!.getTime()).toBeGreaterThan(Date.now());
      expect(await access.hasAccess(ORG, wabaId)).toBe(true);
    });
  });
});
