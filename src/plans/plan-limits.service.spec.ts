import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PlanLimitsService, EffectiveLimits } from './plan-limits.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { OrganisationSettingsService } from 'src/organisation-settings/organisation-settings.service';

const mockPrisma = {
  subscription: { findMany: jest.fn(), findUnique: jest.fn() },
  plan: { findFirst: jest.fn() },
};

const mockSettings = { billingOrgFor: jest.fn() };

/**
 * The first argument a mocked Prisma call was made with, typed.
 *
 * `mock.calls[0][0]` is `any`, and reaching into it is how a spec quietly
 * stops checking anything — the shape is asserted here instead.
 */
const firstArg = <T>(fn: jest.Mock): T =>
  (fn.mock.calls as unknown as T[][])[0][0];

type WhereArg = {
  where: {
    ssoOrgId?: string | null;
    status?: { in: string[] };
    wabaId_ssoOrgId?: { wabaId: string; ssoOrgId: string };
  };
};

const plan = (over: Record<string, unknown> = {}) => ({
  code: 'starter',
  name: 'Starter',
  price: 49900,
  rank: 10,
  includedWabas: 1,
  includedPhoneNumbersPerWaba: 1,
  includedClients: null,
  additionalWabaPrice: 29900,
  additionalNumberPrice: 19900,
  maxTeamMembers: 2,
  maxWebhookEndpoints: 1,
  maxApiKeysPerWaba: 1,
  maxContacts: 1000,
  maxMessagesPerMinute: 100,
  historyDays: 30,
  ...over,
});

const growth = plan({
  code: 'growth',
  name: 'Growth',
  price: 99900,
  rank: 20,
  includedWabas: 3,
  maxTeamMembers: 5,
  maxWebhookEndpoints: 5,
  maxApiKeysPerWaba: 5,
  maxContacts: 10000,
  maxMessagesPerMinute: 500,
  historyDays: 90,
});

/** A negotiated plan: no price to compare, only a rank. */
const agency = plan({
  code: 'agency',
  name: 'Agency',
  price: null,
  rank: 40,
  includedWabas: 50,
  includedClients: 20,
  maxTeamMembers: 100,
});

describe('PlanLimitsService', () => {
  let service: PlanLimitsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.plan.findFirst.mockResolvedValue(plan());
    // Nobody is an agency client unless a test says so.
    mockSettings.billingOrgFor.mockImplementation((id: string) =>
      Promise.resolve(id),
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanLimitsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrganisationSettingsService, useValue: mockSettings },
      ],
    }).compile();
    service = module.get(PlanLimitsService);
  });

  describe('forOrg', () => {
    it('takes the best-ranked tier the organisation holds', async () => {
      // One account on Starter and one on Growth is a Growth customer for
      // anything organisation-wide; holding the cheaper one too is not a
      // reason to be held to it.
      mockPrisma.subscription.findMany.mockResolvedValue([
        { plan: plan() },
        { plan: growth },
      ]);

      const limits = await service.forOrg('org_1');

      expect(limits.planCode).toBe('growth');
      expect(limits.includedWabas).toBe(3);
      expect(limits.teamMembers).toBe(5);
    });

    it('ranks a quoted plan above a published one, despite having no price', async () => {
      // The bug this replaces: sorting by `price ?? 0` mapped Agency's null
      // price to zero, so the customer paying us most was held to Growth.
      mockPrisma.subscription.findMany.mockResolvedValue([
        { plan: growth },
        { plan: agency },
      ]);

      const limits = await service.forOrg('org_1');

      expect(limits.planCode).toBe('agency');
      expect(limits.includedWabas).toBe(50);
    });

    it('resolves the paying organisation before looking for a subscription', async () => {
      // A client organisation has no subscription of its own; its agency's is
      // the one that answers for it.
      mockSettings.billingOrgFor.mockResolvedValue('agency_1');
      mockPrisma.subscription.findMany.mockResolvedValue([{ plan: agency }]);

      const limits = await service.forOrg('client_1');

      expect(mockSettings.billingOrgFor).toHaveBeenCalledWith('client_1');
      const { where } = firstArg<WhereArg>(mockPrisma.subscription.findMany);
      expect(where.ssoOrgId).toBe('agency_1');
      expect(limits.planCode).toBe('agency');
    });

    it('counts only subscriptions that are paying for something', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      await service.forOrg('org_1');

      const { where } = firstArg<WhereArg>(mockPrisma.subscription.findMany);
      expect(where.status?.in).toEqual(
        expect.arrayContaining([
          'active',
          'authenticated',
          'pending',
          'halted',
        ]),
      );
      expect(where.status?.in).not.toContain('cancelled');
    });

    it('falls back to the cheapest published plan when nothing is subscribed', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      const limits = await service.forOrg('org_1');

      expect(mockPrisma.plan.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { price: 'asc' } }),
      );
      expect(limits.includedWabas).toBe(1);
      // The floor, not a plan they are on — nothing should tell them they are
      // on Starter when they have bought nothing.
      expect(limits.planCode).toBeNull();
    });

    it('never takes the floor from somebody else’s negotiated plan', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      await service.forOrg('org_1');

      const { where } = firstArg<WhereArg>(mockPrisma.plan.findFirst);
      expect(where.ssoOrgId).toBeNull();
    });

    it('limits nothing when there is no price list at all', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([]);
      mockPrisma.plan.findFirst.mockResolvedValue(null);

      const limits = await service.forOrg('org_1');

      // Inventing a number here would lock people out of a deployment that
      // never sold them a plan.
      expect(limits.includedWabas).toBeNull();
      expect(limits.webhookEndpoints).toBeNull();
    });
  });

  describe('forWaba', () => {
    it("uses the plan of the account's own subscription", async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({
        status: 'active',
        plan: growth,
      });

      const limits = await service.forWaba('org_1', 'waba_1');

      expect(limits.planCode).toBe('growth');
      expect(limits.webhookEndpoints).toBe(5);
    });

    it('falls back to the organisation, not the floor, for an account with no subscription', async () => {
      // Under an organisation-level subscription no WABA has one of its own.
      // Answering "the cheapest published tier" here would quietly hold a
      // paying customer to Starter on every account they run.
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      mockPrisma.subscription.findMany.mockResolvedValue([{ plan: growth }]);

      const limits = await service.forWaba('org_1', 'waba_1');

      expect(limits.planCode).toBe('growth');
      expect(limits.webhookEndpoints).toBe(5);
    });

    it('does not honour a cancelled subscription’s tier', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({
        status: 'cancelled',
        plan: growth,
      });
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      const limits = await service.forWaba('org_1', 'waba_1');

      expect(limits.planCode).toBeNull();
      expect(limits.includedPhoneNumbersPerWaba).toBe(1);
    });

    it('looks the account up under the paying organisation', async () => {
      mockSettings.billingOrgFor.mockResolvedValue('agency_1');
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      mockPrisma.subscription.findMany.mockResolvedValue([{ plan: agency }]);

      await service.forWaba('client_1', 'waba_1');

      const { where } = firstArg<WhereArg>(mockPrisma.subscription.findUnique);
      expect(where.wabaId_ssoOrgId?.ssoOrgId).toBe('agency_1');
    });
  });

  describe('assertWithin', () => {
    const limits = {
      planCode: 'starter',
      planName: 'Starter',
      includedWabas: 1,
      includedPhoneNumbersPerWaba: 1,
      includedClients: null,
      additionalWabaPrice: 29900,
      additionalNumberPrice: 19900,
      teamMembers: 2,
      webhookEndpoints: 2,
      apiKeysPerWaba: 1,
      contacts: 1000,
      messagesPerMinute: 100,
      historyDays: 30,
    } satisfies EffectiveLimits;

    it('allows anything below the limit', () => {
      expect(() =>
        service.assertWithin(limits, 2, 1, 'webhook endpoint'),
      ).not.toThrow();
    });

    it('refuses at the limit, naming the plan and what to do about it', () => {
      expect(() =>
        service.assertWithin(limits, 2, 2, 'webhook endpoint'),
      ).toThrow(/Starter plan includes 2 webhook endpoints, and you have 2/);
      expect(() =>
        service.assertWithin(limits, 2, 2, 'webhook endpoint'),
      ).toThrow(BadRequestException);
    });

    it('says "Your plan" when the organisation is on the floor rather than a tier', () => {
      expect(() =>
        service.assertWithin(
          { ...limits, planName: null },
          1,
          1,
          'phone number',
        ),
      ).toThrow(/Your plan includes 1 phone number/);
    });

    it('allows anything at all when the plan names no limit', () => {
      expect(() =>
        service.assertWithin(limits, null, 9_000, 'webhook endpoint'),
      ).not.toThrow();
    });
  });
});
