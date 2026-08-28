import { BillingService } from 'src/billing/billing.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { WabaService } from 'src/waba/waba.service';
import { WebhookEndpointsService } from 'src/webhooks/webhook-endpoints.service';
import { Harness, ORG, seedAccount, startHarness } from './harness';

/**
 * The limits, counted against a real database.
 *
 * The unit suite proves the decision; this proves the count. Every check here
 * is count-then-refuse against rows that actually exist, on the plan a
 * subscription actually holds — which is the part a mocked `count()` cannot
 * say anything about.
 */
describe('Plan limits (integration)', () => {
  let h: Harness;
  let limits: PlanLimitsService;
  let billing: BillingService;
  let endpoints: WebhookEndpointsService;
  let wabas: WabaService;

  beforeAll(async () => {
    h = await startHarness();
    limits = h.app.get(PlanLimitsService);
    billing = h.app.get(BillingService);
    endpoints = h.app.get(WebhookEndpointsService);
    wabas = h.app.get(WabaService);
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
  async function subscribe(
    userId: number,
    plan: 'starter' | 'growth' | 'business',
  ): Promise<void> {
    await billing.register(userId, ORG, plan);
    await h.prisma.subscription.updateMany({
      where: { ssoOrgId: ORG },
      data: {
        status: 'active',
        currentEnd: new Date(Date.now() + 20 * 24 * 3600 * 1000),
      },
    });
  }

  describe('what a plan allows', () => {
    it('reads the tier an account is actually subscribed on', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      await subscribe(userId, 'growth');

      const effective = await limits.forWaba(ORG, wabaId);

      expect(effective).toMatchObject({
        planCode: 'growth',
        planName: 'Growth',
        includedWabas: 3,
        includedPhoneNumbersPerWaba: 1,
        teamMembers: 5,
        webhookEndpoints: 5,
        apiKeysPerWaba: 5,
        contacts: 10000,
        messagesPerMinute: 500,
        historyDays: 90,
      });
    });

    it('holds an organisation that pays for nothing to the cheapest plan', async () => {
      const { wabaId } = await seedAccount(h.prisma);

      const effective = await limits.forWaba(ORG, wabaId);

      expect(effective.webhookEndpoints).toBe(1);
      expect(effective.planCode).toBeNull();
    });

    it('answers for every account the one subscription covers', async () => {
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
      await subscribe(first.userId, 'business');

      // The subscription names no account, so `forWaba` falls back to it —
      // holding a paying customer to the entry floor on a second account was
      // exactly the bug organisation-level billing removes.
      expect((await limits.forOrg(ORG)).planCode).toBe('business');
      expect((await limits.forWaba(ORG, 'waba_a')).includedWabas).toBe(10);
      expect((await limits.forWaba(ORG, 'waba_b')).includedWabas).toBe(10);
    });

    it('stops honouring a tier once its subscription is cancelled and run out', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      await subscribe(userId, 'business');
      await h.prisma.subscription.updateMany({
        where: { ssoOrgId: ORG },
        data: {
          status: 'cancelled',
          currentEnd: new Date(Date.now() - 3600_000),
        },
      });

      const effective = await limits.forWaba(ORG, wabaId);

      expect(effective.planCode).toBeNull();
      // Back to the entry floor: what the cheapest published tier includes.
      expect(effective.includedWabas).toBe(1);
      expect(effective.includedPhoneNumbersPerWaba).toBe(1);
    });
  });

  describe('webhook endpoints', () => {
    const url = (n: number) => `https://api.example.com/hooks/${n}`;

    it("allows exactly what the organisation's plan includes, then refuses", async () => {
      // Endpoints are not sold by the unit, so this refuses rather than bills.
      const { userId, wabaId } = await seedAccount(h.prisma);
      await subscribe(userId, 'starter');

      await endpoints.create(userId, ORG, { url: url(1), wabaId });

      await expect(
        endpoints.create(userId, ORG, { url: url(2), wabaId }),
      ).rejects.toThrow(/Starter plan includes 1 webhook endpoint/);

      expect(await h.prisma.webhookEndpoint.count({ where: { wabaId } })).toBe(
        1,
      );
    });

    it('gives a higher tier the endpoints it sells', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      await subscribe(userId, 'growth');

      for (let n = 1; n <= 5; n++) {
        await endpoints.create(userId, ORG, { url: url(n), wabaId });
      }

      // Growth publishes five, where Starter allows one.
      expect(await h.prisma.webhookEndpoint.count({ where: { wabaId } })).toBe(
        5,
      );
      await expect(
        endpoints.create(userId, ORG, { url: url(6), wabaId }),
      ).rejects.toThrow(/Growth plan includes 5 webhook endpoints/);
    });

    it('gives the top tier twice what the middle one has', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      await subscribe(userId, 'business');

      for (let n = 1; n <= 10; n++) {
        await endpoints.create(userId, ORG, { url: url(n), wabaId });
      }

      expect(await h.prisma.webhookEndpoint.count({ where: { wabaId } })).toBe(
        10,
      );
    });

    it('frees a slot when one is deleted', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      await subscribe(userId, 'starter');
      const first = await endpoints.create(userId, ORG, {
        url: url(1),
        wabaId,
      });

      await endpoints.remove(ORG, first.id);

      await expect(
        endpoints.create(userId, ORG, { url: url(2), wabaId }),
      ).resolves.toBeDefined();
    });
  });

  describe('accounts', () => {
    it('connects a second account on a plan that includes one, and bills it', async () => {
      // Accounts past the included ones are sold at ₹299, not refused. A limit
      // that turns a customer away from spending more is not a limit worth
      // having; the charge is raised on the next invoice.
      const { userId } = await seedAccount(h.prisma, { wabaId: 'waba_a' });
      await subscribe(userId, 'starter');

      await expect(
        wabas.createOrUpdateWaba({
          wabaId: 'waba_b',
          userId,
          ssoOrgId: ORG,
          name: 'Second',
        }),
      ).resolves.toMatchObject({ wabaId: 'waba_b' });

      expect(await h.prisma.waba.count()).toBe(2);
    });

    it('lets an account already connected here be refreshed at any count', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      await subscribe(userId, 'starter');

      // Re-connecting is not adding: metadata refreshes must not start failing
      // because the organisation is at its limit.
      await expect(
        wabas.createOrUpdateWaba({
          wabaId,
          userId,
          ssoOrgId: ORG,
          name: 'Renamed at Meta',
        }),
      ).resolves.toMatchObject({ name: 'Renamed at Meta' });
    });

    it('connects past what a tier includes rather than refusing', async () => {
      const { userId } = await seedAccount(h.prisma, { wabaId: 'waba_a' });
      await subscribe(userId, 'growth');

      for (const wabaId of ['waba_b', 'waba_c', 'waba_d']) {
        await wabas.createOrUpdateWaba({
          wabaId,
          userId,
          ssoOrgId: ORG,
          name: wabaId,
        });
      }

      // Four on Growth, which includes three. The fourth is billed, and the
      // console says so — it is not turned away.
      expect(await h.prisma.waba.count()).toBe(4);
      expect((await limits.forOrg(ORG)).additionalWabaPrice).toBe(29900);
    });
  });
});
