import { Test, TestingModule } from '@nestjs/testing';
import { SubscriptionAccessService } from './subscription-access.service';
import { RazorpayService } from './razorpay.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';

const mockPrisma = { subscription: { findUnique: jest.fn() } };
const mockRedis = {
  getSubscriptionAccess: jest.fn(),
  setSubscriptionAccess: jest.fn(),
  invalidateSubscriptionAccess: jest.fn(),
};
const mockRazorpay = { isConfigured: jest.fn().mockReturnValue(true) };

const HOUR = 60 * 60 * 1000;
const soon = () => new Date(Date.now() + 10 * 24 * HOUR);
const past = () => new Date(Date.now() - 2 * HOUR);

const row = (over: Record<string, unknown> = {}) => ({
  wabaId: 'waba_1',
  ssoOrgId: 'org_1',
  status: 'active',
  currentEnd: soon(),
  ...over,
});

describe('SubscriptionAccessService', () => {
  let service: SubscriptionAccessService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRazorpay.isConfigured.mockReturnValue(true);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionAccessService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: RazorpayService, useValue: mockRazorpay },
      ],
    }).compile();
    service = module.get(SubscriptionAccessService);
  });

  describe('grants — who may call the API', () => {
    it('lets an active subscription through', () => {
      expect(SubscriptionAccessService.grants(row() as never)).toBe(true);
    });

    it('keeps a cancelled subscription until the paid month runs out', () => {
      // The whole point of "cancel any time": the month is already bought.
      expect(
        SubscriptionAccessService.grants({
          status: 'cancelled',
          currentEnd: soon(),
        } as never),
      ).toBe(true);
    });

    it('shuts a cancelled subscription out once the month has passed', () => {
      expect(
        SubscriptionAccessService.grants({
          status: 'cancelled',
          currentEnd: past(),
        } as never),
      ).toBe(false);
    });

    it('keeps serving while a renewal is being retried', () => {
      // `pending` means the next charge failed, not that the paid month ended.
      expect(
        SubscriptionAccessService.grants({
          status: 'pending',
          currentEnd: soon(),
        } as never),
      ).toBe(true);
    });

    it('refuses a subscription whose mandate was never authorised', () => {
      expect(
        SubscriptionAccessService.grants({
          status: 'created',
          currentEnd: null,
        } as never),
      ).toBe(false);
    });

    it('refuses an account that never subscribed', () => {
      expect(SubscriptionAccessService.grants(null)).toBe(false);
    });
  });

  describe('hasAccess', () => {
    it('answers from the cache without touching the database', async () => {
      mockRedis.getSubscriptionAccess.mockResolvedValue(true);

      await expect(service.hasAccess('org_1', 'waba_1')).resolves.toBe(true);
      expect(mockPrisma.subscription.findUnique).not.toHaveBeenCalled();
    });

    it('reads through and caches on a miss, keyed by organisation and account', async () => {
      mockRedis.getSubscriptionAccess.mockResolvedValue(null);
      mockPrisma.subscription.findUnique.mockResolvedValue(row());

      await expect(service.hasAccess('org_1', 'waba_1')).resolves.toBe(true);
      expect(mockPrisma.subscription.findUnique).toHaveBeenCalledWith({
        where: { wabaId_ssoOrgId: { wabaId: 'waba_1', ssoOrgId: 'org_1' } },
      });
      expect(mockRedis.setSubscriptionAccess).toHaveBeenCalledWith(
        'org_1:waba_1',
        true,
      );
    });

    it('refuses an account whose neighbour is the one that is paid for', async () => {
      // Per-account subscriptions: paying for one WABA buys nothing for another.
      mockRedis.getSubscriptionAccess.mockResolvedValue(null);
      mockPrisma.subscription.findUnique.mockResolvedValue(null);

      await expect(service.hasAccess('org_1', 'waba_2')).resolves.toBe(false);
    });

    it('refuses an organisation riding on another organisation`s payment', async () => {
      // The same account connected twice is two subscriptions. The lookup is
      // the composite key, so org_2 asking about a WABA org_1 pays for finds
      // nothing — and its own cache entry is the one that gets written.
      mockRedis.getSubscriptionAccess.mockResolvedValue(null);
      mockPrisma.subscription.findUnique.mockImplementation(({ where }: any) =>
        where.wabaId_ssoOrgId.ssoOrgId === 'org_1' ? row() : null,
      );

      await expect(service.hasAccess('org_1', 'waba_1')).resolves.toBe(true);
      await expect(service.hasAccess('org_2', 'waba_1')).resolves.toBe(false);
      expect(mockRedis.setSubscriptionAccess).toHaveBeenCalledWith(
        'org_2:waba_1',
        false,
      );
    });
  });

  describe('requireAccess', () => {
    it('passes when the account is paid for', async () => {
      mockRedis.getSubscriptionAccess.mockResolvedValue(true);

      await expect(
        service.requireAccess('org_1', 'waba_1'),
      ).resolves.toBeUndefined();
    });

    it('answers 402 when it is not', async () => {
      mockRedis.getSubscriptionAccess.mockResolvedValue(false);

      await expect(
        service.requireAccess('org_1', 'waba_1'),
      ).rejects.toMatchObject({ status: 402 });
    });

    it('lets everything through where no payment provider is configured', async () => {
      // Development and self-hosting must not need one.
      mockRazorpay.isConfigured.mockReturnValue(false);

      await expect(
        service.requireAccess('org_1', 'waba_1'),
      ).resolves.toBeUndefined();
      expect(mockRedis.getSubscriptionAccess).not.toHaveBeenCalled();
    });
  });

  it('invalidates on the same key it caches under', async () => {
    await service.invalidate('org_1', 'waba_1');
    expect(mockRedis.invalidateSubscriptionAccess).toHaveBeenCalledWith(
      'org_1:waba_1',
    );
  });
});
