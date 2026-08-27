import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BillingService } from './billing.service';
import { RazorpayService } from './razorpay.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import { mailNotificationsDouble } from 'src/mail/mail.test-doubles';
import { SubscriptionAccessService } from './subscription-access.service';
import { OrganisationSettingsService } from 'src/organisation-settings/organisation-settings.service';
import { WabaProvisioningService } from 'src/provisioning/waba-provisioning.service';

const mockPrisma = {
  subscription: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
  },
  subscriptionEvent: { create: jest.fn() },
  subscriptionPayment: { findMany: jest.fn(), upsert: jest.fn() },
  waba: { findFirst: jest.fn(), findMany: jest.fn() },
  user: { findUnique: jest.fn() },
  plan: { findFirst: jest.fn(), findUnique: jest.fn() },
  wabaPhoneNumber: { count: jest.fn(), groupBy: jest.fn() },
  wabaOrganisation: { findMany: jest.fn() },
};

/** A published tier, as `sellablePlan` selects it. */
const tier = (over: Record<string, unknown> = {}) => ({
  id: 2,
  code: 'growth',
  name: 'Growth',
  ctaKind: 'subscribe',
  razorpayPlanId: 'plan_growth',
  price: 99_900,
  ...over,
});

const mockRedis = {
  getSubscriptionAccess: jest.fn(),
  setSubscriptionAccess: jest.fn(),
  invalidateSubscriptionAccess: jest.fn(),
};

const mockRazorpay = {
  isConfigured: jest.fn().mockReturnValue(true),
  keyId: 'rzp_test_key',
  createCustomer: jest.fn(),
  updateCustomer: jest.fn(),
  createSubscription: jest.fn(),
  cancelSubscription: jest.fn(),
  fetchSubscription: jest.fn(),
  verifyCheckoutSignature: jest.fn(),
  fetchPlan: jest.fn(),
  addSubscriptionAddon: jest.fn(),
  changeSubscriptionPlan: jest.fn(),
};

/** The monthly plan, as Razorpay describes it. */
const PLAN = {
  id: 'plan_1',
  period: 'monthly',
  interval: 1,
  item: { amount: 49900, currency: 'INR', name: 'WA Console monthly' },
};

const mockMail = mailNotificationsDouble();

const mockAccess = { invalidate: jest.fn(), invalidatePayer: jest.fn() };
const mockOrgSettings = {
  billingOrgFor: jest.fn(),
  billingScope: jest.fn(),
  bumpPayerVersion: jest.fn(),
};

const mockProvisioning = {
  isProvisioned: jest.fn().mockResolvedValue(false),
  provision: jest.fn().mockResolvedValue({
    phoneNumbers: 0,
    templates: 0,
    subscribed: true,
    failures: [],
  }),
};

const HOUR = 60 * 60 * 1000;
const soon = () => new Date(Date.now() + 10 * 24 * HOUR);
const past = () => new Date(Date.now() - 2 * HOUR);

/** A row as the database would hold it. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 1,
  wabaId: 'waba_1',
  ssoOrgId: 'org_1',
  razorpayCustomerId: 'cust_1',
  razorpaySubscriptionId: 'sub_1',
  planId: 'plan_1',
  status: 'active',
  currentStart: new Date(Date.now() - 20 * 24 * HOUR),
  currentEnd: soon(),
  cancelAtCycleEnd: false,
  cancelledAt: null,
  shortUrl: null,
  createdByUserId: 7,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

/** A Razorpay webhook body for a subscription event. */
const hook = (event: string, entity: Record<string, unknown> = {}) => ({
  event,
  payload: {
    subscription: {
      entity: {
        id: 'sub_1',
        plan_id: 'plan_1',
        status: 'active',
        notes: { ssoOrgId: 'org_1', wabaId: 'waba_1' },
        ...entity,
      },
    },
  },
});

describe('BillingService', () => {
  let service: BillingService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRazorpay.isConfigured.mockReturnValue(true);
    mockProvisioning.isProvisioned.mockResolvedValue(false);
    mockRazorpay.fetchPlan.mockResolvedValue(PLAN);
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);
    // Nobody is an agency client unless a test says so, and the billing scope
    // of an ordinary organisation is itself.
    mockOrgSettings.billingOrgFor.mockImplementation((id: string) =>
      Promise.resolve(id),
    );
    mockOrgSettings.billingScope.mockImplementation((id: string) =>
      Promise.resolve([id]),
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: RazorpayService, useValue: mockRazorpay },
        { provide: MailNotifications, useValue: mockMail },
        { provide: SubscriptionAccessService, useValue: mockAccess },
        { provide: OrganisationSettingsService, useValue: mockOrgSettings },
        { provide: WabaProvisioningService, useValue: mockProvisioning },
      ],
    }).compile();
    service = module.get<BillingService>(BillingService);
  });

  describe('register', () => {
    beforeEach(() => {
      mockRazorpay.createCustomer.mockResolvedValue({ id: 'cust_1' });
      mockRazorpay.createSubscription.mockResolvedValue({
        id: 'sub_new',
        plan_id: 'plan_1',
        status: 'created',
        short_url: 'https://rzp.io/i/abc',
      });
      mockPrisma.subscription.upsert.mockResolvedValue({});
      mockPrisma.waba.findFirst.mockResolvedValue({
        wabaId: 'waba_1',
        name: 'Games',
      });
      mockPrisma.subscription.findFirst.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({
        email: 'suraj@example.com',
        firstName: 'Suraj',
        lastName: 'Aggarwal',
      });
    });

    it('returns the authorisation page and stores the subscription', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);

      const result = await service.register(7, 'org_1', 'waba_1');

      // Checkout opens against the subscription; the hosted page is a fallback.
      expect(result.subscriptionId).toBe('sub_new');
      expect(result.keyId).toBe('rzp_test_key');
      expect(result.authorisationUrl).toBe('https://rzp.io/i/abc');
      expect(mockPrisma.subscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            wabaId: 'waba_1',
            ssoOrgId: 'org_1',
            razorpaySubscriptionId: 'sub_new',
            status: 'created',
            createdByUserId: 7,
          }),
        }),
      );
      expect(mockAccess.invalidatePayer).toHaveBeenCalledWith('org_1');
    });

    it('sells the chosen tier: its Razorpay plan, and the row says which', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      mockPrisma.plan.findFirst.mockResolvedValue(tier());
      mockRazorpay.createSubscription.mockResolvedValue({
        id: 'sub_new',
        plan_id: 'plan_growth',
        status: 'created',
        short_url: 'https://rzp.io/i/abc',
      });

      const result = await service.register(7, 'org_1', 'waba_1', 'growth');

      expect(mockRazorpay.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          planId: 'plan_growth',
          // The tier travels to Razorpay too, so a payment in their dashboard
          // can be read back to a plan without our database.
          notes: expect.objectContaining({ planCode: 'growth' }),
        }),
      );
      expect(mockPrisma.subscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            planId: 'plan_growth',
            planRefId: 2,
          }),
        }),
      );
      expect(result.planCode).toBe('growth');
    });

    it('falls back to the configured plan when no tier is named', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);

      const result = await service.register(7, 'org_1', 'waba_1');

      expect(mockPrisma.plan.findFirst).not.toHaveBeenCalled();
      expect(mockRazorpay.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ planId: undefined }),
      );
      expect(mockPrisma.subscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ planRefId: null }),
        }),
      );
      expect(result.planCode).toBeNull();
    });

    it('refuses a tier that is not on offer, before creating anything', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      mockPrisma.plan.findFirst.mockResolvedValue(null);

      await expect(
        service.register(7, 'org_1', 'waba_1', 'enterprise'),
      ).rejects.toThrow(NotFoundException);
      expect(mockRazorpay.createCustomer).not.toHaveBeenCalled();
      expect(mockRazorpay.createSubscription).not.toHaveBeenCalled();
    });

    it('refuses to sell a tier that is quoted rather than priced', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      mockPrisma.plan.findFirst.mockResolvedValue(
        tier({ code: 'agency', name: 'Agency', ctaKind: 'contact' }),
      );

      // Opening Checkout on Agency would charge whichever plan happened to be
      // wired up — a price nobody agreed.
      await expect(
        service.register(7, 'org_1', 'waba_1', 'agency'),
      ).rejects.toThrow(BadRequestException);
      expect(mockRazorpay.createSubscription).not.toHaveBeenCalled();
    });

    it('refuses a tier with no Razorpay plan behind it', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      mockPrisma.plan.findFirst.mockResolvedValue(
        tier({ razorpayPlanId: null }),
      );

      await expect(
        service.register(7, 'org_1', 'waba_1', 'growth'),
      ).rejects.toThrow(BadRequestException);
      expect(mockRazorpay.createSubscription).not.toHaveBeenCalled();
    });

    it('names the customer from the user row, not the request context', async () => {
      // The request carries an id and an SSO id only; everything else was
      // copied from SSO at sign-in and lives on the user row.
      mockPrisma.subscription.findUnique.mockResolvedValue(null);

      await service.register(7, 'org_1', 'waba_1');

      expect(mockRazorpay.createCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Suraj Aggarwal',
          email: 'suraj@example.com',
        }),
      );
    });

    it('sends no blank name when SSO gave us none', async () => {
      // Razorpay rejects an empty string where it accepts an absent field.
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({
        email: null,
        firstName: null,
        lastName: null,
      });

      await service.register(7, 'org_1', 'waba_1');

      expect(mockRazorpay.createCustomer).toHaveBeenCalledWith(
        expect.not.objectContaining({ name: expect.anything() }),
      );
    });

    it('fills in the details of a customer created before we had them', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      mockPrisma.subscription.findFirst.mockResolvedValue({
        razorpayCustomerId: 'cust_1',
      });

      await service.register(7, 'org_1', 'waba_2');

      expect(mockRazorpay.updateCustomer).toHaveBeenCalledWith('cust_1', {
        name: 'Suraj Aggarwal',
        email: 'suraj@example.com',
      });
      expect(mockRazorpay.createCustomer).not.toHaveBeenCalled();
    });

    it('carries the account and organisation on the Razorpay record', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);

      await service.register(7, 'org_1', 'waba_1');

      expect(mockRazorpay.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          notes: expect.objectContaining({
            ssoOrgId: 'org_1',
            wabaId: 'waba_1',
          }),
        }),
      );
    });

    it('refuses an account belonging to another organisation', async () => {
      // The id alone would otherwise start a subscription against someone
      // else's account.
      mockPrisma.waba.findFirst.mockResolvedValue(null);

      await expect(service.register(7, 'org_1', 'waba_x')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockRazorpay.createSubscription).not.toHaveBeenCalled();
    });

    it('refuses a second subscription while one is running', async () => {
      // Two mandates on one account means two debits a month.
      mockPrisma.subscription.findUnique.mockResolvedValue(row());

      await expect(service.register(7, 'org_1', 'waba_1')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRazorpay.createSubscription).not.toHaveBeenCalled();
    });

    it('reuses the organisation’s Razorpay customer for a second account', async () => {
      // Three accounts on one payment history, not three customers.
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      mockPrisma.subscription.findFirst.mockResolvedValue({
        razorpayCustomerId: 'cust_1',
      });

      await service.register(7, 'org_1', 'waba_2');

      expect(mockRazorpay.createCustomer).not.toHaveBeenCalled();
      expect(mockRazorpay.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: 'cust_1' }),
      );
    });

    it('lets an account subscribe again after its last one ended', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ status: 'cancelled', currentEnd: past() }),
      );

      await expect(service.register(7, 'org_1', 'waba_1')).resolves.toEqual(
        expect.objectContaining({ authorisationUrl: 'https://rzp.io/i/abc' }),
      );
      // The Razorpay customer is reused, so their payment history stays in one place.
      expect(mockRazorpay.createCustomer).not.toHaveBeenCalled();
    });

    it('refuses when the deployment has no payment provider', async () => {
      mockRazorpay.isConfigured.mockReturnValue(false);
      await expect(service.register(7, 'org_1', 'waba_1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('confirm — what Checkout hands back', () => {
    const payload = {
      razorpayPaymentId: 'pay_1',
      razorpaySubscriptionId: 'sub_1',
      razorpaySignature: 'deadbeef',
    };

    beforeEach(() => {
      mockPrisma.waba.findFirst.mockResolvedValue({
        wabaId: 'waba_1',
        name: 'Games',
      });
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ status: 'created', currentEnd: null }),
      );
      mockPrisma.subscription.update.mockResolvedValue(row());
    });

    it('records the mandate from Razorpay rather than from the browser', async () => {
      mockRazorpay.verifyCheckoutSignature.mockReturnValue(true);
      const end = Math.floor((Date.now() + 30 * 24 * HOUR) / 1000);
      mockRazorpay.fetchSubscription.mockResolvedValue({
        id: 'sub_1',
        plan_id: 'plan_1',
        status: 'active',
        current_end: end,
      });

      const state = await service.confirm('org_1', 'waba_1', payload);

      // The payload says a mandate exists; only Razorpay says what it bought.
      expect(mockRazorpay.fetchSubscription).toHaveBeenCalledWith('sub_1');
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'active',
            currentEnd: new Date(end * 1000),
          }),
        }),
      );
      expect(mockAccess.invalidatePayer).toHaveBeenCalledWith('org_1');
      expect(state.active).toBe(true);
    });

    it('still names the tier after the mandate is recorded', async () => {
      // The update that writes Razorpay's state is what confirm() reports
      // back; without the relation on it, a Growth customer was answered with
      // no plan and the console lost the name until the next reload.
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ planRefId: 2, plan: { code: 'growth', name: 'Growth' } }),
      );
      mockRazorpay.verifyCheckoutSignature.mockReturnValue(true);
      mockRazorpay.fetchSubscription.mockResolvedValue({
        id: 'sub_1',
        plan_id: 'plan_growth',
        status: 'active',
        current_end: Math.floor(soon().getTime() / 1000),
      });
      mockPrisma.subscription.update.mockResolvedValue(
        row({ planRefId: 2, plan: { code: 'growth', name: 'Growth' } }),
      );

      const state = await service.confirm('org_1', 'waba_1', {
        razorpayPaymentId: 'pay_1',
        razorpaySubscriptionId: 'sub_1',
        razorpaySignature: 'sig',
      });

      expect(state.planCode).toBe('growth');
      expect(state.planName).toBe('Growth');
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            plan: { select: { code: true, name: true } },
            pendingPlan: { select: { code: true, name: true } },
          },
        }),
      );
    });

    it('refuses an unverified signature', async () => {
      // Otherwise a crafted request would mark a subscription paid.
      mockRazorpay.verifyCheckoutSignature.mockReturnValue(false);

      await expect(service.confirm('org_1', 'waba_1', payload)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRazorpay.fetchSubscription).not.toHaveBeenCalled();
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });

    it('refuses a payment for a different subscription', async () => {
      // A signature valid for someone else's subscription must not pass here.
      mockRazorpay.verifyCheckoutSignature.mockReturnValue(true);

      await expect(
        service.confirm('org_1', 'waba_1', {
          ...payload,
          razorpaySubscriptionId: 'sub_other',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockRazorpay.verifyCheckoutSignature).not.toHaveBeenCalled();
    });

    it('refuses when the account has no subscription at all', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);

      await expect(service.confirm('org_1', 'waba_1', payload)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('provisioning on the payment edge', () => {
    const payload = {
      razorpayPaymentId: 'pay_1',
      razorpaySubscriptionId: 'sub_1',
      razorpaySignature: 'deadbeef',
    };
    const end = Math.floor((Date.now() + 30 * 24 * HOUR) / 1000);

    beforeEach(() => {
      mockPrisma.waba.findFirst.mockResolvedValue({
        wabaId: 'waba_1',
        name: 'Games',
      });
      mockRazorpay.verifyCheckoutSignature.mockReturnValue(true);
      mockRazorpay.fetchSubscription.mockResolvedValue({
        id: 'sub_1',
        plan_id: 'plan_1',
        status: 'active',
        current_end: end,
      });
    });

    it('pulls the account in the first time it is paid for', async () => {
      // Connecting syncs nothing, so this is the moment a connected account
      // becomes a usable one.
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ status: 'created', currentEnd: null }),
      );
      mockPrisma.subscription.update.mockResolvedValue(row());

      await service.confirm('org_1', 'waba_1', payload);

      expect(mockProvisioning.provision).toHaveBeenCalledWith(
        'org_1',
        'waba_1',
      );
    });

    it('does not pull again on a renewal', async () => {
      // The edge is not-granting to granting. A subscription that was already
      // paid stays put — otherwise every monthly charge re-synced everything.
      mockPrisma.subscription.findUnique.mockResolvedValue(row());
      mockPrisma.subscription.update.mockResolvedValue(row());

      await service.confirm('org_1', 'waba_1', payload);

      expect(mockProvisioning.provision).not.toHaveBeenCalled();
    });

    it('does not pull again for a second organisation on an account already filled in', async () => {
      // Numbers and templates belong to the account, so org_2 paying does not
      // mean fetching them a second time.
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ ssoOrgId: 'org_2', status: 'created', currentEnd: null }),
      );
      mockPrisma.subscription.update.mockResolvedValue(
        row({ ssoOrgId: 'org_2' }),
      );
      mockProvisioning.isProvisioned.mockResolvedValue(true);

      await service.confirm('org_2', 'waba_1', payload);

      expect(mockProvisioning.provision).not.toHaveBeenCalled();
    });

    it('still reports the payment when provisioning fails', async () => {
      // Razorpay has taken the money either way; a Meta outage must not turn a
      // successful payment into a failed request.
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ status: 'created', currentEnd: null }),
      );
      mockPrisma.subscription.update.mockResolvedValue(row());
      mockProvisioning.provision.mockRejectedValueOnce(
        new Error('Meta is down'),
      );

      await expect(
        service.confirm('org_1', 'waba_1', payload),
      ).resolves.toMatchObject({
        active: true,
      });
    });
  });

  describe('changePlan', () => {
    beforeEach(() => {
      mockPrisma.waba.findFirst.mockResolvedValue({
        wabaId: 'waba_1',
        name: 'Games',
      });
      mockPrisma.plan.findFirst.mockResolvedValue(tier());
      mockPrisma.subscription.update.mockResolvedValue(
        row({ planRefId: 2, plan: { code: 'growth', name: 'Growth' } }),
      );
      mockRazorpay.changeSubscriptionPlan.mockResolvedValue({
        id: 'sub_1',
        plan_id: 'plan_growth',
        status: 'active',
      });
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);
      mockRazorpay.fetchPlan.mockResolvedValue(PLAN);
    });

    it('moves to a dearer tier immediately', async () => {
      // Starter (₹499) to Growth (₹999): the customer wants the limits now,
      // and the new price is what is next debited.
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ planRefId: 1, planId: 'plan_starter' }),
      );
      mockPrisma.plan.findUnique.mockResolvedValue({ price: 49_900 });

      await service.changePlan('org_1', 'waba_1', 'growth');

      expect(mockRazorpay.changeSubscriptionPlan).toHaveBeenCalledWith(
        'sub_1',
        {
          planId: 'plan_growth',
          atCycleEnd: false,
        },
      );
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            plan: { connect: { id: 2 } },
            pendingPlan: { disconnect: true },
          }),
        }),
      );
      expect(mockAccess.invalidatePayer).toHaveBeenCalledWith('org_1');
    });

    it('holds a cheaper tier until the month already paid for runs out', async () => {
      // Business (₹1,999) down to Growth: taking the limits away now would be
      // taking away what they paid for.
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ planRefId: 3, planId: 'plan_business' }),
      );
      mockPrisma.plan.findUnique.mockResolvedValue({ price: 199_900 });

      const state = await service.changePlan('org_1', 'waba_1', 'growth');

      expect(mockRazorpay.changeSubscriptionPlan).toHaveBeenCalledWith(
        'sub_1',
        {
          planId: 'plan_growth',
          atCycleEnd: true,
        },
      );
      const [call] = mockPrisma.subscription.update.mock.calls.slice(-1);
      expect(call[0].data).toEqual({
        pendingPlan: { connect: { id: 2 } },
        pendingPlanAt: expect.any(Date),
      });
      // The tier it is on is untouched — only what happens next changes.
      expect(call[0].data.plan).toBeUndefined();
      expect(state).toBeDefined();
    });

    it('waits for the renewal when the current price cannot be read', async () => {
      // An older subscription on a plan no tier claims, or Razorpay
      // unreachable. Shortening a paid month on a guess is the worse mistake.
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ planRefId: null, planId: 'plan_legacy' }),
      );
      mockRazorpay.fetchPlan.mockResolvedValue(null);

      await service.changePlan('org_1', 'waba_1', 'growth');

      expect(mockRazorpay.changeSubscriptionPlan).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({ atCycleEnd: true }),
      );
    });

    it('refuses a tier the account is already on', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ planRefId: 2 }),
      );

      await expect(
        service.changePlan('org_1', 'waba_1', 'growth'),
      ).rejects.toThrow(/already on Growth/);
      expect(mockRazorpay.changeSubscriptionPlan).not.toHaveBeenCalled();
    });

    it('refuses a quoted tier without touching Razorpay', async () => {
      mockPrisma.plan.findFirst.mockResolvedValue(
        tier({ code: 'agency', name: 'Agency', ctaKind: 'contact' }),
      );
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ planRefId: 1 }),
      );

      await expect(
        service.changePlan('org_1', 'waba_1', 'agency'),
      ).rejects.toThrow(/priced individually/);
      expect(mockRazorpay.changeSubscriptionPlan).not.toHaveBeenCalled();
    });

    it('refuses a subscription whose mandate was never authorised', async () => {
      // There is nothing to re-point: finishing that authorisation would
      // charge the tier it was created on.
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ status: 'created', planRefId: 1 }),
      );

      await expect(
        service.changePlan('org_1', 'waba_1', 'growth'),
      ).rejects.toThrow(/has not been authorised/);
      expect(mockRazorpay.changeSubscriptionPlan).not.toHaveBeenCalled();
    });

    it('refuses one that is already ending', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ cancelAtCycleEnd: true, planRefId: 1 }),
      );

      await expect(
        service.changePlan('org_1', 'waba_1', 'growth'),
      ).rejects.toThrow(/set to end/);
    });

    it('refuses when there is no subscription at all', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);

      await expect(
        service.changePlan('org_1', 'waba_1', 'growth'),
      ).rejects.toThrow(NotFoundException);
    });

    it('writes nothing when Razorpay refuses the change', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ planRefId: 1, planId: 'plan_starter' }),
      );
      mockPrisma.plan.findUnique.mockResolvedValue({ price: 49_900 });
      mockPrisma.subscription.update.mockClear();
      mockRazorpay.changeSubscriptionPlan.mockRejectedValue(
        new BadRequestException('mandate will not cover it'),
      );

      await expect(
        service.changePlan('org_1', 'waba_1', 'growth'),
      ).rejects.toThrow(/mandate will not cover it/);
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    beforeEach(() => {
      mockPrisma.waba.findFirst.mockResolvedValue({
        wabaId: 'waba_1',
        name: 'Games',
      });
    });

    it('stops at the end of the month already paid for', async () => {
      const current = row();
      mockPrisma.subscription.findUnique.mockResolvedValue(current);
      mockRazorpay.cancelSubscription.mockResolvedValue({
        id: 'sub_1',
        status: 'active',
      });
      mockPrisma.subscription.update.mockResolvedValue({});

      await service.cancel('org_1', 'waba_1');

      expect(mockRazorpay.cancelSubscription).toHaveBeenCalledWith(
        'sub_1',
        true,
      );
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ cancelAtCycleEnd: true }),
        }),
      );
      expect(mockMail.subscriptionCancelled).toHaveBeenCalledWith(
        7,
        'org_1',
        'Games',
        current.currentEnd,
      );
      expect(mockAccess.invalidatePayer).toHaveBeenCalledWith('org_1');
    });

    it('stops immediately when nothing has been paid for yet', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ status: 'created', currentEnd: null }),
      );
      mockRazorpay.cancelSubscription.mockResolvedValue({
        id: 'sub_1',
        status: 'cancelled',
      });
      mockPrisma.subscription.update.mockResolvedValue({});

      await service.cancel('org_1', 'waba_1');

      expect(mockRazorpay.cancelSubscription).toHaveBeenCalledWith(
        'sub_1',
        false,
      );
    });

    it('refuses to cancel twice', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ cancelAtCycleEnd: true }),
      );
      await expect(service.cancel('org_1', 'waba_1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses when there is nothing to cancel', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      await expect(service.cancel('org_1', 'waba_1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('what the console is told about the money', () => {
    beforeEach(() => {
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'waba_1', name: 'Games' },
      ]);
      mockPrisma.subscription.findMany.mockResolvedValue([row()]);
    });

    it('reports the price, so the page can say what it costs', async () => {
      const [state] = await service.listStates('org_1');

      expect(state.plan).toEqual({
        planId: 'plan_1',
        name: 'WA Console monthly',
        amount: 49900,
        currency: 'INR',
        period: 'monthly',
        interval: 1,
      });
    });

    it('shows a state without a price rather than failing the page', async () => {
      // A plan the console cannot read is not a reason to answer 500 to a
      // question it can otherwise answer.
      mockRazorpay.fetchPlan.mockResolvedValue(null);

      const [state] = await service.listStates('org_1');

      expect(state.plan).toBeNull();
      expect(state.active).toBe(true);
    });

    it('reports what was taken and how', async () => {
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([
        {
          subscriptionId: 1,
          razorpayPaymentId: 'pay_2',
          razorpayInvoiceId: 'inv_2',
          amount: 49900,
          currency: 'INR',
          status: 'captured',
          method: 'card',
          methodDetail: 'Visa ···· 4242',
          paidAt: new Date('2026-08-02T00:00:00Z'),
        },
        {
          subscriptionId: 1,
          razorpayPaymentId: 'pay_1',
          razorpayInvoiceId: 'inv_1',
          amount: 49900,
          currency: 'INR',
          status: 'captured',
          method: 'card',
          methodDetail: 'Visa ···· 4242',
          paidAt: new Date('2026-07-02T00:00:00Z'),
        },
      ]);

      const [state] = await service.listStates('org_1');

      expect(state.payments).toHaveLength(2);
      expect(state.lastPayment?.razorpayPaymentId).toBe('pay_2');
      expect(state.lastPayment?.methodDetail).toBe('Visa ···· 4242');
      expect(state.paidCount).toBe(2);
    });

    it('names a next charge only when one is actually coming', async () => {
      const [active] = await service.listStates('org_1');
      expect(active.nextChargeAt).toEqual(active.currentEnd);

      // Cancelled: the paid month runs out and then nothing happens, so a date
      // here would be a promise to debit that is never kept.
      mockPrisma.subscription.findMany.mockResolvedValue([
        row({ cancelAtCycleEnd: true }),
      ]);
      const [cancelled] = await service.listStates('org_1');
      expect(cancelled.nextChargeAt).toBeNull();
      expect(cancelled.active).toBe(true);
    });

    it('keeps each account`s debits to its own subscription', async () => {
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'waba_1', name: 'Games' },
        { wabaId: 'waba_2', name: 'Support' },
      ]);
      mockPrisma.subscription.findMany.mockResolvedValue([
        row(),
        row({ id: 2, wabaId: 'waba_2' }),
      ]);
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([
        {
          subscriptionId: 2,
          razorpayPaymentId: 'pay_b',
          amount: 49900,
          currency: 'INR',
          status: 'captured',
          method: 'upi',
          methodDetail: 'suraj@upi',
          razorpayInvoiceId: null,
          paidAt: new Date(),
        },
        {
          subscriptionId: 1,
          razorpayPaymentId: 'pay_a',
          amount: 49900,
          currency: 'INR',
          status: 'captured',
          method: 'card',
          methodDetail: 'Visa ···· 4242',
          razorpayInvoiceId: null,
          paidAt: new Date(),
        },
      ]);

      const [games, support] = await service.listStates('org_1');

      expect(games.lastPayment?.razorpayPaymentId).toBe('pay_a');
      expect(support.lastPayment?.razorpayPaymentId).toBe('pay_b');
    });
  });

  describe('recording a charge', () => {
    const charged = (payment: Record<string, unknown>) => ({
      event: 'subscription.charged',
      payload: {
        subscription: {
          entity: { id: 'sub_1', plan_id: 'plan_1', status: 'active' },
        },
        payment: { entity: payment },
      },
    });

    beforeEach(() => {
      mockPrisma.subscription.findUnique.mockResolvedValue(row());
      mockPrisma.subscription.update.mockResolvedValue(row());
    });

    describe('overage', () => {
      const chargedNoPayment = () => ({
        event: 'subscription.charged',
        payload: {
          subscription: {
            entity: { id: 'sub_1', plan_id: 'plan_growth', status: 'active' },
          },
        },
      });

      /** `groupBy` shape: one row per account, with its registered count. */
      const numbersOn = (counts: Record<string, number>) =>
        Object.entries(counts).map(([wabaId, n]) => ({
          wabaId,
          _count: { _all: n },
        }));

      beforeEach(() => {
        mockPrisma.subscription.findUnique.mockResolvedValue(
          row({ planRefId: 2, wabaId: 'waba_1' }),
        );
        mockPrisma.plan.findUnique.mockResolvedValue({
          additionalNumberPrice: 19900,
          additionalWabaPrice: 29900,
          includedWabas: 3,
          includedPhoneNumbersPerWaba: 1,
          currency: 'INR',
          name: 'Growth',
        });
        mockPrisma.wabaPhoneNumber.groupBy.mockResolvedValue([]);
        mockPrisma.wabaOrganisation.findMany.mockResolvedValue([]);
        mockRazorpay.addSubscriptionAddon.mockResolvedValue({ id: 'ao_1' });
      });

      it('bills every number past what the plan includes, on the next invoice', async () => {
        mockPrisma.wabaPhoneNumber.groupBy.mockResolvedValue(
          numbersOn({ waba_1: 3 }),
        );

        await service.handleWebhook('evt_extra', chargedNoPayment() as never);

        expect(mockRazorpay.addSubscriptionAddon).toHaveBeenCalledWith(
          'sub_1',
          {
            name: 'Additional phone numbers',
            amount: 19900,
            currency: 'INR',
            // Three registered, one included by the plan.
            quantity: 2,
          },
        );
      });

      it('takes the included count from the plan, not a constant', async () => {
        // The bug this replaces: `registered - 1` was hardcoded, so a Growth
        // account including three numbers was billed for two it already had.
        mockPrisma.plan.findUnique.mockResolvedValue({
          additionalNumberPrice: 19900,
          additionalWabaPrice: null,
          includedWabas: null,
          includedPhoneNumbersPerWaba: 3,
          currency: 'INR',
          name: 'Legacy',
        });
        mockPrisma.wabaPhoneNumber.groupBy.mockResolvedValue(
          numbersOn({ waba_1: 3 }),
        );

        await service.handleWebhook('evt_inc', chargedNoPayment() as never);

        expect(mockRazorpay.addSubscriptionAddon).not.toHaveBeenCalled();
      });

      it('counts numbers per account, so one account’s spare does not cover another', async () => {
        // Two accounts, one number each: both are included, nothing is owed.
        // Summing to two and subtracting one allowance would have billed one.
        mockPrisma.subscription.findUnique.mockResolvedValue(
          row({ planRefId: 2, wabaId: null }),
        );
        mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
          { wabaId: 'waba_1' },
          { wabaId: 'waba_2' },
        ]);
        mockPrisma.wabaPhoneNumber.groupBy.mockResolvedValue(
          numbersOn({ waba_1: 1, waba_2: 1 }),
        );

        await service.handleWebhook('evt_per', chargedNoPayment() as never);

        expect(mockRazorpay.addSubscriptionAddon).not.toHaveBeenCalled();
      });

      it('bills accounts past what the plan includes', async () => {
        mockPrisma.subscription.findUnique.mockResolvedValue(
          row({ planRefId: 2, wabaId: null }),
        );
        mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
          { wabaId: 'w1' },
          { wabaId: 'w2' },
          { wabaId: 'w3' },
          { wabaId: 'w4' },
          { wabaId: 'w5' },
        ]);

        await service.handleWebhook('evt_wabas', chargedNoPayment() as never);

        expect(mockRazorpay.addSubscriptionAddon).toHaveBeenCalledWith(
          'sub_1',
          {
            name: 'Additional WhatsApp Business Accounts',
            amount: 29900,
            currency: 'INR',
            // Five connected, three included.
            quantity: 2,
          },
        );
      });

      it('counts overage across every organisation the subscription answers for', async () => {
        // An agency pays once and its clients inherit, so their accounts are
        // part of what the invoice covers.
        mockPrisma.subscription.findUnique.mockResolvedValue(
          row({ planRefId: 2, wabaId: null, ssoOrgId: 'agency_1' }),
        );
        mockOrgSettings.billingScope.mockResolvedValue([
          'agency_1',
          'client_1',
          'client_2',
        ]);
        mockPrisma.wabaOrganisation.findMany.mockResolvedValue([]);

        await service.handleWebhook('evt_scope', chargedNoPayment() as never);

        const { where } = mockPrisma.wabaOrganisation.findMany.mock
          .calls[0][0] as { where: { ssoOrgId: { in: string[] } } };
        expect(where.ssoOrgId.in).toEqual(['agency_1', 'client_1', 'client_2']);
      });

      it('bills an organisation-level subscription, which names no account', async () => {
        // The guard this replaces returned early on a null `wabaId`, so an
        // organisation-level subscription silently stopped billing overage.
        mockPrisma.subscription.findUnique.mockResolvedValue(
          row({ planRefId: 2, wabaId: null }),
        );
        mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
          { wabaId: 'waba_1' },
        ]);
        mockPrisma.wabaPhoneNumber.groupBy.mockResolvedValue(
          numbersOn({ waba_1: 4 }),
        );

        await service.handleWebhook('evt_org', chargedNoPayment() as never);

        expect(mockRazorpay.addSubscriptionAddon).toHaveBeenCalledWith(
          'sub_1',
          expect.objectContaining({
            name: 'Additional phone numbers',
            quantity: 3,
          }),
        );
      });

      it('charges nothing when the account runs the one number it includes', async () => {
        mockPrisma.wabaPhoneNumber.groupBy.mockResolvedValue(
          numbersOn({ waba_1: 1 }),
        );

        await service.handleWebhook('evt_extra_1', chargedNoPayment() as never);

        expect(mockRazorpay.addSubscriptionAddon).not.toHaveBeenCalled();
      });

      it('charges nothing on a plan that prices no extras', async () => {
        mockPrisma.plan.findUnique.mockResolvedValue({
          additionalNumberPrice: null,
          additionalWabaPrice: null,
          includedWabas: null,
          includedPhoneNumbersPerWaba: 1,
          currency: 'INR',
          name: 'Agency',
        });
        mockPrisma.wabaPhoneNumber.groupBy.mockResolvedValue(
          numbersOn({ waba_1: 4 }),
        );

        await service.handleWebhook('evt_extra_2', chargedNoPayment() as never);

        expect(mockRazorpay.addSubscriptionAddon).not.toHaveBeenCalled();
      });

      it('counts only numbers live on the Cloud API', async () => {
        mockPrisma.wabaPhoneNumber.groupBy.mockResolvedValue(
          numbersOn({ waba_1: 2 }),
        );

        await service.handleWebhook('evt_extra_3', chargedNoPayment() as never);

        const arg = mockPrisma.wabaPhoneNumber.groupBy.mock.calls[0][0] as {
          where: { platformType: string };
        };
        expect(arg.where.platformType).toBe('CLOUD_API');
      });

      it('records the payment even when the extra charge cannot be raised', async () => {
        mockPrisma.wabaPhoneNumber.groupBy.mockRejectedValue(
          new Error('db down'),
        );

        // The webhook's real job is the payment that already happened; failing
        // it would have Razorpay retry a charge we have recorded.
        await expect(
          service.handleWebhook('evt_extra_4', chargedNoPayment() as never),
        ).resolves.toBeUndefined();
      });

      it('leaves a subscription sold before the price list alone', async () => {
        mockPrisma.subscription.findUnique.mockResolvedValue(
          row({ planRefId: null, wabaId: 'waba_1' }),
        );

        await service.handleWebhook('evt_extra_5', chargedNoPayment() as never);

        expect(mockRazorpay.addSubscriptionAddon).not.toHaveBeenCalled();
      });
    });

    it('stores the amount and the instrument, keyed on the payment id', async () => {
      await service.handleWebhook(
        'evt_pay',
        charged({
          id: 'pay_9',
          invoice_id: 'inv_9',
          amount: 49900,
          currency: 'INR',
          status: 'captured',
          method: 'card',
          card: { network: 'Visa', last4: '4242' },
          created_at: 1785000000,
        }) as never,
      );

      expect(mockPrisma.subscriptionPayment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { razorpayPaymentId: 'pay_9' },
          create: expect.objectContaining({
            subscriptionId: 1,
            amount: 49900,
            method: 'card',
            methodDetail: 'Visa ···· 4242',
          }),
        }),
      );
    });

    it('describes a UPI debit by its handle', async () => {
      await service.handleWebhook(
        'evt_upi',
        charged({
          id: 'pay_10',
          amount: 49900,
          currency: 'INR',
          status: 'captured',
          method: 'upi',
          vpa: 'suraj@okhdfcbank',
        }) as never,
      );

      const written = mockPrisma.subscriptionPayment.upsert.mock.calls[0][0];
      expect(written.create.methodDetail).toBe('suraj@okhdfcbank');
    });

    it('records nothing for an event with no payment half', async () => {
      await service.handleWebhook('evt_auth', {
        event: 'subscription.authenticated',
        payload: {
          subscription: { entity: { id: 'sub_1', status: 'authenticated' } },
        },
      } as never);

      expect(mockPrisma.subscriptionPayment.upsert).not.toHaveBeenCalled();
    });

    it('applies the subscription even when the payment cannot be stored', async () => {
      // Billing history is worth having, not worth failing a webhook over:
      // Razorpay would retry the whole delivery and re-apply the state.
      mockPrisma.subscriptionPayment.upsert.mockRejectedValueOnce(
        new Error('db down'),
      );

      await expect(
        service.handleWebhook(
          'evt_bad',
          charged({
            id: 'pay_11',
            amount: 49900,
            currency: 'INR',
            status: 'captured',
          }) as never,
        ),
      ).resolves.toBeUndefined();
      expect(mockPrisma.subscription.update).toHaveBeenCalled();
    });
  });

  describe('handleWebhook', () => {
    it('moves the paid-until date on a successful charge', async () => {
      const end = Math.floor((Date.now() + 30 * 24 * HOUR) / 1000);
      mockPrisma.subscriptionEvent.create.mockResolvedValue({});
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ currentEnd: past() }),
      );
      mockPrisma.subscription.update.mockResolvedValue({});

      await service.handleWebhook(
        'evt_1',
        hook('subscription.charged', {
          current_end: end,
          current_start: end - 2592000,
        }),
      );

      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'active',
            currentEnd: new Date(end * 1000),
          }),
        }),
      );
      expect(mockAccess.invalidatePayer).toHaveBeenCalledWith('org_1');
      expect(mockMail.subscriptionCharged).toHaveBeenCalled();
    });

    it('ignores a repeat delivery of the same event', async () => {
      // Razorpay retries; a replayed charge must not extend the month twice.
      const duplicate = Object.assign(new Error('dup'), { code: 'P2002' });
      Object.setPrototypeOf(
        duplicate,

        require('@prisma/client').Prisma.PrismaClientKnownRequestError
          .prototype,
      );
      mockPrisma.subscriptionEvent.create.mockRejectedValue(duplicate);

      await service.handleWebhook('evt_1', hook('subscription.charged'));

      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });

    it('never shortens a paid month when events arrive out of order', async () => {
      const paidUntil = soon();
      mockPrisma.subscriptionEvent.create.mockResolvedValue({});
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ currentEnd: paidUntil }),
      );
      mockPrisma.subscription.update.mockResolvedValue({});

      // An `authenticated` delivered late carries an earlier period.
      await service.handleWebhook(
        'evt_2',
        hook('subscription.authenticated', {
          status: 'authenticated',
          current_end: Math.floor((Date.now() + HOUR) / 1000),
        }),
      );

      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ currentEnd: paidUntil }),
        }),
      );
    });

    it('emails once retries are exhausted', async () => {
      mockPrisma.subscriptionEvent.create.mockResolvedValue({});
      mockPrisma.subscription.findUnique.mockResolvedValue(row());
      mockPrisma.subscription.update.mockResolvedValue({});

      await service.handleWebhook(
        'evt_3',
        hook('subscription.halted', { status: 'halted' }),
      );

      expect(mockMail.subscriptionPaymentFailed).toHaveBeenCalledWith(
        7,
        'org_1',
        expect.any(String),
        true,
        expect.anything(),
      );
    });

    it('records an event for a subscription it does not know', async () => {
      mockPrisma.subscriptionEvent.create.mockResolvedValue({});
      mockPrisma.subscription.findUnique.mockResolvedValue(null);

      await service.handleWebhook('evt_4', hook('subscription.charged'));

      expect(mockPrisma.subscriptionEvent.create).toHaveBeenCalled();
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });
  });

  describe('listStates', () => {
    it('lists every connected account, subscribed or not', async () => {
      // An account missing from the list would read as disconnected rather
      // than unpaid, which is the opposite of what it means.
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'waba_1', name: 'Games' },
        { wabaId: 'waba_2', name: 'Support' },
      ]);
      mockPrisma.subscription.findMany.mockResolvedValue([row()]);

      const states = await service.listStates('org_1');

      expect(states).toHaveLength(2);
      expect(states[0]).toEqual(
        expect.objectContaining({
          wabaId: 'waba_1',
          wabaName: 'Games',
          active: true,
        }),
      );
      expect(states[1]).toEqual(
        expect.objectContaining({
          wabaId: 'waba_2',
          active: false,
          status: null,
        }),
      );
    });

    it('prices each account from its own tier, not one price for the org', async () => {
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'waba_1', name: 'Games' },
        { wabaId: 'waba_2', name: 'Support' },
      ]);
      mockPrisma.subscription.findMany.mockResolvedValue([
        row({
          planId: 'plan_starter',
          plan: { code: 'starter', name: 'Starter' },
        }),
        {
          ...row({
            planId: 'plan_growth',
            plan: { code: 'growth', name: 'Growth' },
          }),
          id: 2,
          wabaId: 'waba_2',
          razorpaySubscriptionId: 'sub_2',
        },
      ]);
      mockRazorpay.fetchPlan.mockImplementation((id: string) =>
        Promise.resolve(
          id === 'plan_growth'
            ? { ...PLAN, id, item: { ...PLAN.item, amount: 99900 } }
            : { ...PLAN, id },
        ),
      );

      const states = await service.listStates('org_1');

      // A Growth customer shown the Starter price is the whole reason this is
      // read per subscription.
      expect(states[0].plan?.amount).toBe(49900);
      expect(states[0].planCode).toBe('starter');
      expect(states[1].plan?.amount).toBe(99900);
      expect(states[1].planName).toBe('Growth');
    });

    it('asks Razorpay once per tier, however many accounts are on it', async () => {
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'waba_1', name: 'Games' },
        { wabaId: 'waba_2', name: 'Support' },
      ]);
      mockPrisma.subscription.findMany.mockResolvedValue([
        row({ planId: 'plan_growth' }),
        { ...row({ planId: 'plan_growth' }), id: 2, wabaId: 'waba_2' },
      ]);
      mockRazorpay.fetchPlan.mockResolvedValue(PLAN);

      await service.listStates('org_1');

      expect(mockRazorpay.fetchPlan).toHaveBeenCalledTimes(1);
    });

    it('quotes no price for an account nobody has chosen a plan for', async () => {
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'waba_2', name: 'Support' },
      ]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      const [state] = await service.listStates('org_1');

      // What it would cost depends on a tier nobody has picked; the console
      // sends the reader to the price list instead of guessing one.
      expect(state.plan).toBeNull();
      expect(state.planCode).toBeNull();
      expect(mockRazorpay.fetchPlan).not.toHaveBeenCalled();
    });

    it('offers the authorisation page only while nothing is charged', async () => {
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'waba_1', name: 'Games' },
      ]);
      mockPrisma.subscription.findMany.mockResolvedValue([
        row({
          status: 'created',
          currentEnd: null,
          shortUrl: 'https://rzp.io/i/abc',
        }),
      ]);

      const [state] = await service.listStates('org_1');

      expect(state.subscriptionId).toBe('sub_1');
      expect(state.keyId).toBe('rzp_test_key');
      expect(state.authorisationUrl).toBe('https://rzp.io/i/abc');
      expect(state.active).toBe(false);
    });

    it('offers nothing to authorise once the mandate exists', async () => {
      // Checkout has nothing left to do, and the hosted page is retired.
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'waba_1', name: 'Games' },
      ]);
      mockPrisma.subscription.findMany.mockResolvedValue([row()]);

      const [state] = await service.listStates('org_1');

      expect(state.subscriptionId).toBeNull();
      expect(state.keyId).toBeNull();
      expect(state.authorisationUrl).toBeNull();
    });
  });

  describe('reconcile', () => {
    it('re-reads subscriptions whose paid month has run out', async () => {
      // A missed `charged` webhook looks exactly like a lapsed customer.
      mockPrisma.subscription.findMany.mockResolvedValue([
        row({ currentEnd: past() }),
      ]);
      const end = Math.floor((Date.now() + 30 * 24 * HOUR) / 1000);
      mockRazorpay.fetchSubscription.mockResolvedValue({
        id: 'sub_1',
        plan_id: 'plan_1',
        status: 'active',
        current_end: end,
      });
      mockPrisma.subscription.update.mockResolvedValue({});

      await service.reconcile();

      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ currentEnd: new Date(end * 1000) }),
        }),
      );
      expect(mockAccess.invalidatePayer).toHaveBeenCalledWith('org_1');
    });

    it('carries on after one subscription fails to fetch', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([
        row({ id: 1, razorpaySubscriptionId: 'sub_bad' }),
        row({ id: 2, razorpaySubscriptionId: 'sub_ok', wabaId: 'waba_2' }),
      ]);
      mockRazorpay.fetchSubscription
        .mockRejectedValueOnce(new Error('gateway down'))
        .mockResolvedValueOnce({
          id: 'sub_ok',
          plan_id: 'plan_1',
          status: 'active',
        });
      mockPrisma.subscription.update.mockResolvedValue({});

      await service.reconcile();

      expect(mockPrisma.subscription.update).toHaveBeenCalledTimes(1);
    });

    it('does nothing without a payment provider', async () => {
      mockRazorpay.isConfigured.mockReturnValue(false);
      await service.reconcile();
      expect(mockPrisma.subscription.findMany).not.toHaveBeenCalled();
    });
  });
});
