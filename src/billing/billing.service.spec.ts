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
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { OrgService } from 'src/org/org.service';
import { AgencyBillingService } from './agency-billing.service';
import { firstArg } from 'src/common/utils/mock-args';

const mockPrisma = {
  subscription: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
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
  webhookEndpoint: { groupBy: jest.fn() },
  userApiKey: { groupBy: jest.fn() },
  contact: { count: jest.fn() },
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
  get: jest.fn(),
  clientsOf: jest.fn(),
};

const mockOrg = { listMembers: jest.fn(), listInvitations: jest.fn() };

/** An agency's mandate covers several clients; the group path handles those. */
const mockAgencyBilling = { applyToGroup: jest.fn() };

const mockPlanLimits = { forOrg: jest.fn() };

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
    mockPrisma.waba.findMany.mockResolvedValue([]);
    mockPrisma.wabaPhoneNumber.groupBy.mockResolvedValue([]);
    mockPrisma.webhookEndpoint.groupBy.mockResolvedValue([]);
    mockPrisma.userApiKey.groupBy.mockResolvedValue([]);
    mockPrisma.contact.count.mockResolvedValue(0);
    // The tier an organisation holds, for the console's "3 of 1 accounts"
    // line. Overridden where a test is about the numbers themselves.
    mockPlanLimits.forOrg.mockResolvedValue({
      planName: 'Growth',
      includedWabas: 3,
      includedPhoneNumbersPerWaba: 1,
      additionalWabaPrice: 29_900,
      additionalNumberPrice: 19_900,
    });
    // Nobody is an agency client unless a test says so, and the billing scope
    // of an ordinary organisation is itself.
    mockOrgSettings.billingOrgFor.mockImplementation((id: string) =>
      Promise.resolve(id),
    );
    mockOrgSettings.billingScope.mockImplementation((id: string) =>
      Promise.resolve([id]),
    );
    mockOrgSettings.get.mockImplementation((id: string) =>
      Promise.resolve({ ssoOrgId: id, isAgency: false, agencyOrgId: null }),
    );
    mockOrgSettings.clientsOf.mockResolvedValue([]);
    mockOrg.listMembers.mockResolvedValue([]);
    mockOrg.listInvitations.mockResolvedValue([]);
    mockAgencyBilling.applyToGroup.mockResolvedValue(false);
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
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        { provide: OrgService, useValue: mockOrg },
        { provide: AgencyBillingService, useValue: mockAgencyBilling },
      ],
    }).compile();
    service = module.get<BillingService>(BillingService);
  });

  describe('register', () => {
    beforeEach(() => {
      mockRazorpay.createCustomer.mockResolvedValue({ id: 'cust_1' });
      mockRazorpay.createSubscription.mockResolvedValue({
        id: 'sub_new',
        plan_id: 'plan_growth',
        status: 'created',
        short_url: 'https://rzp.io/i/abc',
      });
      mockPrisma.plan.findFirst.mockResolvedValue(tier());
      mockPrisma.subscription.create.mockResolvedValue({});
      mockPrisma.subscription.update.mockResolvedValue({});
      // No subscription and no earlier customer, unless a test says otherwise.
      mockPrisma.subscription.findFirst.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({
        email: 'suraj@example.com',
        firstName: 'Suraj',
        lastName: 'Aggarwal',
      });
    });

    it('returns the authorisation page and stores the subscription', async () => {
      const result = await service.register(7, 'org_1', 'growth');

      // Checkout opens against the subscription; the hosted page is a fallback.
      expect(result.subscriptionId).toBe('sub_new');
      expect(result.keyId).toBe('rzp_test_key');
      expect(result.authorisationUrl).toBe('https://rzp.io/i/abc');
      expect(mockPrisma.subscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ssoOrgId: 'org_1',
            razorpaySubscriptionId: 'sub_new',
            status: 'created',
            createdByUserId: 7,
          }),
        }),
      );
      expect(mockAccess.invalidatePayer).toHaveBeenCalledWith('org_1');
    });

    it('writes the row against the organisation, not against an account', async () => {
      // `wabaId: null` is what makes a row the organisation's, and what the
      // partial unique index in the database keys on. One subscription covers
      // every account they have.
      await service.register(7, 'org_1', 'growth');

      expect(mockPrisma.subscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ wabaId: null }),
        }),
      );
    });

    it('sells the chosen tier: its Razorpay plan, and the row says which', async () => {
      const result = await service.register(7, 'org_1', 'growth');

      expect(mockRazorpay.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          planId: 'plan_growth',
          // The tier travels to Razorpay too, so a payment in their dashboard
          // can be read back to a plan without our database.
          notes: expect.objectContaining({ planCode: 'growth' }),
        }),
      );
      expect(mockPrisma.subscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            planId: 'plan_growth',
            planRefId: 2,
          }),
        }),
      );
      expect(result.planCode).toBe('growth');
    });

    it('scopes the tier lookup to the buyer, so a private plan stays private', async () => {
      // A negotiated rate lives in the same table as the price list. Knowing
      // its code must not be enough to buy it.
      await service.register(7, 'org_1', 'growth');

      const { where } = firstArg<{
        where: { OR: unknown[] };
      }>(mockPrisma.plan.findFirst);
      expect(where.OR).toEqual([{ ssoOrgId: null }, { ssoOrgId: 'org_1' }]);
    });

    it('refuses a tier that is not on offer, before creating anything', async () => {
      mockPrisma.plan.findFirst.mockResolvedValue(null);

      await expect(service.register(7, 'org_1', 'enterprise')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockRazorpay.createCustomer).not.toHaveBeenCalled();
      expect(mockRazorpay.createSubscription).not.toHaveBeenCalled();
    });

    it('refuses to sell a tier that is quoted rather than priced', async () => {
      mockPrisma.plan.findFirst.mockResolvedValue(
        tier({ code: 'agency', name: 'Agency', ctaKind: 'contact' }),
      );

      // Opening Checkout on the public Agency card would charge whichever plan
      // happened to be wired up — a price nobody agreed. A signed deal is a
      // row of its own, scoped to the organisation and marked `subscribe`.
      await expect(service.register(7, 'org_1', 'agency')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRazorpay.createSubscription).not.toHaveBeenCalled();
    });

    it('refuses a tier with no Razorpay plan behind it', async () => {
      mockPrisma.plan.findFirst.mockResolvedValue(
        tier({ razorpayPlanId: null }),
      );

      await expect(service.register(7, 'org_1', 'growth')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRazorpay.createSubscription).not.toHaveBeenCalled();
    });

    it('refuses a client that is billed through its agency', async () => {
      // It already has the entitlement. Selling it one of its own would charge
      // twice for the same thing, and stop its usage counting against the deal
      // the agency signed.
      mockOrgSettings.billingOrgFor.mockResolvedValue('org_agency');

      await expect(service.register(7, 'org_1', 'growth')).rejects.toThrow(
        /billed through its agency/,
      );
      expect(mockRazorpay.createSubscription).not.toHaveBeenCalled();
    });

    it('names the customer from the user row, not the request context', async () => {
      // The request carries an id and an SSO id only; everything else was
      // copied from SSO at sign-in and lives on the user row.
      await service.register(7, 'org_1', 'growth');

      expect(mockRazorpay.createCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Suraj Aggarwal',
          email: 'suraj@example.com',
        }),
      );
    });

    it('sends no blank name when SSO gave us none', async () => {
      // Razorpay rejects an empty string where it accepts an absent field.
      mockPrisma.user.findUnique.mockResolvedValue({
        email: null,
        firstName: null,
        lastName: null,
      });

      await service.register(7, 'org_1', 'growth');

      expect(mockRazorpay.createCustomer).toHaveBeenCalledWith(
        expect.not.objectContaining({ name: expect.anything() }),
      );
    });

    it('fills in the details of a customer created before we had them', async () => {
      // The first subscription is the organisation's; a later one reuses the
      // customer, which may predate our having a name to give it.
      mockPrisma.subscription.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ razorpayCustomerId: 'cust_1' });

      await service.register(7, 'org_1', 'growth');

      expect(mockRazorpay.updateCustomer).toHaveBeenCalledWith('cust_1', {
        name: 'Suraj Aggarwal',
        email: 'suraj@example.com',
      });
      expect(mockRazorpay.createCustomer).not.toHaveBeenCalled();
    });

    it('carries the organisation on the Razorpay record', async () => {
      // So a payment in their dashboard can be traced back even if our row
      // were lost.
      await service.register(7, 'org_1', 'growth');

      expect(mockRazorpay.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          notes: expect.objectContaining({ ssoOrgId: 'org_1' }),
        }),
      );
    });

    it('refuses a second subscription while one is running', async () => {
      // Two mandates on one organisation means two debits a month.
      mockPrisma.subscription.findFirst.mockResolvedValue(row());

      await expect(service.register(7, 'org_1', 'growth')).rejects.toThrow(
        /already has a subscription/,
      );
      expect(mockRazorpay.createSubscription).not.toHaveBeenCalled();
    });

    it('refuses to replace one that is already set to end', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ cancelAtCycleEnd: true }),
      );

      await expect(service.register(7, 'org_1', 'growth')).rejects.toThrow(
        /close of the paid month/,
      );
    });

    it('reuses the row rather than leaving the old one behind', async () => {
      // An organisation has one subscription row. Creating a second would give
      // the partial unique index something to reject, and `find` two answers.
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ status: 'cancelled', currentEnd: past() }),
      );

      await service.register(7, 'org_1', 'growth');

      expect(mockPrisma.subscription.create).not.toHaveBeenCalled();
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 1 } }),
      );
    });

    it('lets an organisation subscribe again after its last one ended', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ status: 'cancelled', currentEnd: past() }),
      );

      await expect(service.register(7, 'org_1', 'growth')).resolves.toEqual(
        expect.objectContaining({ authorisationUrl: 'https://rzp.io/i/abc' }),
      );
      // The Razorpay customer is reused, so their payment history stays in one place.
      expect(mockRazorpay.createCustomer).not.toHaveBeenCalled();
    });

    it('refuses when the deployment has no payment provider', async () => {
      mockRazorpay.isConfigured.mockReturnValue(false);
      await expect(service.register(7, 'org_1', 'growth')).rejects.toThrow(
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
      mockPrisma.subscription.findFirst.mockResolvedValue(
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

      const state = await service.confirm('org_1', payload);

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
      mockPrisma.subscription.findFirst.mockResolvedValue(
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

      const state = await service.confirm('org_1', {
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

      await expect(service.confirm('org_1', payload)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRazorpay.fetchSubscription).not.toHaveBeenCalled();
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });

    it('refuses a payment for a different subscription', async () => {
      // A signature valid for someone else's subscription must not pass here.
      mockRazorpay.verifyCheckoutSignature.mockReturnValue(true);

      await expect(
        service.confirm('org_1', {
          ...payload,
          razorpaySubscriptionId: 'sub_other',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockRazorpay.verifyCheckoutSignature).not.toHaveBeenCalled();
    });

    it('refuses when the organisation has no subscription at all', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(null);

      await expect(service.confirm('org_1', payload)).rejects.toThrow(
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
      mockRazorpay.verifyCheckoutSignature.mockReturnValue(true);
      mockRazorpay.fetchSubscription.mockResolvedValue({
        id: 'sub_1',
        plan_id: 'plan_1',
        status: 'active',
        current_end: end,
      });
      // The subscription is the organisation's, so its accounts are read from
      // the membership table rather than off the row.
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
        { wabaId: 'waba_1' },
      ]);
    });

    it('pulls the accounts in the first time the organisation is paid for', async () => {
      // Connecting syncs nothing, so this is the moment a connected account
      // becomes a usable one.
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ wabaId: null, status: 'created', currentEnd: null }),
      );
      mockPrisma.subscription.update.mockResolvedValue(row({ wabaId: null }));

      await service.confirm('org_1', payload);

      expect(mockProvisioning.provision).toHaveBeenCalledWith(
        'org_1',
        'waba_1',
      );
    });

    it('pulls in every account, because one payment covers them all', async () => {
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
        { wabaId: 'waba_1' },
        { wabaId: 'waba_2' },
      ]);
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ wabaId: null, status: 'created', currentEnd: null }),
      );
      mockPrisma.subscription.update.mockResolvedValue(row({ wabaId: null }));

      await service.confirm('org_1', payload);

      expect(mockProvisioning.provision).toHaveBeenCalledTimes(2);
    });

    it('carries on to the rest when one account cannot be pulled in', async () => {
      // They were all paid for by the same debit; one Meta failure must not
      // leave the others empty.
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
        { wabaId: 'waba_1' },
        { wabaId: 'waba_2' },
      ]);
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ wabaId: null, status: 'created', currentEnd: null }),
      );
      mockPrisma.subscription.update.mockResolvedValue(row({ wabaId: null }));
      mockProvisioning.provision.mockRejectedValueOnce(new Error('Meta down'));

      await service.confirm('org_1', payload);

      expect(mockProvisioning.provision).toHaveBeenCalledTimes(2);
    });

    it('does not pull again on a renewal', async () => {
      // The edge is not-granting to granting. A subscription that was already
      // paid stays put — otherwise every monthly charge re-synced everything.
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ wabaId: null }),
      );
      mockPrisma.subscription.update.mockResolvedValue(row({ wabaId: null }));

      await service.confirm('org_1', payload);

      expect(mockProvisioning.provision).not.toHaveBeenCalled();
    });

    it('does not pull again for an account already filled in', async () => {
      // Numbers and templates belong to the account, so a second organisation
      // paying does not mean fetching them again.
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({
          wabaId: null,
          ssoOrgId: 'org_2',
          status: 'created',
          currentEnd: null,
        }),
      );
      mockPrisma.subscription.update.mockResolvedValue(
        row({ wabaId: null, ssoOrgId: 'org_2' }),
      );
      mockProvisioning.isProvisioned.mockResolvedValue(true);

      await service.confirm('org_2', payload);

      expect(mockProvisioning.provision).not.toHaveBeenCalled();
    });

    it('still reports the payment when provisioning fails', async () => {
      // Razorpay has taken the money either way; a Meta outage must not turn a
      // successful payment into a failed request.
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ wabaId: null, status: 'created', currentEnd: null }),
      );
      mockPrisma.subscription.update.mockResolvedValue(row({ wabaId: null }));
      mockProvisioning.provision.mockRejectedValue(new Error('Meta down'));

      const state = await service.confirm('org_1', payload);

      expect(state.active).toBe(true);
    });
  });

  describe('changePlan', () => {
    beforeEach(() => {
      mockPrisma.plan.findFirst.mockResolvedValue(tier());
      mockPrisma.subscription.update.mockResolvedValue(
        row({ planRefId: 2, plan: { code: 'growth', name: 'Growth' } }),
      );
      mockRazorpay.changeSubscriptionPlan.mockResolvedValue({
        id: 'sub_1',
        plan_id: 'plan_growth',
        status: 'active',
      });
      mockRazorpay.createSubscription.mockResolvedValue({
        id: 'sub_upgrade',
        plan_id: 'plan_growth',
        status: 'created',
        short_url: 'https://rzp.io/i/up',
      });
      mockRazorpay.addSubscriptionAddon.mockResolvedValue({ id: 'ao_1' });
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);
      mockRazorpay.fetchPlan.mockResolvedValue(PLAN);
    });

    describe('a dearer tier', () => {
      beforeEach(() => {
        // Starter (₹499) up to Growth (₹999), ten days into a thirty-day month.
        mockPrisma.subscription.findFirst.mockResolvedValue(
          row({ planRefId: 1, planId: 'plan_starter' }),
        );
        mockPrisma.plan.findUnique.mockResolvedValue({ price: 49_900 });
      });

      it('asks the customer to authorise a new mandate rather than raising the old one', async () => {
        // A Razorpay mandate is authorised for a fixed amount. Nothing can
        // raise what a customer is charged without them approving it again.
        const state = await service.changePlan('org_1', 'growth');

        expect(mockRazorpay.createSubscription).toHaveBeenCalledWith(
          expect.objectContaining({ planId: 'plan_growth' }),
        );
        expect(state.pendingAuthorisation).toEqual(
          expect.objectContaining({
            subscriptionId: 'sub_upgrade',
            authorisationUrl: 'https://rzp.io/i/up',
            planCode: 'growth',
          }),
        );
      });

      it('starts the new subscription where the paid month ends', async () => {
        // Without it Razorpay charges the new tier today and the customer has
        // bought the same days twice.
        await service.changePlan('org_1', 'growth');

        const [call] = mockRazorpay.createSubscription.mock
          .calls as unknown as {
          startAt: number;
        }[][];
        expect(call[0].startAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      });

      it('charges only the difference for the days left in the month', async () => {
        await service.changePlan('org_1', 'growth');

        const [call] = mockRazorpay.addSubscriptionAddon.mock
          .calls as unknown as [string, { amount: number; quantity: number }][];
        expect(call[0]).toBe('sub_upgrade');
        // ₹500 of difference across a thirty-day cycle with ten days left, so
        // a third of it — never the whole month, and never the whole price.
        expect(call[1].amount).toBeGreaterThan(0);
        expect(call[1].amount).toBeLessThan(99_900 - 49_900);
        expect(call[1].quantity).toBe(1);
      });

      it('does not move the tier the customer holds until the money is authorised', async () => {
        // The limits read `planRefId`. Moving it here would hand out the
        // dearer tier to somebody who then abandoned Checkout.
        await service.changePlan('org_1', 'growth');

        const { data } = firstArg<{ data: Record<string, unknown> }>(
          mockPrisma.subscription.update,
        );
        expect(data.planRefId).toBeUndefined();
        expect(data.pendingPlanRefId).toBe(2);
        expect(data.pendingRazorpaySubscriptionId).toBe('sub_upgrade');
      });

      it('leaves the old subscription running', async () => {
        // It is what they are still paying and still entitled to. `confirm`
        // cancels it, once there is something to replace it with.
        await service.changePlan('org_1', 'growth');

        expect(mockRazorpay.cancelSubscription).not.toHaveBeenCalled();
      });

      it('raises no add-on when there is nothing left of the month', async () => {
        mockPrisma.subscription.findFirst.mockResolvedValue(
          row({ planRefId: 1, planId: 'plan_starter', currentEnd: past() }),
        );

        await service.changePlan('org_1', 'growth');

        expect(mockRazorpay.addSubscriptionAddon).not.toHaveBeenCalled();
      });
    });

    it('holds a cheaper tier until the month already paid for runs out', async () => {
      // Business (₹1,999) down to Growth: taking the limits away now would be
      // taking away what they paid for.
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ planRefId: 3, planId: 'plan_business' }),
      );
      mockPrisma.plan.findUnique.mockResolvedValue({ price: 199_900 });

      const state = await service.changePlan('org_1', 'growth');

      expect(mockRazorpay.changeSubscriptionPlan).toHaveBeenCalledWith(
        'sub_1',
        { planId: 'plan_growth', atCycleEnd: true },
      );
      const { data } = firstArg<{ data: Record<string, unknown> }>(
        mockPrisma.subscription.update,
      );
      expect(data.pendingPlanRefId).toBe(2);
      // The tier it is on is untouched — only what happens next changes.
      expect(data.planRefId).toBeUndefined();
      expect(state).toBeDefined();
    });

    it('needs no new mandate to go down a tier', async () => {
      // The amount is falling, so what the customer already authorised covers
      // it. Sending them back to Checkout to pay less would be absurd.
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ planRefId: 3, planId: 'plan_business' }),
      );
      mockPrisma.plan.findUnique.mockResolvedValue({ price: 199_900 });

      const state = await service.changePlan('org_1', 'growth');

      expect(mockRazorpay.createSubscription).not.toHaveBeenCalled();
      expect(state.pendingAuthorisation).toBeNull();
    });

    it('waits for the renewal when the current price cannot be read', async () => {
      // An older subscription on a plan no tier claims, or Razorpay
      // unreachable. Asking somebody to re-authorise on a guess is the worse
      // mistake.
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ planRefId: null, planId: 'plan_legacy' }),
      );
      mockRazorpay.fetchPlan.mockResolvedValue(null);

      await service.changePlan('org_1', 'growth');

      expect(mockRazorpay.changeSubscriptionPlan).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({ atCycleEnd: true }),
      );
      expect(mockRazorpay.createSubscription).not.toHaveBeenCalled();
    });

    it('refuses a tier the organisation is already on', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ planRefId: 2 }),
      );

      await expect(service.changePlan('org_1', 'growth')).rejects.toThrow(
        /already on Growth/,
      );
      expect(mockRazorpay.changeSubscriptionPlan).not.toHaveBeenCalled();
    });

    it('refuses a quoted tier without touching Razorpay', async () => {
      mockPrisma.plan.findFirst.mockResolvedValue(
        tier({ code: 'agency', name: 'Agency', ctaKind: 'contact' }),
      );
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ planRefId: 1 }),
      );

      await expect(service.changePlan('org_1', 'agency')).rejects.toThrow(
        /priced individually/,
      );
      expect(mockRazorpay.changeSubscriptionPlan).not.toHaveBeenCalled();
    });

    it('refuses a subscription whose mandate was never authorised', async () => {
      // There is nothing to replace: finishing that authorisation would charge
      // the tier it was created on.
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ status: 'created', planRefId: 1 }),
      );

      await expect(service.changePlan('org_1', 'growth')).rejects.toThrow(
        /has not been authorised/,
      );
      expect(mockRazorpay.changeSubscriptionPlan).not.toHaveBeenCalled();
    });

    it('refuses one that is already ending', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ cancelAtCycleEnd: true, planRefId: 1 }),
      );

      await expect(service.changePlan('org_1', 'growth')).rejects.toThrow(
        /set to end/,
      );
    });

    it('refuses when there is no subscription at all', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(null);

      await expect(service.changePlan('org_1', 'growth')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('writes nothing when Razorpay refuses the new subscription', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ planRefId: 1, planId: 'plan_starter' }),
      );
      mockPrisma.plan.findUnique.mockResolvedValue({ price: 49_900 });
      mockPrisma.subscription.update.mockClear();
      mockRazorpay.createSubscription.mockRejectedValue(
        new BadRequestException('mandate will not cover it'),
      );

      await expect(service.changePlan('org_1', 'growth')).rejects.toThrow(
        /mandate will not cover it/,
      );
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('stops at the end of the month already paid for', async () => {
      const current = row();
      mockPrisma.subscription.findFirst.mockResolvedValue(current);
      mockRazorpay.cancelSubscription.mockResolvedValue({
        id: 'sub_1',
        status: 'active',
      });
      mockPrisma.subscription.update.mockResolvedValue({});

      await service.cancel('org_1');

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
        current.currentEnd,
      );
      expect(mockAccess.invalidatePayer).toHaveBeenCalledWith('org_1');
    });

    it('stops immediately when nothing has been paid for yet', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ status: 'created', currentEnd: null }),
      );
      mockRazorpay.cancelSubscription.mockResolvedValue({
        id: 'sub_1',
        status: 'cancelled',
      });
      mockPrisma.subscription.update.mockResolvedValue({});

      await service.cancel('org_1');

      expect(mockRazorpay.cancelSubscription).toHaveBeenCalledWith(
        'sub_1',
        false,
      );
    });

    it('abandons an upgrade the customer never authorised', async () => {
      // Leaving it would have Razorpay open a mandate on a dearer tier for an
      // organisation that has just said it wants to stop paying.
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ pendingRazorpaySubscriptionId: 'sub_upgrade' }),
      );
      mockRazorpay.cancelSubscription.mockResolvedValue({
        id: 'sub_1',
        status: 'active',
      });
      mockPrisma.subscription.update.mockResolvedValue({});

      await service.cancel('org_1');

      expect(mockRazorpay.cancelSubscription).toHaveBeenCalledWith(
        'sub_upgrade',
        false,
      );
      const { data } = firstArg<{ data: Record<string, unknown> }>(
        mockPrisma.subscription.update,
      );
      expect(data.pendingRazorpaySubscriptionId).toBeNull();
    });

    it('refuses to cancel twice', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ cancelAtCycleEnd: true }),
      );
      await expect(service.cancel('org_1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses when there is nothing to cancel', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(null);
      await expect(service.cancel('org_1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('what the console is told about the money', () => {
    beforeEach(() => {
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'waba_1', name: 'Games' },
      ]);
      mockPrisma.subscription.findFirst.mockResolvedValue(row());
    });

    it('reports the price, so the page can say what it costs', async () => {
      const state = await service.state('org_1');

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

      const state = await service.state('org_1');

      expect(state.plan).toBeNull();
      expect(state.active).toBe(true);
    });

    it('reports what was taken and how', async () => {
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([
        {
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

      const state = await service.state('org_1');

      expect(state.payments).toHaveLength(2);
      expect(state.lastPayment?.razorpayPaymentId).toBe('pay_2');
      expect(state.lastPayment?.methodDetail).toBe('Visa ···· 4242');
      expect(state.paidCount).toBe(2);
    });

    it('names a next charge only when one is actually coming', async () => {
      const active = await service.state('org_1');
      expect(active.nextChargeAt).toEqual(active.currentEnd);

      // Cancelled: the paid month runs out and then nothing happens, so a date
      // here would be a promise to debit that is never kept.
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ cancelAtCycleEnd: true }),
      );
      const cancelled = await service.state('org_1');
      expect(cancelled.nextChargeAt).toBeNull();
      expect(cancelled.active).toBe(true);
    });

    it('lists every account the one subscription covers', async () => {
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'waba_1', name: 'Games' },
        { wabaId: 'waba_2', name: 'Support' },
      ]);
      mockPrisma.wabaPhoneNumber.groupBy.mockResolvedValue([
        { wabaId: 'waba_1', _count: { _all: 2 } },
      ]);

      const state = await service.state('org_1');

      expect(state.covers).toEqual([
        {
          wabaId: 'waba_1',
          name: 'Games',
          phoneNumbers: 2,
          webhookEndpoints: 0,
          apiKeys: 0,
        },
        {
          wabaId: 'waba_2',
          name: 'Support',
          phoneNumbers: 0,
          webhookEndpoints: 0,
          apiKeys: 0,
        },
      ]);
    });

    it('says what is connected against what the tier includes', async () => {
      // Nothing here is a cap. The console's job is to price the next account,
      // not to refuse it.
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'waba_1', name: 'Games' },
        { wabaId: 'waba_2', name: 'Support' },
        { wabaId: 'waba_3', name: 'Sales' },
      ]);
      mockPrisma.wabaPhoneNumber.groupBy.mockResolvedValue([
        { wabaId: 'waba_1', _count: { _all: 3 } },
      ]);
      mockPlanLimits.forOrg.mockResolvedValue({
        planName: 'Starter',
        includedWabas: 1,
        includedPhoneNumbersPerWaba: 1,
        additionalWabaPrice: 29_900,
        additionalNumberPrice: 19_900,
      });

      const state = await service.state('org_1');

      expect(state.usage).toMatchObject({
        wabas: 3,
        phoneNumbers: 3,
        includedWabas: 1,
        includedPhoneNumbersPerWaba: 1,
        additionalWabaPrice: 29_900,
        additionalNumberPrice: 19_900,
      });
    });

    it('reports every limit the plan carries, with what is used against it', async () => {
      // The page used to show two allowances out of the eight the plan sells.
      // A limit nobody can see is one they meet as a refusal.
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'waba_1', name: 'Games' },
      ]);
      mockPrisma.contact.count.mockResolvedValue(1_840);
      mockPrisma.webhookEndpoint.groupBy.mockResolvedValue([
        { wabaId: 'waba_1', _count: { _all: 2 } },
      ]);
      mockPrisma.userApiKey.groupBy.mockResolvedValue([
        { wabaId: 'waba_1', _count: { _all: 3 } },
      ]);
      mockOrg.listMembers.mockResolvedValue([{ id: 1 }, { id: 2 }]);
      mockOrg.listInvitations.mockResolvedValue([{ id: 9 }]);
      mockPlanLimits.forOrg.mockResolvedValue({
        planName: 'Growth',
        includedWabas: 3,
        includedPhoneNumbersPerWaba: 1,
        includedClients: null,
        additionalWabaPrice: 29_900,
        additionalNumberPrice: 19_900,
        contacts: 10_000,
        webhookEndpoints: 5,
        apiKeysPerWaba: 5,
        teamMembers: 5,
        messagesPerMinute: 500,
        historyDays: 90,
      });

      const state = await service.state('org_1', 'Bearer token');

      expect(state.usage).toMatchObject({
        contacts: 1_840,
        maxContacts: 10_000,
        webhookEndpoints: 2,
        maxWebhookEndpointsPerWaba: 5,
        apiKeys: 3,
        maxApiKeysPerWaba: 5,
        // An invitation is a seat somebody is about to take, and it is counted
        // that way when a seat is refused — so it is counted that way here.
        teamMembers: 3,
        maxTeamMembers: 5,
        maxMessagesPerMinute: 500,
        historyDays: 90,
      });
    });

    it('counts a revoked key against nothing', async () => {
      // The ceiling is on live keys, so a meter that counted revoked ones
      // would show somebody full when they are not.
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'waba_1', name: 'Games' },
      ]);

      await service.state('org_1');

      const [args] = mockPrisma.userApiKey.groupBy.mock.calls[0] as [
        { where: { status: boolean } },
      ];
      expect(args.where.status).toBe(true);
    });

    it('says nothing about seats rather than guessing when the SSO will not answer', async () => {
      // A billing page that 500s over a seat count would hide the payment
      // state, and "0 of 5" would be a lie somebody might act on.
      mockOrg.listMembers.mockRejectedValue(new Error('SSO unreachable'));

      const state = await service.state('org_1', 'Bearer token');

      expect(state.usage.teamMembers).toBeNull();
      expect(state.active).toBeDefined();
    });

    it('does not ask the SSO for seats when there is no session to ask with', async () => {
      // Webhooks and the write paths reach the same builder without a token.
      await service.state('org_1');

      expect(mockOrg.listMembers).not.toHaveBeenCalled();
    });

    it('counts clients only for an agency', async () => {
      mockOrgSettings.get.mockResolvedValue({
        ssoOrgId: 'org_1',
        isAgency: true,
        agencyOrgId: null,
      });
      mockOrgSettings.clientsOf.mockResolvedValue(['org_a', 'org_b']);

      const state = await service.state('org_1');

      expect(state.usage.clients).toBe(2);
    });

    it('reports no client count for an organisation that is not an agency', async () => {
      // Null is "does not apply", which the console shows as nothing at all.
      // Zero would put an empty meter on every ordinary customer's page.
      const state = await service.state('org_1');

      expect(state.usage.clients).toBeNull();
    });

    it('answers for an organisation that has never subscribed', async () => {
      // The console asks this to decide whether to offer a tier. An error, or
      // an empty body, would read as a fault rather than as "not subscribed".
      mockPrisma.subscription.findFirst.mockResolvedValue(null);

      const state = await service.state('org_1');

      expect(state.active).toBe(false);
      expect(state.status).toBeNull();
      expect(state.covers).toHaveLength(1);
    });

    it('offers the upgrade still waiting to be authorised', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({
          pendingRazorpaySubscriptionId: 'sub_upgrade',
          pendingShortUrl: 'https://rzp.io/i/up',
          pendingPlan: { code: 'business', name: 'Business' },
        }),
      );

      const state = await service.state('org_1');

      expect(state.pendingAuthorisation).toEqual(
        expect.objectContaining({
          subscriptionId: 'sub_upgrade',
          planCode: 'business',
        }),
      );
      // Checkout needs the key to open on it.
      expect(state.keyId).toBe('rzp_test_key');
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
    mockPrisma.webhookEndpoint.groupBy.mockResolvedValue([]);
    mockPrisma.userApiKey.groupBy.mockResolvedValue([]);
    mockPrisma.contact.count.mockResolvedValue(0);
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

  describe('what Checkout is offered', () => {
    beforeEach(() => {
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'waba_1', name: 'Games' },
      ]);
    });

    it('offers the authorisation page only while nothing is charged', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({
          status: 'created',
          currentEnd: null,
          shortUrl: 'https://rzp.io/i/abc',
        }),
      );

      const state = await service.state('org_1');

      expect(state.subscriptionId).toBe('sub_1');
      expect(state.keyId).toBe('rzp_test_key');
      expect(state.authorisationUrl).toBe('https://rzp.io/i/abc');
      expect(state.active).toBe(false);
    });

    it('offers nothing to authorise once the mandate exists', async () => {
      // Checkout has nothing left to do, and the hosted page is retired.
      mockPrisma.subscription.findFirst.mockResolvedValue(row());

      const state = await service.state('org_1');

      expect(state.subscriptionId).toBeNull();
      expect(state.keyId).toBeNull();
      expect(state.authorisationUrl).toBeNull();
    });

    it('quotes no price for an organisation nobody has chosen a plan for', async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(null);

      const state = await service.state('org_1');

      // What it would cost depends on a tier nobody has picked; the console
      // sends the reader to the price list instead of guessing one.
      expect(state.plan).toBeNull();
      expect(state.planCode).toBeNull();
      expect(mockRazorpay.fetchPlan).not.toHaveBeenCalled();
    });

    it('reads the price of the tier held, not of a default', async () => {
      // A Growth customer shown the Starter price is the whole reason this is
      // read from the subscription's own plan id.
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({
          planId: 'plan_growth',
          plan: { code: 'growth', name: 'Growth' },
        }),
      );
      mockRazorpay.fetchPlan.mockResolvedValue({
        ...PLAN,
        id: 'plan_growth',
        item: { ...PLAN.item, amount: 99_900 },
      });

      const state = await service.state('org_1');

      expect(mockRazorpay.fetchPlan).toHaveBeenCalledWith('plan_growth');
      expect(state.plan?.amount).toBe(99_900);
      expect(state.planName).toBe('Growth');
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
