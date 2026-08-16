import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WabaPhoneNumberService } from './waba-phone-number.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { SubscriptionAccessService } from 'src/billing/subscription-access.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { WabaMembershipService } from 'src/waba/waba-membership.service';
import { billingServiceDouble } from 'src/billing/billing.test-doubles';
import { wabaMembershipDouble } from 'src/waba/waba.test-doubles';
import { EncryptionService } from 'src/common/services/crypto.service';
import { RedisService } from 'src/redis/redis.service';
import axios from 'axios';
import { MailNotifications } from 'src/mail/mail.notifications';
import { mailNotificationsDouble } from 'src/mail/mail.test-doubles';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockPrisma = {
  waba: { findFirst: jest.fn() },
  wabaPhoneNumber: {
    count: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  },
  userWhatsapp: { findFirst: jest.fn() },
};

const mockMembership = wabaMembershipDouble();
const mockEncryption = { decrypt: jest.fn().mockReturnValue('raw_token') };
const mockRedis = { setPhoneCache: jest.fn(), invalidatePhoneCache: jest.fn() };

const mockMailNotifications = mailNotificationsDouble();

const realPlanLimits = new PlanLimitsService({} as never);
const mockPlanLimits = {
  forWaba: jest.fn().mockResolvedValue({
    planCode: 'starter',
    planName: 'Starter',
    wabas: 1,
    phoneNumbersPerWaba: 1,
    teamMembers: 2,
    webhookEndpoints: 2,
    historyDays: 30,
  }),
  assertWithin: realPlanLimits.assertWithin.bind(realPlanLimits),
};

describe('WabaPhoneNumberService', () => {
  let service: WabaPhoneNumberService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // No stale numbers to prune unless a test overrides it.
    mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue([]);
    // Nothing registered on the account yet, so the plan's first number is free
    // to take unless a test says otherwise.
    mockPrisma.wabaPhoneNumber.count.mockResolvedValue(0);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: MailNotifications, useValue: mockMailNotifications },
        WabaPhoneNumberService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SubscriptionAccessService, useValue: billingServiceDouble() },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        { provide: WabaMembershipService, useValue: mockMembership },
        { provide: EncryptionService, useValue: mockEncryption },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();
    service = module.get<WabaPhoneNumberService>(WabaPhoneNumberService);
  });

  describe('findAllByWabaId', () => {
    it('throws NotFoundException when the organisation does not hold the WABA', async () => {
      mockMembership.require.mockRejectedValueOnce(new NotFoundException('nope'));
      await expect(service.findAllByWabaId('org_1', 'w1')).rejects.toThrow(NotFoundException);
    });

    it('lists for the organisation, not for the account`s first connector', async () => {
      const phones = [{ phoneNumberId: 'p1' }];
      mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue(phones);

      await expect(service.findAllByWabaId('org_2', 'w1')).resolves.toEqual(phones);
      expect(mockMembership.require).toHaveBeenCalledWith('org_2', 'w1');
    });
  });

  describe('syncPhoneNumbers', () => {
    it('throws NotFoundException when no connection found', async () => {
      mockMembership.connection.mockRejectedValueOnce(new NotFoundException('gone'));
      await expect(service.syncPhoneNumbers(1, 'org_1', 'w1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('fetches from Meta, upserts to DB and populates Redis cache', async () => {
      const userWhatsapp = { accessToken: 'enc_token' };
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue(userWhatsapp);
      mockEncryption.decrypt.mockReturnValue('raw_token');

      const metaPhone = {
        id: 'p1',
        verified_name: 'Test',
        code_verification_status: 'VERIFIED',
        display_phone_number: '+1555',
        quality_rating: 'GREEN',
        platform_type: 'CLOUD_API',
        throughput: { level: 'STANDARD' },
        last_onboarded_time: new Date().toISOString(),
      };
      mockedAxios.get = jest.fn().mockResolvedValue({ data: { data: [metaPhone] } });

      const upsertedPhone = { phoneNumberId: 'p1', wabaId: 'w1' };
      mockPrisma.wabaPhoneNumber.upsert.mockResolvedValue(upsertedPhone);

      const result = await service.syncPhoneNumbers(1, 'org_1', 'w1');

      expect(result).toHaveLength(1);
      expect(result[0].phoneNumberId).toBe('p1');
      // No user in the entry: who may send is a membership question now.
      expect(mockRedis.setPhoneCache).toHaveBeenCalledWith('p1', 'w1', 'enc_token');
    });

    it('prunes numbers removed on Meta and invalidates their cache', async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: { data: [{ id: 'p1', platform_type: 'CLOUD_API' }] },
      });
      mockPrisma.wabaPhoneNumber.upsert.mockResolvedValue({ phoneNumberId: 'p1', wabaId: 'w1' });
      // Meta no longer returns 'p_old' → it should be pruned.
      mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue([{ phoneNumberId: 'p_old' }]);

      await service.syncPhoneNumbers(1, 'org_1', 'w1');

      expect(mockPrisma.wabaPhoneNumber.deleteMany).toHaveBeenCalledWith({
        where: { wabaId: 'w1', phoneNumberId: { notIn: ['p1'] } },
      });
      expect(mockRedis.invalidatePhoneCache).toHaveBeenCalledWith('p_old');
    });
  });

  describe('syncPhoneNumbersWithToken', () => {
    it('fetches and upserts using provided tokens', async () => {
      const metaPhone = {
        id: 'p2',
        verified_name: 'Phone2',
        code_verification_status: 'VERIFIED',
        display_phone_number: '+1999',
        quality_rating: 'GREEN',
        platform_type: 'CLOUD_API',
        throughput: { level: 'STANDARD' },
        last_onboarded_time: new Date().toISOString(),
      };
      mockedAxios.get = jest.fn().mockResolvedValue({ data: { data: [metaPhone] } });
      const upserted = { phoneNumberId: 'p2', wabaId: 'w1' };
      mockPrisma.wabaPhoneNumber.upsert.mockResolvedValue(upserted);

      const result = await service.syncPhoneNumbersWithToken('w1', 'raw', 'enc');

      expect(result).toHaveLength(1);
      expect(mockRedis.setPhoneCache).toHaveBeenCalledWith('p2', 'w1', 'enc');
    });

    it('handles a "Pending sync" number with fields omitted by Meta', async () => {
      // A not-yet-onboarded number comes back with no last_onboarded_time and
      // several fields missing. This must not crash the connect flow.
      const metaPhone = { id: 'p3' };
      mockedAxios.get = jest.fn().mockResolvedValue({ data: { data: [metaPhone] } });
      mockPrisma.wabaPhoneNumber.upsert.mockImplementation(({ create }) => create);

      const result = await service.syncPhoneNumbersWithToken('w1', 'raw', 'enc');

      expect(result).toHaveLength(1);
      const written = mockPrisma.wabaPhoneNumber.upsert.mock.calls[0][0].create;
      expect(written.lastOnboardedTime).toBeNull();
      expect(written.qualityRating).toBe('UNKNOWN');
      expect(written.platformType).toBe('NOT_APPLICABLE');
      expect(written.codeVerificationStatus).toBe('NOT_VERIFIED');
      expect(written.verifiedName).toBe('');
    });
  });

  describe('registerPhoneNumber', () => {
    it('throws NotFoundException when the WABA is not owned by the user', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue(null);
      await expect(
        service.registerPhoneNumber(1, 'org_1', 'w1', 'p1', '123456'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the phone is not on the WABA', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockPrisma.wabaPhoneNumber.findFirst.mockResolvedValue(null);
      await expect(
        service.registerPhoneNumber(1, 'org_1', 'w1', 'p1', '123456'),
      ).rejects.toThrow(NotFoundException);
    });

    it('posts the PIN to Meta then re-syncs and returns the updated number', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockPrisma.wabaPhoneNumber.findFirst.mockResolvedValue({ phoneNumberId: 'p1', wabaId: 'w1' });
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue({ accessToken: 'enc_token' });
      mockEncryption.decrypt.mockReturnValue('raw_token');
      mockedAxios.post = jest.fn().mockResolvedValue({ data: { success: true } });
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: { data: [{ id: 'p1', platform_type: 'CLOUD_API', throughput: { level: 'STANDARD' } }] },
      });
      mockPrisma.wabaPhoneNumber.upsert.mockImplementation(({ create }) => create);

      const result = await service.registerPhoneNumber(
        1,
        'org_1',
        'w1',
        'p1',
        '123456',
      );

      const [url, payload] = (mockedAxios.post as jest.Mock).mock.calls[0];
      expect(url).toContain('/p1/register');
      expect(payload).toEqual({ messaging_product: 'whatsapp', pin: '123456' });
      expect(result.phoneNumberId).toBe('p1');
      expect(result.platformType).toBe('CLOUD_API');
      // No user in the entry: who may send is a membership question now.
      expect(mockRedis.setPhoneCache).toHaveBeenCalledWith('p1', 'w1', 'enc_token');
    });

    it("refuses a number past the account's plan limit, before calling Meta", async () => {
      // Starter includes one number; the second is an upgrade, not a request
      // Meta should be asked to register.
      mockPrisma.wabaPhoneNumber.findFirst.mockResolvedValue({
        phoneNumberId: 'phone_2',
        wabaId: 'waba_1',
        platformType: 'NOT_APPLICABLE',
      });
      mockPrisma.wabaPhoneNumber.count.mockResolvedValue(1);

      await expect(
        service.registerPhoneNumber(1, 'org_1', 'waba_1', 'phone_2', '123456'),
      ).rejects.toThrow(BadRequestException);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('re-registers a number already live without counting it again', async () => {
      // It is already one of the numbers being paid for; registering it again
      // adds nothing to the count.
      mockPrisma.wabaPhoneNumber.findFirst.mockResolvedValue({
        phoneNumberId: 'phone_1',
        wabaId: 'waba_1',
        platformType: 'CLOUD_API',
      });
      mockPrisma.wabaPhoneNumber.count.mockResolvedValue(1);
      mockedAxios.post.mockResolvedValue({ data: { success: true } });
      mockedAxios.get.mockResolvedValue({ data: { data: [] } });

      await expect(
        service.registerPhoneNumber(1, 'org_1', 'waba_1', 'phone_1', '123456'),
      ).resolves.toBeDefined();
      expect(mockedAxios.post).toHaveBeenCalled();
    });

    it('translates a Meta failure into a BadRequestException and does not re-sync', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockPrisma.wabaPhoneNumber.findFirst.mockResolvedValue({ phoneNumberId: 'p1', wabaId: 'w1' });
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue({ accessToken: 'enc_token' });
      mockedAxios.post = jest.fn().mockRejectedValue({
        response: { data: { error: { message: 'Invalid PIN', code: 100 } } },
      });
      mockedAxios.get = jest.fn();

      await expect(
        service.registerPhoneNumber(1, 'org_1', 'w1', 'p1', '000000'),
      ).rejects.toThrow('Invalid PIN');
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });
  });
});
