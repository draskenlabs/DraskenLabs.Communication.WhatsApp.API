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

  /** Subscribe an account and mark the mandate authorised, as a charge would. */
  async function subscribe(
    userId: number,
    wabaId: string,
    plan: 'starter' | 'growth' | 'business',
  ): Promise<void> {
    await billing.register(userId, ORG, wabaId, plan);
    await h.prisma.subscription.updateMany({
      where: { wabaId, ssoOrgId: ORG },
      data: {
        status: 'active',
        currentEnd: new Date(Date.now() + 20 * 24 * 3600 * 1000),
      },
    });
  }

  describe('what a plan allows', () => {
    it('reads the tier an account is actually subscribed on', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      await subscribe(userId, wabaId, 'growth');

      const effective = await limits.forWaba(ORG, wabaId);

      expect(effective).toMatchObject({
        planCode: 'growth',
        planName: 'Growth',
        wabas: 3,
        phoneNumbersPerWaba: null,
        teamMembers: 5,
        webhookEndpoints: 10,
        historyDays: 90,
      });
    });

    it('holds an organisation that pays for nothing to the cheapest plan', async () => {
      const { wabaId } = await seedAccount(h.prisma);

      const effective = await limits.forWaba(ORG, wabaId);

      expect(effective.webhookEndpoints).toBe(2);
      expect(effective.planCode).toBeNull();
    });

    it('takes the best tier across an organisation for what it owns as a whole', async () => {
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
      await subscribe(first.userId, 'waba_a', 'starter');
      await subscribe(first.userId, 'waba_b', 'business');

      const effective = await limits.forOrg(ORG);

      expect(effective.planCode).toBe('business');
      expect(effective.wabas).toBe(10);
    });

    it('stops honouring a tier once its subscription is cancelled and run out', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      await subscribe(userId, wabaId, 'business');
      await h.prisma.subscription.updateMany({
        where: { wabaId },
        data: {
          status: 'cancelled',
          currentEnd: new Date(Date.now() - 3600_000),
        },
      });

      const effective = await limits.forWaba(ORG, wabaId);

      expect(effective.planCode).toBeNull();
      // The entry floor is the cheapest plan's, and that plan caps accounts
      // rather than the numbers on them.
      expect(effective.wabas).toBe(1);
      expect(effective.phoneNumbersPerWaba).toBeNull();
    });
  });

  describe('webhook endpoints', () => {
    const url = (n: number) => `https://api.example.com/hooks/${n}`;

    it("allows exactly what the account's plan includes, then refuses", async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      await subscribe(userId, wabaId, 'starter');

      await endpoints.create(userId, ORG, { url: url(1), wabaId });
      await endpoints.create(userId, ORG, { url: url(2), wabaId });

      await expect(
        endpoints.create(userId, ORG, { url: url(3), wabaId }),
      ).rejects.toThrow(/Starter plan includes 2 webhook endpoints/);

      expect(await h.prisma.webhookEndpoint.count({ where: { wabaId } })).toBe(
        2,
      );
    });

    it('gives a higher tier the endpoints it sells', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      await subscribe(userId, wabaId, 'growth');

      for (let n = 1; n <= 6; n++) {
        await endpoints.create(userId, ORG, { url: url(n), wabaId });
      }

      // Growth publishes ten; six is well inside it, where Starter's old
      // hardcoded five would have refused the sixth.
      expect(await h.prisma.webhookEndpoint.count({ where: { wabaId } })).toBe(
        6,
      );
    });

    it('puts no ceiling on a tier that publishes none', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      await subscribe(userId, wabaId, 'business');

      for (let n = 1; n <= 12; n++) {
        await endpoints.create(userId, ORG, { url: url(n), wabaId });
      }

      expect(await h.prisma.webhookEndpoint.count({ where: { wabaId } })).toBe(
        12,
      );
    });

    it('frees a slot when one is deleted', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      await subscribe(userId, wabaId, 'starter');
      const first = await endpoints.create(userId, ORG, {
        url: url(1),
        wabaId,
      });
      await endpoints.create(userId, ORG, { url: url(2), wabaId });

      await endpoints.remove(ORG, first.id);

      await expect(
        endpoints.create(userId, ORG, { url: url(3), wabaId }),
      ).resolves.toBeDefined();
    });
  });

  describe('accounts', () => {
    it('refuses a second account on a plan that includes one', async () => {
      const { userId } = await seedAccount(h.prisma, { wabaId: 'waba_a' });
      await subscribe(userId, 'waba_a', 'starter');

      await expect(
        wabas.createOrUpdateWaba({
          wabaId: 'waba_b',
          userId,
          ssoOrgId: ORG,
          name: 'Second',
        }),
      ).rejects.toThrow(/Starter plan includes 1 WhatsApp Business Account/);

      expect(await h.prisma.waba.count()).toBe(1);
    });

    it('lets an account already connected here be refreshed at any count', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma);
      await subscribe(userId, wabaId, 'starter');

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

    it('allows up to what a higher tier includes', async () => {
      const { userId } = await seedAccount(h.prisma, { wabaId: 'waba_a' });
      await subscribe(userId, 'waba_a', 'growth');

      await wabas.createOrUpdateWaba({
        wabaId: 'waba_b',
        userId,
        ssoOrgId: ORG,
        name: 'B',
      });
      await wabas.createOrUpdateWaba({
        wabaId: 'waba_c',
        userId,
        ssoOrgId: ORG,
        name: 'C',
      });

      // Three on Growth; the fourth is what an upgrade is for.
      await expect(
        wabas.createOrUpdateWaba({
          wabaId: 'waba_d',
          userId,
          ssoOrgId: ORG,
          name: 'D',
        }),
      ).rejects.toThrow(/Growth plan includes 3 WhatsApp Business Accounts/);
    });
  });
});
