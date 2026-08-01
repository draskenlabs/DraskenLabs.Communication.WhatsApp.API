import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BillingService } from './billing.service';
import { RazorpayService } from './razorpay.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import { mailNotificationsDouble } from 'src/mail/mail.test-doubles';

const mockPrisma = {
  subscription: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
  },
  subscriptionEvent: { create: jest.fn() },
};

const mockRedis = {
  getSubscriptionAccess: jest.fn(),
  setSubscriptionAccess: jest.fn(),
  invalidateSubscriptionAccess: jest.fn(),
};

const mockRazorpay = {
  isConfigured: jest.fn().mockReturnValue(true),
  createCustomer: jest.fn(),
  createSubscription: jest.fn(),
  cancelSubscription: jest.fn(),
  fetchSubscription: jest.fn(),
};

const mockMail = mailNotificationsDouble();

const HOUR = 60 * 60 * 1000;
const soon = () => new Date(Date.now() + 10 * 24 * HOUR);
const past = () => new Date(Date.now() - 2 * HOUR);

/** A row as the database would hold it. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 1,
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
        notes: { ssoOrgId: 'org_1' },
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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: RazorpayService, useValue: mockRazorpay },
        { provide: MailNotifications, useValue: mockMail },
      ],
    }).compile();
    service = module.get<BillingService>(BillingService);
  });

  describe('grants — who may call the API', () => {
    it('lets an active subscription through', () => {
      expect(BillingService.grants(row() as never)).toBe(true);
    });

    it('keeps a cancelled subscription until the paid month runs out', () => {
      // The whole point of "cancel any time": the month is already bought.
      expect(
        BillingService.grants({ status: 'cancelled', currentEnd: soon() } as never),
      ).toBe(true);
    });

    it('shuts a cancelled subscription out once the month has passed', () => {
      expect(
        BillingService.grants({ status: 'cancelled', currentEnd: past() } as never),
      ).toBe(false);
    });

    it('keeps serving while a renewal is being retried', () => {
      // `pending` means the next charge failed, not that the paid month ended.
      expect(
        BillingService.grants({ status: 'pending', currentEnd: soon() } as never),
      ).toBe(true);
    });

    it('refuses a subscription whose mandate was never authorised', () => {
      expect(
        BillingService.grants({ status: 'created', currentEnd: null } as never),
      ).toBe(false);
    });

    it('refuses an organisation that never subscribed', () => {
      expect(BillingService.grants(null)).toBe(false);
    });
  });

  describe('hasAccess', () => {
    it('answers from the cache without touching the database', async () => {
      mockRedis.getSubscriptionAccess.mockResolvedValue(true);

      await expect(service.hasAccess('org_1')).resolves.toBe(true);
      expect(mockPrisma.subscription.findUnique).not.toHaveBeenCalled();
    });

    it('reads through and caches on a miss', async () => {
      mockRedis.getSubscriptionAccess.mockResolvedValue(null);
      mockPrisma.subscription.findUnique.mockResolvedValue(row());

      await expect(service.hasAccess('org_1')).resolves.toBe(true);
      expect(mockRedis.setSubscriptionAccess).toHaveBeenCalledWith('org_1', true);
    });
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
    });

    it('returns the authorisation page and stores the subscription', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);

      const result = await service.register(7, 'org_1', { email: 'a@b.com' });

      expect(result.authorisationUrl).toBe('https://rzp.io/i/abc');
      expect(mockPrisma.subscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            ssoOrgId: 'org_1',
            razorpaySubscriptionId: 'sub_new',
            status: 'created',
            createdByUserId: 7,
          }),
        }),
      );
      expect(mockRedis.invalidateSubscriptionAccess).toHaveBeenCalledWith('org_1');
    });

    it('carries the organisation on the Razorpay record', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);

      await service.register(7, 'org_1', {});

      expect(mockRazorpay.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ notes: expect.objectContaining({ ssoOrgId: 'org_1' }) }),
      );
    });

    it('refuses a second subscription while one is running', async () => {
      // Two mandates on one organisation means two debits a month.
      mockPrisma.subscription.findUnique.mockResolvedValue(row());

      await expect(service.register(7, 'org_1', {})).rejects.toThrow(BadRequestException);
      expect(mockRazorpay.createSubscription).not.toHaveBeenCalled();
    });

    it('lets an organisation subscribe again after its last one ended', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ status: 'cancelled', currentEnd: past() }),
      );

      await expect(service.register(7, 'org_1', {})).resolves.toEqual(
        expect.objectContaining({ authorisationUrl: 'https://rzp.io/i/abc' }),
      );
      // The Razorpay customer is reused, so their payment history stays in one place.
      expect(mockRazorpay.createCustomer).not.toHaveBeenCalled();
    });

    it('refuses when the deployment has no payment provider', async () => {
      mockRazorpay.isConfigured.mockReturnValue(false);
      await expect(service.register(7, 'org_1', {})).rejects.toThrow(BadRequestException);
    });
  });

  describe('cancel', () => {
    it('stops at the end of the month already paid for', async () => {
      const current = row();
      mockPrisma.subscription.findUnique.mockResolvedValue(current);
      mockRazorpay.cancelSubscription.mockResolvedValue({ id: 'sub_1', status: 'active' });
      mockPrisma.subscription.update.mockResolvedValue({});

      await service.cancel('org_1');

      expect(mockRazorpay.cancelSubscription).toHaveBeenCalledWith('sub_1', true);
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ cancelAtCycleEnd: true }),
        }),
      );
      expect(mockMail.subscriptionCancelled).toHaveBeenCalledWith(7, current.currentEnd);
    });

    it('stops immediately when nothing has been paid for yet', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(
        row({ status: 'created', currentEnd: null }),
      );
      mockRazorpay.cancelSubscription.mockResolvedValue({ id: 'sub_1', status: 'cancelled' });
      mockPrisma.subscription.update.mockResolvedValue({});

      await service.cancel('org_1');

      expect(mockRazorpay.cancelSubscription).toHaveBeenCalledWith('sub_1', false);
    });

    it('refuses to cancel twice', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(row({ cancelAtCycleEnd: true }));
      await expect(service.cancel('org_1')).rejects.toThrow(BadRequestException);
    });

    it('refuses when there is nothing to cancel', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      await expect(service.cancel('org_1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('handleWebhook', () => {
    it('moves the paid-until date on a successful charge', async () => {
      const end = Math.floor((Date.now() + 30 * 24 * HOUR) / 1000);
      mockPrisma.subscriptionEvent.create.mockResolvedValue({});
      mockPrisma.subscription.findUnique.mockResolvedValue(row({ currentEnd: past() }));
      mockPrisma.subscription.update.mockResolvedValue({});

      await service.handleWebhook(
        'evt_1',
        hook('subscription.charged', { current_end: end, current_start: end - 2592000 }),
      );

      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'active', currentEnd: new Date(end * 1000) }),
        }),
      );
      expect(mockRedis.invalidateSubscriptionAccess).toHaveBeenCalledWith('org_1');
      expect(mockMail.subscriptionCharged).toHaveBeenCalled();
    });

    it('ignores a repeat delivery of the same event', async () => {
      // Razorpay retries; a replayed charge must not extend the month twice.
      const duplicate = Object.assign(new Error('dup'), { code: 'P2002' });
      Object.setPrototypeOf(
        duplicate,
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('@prisma/client').Prisma.PrismaClientKnownRequestError.prototype,
      );
      mockPrisma.subscriptionEvent.create.mockRejectedValue(duplicate);

      await service.handleWebhook('evt_1', hook('subscription.charged'));

      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });

    it('never shortens a paid month when events arrive out of order', async () => {
      const paidUntil = soon();
      mockPrisma.subscriptionEvent.create.mockResolvedValue({});
      mockPrisma.subscription.findUnique.mockResolvedValue(row({ currentEnd: paidUntil }));
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
        expect.objectContaining({ data: expect.objectContaining({ currentEnd: paidUntil }) }),
      );
    });

    it('emails once retries are exhausted', async () => {
      mockPrisma.subscriptionEvent.create.mockResolvedValue({});
      mockPrisma.subscription.findUnique.mockResolvedValue(row());
      mockPrisma.subscription.update.mockResolvedValue({});

      await service.handleWebhook('evt_3', hook('subscription.halted', { status: 'halted' }));

      expect(mockMail.subscriptionPaymentFailed).toHaveBeenCalledWith(7, true, expect.anything());
    });

    it('records an event for a subscription it does not know', async () => {
      mockPrisma.subscriptionEvent.create.mockResolvedValue({});
      mockPrisma.subscription.findUnique.mockResolvedValue(null);

      await service.handleWebhook('evt_4', hook('subscription.charged'));

      expect(mockPrisma.subscriptionEvent.create).toHaveBeenCalled();
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });
  });

  describe('reconcile', () => {
    it('re-reads subscriptions whose paid month has run out', async () => {
      // A missed `charged` webhook looks exactly like a lapsed customer.
      mockPrisma.subscription.findMany.mockResolvedValue([row({ currentEnd: past() })]);
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
      expect(mockRedis.invalidateSubscriptionAccess).toHaveBeenCalledWith('org_1');
    });

    it('carries on after one subscription fails to fetch', async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([
        row({ id: 1, razorpaySubscriptionId: 'sub_bad' }),
        row({ id: 2, razorpaySubscriptionId: 'sub_ok', ssoOrgId: 'org_2' }),
      ]);
      mockRazorpay.fetchSubscription
        .mockRejectedValueOnce(new Error('gateway down'))
        .mockResolvedValueOnce({ id: 'sub_ok', plan_id: 'plan_1', status: 'active' });
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
