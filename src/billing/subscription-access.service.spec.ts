import { Test, TestingModule } from '@nestjs/testing';
import { SubscriptionAccessService } from './subscription-access.service';
import { RazorpayService } from './razorpay.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { OrganisationSettingsService } from 'src/organisation-settings/organisation-settings.service';

const mockPrisma = {
  subscription: { findUnique: jest.fn(), findFirst: jest.fn() },
};
const mockRedis = {
  getSubscriptionAccess: jest.fn(),
  setSubscriptionAccess: jest.fn(),
  invalidateSubscriptionAccess: jest.fn(),
};
const mockRazorpay = { isConfigured: jest.fn().mockReturnValue(true) };
const mockSettings = {
  billingOrgFor: jest.fn(),
  cacheVersionFor: jest.fn(),
  bumpPayerVersion: jest.fn(),
};

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
    // Nobody is an agency client unless a test says otherwise.
    mockSettings.billingOrgFor.mockImplementation((id: string) =>
      Promise.resolve(id),
    );
    mockSettings.cacheVersionFor.mockResolvedValue(0);
    // No organisation-level subscription unless a test provides one.
    mockPrisma.subscription.findFirst.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionAccessService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: RazorpayService, useValue: mockRazorpay },
        { provide: OrganisationSettingsService, useValue: mockSettings },
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
        'org_1:waba_1:v0',
        true,
      );
    });

    it('answers from the organisation-level subscription when the account has none', async () => {
      // After the move to org-level billing this is every account: the
      // subscription is the organisation's and covers all of them.
      mockRedis.getSubscriptionAccess.mockResolvedValue(null);
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      mockPrisma.subscription.findFirst.mockResolvedValue(row({ wabaId: null }));

      await expect(service.hasAccess('org_1', 'waba_9')).resolves.toBe(true);
      const { where } = mockPrisma.subscription.findFirst.mock
        .calls[0][0] as { where: { ssoOrgId: string; wabaId: null } };
      expect(where.ssoOrgId).toBe('org_1');
      expect(where.wabaId).toBeNull();
    });

    it("falls back to the agency's subscription when a client holds none", async () => {
      // A client attached before per-client subscriptions existed holds
      // nothing of its own, so the lookup has to reach the payer or every one
      // of them is refused.
      mockRedis.getSubscriptionAccess.mockResolvedValue(null);
      mockSettings.billingOrgFor.mockResolvedValue('agency_1');
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      mockPrisma.subscription.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(row({ ssoOrgId: 'agency_1', wabaId: null }));

      await expect(service.hasAccess('client_1', 'waba_1')).resolves.toBe(true);

      const first = mockPrisma.subscription.findFirst.mock.calls[0][0] as {
        where: { ssoOrgId: string };
      };
      const second = mockPrisma.subscription.findFirst.mock.calls[1][0] as {
        where: { ssoOrgId: string };
      };
      expect(first.where.ssoOrgId).toBe('client_1');
      expect(second.where.ssoOrgId).toBe('agency_1');
    });

    it("answers on the client's own subscription without asking who pays", async () => {
      // Where an agency buys a plan for each client, the client holds one and
      // it is what decides — including when the agency's own has lapsed.
      mockRedis.getSubscriptionAccess.mockResolvedValue(null);
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      mockPrisma.subscription.findFirst.mockResolvedValue(
        row({ ssoOrgId: 'client_1', wabaId: null }),
      );

      await expect(service.hasAccess('client_1', 'waba_1')).resolves.toBe(true);
      expect(mockSettings.billingOrgFor).not.toHaveBeenCalled();
    });

    it("keys the cache on the payer's version, so one bump darkens every client", async () => {
      // A failed debit on an agency has to reach every client of theirs. The
      // version is in the key precisely so nothing has to enumerate them.
      mockRedis.getSubscriptionAccess.mockResolvedValue(null);
      mockSettings.cacheVersionFor.mockResolvedValue(7);
      mockPrisma.subscription.findUnique.mockResolvedValue(row());

      await service.hasAccess('client_1', 'waba_1');

      expect(mockRedis.getSubscriptionAccess).toHaveBeenCalledWith(
        'client_1:waba_1:v7',
      );
      expect(mockRedis.setSubscriptionAccess).toHaveBeenCalledWith(
        'client_1:waba_1:v7',
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
        'org_2:waba_1:v0',
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
      'org_1:waba_1:v0',
    );
  });

  it('invalidates a payer by bumping its version rather than walking its clients', async () => {
    await service.invalidatePayer('agency_1');

    expect(mockSettings.bumpPayerVersion).toHaveBeenCalledWith('agency_1');
  });
});
