import * as request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { Server } from 'http';
import { BillingService } from 'src/billing/billing.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { PlanSyncService } from 'src/plans/plan-sync.service';
import { Harness, ORG, PLAN_IDS, seedAccount, startHarness } from './harness';

let h: Harness;

/** The HTTP server, typed — supertest's own parameter is not `any`. */
function api(): TestAgent<request.Test> {
  return request(h.app.getHttpServer() as Server);
}

/**
 * Changing tier, and adopting the customers who had one before there were any.
 *
 * Both halves are about the same column: `planRefId` is what every limit and
 * every per-number charge reads, so a subscription that carries the wrong one
 * — or none — is one whose customer is billed and restricted as somebody else.
 */
describe('Changing plan (integration)', () => {
  let billing: BillingService;
  let limits: PlanLimitsService;

  beforeAll(async () => {
    h = await startHarness();
    billing = h.app.get(BillingService);
    limits = h.app.get(PlanLimitsService);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.reset();
  });

  /** Subscribe an account and mark the mandate authorised, as a charge would. */
  async function subscribed(
    plan: 'starter' | 'growth' | 'business',
    options: { numbers?: number } = {},
  ): Promise<{ userId: number; wabaId: string; subscriptionId: string }> {
    const { userId, wabaId } = await seedAccount(h.prisma, {
      numbers: options.numbers ?? 1,
    });
    const registered = await billing.register(userId, ORG, wabaId, plan);
    await h.prisma.subscription.updateMany({
      where: { wabaId, ssoOrgId: ORG },
      data: {
        status: 'active',
        currentStart: new Date(Date.now() - 9 * 24 * 3600 * 1000),
        currentEnd: new Date(Date.now() + 21 * 24 * 3600 * 1000),
      },
    });
    return { userId, wabaId, subscriptionId: registered.subscriptionId };
  }

  /* ------------------------------------------------------------------ *
   * Upgrading                                                           *
   * ------------------------------------------------------------------ */

  describe('to a tier that costs more', () => {
    it('moves now, because the limits are what was wanted today', async () => {
      const { wabaId, subscriptionId } = await subscribed('starter');

      const state = await billing.changePlan(ORG, wabaId, 'business');

      const change = h.razorpay.only('PATCH', /^\/subscriptions\/[^/]+$/);
      expect(change.path).toBe(`/subscriptions/${subscriptionId}`);
      expect(change.body).toMatchObject({
        plan_id: PLAN_IDS.business,
        schedule_change_at: 'now',
      });

      expect(state.planCode).toBe('business');
      expect(state.pendingPlanCode).toBeNull();
      const stored = await h.prisma.subscription.findFirstOrThrow({
        where: { wabaId },
        include: { plan: true },
      });
      expect(stored.plan?.code).toBe('business');
      expect(stored.planId).toBe(PLAN_IDS.business);
      expect(stored.pendingPlanRefId).toBeNull();
    });

    it('gives the account the new tier’s limits immediately', async () => {
      const { wabaId } = await subscribed('starter');
      // Starter sells two endpoints; Business puts no number on them.
      expect((await limits.forWaba(ORG, wabaId)).webhookEndpoints).toBe(2);

      await billing.changePlan(ORG, wabaId, 'business');

      const after = await limits.forWaba(ORG, wabaId);
      expect(after.planCode).toBe('business');
      expect(after.webhookEndpoints).toBeNull();
    });

    it('charges the new tier’s extras on the next invoice', async () => {
      // Two numbers on Starter, then up to Growth: the add-on that follows the
      // next charge must be priced from the tier they are on now.
      const { wabaId, subscriptionId } = await subscribed('starter', {
        numbers: 3,
      });
      await billing.changePlan(ORG, wabaId, 'growth');
      h.razorpay.reset();

      const body = chargedOn(subscriptionId, PLAN_IDS.growth);
      await api()
        .post('/billing/webhook')
        .set('x-razorpay-event-id', 'evt_after_upgrade')
        .set('x-razorpay-signature', h.webhookSignature(body))
        .send(body)
        .expect(200);

      const addon = h.razorpay.only('POST', /\/addons$/);
      // Two beyond the one Growth includes, at Growth's own per-number price.
      expect(addon.body).toMatchObject({ quantity: 2 });
    });
  });

  /* ------------------------------------------------------------------ *
   * Downgrading                                                         *
   * ------------------------------------------------------------------ */

  describe('to a tier that costs the same or less', () => {
    it('waits for the renewal rather than cutting the paid month short', async () => {
      const { wabaId } = await subscribed('business');

      const state = await billing.changePlan(ORG, wabaId, 'starter');

      expect(
        h.razorpay.only('PATCH', /^\/subscriptions\/[^/]+$/).body,
      ).toMatchObject({
        plan_id: PLAN_IDS.starter,
        schedule_change_at: 'cycle_end',
      });
      // Still Business until the month they paid for runs out.
      expect(state.planCode).toBe('business');
      expect(state.pendingPlanCode).toBe('starter');
      expect(state.pendingPlanAt).toEqual(state.currentEnd);
    });

    it('keeps the limits they paid for until then', async () => {
      const { wabaId } = await subscribed('business');

      await billing.changePlan(ORG, wabaId, 'starter');

      const effective = await limits.forWaba(ORG, wabaId);
      // Taking their ten accounts down to one mid-month would be taking away
      // what they bought.
      expect(effective.planCode).toBe('business');
      expect(effective.wabas).toBe(10);
    });

    it('takes effect when Razorpay charges the new plan', async () => {
      const { wabaId, subscriptionId } = await subscribed('business');
      await billing.changePlan(ORG, wabaId, 'starter');

      // The renewal: Razorpay charges the plan the change scheduled.
      const body = chargedOn(subscriptionId, PLAN_IDS.starter);
      await api()
        .post('/billing/webhook')
        .set('x-razorpay-event-id', 'evt_renewal')
        .set('x-razorpay-signature', h.webhookSignature(body))
        .send(body)
        .expect(200);

      const stored = await h.prisma.subscription.findFirstOrThrow({
        where: { wabaId },
        include: { plan: true },
      });
      expect(stored.plan?.code).toBe('starter');
      expect(stored.pendingPlanRefId).toBeNull();
      expect(stored.pendingPlanAt).toBeNull();
      expect((await limits.forWaba(ORG, wabaId)).planCode).toBe('starter');
    });

    it('follows Razorpay when a plan is changed in their dashboard', async () => {
      const { wabaId, subscriptionId } = await subscribed('starter');

      // Nobody asked us; the charge simply arrives on another plan. Razorpay
      // is the ledger, so the tier here follows it.
      const body = chargedOn(subscriptionId, PLAN_IDS.growth);
      await api()
        .post('/billing/webhook')
        .set('x-razorpay-event-id', 'evt_dashboard')
        .set('x-razorpay-signature', h.webhookSignature(body))
        .send(body)
        .expect(200);

      const stored = await h.prisma.subscription.findFirstOrThrow({
        where: { wabaId },
        include: { plan: true },
      });
      expect(stored.plan?.code).toBe('growth');
    });
  });

  /* ------------------------------------------------------------------ *
   * What it refuses                                                     *
   * ------------------------------------------------------------------ */

  describe('what it will not do', () => {
    it('refuses over HTTP for another organisation’s account', async () => {
      const { userId, wabaId } = await subscribed('starter');
      const token = await h.signIn(userId, 'org_somebody_else');

      await api()
        .patch(`/billing/subscriptions/${wabaId}/plan`)
        .set('Authorization', `Bearer ${token}`)
        .send({ planCode: 'business' })
        .expect(404);

      expect(
        h.razorpay.received('PATCH', /^\/subscriptions\/[^/]+$/),
      ).toHaveLength(0);
    });

    it('refuses a quoted tier before touching Razorpay', async () => {
      const { userId, wabaId } = await subscribed('starter');
      const token = await h.signIn(userId, ORG);

      const res = await api()
        .patch(`/billing/subscriptions/${wabaId}/plan`)
        .set('Authorization', `Bearer ${token}`)
        .send({ planCode: 'agency' })
        .expect(400);

      expect(JSON.stringify(res.body)).toMatch(/priced individually/);
      expect(
        h.razorpay.received('PATCH', /^\/subscriptions\/[^/]+$/),
      ).toHaveLength(0);
    });

    it('refuses a subscription that is already ending', async () => {
      const { wabaId } = await subscribed('starter');
      await h.prisma.subscription.updateMany({
        where: { wabaId },
        data: { cancelAtCycleEnd: true },
      });

      await expect(billing.changePlan(ORG, wabaId, 'growth')).rejects.toThrow(
        /set to end/,
      );
    });

    it('says what to do when the mandate will not cover the higher amount', async () => {
      const { wabaId } = await subscribed('starter');
      h.razorpay.on('PATCH', /^\/subscriptions\/[^/]+$/, () => ({
        status: 400,
        body: {
          error: {
            description:
              'Subscription amount is greater than the max amount authorized',
          },
        },
      }));

      // A gateway error would be true and useless; only the customer can
      // authorise a larger debit, and they need telling how.
      await expect(billing.changePlan(ORG, wabaId, 'business')).rejects.toThrow(
        /Cancel the subscription and take out a new one/,
      );
      const stored = await h.prisma.subscription.findFirstOrThrow({
        where: { wabaId },
        include: { plan: true },
      });
      expect(stored.plan?.code).toBe('starter');
    });
  });

  /* ------------------------------------------------------------------ *
   * The customers who were here first                                   *
   * ------------------------------------------------------------------ */

  describe('adopting existing subscriptions', () => {
    /** A subscription as it looked before the price list existed. */
    async function legacy(planId: string): Promise<string> {
      const { userId, wabaId } = await seedAccount(h.prisma, {
        wabaId: `waba_legacy_${planId}`,
        numbers: 1,
      });
      await h.prisma.subscription.create({
        data: {
          wabaId,
          ssoOrgId: ORG,
          razorpaySubscriptionId: `sub_legacy_${planId}`,
          planId,
          planRefId: null,
          status: 'active',
          currentEnd: new Date(Date.now() + 20 * 24 * 3600 * 1000),
          createdByUserId: userId,
        },
      });
      return wabaId;
    }

    it('gives each one the tier it is actually charged on', async () => {
      const starter = await legacy(PLAN_IDS.starter);
      const business = await legacy(PLAN_IDS.business);

      const adopted = await h.app.get(PlanSyncService).adoptExisting();

      expect(adopted).toBe(2);
      const rows = await h.prisma.subscription.findMany({
        where: { wabaId: { in: [starter, business] } },
        include: { plan: true },
        orderBy: { wabaId: 'asc' },
      });
      expect(rows.map((r) => [r.wabaId, r.plan?.code])).toEqual([
        [business, 'business'],
        [starter, 'starter'],
      ]);
    });

    it('stops holding an adopted customer to the entry limits', async () => {
      const wabaId = await legacy(PLAN_IDS.business);
      // Before: no tier, so the cheapest published plan is the ceiling — and
      // a Business customer would be refused their second account.
      expect((await limits.forWaba(ORG, wabaId)).wabas).toBe(1);

      await h.app.get(PlanSyncService).adoptExisting();

      const after = await limits.forWaba(ORG, wabaId);
      expect(after.planCode).toBe('business');
      expect(after.wabas).toBe(10);
    });

    it('leaves a plan id no tier claims alone, and runs again for free', async () => {
      const orphan = await legacy('plan_withdrawn_2024');

      expect(await h.app.get(PlanSyncService).adoptExisting()).toBe(0);
      // Idempotent: a second pass adopts nothing new rather than rewriting
      // what the first one did.
      const known = await legacy(PLAN_IDS.growth);
      expect(await h.app.get(PlanSyncService).adoptExisting()).toBe(1);
      expect(await h.app.get(PlanSyncService).adoptExisting()).toBe(0);

      const rows = await h.prisma.subscription.findMany({
        where: { wabaId: { in: [orphan, known] } },
        include: { plan: true },
      });
      expect(rows.find((r) => r.wabaId === orphan)?.planRefId).toBeNull();
      expect(rows.find((r) => r.wabaId === known)?.plan?.code).toBe('growth');
    });

    it('never overwrites a tier somebody already put right', async () => {
      const wabaId = await legacy(PLAN_IDS.starter);
      const growth = await h.prisma.plan.findFirstOrThrow({
        where: { code: 'growth' },
      });
      // Corrected by hand — a customer moved between plans at Razorpay, say.
      await h.prisma.subscription.updateMany({
        where: { wabaId },
        data: { planRefId: growth.id },
      });

      await h.app.get(PlanSyncService).adoptExisting();

      const stored = await h.prisma.subscription.findFirstOrThrow({
        where: { wabaId },
        include: { plan: true },
      });
      expect(stored.plan?.code).toBe('growth');
    });
  });
});

/** A `subscription.charged` webhook naming the plan it was charged on. */
function chargedOn(
  subscriptionId: string,
  planId: string,
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    event: 'subscription.charged',
    payload: {
      subscription: {
        entity: {
          id: subscriptionId,
          plan_id: planId,
          status: 'active',
          current_start: now,
          current_end: now + 30 * 24 * 3600,
        },
      },
      payment: {
        entity: {
          id: `pay_${subscriptionId}_${planId}`,
          invoice_id: 'inv_change_1',
          amount: 99_900,
          currency: 'INR',
          status: 'captured',
          method: 'upi',
          created_at: now,
        },
      },
    },
  };
}
