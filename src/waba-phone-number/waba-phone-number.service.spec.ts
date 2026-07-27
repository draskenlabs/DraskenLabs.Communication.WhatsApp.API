import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WabaPhoneNumberService } from './waba-phone-number.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { RedisService } from 'src/redis/redis.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockPrisma = {
  waba: { findFirst: jest.fn() },
  wabaPhoneNumber: { findFirst: jest.fn(), findMany: jest.fn(), upsert: jest.fn() },
  userWhatsapp: { findFirst: jest.fn() },
};

const mockEncryption = { decrypt: jest.fn().mockReturnValue('raw_token') };
const mockRedis = { setPhoneCache: jest.fn() };

describe('WabaPhoneNumberService', () => {
  let service: WabaPhoneNumberService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WabaPhoneNumberService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EncryptionService, useValue: mockEncryption },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();
    service = module.get<WabaPhoneNumberService>(WabaPhoneNumberService);
  });

  describe('findAllByWabaId', () => {
    it('throws NotFoundException when WABA not found', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue(null);
      await expect(service.findAllByWabaId(1, 'w1')).rejects.toThrow(NotFoundException);
    });

    it('returns phone numbers for the WABA', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      const phones = [{ phoneNumberId: 'p1' }];
      mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue(phones);
      await expect(service.findAllByWabaId(1, 'w1')).resolves.toEqual(phones);
    });
  });

  describe('syncPhoneNumbers', () => {
    it('throws NotFoundException when no connection found', async () => {
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue(null);
      await expect(service.syncPhoneNumbers(1, 'w1')).rejects.toThrow(NotFoundException);
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

      const result = await service.syncPhoneNumbers(1, 'w1');

      expect(result).toHaveLength(1);
      expect(result[0].phoneNumberId).toBe('p1');
      expect(mockRedis.setPhoneCache).toHaveBeenCalledWith('p1', 1, 'w1', 'enc_token');
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

      const result = await service.syncPhoneNumbersWithToken(1, 'w1', 'raw', 'enc');

      expect(result).toHaveLength(1);
      expect(mockRedis.setPhoneCache).toHaveBeenCalledWith('p2', 1, 'w1', 'enc');
    });

    it('handles a "Pending sync" number with fields omitted by Meta', async () => {
      // A not-yet-onboarded number comes back with no last_onboarded_time and
      // several fields missing. This must not crash the connect flow.
      const metaPhone = { id: 'p3' };
      mockedAxios.get = jest.fn().mockResolvedValue({ data: { data: [metaPhone] } });
      mockPrisma.wabaPhoneNumber.upsert.mockImplementation(({ create }) => create);

      const result = await service.syncPhoneNumbersWithToken(1, 'w1', 'raw', 'enc');

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
      await expect(service.registerPhoneNumber(1, 'w1', 'p1', '123456')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when the phone is not on the WABA', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockPrisma.wabaPhoneNumber.findFirst.mockResolvedValue(null);
      await expect(service.registerPhoneNumber(1, 'w1', 'p1', '123456')).rejects.toThrow(
        NotFoundException,
      );
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

      const result = await service.registerPhoneNumber(1, 'w1', 'p1', '123456');

      const [url, payload] = (mockedAxios.post as jest.Mock).mock.calls[0];
      expect(url).toContain('/p1/register');
      expect(payload).toEqual({ messaging_product: 'whatsapp', pin: '123456' });
      expect(result.phoneNumberId).toBe('p1');
      expect(result.platformType).toBe('CLOUD_API');
      expect(mockRedis.setPhoneCache).toHaveBeenCalledWith('p1', 1, 'w1', 'enc_token');
    });

    it('translates a Meta failure into a BadRequestException and does not re-sync', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockPrisma.wabaPhoneNumber.findFirst.mockResolvedValue({ phoneNumberId: 'p1', wabaId: 'w1' });
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue({ accessToken: 'enc_token' });
      mockedAxios.post = jest.fn().mockRejectedValue({
        response: { data: { error: { message: 'Invalid PIN', code: 100 } } },
      });
      mockedAxios.get = jest.fn();

      await expect(service.registerPhoneNumber(1, 'w1', 'p1', '000000')).rejects.toThrow(
        'Invalid PIN',
      );
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });
  });
});
