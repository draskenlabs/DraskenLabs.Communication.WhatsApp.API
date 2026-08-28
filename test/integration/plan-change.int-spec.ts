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

  /**
   * Subscribe the organisation and mark the mandate authorised, as a charge
   * would. One subscription covers every account it has.
   */
  async function subscribed(
    plan: 'starter' | 'growth' | 'business',
    options: { numbers?: number } = {},
  ): Promise<{ userId: number; wabaId: string; subscriptionId: string }> {
    const { userId, wabaId } = await seedAccount(h.prisma, {
      numbers: options.numbers ?? 1,
    });
    const registered = await billing.register(userId, ORG, plan);
    await h.prisma.subscription.updateMany({
      where: { ssoOrgId: ORG },
      data: {
        status: 'active',
        currentStart: new Date(Date.now() - 9 * 24 * 3600 * 1000),
        currentEnd: new Date(Date.now() + 21 * 24 * 3600 * 1000),
      },
    });
    // The registration itself is not what these tests are about, and leaving
    // it in the recorder makes every `only()` below ambiguous.
    h.razorpay.reset();
    return { userId, wabaId, subscriptionId: registered.subscriptionId };
  }

  /* ------------------------------------------------------------------ *
   * Upgrading                                                           *
   * ------------------------------------------------------------------ */

  describe('to a tier that costs more', () => {
    it('asks the customer to authorise a new mandate', async () => {
      // A Razorpay mandate is authorised for a fixed amount. Re-pointing the
      // running subscription at a dearer plan is what used to fail at the
      // bank's ceiling; a second subscription is what a customer can actually
      // approve.
      const { subscriptionId } = await subscribed('starter');

      const state = await billing.changePlan(ORG, 'business');

      expect(
        h.razorpay.received('PATCH', /^\/subscriptions\/[^/]+$/),
      ).toHaveLength(0);
      const created = h.razorpay.only('POST', /^\/subscriptions$/);
      expect(created.body).toMatchObject({
        plan_id: PLAN_IDS.business,
        total_count: 120,
        customer_notify: 1,
        notes: { ssoOrgId: ORG, planCode: 'business' },
      });
      expect(state.pendingAuthorisation?.planCode).toBe('business');
      expect(state.pendingAuthorisation?.subscriptionId).not.toBe(
        subscriptionId,
      );
    });

    it('starts the new subscription where the paid month ends', async () => {
      // Nine days in, twenty-one to run. Charging the new tier today would
      // sell the customer the same days twice.
      await subscribed('starter');

      await billing.changePlan(ORG, 'business');

      const created = h.razorpay.only('POST', /^\/subscriptions$/);
      const startAt = created.body.start_at as number;
      expect(startAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('charges only the difference for the days that are left', async () => {
      await subscribed('starter');

      await billing.changePlan(ORG, 'business');

      const addon = h.razorpay.only('POST', /\/addons$/);
      const amount = (addon.body.item as { amount: number }).amount;
      // ₹1,999 less ₹499 is ₹1,500 a month; three weeks of it is less than
      // that and more than nothing. Never a whole month, never a whole price.
      expect(amount).toBeGreaterThan(0);
      expect(amount).toBeLessThan(199900 - 49900);
      expect(addon.body.quantity).toBe(1);
    });

    it('leaves the customer on the tier they are paying for until they authorise', async () => {
      const { wabaId } = await subscribed('starter');
      expect((await limits.forWaba(ORG, wabaId)).webhookEndpoints).toBe(1);

      const state = await billing.changePlan(ORG, 'business');

      // Nothing has been paid. Handing over Business's limits here would give
      // them away to anyone who opened Checkout and closed it again.
      expect(state.planCode).toBe('starter');
      expect((await limits.forWaba(ORG, wabaId)).planCode).toBe('starter');
      const stored = await h.prisma.subscription.findFirstOrThrow({
        where: { ssoOrgId: ORG },
        include: { plan: true, pendingPlan: true },
      });
      expect(stored.plan?.code).toBe('starter');
      expect(stored.pendingPlan?.code).toBe('business');
      expect(stored.pendingRazorpaySubscriptionId).not.toBeNull();
    });

    it('swaps the two over once the new mandate is authorised', async () => {
      const { subscriptionId } = await subscribed('starter');
      const state = await billing.changePlan(ORG, 'business');
      const upgradeId = state.pendingAuthorisation!.subscriptionId;

      // Reset first: it clears the stand-in's subscriptions along with its
      // recorded requests.
      h.razorpay.reset();
      const now = Math.floor(Date.now() / 1000);
      h.razorpay.subscriptions.set(upgradeId, {
        id: upgradeId,
        plan_id: PLAN_IDS.business,
        status: 'active',
        current_start: now,
        current_end: now + 30 * 24 * 3600,
      });

      const after = await billing.confirm(ORG, {
        razorpayPaymentId: 'pay_upgrade',
        razorpaySubscriptionId: upgradeId,
        razorpaySignature: h.checkoutSignature('pay_upgrade', upgradeId),
      });

      expect(after.planCode).toBe('business');
      // The old one is cancelled only now, and at its cycle end — the month
      // they already paid for is theirs.
      const cancelled = h.razorpay.only(
        'POST',
        /\/subscriptions\/[^/]+\/cancel$/,
      );
      expect(cancelled.path).toBe(`/subscriptions/${subscriptionId}/cancel`);
      expect(cancelled.body).toMatchObject({ cancel_at_cycle_end: 1 });

      const stored = await h.prisma.subscription.findFirstOrThrow({
        where: { ssoOrgId: ORG },
        include: { plan: true },
      });
      expect(stored.razorpaySubscriptionId).toBe(upgradeId);
      expect(stored.plan?.code).toBe('business');
      expect(stored.pendingRazorpaySubscriptionId).toBeNull();
      expect(stored.pendingPlanRefId).toBeNull();
    });

    it('gives the new tier’s limits only after the money is authorised', async () => {
      const { wabaId } = await subscribed('starter');
      const state = await billing.changePlan(ORG, 'business');
      const upgradeId = state.pendingAuthorisation!.subscriptionId;

      const now = Math.floor(Date.now() / 1000);
      h.razorpay.subscriptions.set(upgradeId, {
        id: upgradeId,
        plan_id: PLAN_IDS.business,
        status: 'active',
        current_start: now,
        current_end: now + 30 * 24 * 3600,
      });
      await billing.confirm(ORG, {
        razorpayPaymentId: 'pay_upgrade',
        razorpaySubscriptionId: upgradeId,
        razorpaySignature: h.checkoutSignature('pay_upgrade', upgradeId),
      });

      const after = await limits.forWaba(ORG, wabaId);
      expect(after.planCode).toBe('business');
      expect(after.webhookEndpoints).toBe(10);
    });

    it('leaves them where they were when the upgrade is abandoned', async () => {
      // They closed Checkout. Nothing about what they hold or pay has changed.
      const { wabaId, subscriptionId } = await subscribed('starter');

      await billing.changePlan(ORG, 'business');

      const stored = await h.prisma.subscription.findFirstOrThrow({
        where: { ssoOrgId: ORG },
      });
      expect(stored.razorpaySubscriptionId).toBe(subscriptionId);
      expect((await limits.forWaba(ORG, wabaId)).planCode).toBe('starter');
      expect(
        h.razorpay.received('POST', /\/subscriptions\/[^/]+\/cancel$/),
      ).toHaveLength(0);
    });

    it('charges the new tier’s extras on the next invoice', async () => {
      // Three numbers on Starter, then up to Growth and authorised: the add-on
      // that follows the next charge must be priced from the tier they are on
      // now.
      const { subscriptionId } = await subscribed('starter', { numbers: 3 });
      const state = await billing.changePlan(ORG, 'growth');
      const upgradeId = state.pendingAuthorisation!.subscriptionId;

      const now = Math.floor(Date.now() / 1000);
      h.razorpay.subscriptions.set(upgradeId, {
        id: upgradeId,
        plan_id: PLAN_IDS.growth,
        status: 'active',
        current_start: now,
        current_end: now + 30 * 24 * 3600,
      });
      await billing.confirm(ORG, {
        razorpayPaymentId: 'pay_upgrade',
        razorpaySubscriptionId: upgradeId,
        razorpaySignature: h.checkoutSignature('pay_upgrade', upgradeId),
      });
      expect(subscriptionId).not.toBe(upgradeId);
      h.razorpay.reset();

      const body = chargedOn(upgradeId, PLAN_IDS.growth);
      await api()
        .post('/billing/webhook')
        .set('x-razorpay-event-id', 'evt_after_upgrade')
        .set('x-razorpay-signature', h.webhookSignature(body))
        .send(body)
        .expect(200);

      const addon = h.razorpay.only('POST', /\/addons$/);
      // Two beyond the one Growth includes per account.
      expect(addon.body).toMatchObject({ quantity: 2 });
    });
  });

  /* ------------------------------------------------------------------ *
   * Downgrading                                                         *
   * ------------------------------------------------------------------ */

  describe('to a tier that costs the same or less', () => {
    it('waits for the renewal rather than cutting the paid month short', async () => {
      await subscribed('business');

      const state = await billing.changePlan(ORG, 'starter');

      expect(
        h.razorpay.only('PATCH', /^\/subscriptions\/[^/]+$/).body,
      ).toMatchObject({
        plan_id: PLAN_IDS.starter,
        schedule_change_at: 'cycle_end',
      });
      // Still Business until the month they paid for runs out, and no new
      // mandate: the amount is falling, so what they authorised covers it.
      expect(state.planCode).toBe('business');
      expect(state.pendingPlanCode).toBe('starter');
      expect(state.pendingPlanAt).toEqual(state.currentEnd);
      expect(state.pendingAuthorisation).toBeNull();
      expect(h.razorpay.received('POST', /^\/subscriptions$/)).toHaveLength(0);
    });

    it('keeps the limits they paid for until then', async () => {
      const { wabaId } = await subscribed('business');

      await billing.changePlan(ORG, 'starter');

      const effective = await limits.forWaba(ORG, wabaId);
      // Taking their ten accounts down to one mid-month would be taking away
      // what they bought.
      expect(effective.planCode).toBe('business');
      expect(effective.includedWabas).toBe(10);
    });

    it('takes effect when Razorpay charges the new plan', async () => {
      const { wabaId, subscriptionId } = await subscribed('business');
      await billing.changePlan(ORG, 'starter');

      // The renewal: Razorpay charges the plan the change scheduled.
      const body = chargedOn(subscriptionId, PLAN_IDS.starter);
      await api()
        .post('/billing/webhook')
        .set('x-razorpay-event-id', 'evt_renewal')
        .set('x-razorpay-signature', h.webhookSignature(body))
        .send(body)
        .expect(200);

      const stored = await h.prisma.subscription.findFirstOrThrow({
        where: { ssoOrgId: ORG },
        include: { plan: true },
      });
      expect(stored.plan?.code).toBe('starter');
      expect(stored.pendingPlanRefId).toBeNull();
      expect(stored.pendingPlanAt).toBeNull();
      expect((await limits.forWaba(ORG, wabaId)).planCode).toBe('starter');
    });

    it('follows Razorpay when a plan is changed in their dashboard', async () => {
      const { subscriptionId } = await subscribed('starter');

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
        where: { ssoOrgId: ORG },
        include: { plan: true },
      });
      expect(stored.plan?.code).toBe('growth');
    });
  });

  /* ------------------------------------------------------------------ *
   * What it refuses                                                     *
   * ------------------------------------------------------------------ */

  describe('what it will not do', () => {
    it('refuses over HTTP for an organisation with no subscription', async () => {
      const { userId } = await subscribed('starter');
      const token = await h.signIn(userId, 'org_somebody_else');

      await api()
        .patch('/billing/subscription/plan')
        .set('Authorization', `Bearer ${token}`)
        .send({ planCode: 'business' })
        .expect(404);

      expect(h.razorpay.received('POST', /^\/subscriptions$/)).toHaveLength(0);
    });

    it('refuses a quoted tier before touching Razorpay', async () => {
      const { userId } = await subscribed('starter');
      const token = await h.signIn(userId, ORG);

      const res = await api()
        .patch('/billing/subscription/plan')
        .set('Authorization', `Bearer ${token}`)
        .send({ planCode: 'agency' })
        .expect(400);

      expect(JSON.stringify(res.body)).toMatch(/priced individually/);
      expect(h.razorpay.received('POST', /^\/subscriptions$/)).toHaveLength(0);
      expect(
        h.razorpay.received('PATCH', /^\/subscriptions\/[^/]+$/),
      ).toHaveLength(0);
    });

    it('refuses a subscription that is already ending', async () => {
      await subscribed('starter');
      await h.prisma.subscription.updateMany({
        where: { ssoOrgId: ORG },
        data: { cancelAtCycleEnd: true },
      });

      await expect(billing.changePlan(ORG, 'growth')).rejects.toThrow(
        /set to end/,
      );
    });

    it('never asks Razorpay to raise an amount past the mandate', async () => {
      // The bank's ceiling is why an upgrade is a new subscription rather than
      // a plan change: the PATCH that raises the amount is the one Razorpay
      // refuses, and this path no longer sends one.
      await subscribed('starter');

      await billing.changePlan(ORG, 'business');

      expect(
        h.razorpay.received('PATCH', /^\/subscriptions\/[^/]+$/),
      ).toHaveLength(0);
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
      expect((await limits.forWaba(ORG, wabaId)).includedWabas).toBe(1);

      await h.app.get(PlanSyncService).adoptExisting();

      const after = await limits.forWaba(ORG, wabaId);
      expect(after.planCode).toBe('business');
      expect(after.includedWabas).toBe(10);
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
        where: { ssoOrgId: ORG },
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
