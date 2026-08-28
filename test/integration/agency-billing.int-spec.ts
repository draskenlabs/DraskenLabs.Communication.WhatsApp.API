import { AgencyBillingService } from 'src/billing/agency-billing.service';
import { AgencyService } from 'src/agency/agency.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { SubscriptionAccessService } from 'src/billing/subscription-access.service';
import { Harness, ORG, seedAccount, startHarness } from './harness';

/**
 * An agency paying per client, against a real database and the provider
 * stand-in over real HTTP.
 *
 * The unit suite proves each decision in isolation. This proves the two things
 * it cannot: that a client ends up genuinely entitled by a row of its own, and
 * that one mandate carries several clients as a quantity rather than one
 * authorisation each.
 */
describe('Agency billing (integration)', () => {
  let h: Harness;
  let agencyBilling: AgencyBillingService;
  let agency: AgencyService;
  let limits: PlanLimitsService;
  let access: SubscriptionAccessService;

  beforeAll(async () => {
    h = await startHarness();
    agencyBilling = h.app.get(AgencyBillingService);
    agency = h.app.get(AgencyService);
    limits = h.app.get(PlanLimitsService);
    access = h.app.get(SubscriptionAccessService);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.reset();
  });

  /** An agency, and the user acting for it. */
  async function anAgency(): Promise<number> {
    const { userId } = await seedAccount(h.prisma, { wabaId: 'waba_agency' });
    await agency.convert(ORG, true, userId);
    return userId;
  }

  const take = (userId: number, ssoOrgId: string, planCode = 'growth') =>
    agencyBilling.subscribeClient({
      agencyOrgId: ORG,
      ssoOrgId,
      planCode,
      userId,
    });

  /** The agency authorises its mandate, as the first charge would. */
  async function authorise(planCode = 'growth'): Promise<void> {
    const plan = await h.prisma.plan.findUniqueOrThrow({
      where: { code: planCode },
      select: { id: true },
    });
    const group = await h.prisma.agencyBillingGroup.findFirstOrThrow({
      where: { agencyOrgId: ORG, planRefId: plan.id },
    });
    await agencyBilling.applyToGroup(group.razorpaySubscriptionId, {
      status: 'active',
      current_start: Math.floor(Date.now() / 1000),
      current_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    });
  }

  describe('taking clients on', () => {
    it('entitles the client by a row of its own, paid by the agency', async () => {
      const userId = await anAgency();

      await take(userId, 'org_kettle');

      const sub = await h.prisma.subscription.findFirst({
        where: { ssoOrgId: 'org_kettle' },
      });
      expect(sub?.payerOrgId).toBe(ORG);
      expect(sub?.billingGroupId).toBeGreaterThan(0);
      // No mandate of its own: it is a quantity on the agency's.
      expect(sub?.razorpaySubscriptionId).toBeNull();
    });

    it('carries a second client on the same mandate, not a second one', async () => {
      const userId = await anAgency();
      await take(userId, 'org_kettle');
      await authorise();

      const second = await take(userId, 'org_loom');

      // Nothing to authorise: the mandate already covering the first client
      // simply grew. A subscription per client would be an OTP per client.
      expect(second.authorisation).toBeNull();

      const groups = await h.prisma.agencyBillingGroup.findMany({
        where: { agencyOrgId: ORG },
      });
      expect(groups).toHaveLength(1);
      expect(groups[0].quantity).toBe(2);

      // And the provider was actually told.
      const remote = h.razorpay.subscriptions.get(
        groups[0].razorpaySubscriptionId,
      );
      expect(remote?.quantity).toBe(2);
    });

    it('re-asks for one mandate at the right size while it is still unpaid', async () => {
      // The provider will not change the quantity on a subscription nobody has
      // authorised. Refusing the second client until somebody pays for the
      // first would make taking on three at once impossible, so the unpaid
      // mandate is replaced by one for the number actually wanted.
      const userId = await anAgency();

      const first = await take(userId, 'org_kettle');
      const second = await take(userId, 'org_loom');

      expect(first.authorisation).not.toBeNull();
      expect(second.authorisation).not.toBeNull();
      expect(second.authorisation?.subscriptionId).not.toBe(
        first.authorisation?.subscriptionId,
      );

      // Still one mandate, now covering both.
      const groups = await h.prisma.agencyBillingGroup.findMany({
        where: { agencyOrgId: ORG },
      });
      expect(groups).toHaveLength(1);
      expect(groups[0].quantity).toBe(2);
      expect(groups[0].razorpaySubscriptionId).toBe(
        second.authorisation?.subscriptionId,
      );

      // Both clients hang off it — neither was stranded by the swap.
      const clients = await h.prisma.subscription.findMany({
        where: { billingGroupId: groups[0].id },
      });
      expect(clients).toHaveLength(2);
    });

    it('holds a separate mandate for each plan the agency uses', async () => {
      const userId = await anAgency();

      await take(userId, 'org_kettle', 'growth');
      const other = await take(userId, 'org_loom', 'business');

      // A plan the agency has not used before is its own authorisation.
      expect(other.authorisation).not.toBeNull();
      const groups = await h.prisma.agencyBillingGroup.findMany({
        where: { agencyOrgId: ORG },
      });
      expect(groups).toHaveLength(2);
      expect(groups.every((g) => g.quantity === 1)).toBe(true);
    });

    it('holds each client to the plan bought for it', async () => {
      // The whole point: limits and money move together, so a client on
      // Starter is on Starter even though its agency also sells Business.
      const userId = await anAgency();

      await take(userId, 'org_small', 'starter');
      await take(userId, 'org_big', 'business');
      // Limits follow money: nothing applies until the mandate is paid.
      await authorise('starter');
      await authorise('business');

      const small = await limits.forOrg('org_small');
      const big = await limits.forOrg('org_big');
      expect(small.planCode).toBe('starter');
      expect(big.planCode).toBe('business');
      expect(small.contacts).not.toBe(big.contacts);
    });

    it('refuses a client the agency already pays for', async () => {
      const userId = await anAgency();
      await take(userId, 'org_kettle');

      await expect(take(userId, 'org_kettle')).rejects.toThrow(
        /already has a subscription/,
      );
    });
  });

  describe('the mandate being charged', () => {
    it('moves every client on it when the group renews', async () => {
      // Without the fan-out a client's period never moves and its cover lapses
      // a month after it was taken on.
      const userId = await anAgency();
      await take(userId, 'org_kettle');
      await take(userId, 'org_loom');

      const group = await h.prisma.agencyBillingGroup.findFirstOrThrow({
        where: { agencyOrgId: ORG },
      });
      const currentEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

      await agencyBilling.applyToGroup(group.razorpaySubscriptionId, {
        status: 'active',
        current_start: Math.floor(Date.now() / 1000),
        current_end: currentEnd,
      });

      const clients = await h.prisma.subscription.findMany({
        where: { billingGroupId: group.id },
      });
      expect(clients).toHaveLength(2);
      for (const client of clients) {
        expect(client.status).toBe('active');
        expect(client.currentEnd?.getTime()).toBe(currentEnd * 1000);
      }
    });

    it('lets a client send once the mandate is paid, and not before', async () => {
      const userId = await anAgency();
      await take(userId, 'org_kettle');
      await h.prisma.waba.create({
        data: {
          wabaId: 'waba_kettle',
          userId,
          ssoOrgId: 'org_kettle',
          name: 'Kettle',
        },
      });
      await h.prisma.wabaOrganisation.create({
        data: { wabaId: 'waba_kettle', ssoOrgId: 'org_kettle', userId },
      });

      // Created, not yet authorised: nothing has been paid for.
      await expect(access.hasAccess('org_kettle', 'waba_kettle')).resolves.toBe(
        false,
      );

      const group = await h.prisma.agencyBillingGroup.findFirstOrThrow({
        where: { agencyOrgId: ORG },
      });
      await agencyBilling.applyToGroup(group.razorpaySubscriptionId, {
        status: 'active',
        current_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      });

      await expect(access.hasAccess('org_kettle', 'waba_kettle')).resolves.toBe(
        true,
      );
    });
  });

  describe('letting a client go', () => {
    it('keeps its cover to the end of the month already paid for', async () => {
      const userId = await anAgency();
      await take(userId, 'org_kettle');

      await agencyBilling.releaseClient(ORG, 'org_kettle');

      const sub = await h.prisma.subscription.findFirstOrThrow({
        where: { ssoOrgId: 'org_kettle' },
      });
      expect(sub.cancelAtCycleEnd).toBe(true);
      // Still there. The month was bought.
      expect(sub.status).not.toBe('cancelled');
    });

    it('drops the quantity, and cancels the mandate with the last client', async () => {
      const userId = await anAgency();
      await take(userId, 'org_kettle');
      await take(userId, 'org_loom');

      await agencyBilling.releaseClient(ORG, 'org_kettle');
      let group = await h.prisma.agencyBillingGroup.findFirstOrThrow({
        where: { agencyOrgId: ORG },
      });
      expect(group.quantity).toBe(1);
      expect(group.cancelAtCycleEnd).toBe(false);

      await agencyBilling.releaseClient(ORG, 'org_loom');
      group = await h.prisma.agencyBillingGroup.findFirstOrThrow({
        where: { agencyOrgId: ORG },
      });
      expect(group.quantity).toBe(0);
      expect(group.cancelAtCycleEnd).toBe(true);
    });
  });
});
