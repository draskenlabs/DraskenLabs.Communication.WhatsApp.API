import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AgencyBillingService } from './agency-billing.service';
import { RazorpayService } from './razorpay.service';
import { SubscriptionAccessService } from './subscription-access.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { OrganisationSettingsService } from 'src/organisation-settings/organisation-settings.service';

const mockPrisma = {
  plan: { findFirst: jest.fn() },
  subscription: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  agencyBillingGroup: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
  },
  subscriptionPayment: { upsert: jest.fn() },
  user: { findUnique: jest.fn() },
};

const mockRazorpay = {
  createSubscription: jest.fn(),
  setSubscriptionQuantity: jest.fn(),
  cancelSubscription: jest.fn(),
  createCustomer: jest.fn(),
};

const mockSettings = { bumpPayerVersion: jest.fn() };
const mockAccess = { invalidatePayer: jest.fn() };

const GROWTH = {
  id: 2,
  code: 'growth',
  name: 'Growth',
  ctaKind: 'subscribe',
  razorpayPlanId: 'plan_growth',
};

const group = (over: Record<string, unknown> = {}) => ({
  id: 9,
  agencyOrgId: 'org_agency',
  planRefId: 2,
  razorpayCustomerId: 'cust_1',
  razorpaySubscriptionId: 'sub_group',
  planId: 'plan_growth',
  quantity: 3,
  status: 'active',
  currentStart: new Date('2026-08-01'),
  currentEnd: new Date('2026-09-01'),
  cancelAtCycleEnd: false,
  ...over,
});

describe('AgencyBillingService', () => {
  let service: AgencyBillingService;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockPrisma.plan.findFirst.mockResolvedValue(GROWTH);
    mockPrisma.subscription.findFirst.mockResolvedValue(null);
    mockPrisma.subscription.findMany.mockResolvedValue([]);
    mockPrisma.subscription.create.mockResolvedValue({ id: 1 });
    mockPrisma.agencyBillingGroup.findUnique.mockResolvedValue(null);
    mockPrisma.agencyBillingGroup.findFirst.mockResolvedValue(null);
    mockPrisma.agencyBillingGroup.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(group(data)),
    );
    mockPrisma.agencyBillingGroup.upsert.mockImplementation(
      ({ create }: { create: Record<string, unknown> }) =>
        Promise.resolve({ id: 9, ...create }),
    );
    mockPrisma.user.findUnique.mockResolvedValue({
      email: 'ops@agency.test',
      firstName: 'Ops',
      lastName: null,
    });
    mockRazorpay.createCustomer.mockResolvedValue({ id: 'cust_new' });
    mockRazorpay.createSubscription.mockResolvedValue({
      id: 'sub_new',
      plan_id: 'plan_growth',
      status: 'created',
      short_url: 'https://pay.example/sub_new',
      current_start: null,
      current_end: null,
    });
    mockRazorpay.setSubscriptionQuantity.mockResolvedValue({ id: 'sub_group' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgencyBillingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RazorpayService, useValue: mockRazorpay },
        { provide: OrganisationSettingsService, useValue: mockSettings },
        { provide: SubscriptionAccessService, useValue: mockAccess },
      ],
    }).compile();
    service = module.get(AgencyBillingService);
  });

  const take = (over: Record<string, unknown> = {}) =>
    service.subscribeClient({
      agencyOrgId: 'org_agency',
      ssoOrgId: 'org_client',
      planCode: 'growth',
      userId: 7,
      ...over,
    });

  describe('taking a client on', () => {
    it('creates the mandate for the first client on a plan, and asks for it', async () => {
      const result = await take();

      expect(mockRazorpay.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ planId: 'plan_growth', quantity: 1 }),
      );
      expect(result.authorisation).toEqual({
        subscriptionId: 'sub_new',
        shortUrl: 'https://pay.example/sub_new',
      });
    });

    it('grows the existing mandate for the second, asking for nothing', async () => {
      // A subscription per client would be an authorisation per client, and
      // nobody would sit through eight of those.
      mockPrisma.agencyBillingGroup.findUnique.mockResolvedValue(group());

      const result = await take();

      expect(mockRazorpay.setSubscriptionQuantity).toHaveBeenCalledWith(
        'sub_group',
        4,
      );
      expect(mockRazorpay.createSubscription).not.toHaveBeenCalled();
      expect(result.authorisation).toBeNull();
    });

    it('writes the entitlement against the client, and the money against the agency', async () => {
      mockPrisma.agencyBillingGroup.findUnique.mockResolvedValue(group());

      await take();

      const [{ data }] = mockPrisma.subscription.create.mock.calls[0] as [
        {
          data: {
            ssoOrgId: string;
            payerOrgId: string;
            billingGroupId: number;
            razorpaySubscriptionId: string | null;
          };
        },
      ];
      expect(data.ssoOrgId).toBe('org_client');
      expect(data.payerOrgId).toBe('org_agency');
      expect(data.billingGroupId).toBe(9);
      // No mandate of its own: it is a quantity on the agency's.
      expect(data.razorpaySubscriptionId).toBeNull();
    });

    it('gives the client the group’s period, so its cover is real from the start', async () => {
      mockPrisma.agencyBillingGroup.findUnique.mockResolvedValue(group());

      await take();

      const [{ data }] = mockPrisma.subscription.create.mock.calls[0] as [
        { data: { currentEnd: Date; status: string } },
      ];
      expect(data.currentEnd).toEqual(new Date('2026-09-01'));
      expect(data.status).toBe('active');
    });

    it('re-keys the client’s cached access', async () => {
      // Its answer now comes from a subscription of its own rather than from
      // whatever its agency holds.
      mockPrisma.agencyBillingGroup.findUnique.mockResolvedValue(group());

      await take();

      expect(mockSettings.bumpPayerVersion).toHaveBeenCalledWith('org_client');
    });

    it('refuses a plan written for another agency', async () => {
      mockPrisma.plan.findFirst.mockResolvedValue(null);

      await expect(take()).rejects.toThrow(NotFoundException);
      const [call] = mockPrisma.plan.findFirst.mock.calls as [
        [{ where: { OR: unknown[] } }],
      ];
      const { where } = call[0];
      expect(where.OR).toEqual([
        { ssoOrgId: null },
        { ssoOrgId: 'org_agency' },
      ]);
    });

    it('refuses a quoted card, which is not a product', async () => {
      mockPrisma.plan.findFirst.mockResolvedValue({
        ...GROWTH,
        ctaKind: 'contact',
      });

      await expect(take()).rejects.toThrow(/priced individually/);
    });

    it('refuses a tier with no provider plan behind it', async () => {
      mockPrisma.plan.findFirst.mockResolvedValue({
        ...GROWTH,
        razorpayPlanId: null,
      });

      await expect(take()).rejects.toThrow(/not available for checkout/);
    });

    it('refuses while the agency’s mandate for that plan is not live', async () => {
      // The provider will not accept a change to a subscription that is
      // retrying or has stopped, so promising the agency a client is a lie.
      mockPrisma.agencyBillingGroup.findUnique.mockResolvedValue(
        group({ status: 'halted' }),
      );

      await expect(take()).rejects.toThrow(/is halted/);
      expect(mockPrisma.subscription.create).not.toHaveBeenCalled();
    });

    it('writes no entitlement when the provider will not raise the quantity', async () => {
      mockPrisma.agencyBillingGroup.findUnique.mockResolvedValue(group());
      mockRazorpay.setSubscriptionQuantity.mockResolvedValue(null);

      await expect(take()).rejects.toThrow(/Nothing has been changed/);
      expect(mockPrisma.subscription.create).not.toHaveBeenCalled();
    });

    it('refuses a client that already has a subscription', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 5,
        status: 'active',
        cancelAtCycleEnd: false,
      });

      await expect(take()).rejects.toThrow(/already has a subscription/);
    });

    it('takes on a client whose previous subscription is finished', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 5,
        status: 'cancelled',
        cancelAtCycleEnd: false,
      });

      await expect(take()).resolves.toBeDefined();
    });
  });

  describe('letting a client go', () => {
    beforeEach(() => {
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 5,
        cancelAtCycleEnd: false,
        billingGroup: group(),
      });
    });

    it('ends the cover at the close of the month already paid for', async () => {
      // Not today. The month was bought, and the client is the one who would
      // notice it being taken away.
      await service.releaseClient('org_agency', 'org_client');

      const [{ data }] = mockPrisma.subscription.update.mock.calls[0] as [
        { data: { cancelAtCycleEnd: boolean } },
      ];
      expect(data.cancelAtCycleEnd).toBe(true);
    });

    it('drops the quantity at cycle end, matching what the client keeps', async () => {
      await service.releaseClient('org_agency', 'org_client');

      expect(mockRazorpay.setSubscriptionQuantity).toHaveBeenCalledWith(
        'sub_group',
        2,
        { atCycleEnd: true },
      );
    });

    it('cancels the mandate when the last client on it goes', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 5,
        cancelAtCycleEnd: false,
        billingGroup: group({ quantity: 1 }),
      });

      await service.releaseClient('org_agency', 'org_client');

      expect(mockRazorpay.cancelSubscription).toHaveBeenCalledWith(
        'sub_group',
        true,
      );
      expect(mockRazorpay.setSubscriptionQuantity).not.toHaveBeenCalled();
    });

    it('does nothing twice', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: 5,
        cancelAtCycleEnd: true,
        billingGroup: group(),
      });

      await service.releaseClient('org_agency', 'org_client');

      expect(mockRazorpay.setSubscriptionQuantity).not.toHaveBeenCalled();
    });

    it('refuses for a client this agency does not pay for', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(null);

      await expect(
        service.releaseClient('org_agency', 'org_stranger'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('a webhook for the agency’s mandate', () => {
    beforeEach(() => {
      mockPrisma.agencyBillingGroup.findUnique.mockResolvedValue({
        id: 9,
        agencyOrgId: 'org_agency',
      });
      mockPrisma.subscription.findMany.mockResolvedValue([
        { ssoOrgId: 'org_a' },
        { ssoOrgId: 'org_b' },
      ]);
    });

    it('moves every client on it, or their cover lapses in a month', async () => {
      // The quietest way this could break: the group renews, the clients do
      // not, and a month later every one of them is refused.
      const handled = await service.applyToGroup('sub_group', {
        status: 'active',
        current_start: 1_756_000_000,
        current_end: 1_758_600_000,
      });

      expect(handled).toBe(true);
      const [{ where, data }] = mockPrisma.subscription.updateMany.mock
        .calls[0] as [
        { where: { billingGroupId: number }; data: { status: string } },
      ];
      expect(where.billingGroupId).toBe(9);
      expect(data.status).toBe('active');
    });

    it('re-keys every client, since each is cached separately', async () => {
      await service.applyToGroup('sub_group', { status: 'active' });

      expect(mockAccess.invalidatePayer).toHaveBeenCalledWith('org_a');
      expect(mockAccess.invalidatePayer).toHaveBeenCalledWith('org_b');
      expect(mockAccess.invalidatePayer).toHaveBeenCalledWith('org_agency');
    });

    it('records the payment against the group, not against one client', async () => {
      // One debit covers all of them; filing it under any single client would
      // be a lie about who was charged.
      await service.applyToGroup(
        'sub_group',
        { status: 'active' },
        {
          razorpayPaymentId: 'pay_1',
          razorpayInvoiceId: null,
          amount: 299_700,
          currency: 'INR',
          status: 'captured',
          method: 'card',
          methodDetail: 'Visa ···· 4242',
          paidAt: new Date(),
        },
      );

      const [{ create }] = mockPrisma.subscriptionPayment.upsert.mock
        .calls[0] as [{ create: { billingGroupId: number } }];
      expect(create.billingGroupId).toBe(9);
    });

    it('says it did not handle a subscription that is not a group', async () => {
      mockPrisma.agencyBillingGroup.findUnique.mockResolvedValue(null);

      await expect(
        service.applyToGroup('sub_unknown', { status: 'active' }),
      ).resolves.toBe(false);
    });
  });
});
