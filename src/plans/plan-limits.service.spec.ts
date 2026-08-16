import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PlanLimitsService } from './plan-limits.service';
import { PrismaService } from 'src/prisma/prisma.service';

const mockPrisma = {
  subscription: { findMany: jest.fn(), findUnique: jest.fn() },
  plan: { findFirst: jest.fn() },
};

const plan = (over: Record<string, unknown> = {}) => ({
  code: 'starter',
  name: 'Starter',
  price: 49900,
  maxWabas: 1,
  maxPhoneNumbersPerWaba: 1,
  maxTeamMembers: 2,
  maxWebhookEndpoints: 2,
  historyDays: 30,
  ...over,
});

const growth = plan({
  code: 'growth',
  name: 'Growth',
  price: 99900,
  maxWabas: 3,
  maxPhoneNumbersPerWaba: 3,
  maxTeamMembers: 5,
  maxWebhookEndpoints: 10,
  historyDays: 90,
});

describe('PlanLimitsService', () => {
  let service: PlanLimitsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.plan.findFirst.mockResolvedValue(plan());
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanLimitsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(PlanLimitsService);
  });

  describe('forOrg', () => {
    it('takes the best tier the organisation holds', async () => {
      // One account on Starter and one on Growth is a Growth customer for
      // anything organisation-wide; holding the cheaper one too is not a
      // reason to be held to it.
      mockPrisma.subscription.findMany.mockResolvedValue([
        { plan: plan() },
        { plan: growth },
      ]);

      const limits = await service.forOrg('org_1');

      expect(limits.planCode).toBe('growth');
      expect(limits.wabas).toBe(3);
      expect(limits.teamMembers).toBe(5);
    });

    it('counts only subscriptions that are paying for something', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      await service.forOrg('org_1');

      const { where } = mockPrisma.subscription.findMany.mock.calls[0][0];
      expect(where.status.in).toEqual(
        expect.arrayContaining([
          'active',
          'authenticated',
          'pending',
          'halted',
        ]),
      );
      expect(where.status.in).not.toContain('cancelled');
    });

    it('falls back to the cheapest published plan when nothing is subscribed', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      const limits = await service.forOrg('org_1');

      expect(mockPrisma.plan.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { price: 'asc' } }),
      );
      expect(limits.wabas).toBe(1);
      // The floor, not a plan they are on — nothing should tell them they are
      // on Starter when they have bought nothing.
      expect(limits.planCode).toBeNull();
    });

    it('limits nothing when there is no price list at all', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([]);
      mockPrisma.plan.findFirst.mockResolvedValue(null);

      const limits = await service.forOrg('org_1');

      // Inventing a number here would lock people out of a deployment that
      // never sold them a plan.
      expect(limits.wabas).toBeNull();
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
      expect(limits.phoneNumbersPerWaba).toBe(3);
    });

    it('falls back to the floor for an account that is not paid for', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);

      const limits = await service.forWaba('org_1', 'waba_1');

      expect(limits.phoneNumbersPerWaba).toBe(1);
      expect(limits.planCode).toBeNull();
    });

    it('does not honour a cancelled subscription’s tier', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({
        status: 'cancelled',
        plan: growth,
      });

      const limits = await service.forWaba('org_1', 'waba_1');

      expect(limits.planCode).toBeNull();
      expect(limits.phoneNumbersPerWaba).toBe(1);
    });
  });

  describe('assertWithin', () => {
    const limits = {
      planCode: 'starter',
      planName: 'Starter',
      wabas: 1,
      phoneNumbersPerWaba: 1,
      teamMembers: 2,
      webhookEndpoints: 2,
      historyDays: 30,
    };

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
