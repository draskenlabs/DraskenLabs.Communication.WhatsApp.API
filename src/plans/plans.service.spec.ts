import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PlansService } from './plans.service';
import { PrismaService } from 'src/prisma/prisma.service';

const mockPrisma = { plan: { findMany: jest.fn(), findFirst: jest.fn() } };

const row = (over: Record<string, unknown> = {}) => ({
  code: 'growth',
  name: 'Growth',
  audience: 'Growing businesses and teams.',
  price: 99900,
  priceLabel: null,
  currency: 'INR',
  unit: '/WABA/month',
  additionalNumberPrice: 19900,
  maxWabas: 3,
  maxPhoneNumbersPerWaba: 3,
  maxTeamMembers: 5,
  maxWebhookEndpoints: 10,
  historyDays: 90,
  recommended: true,
  ctaKind: 'subscribe',
  ctaLabel: 'Choose Growth',
  inherits: { code: 'starter' },
  features: [{ label: 'Up to 3 WABAs' }, { label: '3 phone numbers per WABA' }],
  ...over,
});

describe('PlansService', () => {
  let service: PlansService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlansService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(PlansService);
  });

  it('returns active plans in published order, limits flattened out of the columns', async () => {
    mockPrisma.plan.findMany.mockResolvedValue([row()]);

    const plans = await service.findAll();

    expect(mockPrisma.plan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { active: true },
        orderBy: { sortOrder: 'asc' },
      }),
    );
    expect(plans[0]).toMatchObject({
      code: 'growth',
      price: 99900,
      currency: 'INR',
      additionalNumberPrice: 19900,
      inherits: 'starter',
      recommended: true,
      limits: {
        wabas: 3,
        phoneNumbersPerWaba: 3,
        teamMembers: 5,
        webhookEndpoints: 10,
        historyDays: 90,
      },
    });
    expect(plans[0].features).toEqual([
      'Up to 3 WABAs',
      '3 phone numbers per WABA',
    ]);
  });

  it('never sends the Razorpay plan id to the browser', async () => {
    mockPrisma.plan.findMany.mockResolvedValue([row()]);

    const plans = await service.findAll();

    expect(plans[0]).not.toHaveProperty('razorpayPlanId');
    const { select } = mockPrisma.plan.findMany.mock.calls[0][0];
    expect(select.razorpayPlanId).toBeUndefined();
  });

  it('keeps an unpriced plan unpriced rather than calling it zero', async () => {
    mockPrisma.plan.findMany.mockResolvedValue([
      row({
        code: 'agency',
        price: null,
        priceLabel: 'Custom',
        additionalNumberPrice: null,
        maxWabas: null,
        maxPhoneNumbersPerWaba: null,
        maxTeamMembers: null,
        maxWebhookEndpoints: null,
        historyDays: null,
        ctaKind: 'contact',
        inherits: null,
      }),
    ]);

    const [agency] = await service.findAll();

    expect(agency.price).toBeNull();
    expect(agency.priceLabel).toBe('Custom');
    expect(agency.ctaKind).toBe('contact');
    expect(agency.inherits).toBeNull();
    // Null is "no number on it", not a limit of zero.
    expect(Object.values(agency.limits).every((value) => value === null)).toBe(
      true,
    );
  });

  it('orders the feature bullets as published', async () => {
    mockPrisma.plan.findMany.mockResolvedValue([row()]);

    await service.findAll();

    const { select } = mockPrisma.plan.findMany.mock.calls[0][0];
    expect(select.features.orderBy).toEqual({ sortOrder: 'asc' });
  });

  describe('findByCode', () => {
    it('returns one plan', async () => {
      mockPrisma.plan.findFirst.mockResolvedValue(row());

      const plan = await service.findByCode('growth');

      expect(mockPrisma.plan.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { code: 'growth', active: true } }),
      );
      expect(plan.name).toBe('Growth');
    });

    it('404s for a code that is not on offer', async () => {
      mockPrisma.plan.findFirst.mockResolvedValue(null);

      await expect(service.findByCode('enterprise')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
