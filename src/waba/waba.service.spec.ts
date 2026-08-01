import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { WabaService } from './waba.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { RedisService } from 'src/redis/redis.service';
import axios from 'axios';
import { MailNotifications } from 'src/mail/mail.notifications';
import { mailNotificationsDouble } from 'src/mail/mail.test-doubles';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockPrisma = {
  waba: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), upsert: jest.fn() },
  userWhatsapp: { findFirst: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
  wabaPhoneNumber: { findMany: jest.fn() },
};

const mockEncryption = { decrypt: jest.fn().mockReturnValue('plain_token') };
const mockRedis = { invalidatePhoneCache: jest.fn() };

const mockMailNotifications = mailNotificationsDouble();

describe('WabaService', () => {
  let service: WabaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: MailNotifications, useValue: mockMailNotifications },
        WabaService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EncryptionService, useValue: mockEncryption },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();
    service = module.get<WabaService>(WabaService);
  });

  describe('findAllByOrgId', () => {
    it('returns all WABAs for an org', async () => {
      const wabas = [{ wabaId: 'w1' }, { wabaId: 'w2' }];
      mockPrisma.waba.findMany.mockResolvedValue(wabas);
      await expect(service.findAllByOrgId('sso_org_1')).resolves.toEqual(wabas);
      expect(mockPrisma.waba.findMany).toHaveBeenCalledWith({ where: { ssoOrgId: 'sso_org_1' } });
    });
  });

  describe('findByWabaId', () => {
    it('returns WABA when found', async () => {
      const waba = { wabaId: 'w1', ssoOrgId: 'sso_org_1' };
      mockPrisma.waba.findFirst.mockResolvedValue(waba);
      await expect(service.findByWabaId('sso_org_1', 'w1')).resolves.toEqual(waba);
    });

    it('throws NotFoundException when not found', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue(null);
      const { NotFoundException } = await import('@nestjs/common');
      await expect(service.findByWabaId('sso_org_1', 'missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('createOrUpdateWaba', () => {
    const data = { wabaId: 'w1', userId: 1, ssoOrgId: 'sso_org_1', name: 'Test' };

    it('creates a new WABA when none exists', async () => {
      mockPrisma.waba.findUnique.mockResolvedValue(null);
      mockPrisma.waba.upsert.mockResolvedValue({ ...data });
      await expect(service.createOrUpdateWaba(data)).resolves.toEqual({ ...data });
      expect(mockPrisma.waba.upsert).toHaveBeenCalled();
    });

    it('updates WABA when requester is the owner', async () => {
      mockPrisma.waba.findUnique.mockResolvedValue({ wabaId: 'w1', userId: 1 });
      mockPrisma.waba.upsert.mockResolvedValue({ ...data });
      await expect(service.createOrUpdateWaba(data)).resolves.toBeDefined();
    });

    it('throws ForbiddenException when WABA belongs to another user', async () => {
      mockPrisma.waba.findUnique.mockResolvedValue({ wabaId: 'w1', userId: 99 });
      const { ForbiddenException } = await import('@nestjs/common');
      await expect(service.createOrUpdateWaba(data)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('disconnectWaba', () => {
    it('throws NotFoundException if WABA not in org', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue(null);
      await expect(service.disconnectWaba(1, 'sso_org_1', 'w1')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException if user does not own the connection', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockPrisma.userWhatsapp.findUnique.mockResolvedValue(null);
      await expect(service.disconnectWaba(1, 'sso_org_1', 'w1')).rejects.toThrow(ForbiddenException);
    });

    it('invalidates phone cache for all phone numbers and deletes connection', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockPrisma.userWhatsapp.findUnique.mockResolvedValue({ userId: 1, wabaId: 'w1' });
      mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue([
        { phoneNumberId: 'p1' },
        { phoneNumberId: 'p2' },
      ]);
      mockPrisma.userWhatsapp.delete.mockResolvedValue({});

      await service.disconnectWaba(1, 'sso_org_1', 'w1');

      expect(mockRedis.invalidatePhoneCache).toHaveBeenCalledWith('p1');
      expect(mockRedis.invalidatePhoneCache).toHaveBeenCalledWith('p2');
      expect(mockPrisma.userWhatsapp.delete).toHaveBeenCalledWith({
        where: { userId_wabaId: { userId: 1, wabaId: 'w1' } },
      });
    });

    it('works when WABA has no phone numbers', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockPrisma.userWhatsapp.findUnique.mockResolvedValue({ userId: 1, wabaId: 'w1' });
      mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue([]);
      mockPrisma.userWhatsapp.delete.mockResolvedValue({});

      await service.disconnectWaba(1, 'sso_org_1', 'w1');

      expect(mockRedis.invalidatePhoneCache).not.toHaveBeenCalled();
      expect(mockPrisma.userWhatsapp.delete).toHaveBeenCalled();
    });
  });

  describe('subscribeAppToWaba', () => {
    it('POSTs to subscribed_apps and returns true on success', async () => {
      mockedAxios.post = jest.fn().mockResolvedValue({ data: { success: true } });
      const result = await service.subscribeAppToWaba('w1', 'raw_token');
      expect(result).toBe(true);
      const [url] = (mockedAxios.post as jest.Mock).mock.calls[0];
      expect(url).toContain('/w1/subscribed_apps');
    });

    it('returns false (non-fatal) when Meta rejects the subscription', async () => {
      mockedAxios.post = jest.fn().mockRejectedValue({
        response: { data: { error: { message: 'missing permission', code: 200 } } },
      });
      await expect(service.subscribeAppToWaba('w1', 'raw_token')).resolves.toBe(false);
    });
  });

  describe('subscribeExistingWaba', () => {
    it('throws NotFoundException when there is no connection', async () => {
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue(null);
      await expect(service.subscribeExistingWaba(1, 'w1')).rejects.toThrow(NotFoundException);
    });

    it('decrypts the stored token and subscribes', async () => {
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue({ accessToken: 'enc' });
      mockEncryption.decrypt.mockReturnValue('raw_token');
      mockedAxios.post = jest.fn().mockResolvedValue({ data: { success: true } });
      await expect(service.subscribeExistingWaba(1, 'w1')).resolves.toBe(true);
      expect(mockEncryption.decrypt).toHaveBeenCalledWith('enc');
    });
  });
});
