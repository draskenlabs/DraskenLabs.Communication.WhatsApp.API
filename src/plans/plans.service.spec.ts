import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PlansService } from './plans.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { firstArg } from 'src/common/utils/mock-args';

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
  additionalWabaPrice: 29900,
  includedWabas: 3,
  includedPhoneNumbersPerWaba: 1,
  includedClients: null,
  maxApiKeysPerWaba: 5,
  maxContacts: 10000,
  maxMessagesPerMinute: 500,
  maxTeamMembers: 5,
  maxWebhookEndpoints: 5,
  historyDays: 90,
  recommended: true,
  ctaKind: 'subscribe',
  ctaLabel: 'Choose Growth',
  razorpayPlanId: 'plan_growth',
  inherits: { code: 'starter' },
  features: [{ label: 'Up to 3 WABAs' }, { label: '1 phone number per WABA' }],
  ...over,
});

/** Whatever the deployment has not configured falls back to a default. */
let settings: Record<string, string> = {};
const mockConfig = { get: jest.fn((key: string) => settings[key]) };

describe('PlansService', () => {
  let service: PlansService;

  beforeEach(async () => {
    jest.clearAllMocks();
    settings = {};
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlansService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get(PlansService);
  });

  it('returns active plans in published order, limits flattened out of the columns', async () => {
    mockPrisma.plan.findMany.mockResolvedValue([row()]);

    const plans = await service.findAll();

    expect(mockPrisma.plan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { active: true, OR: [{ ssoOrgId: null }] },
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
        phoneNumbersPerWaba: 1,
        clients: null,
        apiKeysPerWaba: 5,
        contacts: 10000,
        messagesPerMinute: 500,
        teamMembers: 5,
        webhookEndpoints: 5,
        historyDays: 90,
      },
    });
    expect(plans[0].features).toEqual([
      'Up to 3 WABAs',
      '1 phone number per WABA',
    ]);
  });

  it('never sends the Razorpay plan id to the browser, only whether there is one', async () => {
    mockPrisma.plan.findMany.mockResolvedValue([row()]);

    const plans = await service.findAll();

    expect(plans[0]).not.toHaveProperty('razorpayPlanId');
    expect(plans[0].available).toBe(true);
  });

  it('marks a tier with no Razorpay plan as unavailable rather than sellable', async () => {
    mockPrisma.plan.findMany.mockResolvedValue([row({ razorpayPlanId: null })]);

    const [plan] = await service.findAll();

    // The console offers to talk instead of opening a checkout the API would
    // refuse.
    expect(plan.available).toBe(false);
  });

  it('keeps an unpriced plan unpriced rather than calling it zero', async () => {
    mockPrisma.plan.findMany.mockResolvedValue([
      row({
        code: 'agency',
        price: null,
        priceLabel: 'Custom',
        additionalNumberPrice: null,
        additionalWabaPrice: null,
        includedWabas: null,
        includedPhoneNumbersPerWaba: null,
        includedClients: null,
        maxApiKeysPerWaba: null,
        maxContacts: null,
        maxMessagesPerMinute: null,
        maxTeamMembers: null,
        maxWebhookEndpoints: null,
        historyDays: null,
        ctaKind: 'contact',
        razorpayPlanId: null,
        inherits: null,
      }),
    ]);

    const [agency] = await service.findAll();

    expect(agency.price).toBeNull();
    expect(agency.priceLabel).toBe('Custom');
    expect(agency.ctaKind).toBe('contact');
    // Quoted, so never "available" however it is wired up.
    expect(agency.available).toBe(false);
    expect(agency.inherits).toBeNull();
    // Null is "no number on it", not a limit of zero.
    expect(Object.values(agency.limits).every((value) => value === null)).toBe(
      true,
    );
  });

  it('shows a caller their own negotiated plan alongside the public ones', async () => {
    // An agency's agreed rate lives in the same table as the price list. It is
    // theirs to see once we know who is asking.
    mockPrisma.plan.findMany.mockResolvedValue([row()]);

    await service.findAll('sso_org_7');

    expect(mockPrisma.plan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          active: true,
          OR: [{ ssoOrgId: null }, { ssoOrgId: 'sso_org_7' }],
        },
      }),
    );
  });

  it('never shows a private plan to an anonymous visitor', async () => {
    // `/plans` is public. One customer's agreed rate is not something the next
    // visitor gets to read, so with nobody identified only the public rows
    // match.
    mockPrisma.plan.findMany.mockResolvedValue([row()]);

    await service.findAll();

    const { where } = firstArg<{ where: { OR: unknown[] } }>(
      mockPrisma.plan.findMany,
    );
    expect(where.OR).toEqual([{ ssoOrgId: null }]);
  });

  it('orders the feature bullets as published', async () => {
    mockPrisma.plan.findMany.mockResolvedValue([row()]);

    await service.findAll();

    const { select } = firstArg<{
      select: { features: { orderBy: unknown } };
    }>(mockPrisma.plan.findMany);
    expect(select.features.orderBy).toEqual({ sortOrder: 'asc' });
  });

  describe('tax on a published price', () => {
    it('says what the price already contains, where a rate is configured', async () => {
      // The price list is inclusive, so this is not something to add to the
      // figure on the card — it is what the figure already has in it.
      settings.INVOICE_TAX_RATE_BPS = '1800';
      mockPrisma.plan.findMany.mockResolvedValue([row()]);

      const [plan] = await service.findAll();

      expect(plan.taxRateBps).toBe(1800);
      expect(plan.taxLabel).toBe('GST');
    });

    it('says nothing where the deployment charges no tax', async () => {
      mockPrisma.plan.findMany.mockResolvedValue([row()]);

      const [plan] = await service.findAll();

      expect(plan.taxRateBps).toBe(0);
      expect(plan.taxLabel).toBeNull();
    });
  });

  describe('findByCode', () => {
    it('returns one plan', async () => {
      mockPrisma.plan.findFirst.mockResolvedValue(row());

      const plan = await service.findByCode('growth');

      expect(mockPrisma.plan.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { code: 'growth', active: true, OR: [{ ssoOrgId: null }] },
        }),
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
