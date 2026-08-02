import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { RedisService } from 'src/redis/redis.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import { mailNotificationsDouble } from 'src/mail/mail.test-doubles';

const mockPrisma = {
  userApiKey: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  waba: { findFirst: jest.fn() },
};

const mockEncryption = { encrypt: jest.fn().mockReturnValue('enc_secret'), decrypt: jest.fn() };
const mockRedis = { setApiKeyCache: jest.fn(), deleteApiKeyCache: jest.fn() };

const mockMailNotifications = mailNotificationsDouble();

describe('ApiKeyService', () => {
  let service: ApiKeyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: MailNotifications, useValue: mockMailNotifications },
        ApiKeyService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EncryptionService, useValue: mockEncryption },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();
    service = module.get<ApiKeyService>(ApiKeyService);
  });

  describe('createApiKey', () => {
    const dto = { label: 'Test Key', wabaId: 'waba_1' } as any;

    it('creates a key, encrypts secret, caches in Redis', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'waba_1' });
      mockPrisma.userApiKey.create.mockResolvedValue({});

      const result = await service.createApiKey(1, 'sso_org_1', dto);

      expect(result.accessKey).toMatch(/^ak_/);
      expect(result.secretKey).toMatch(/^sk_/);
      expect(result.wabaId).toBe('waba_1');
      expect(mockEncryption.encrypt).toHaveBeenCalled();
      expect(mockPrisma.userApiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 1, ssoOrgId: 'sso_org_1', wabaId: 'waba_1' }),
        }),
      );
      expect(mockRedis.setApiKeyCache).toHaveBeenCalledWith(
        expect.stringMatching(/^ak_/), 1, 'sso_org_1', 'enc_secret', 'waba_1',
      );
    });

    it('refuses a WABA the organisation does not own', async () => {
      // Scoped by org as well as id — otherwise a known id from another
      // organisation would mint a key into it.
      mockPrisma.waba.findFirst.mockResolvedValue(null);

      await expect(service.createApiKey(1, 'sso_org_1', dto)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.userApiKey.create).not.toHaveBeenCalled();
      expect(mockRedis.setApiKeyCache).not.toHaveBeenCalled();
    });
  });

  describe('findAllByOrgId', () => {
    it('lists keys with the name of the account each one acts on', async () => {
      mockPrisma.userApiKey.findMany.mockResolvedValue([
        {
          id: 1, accessKey: 'ak_a', wabaId: 'waba_1', status: true,
          createdAt: new Date('2026-08-01'), waba: { name: 'OneManPlay Games' },
        },
        // A key whose WABA was deleted: still listed, no name to show.
        {
          id: 2, accessKey: 'ak_b', wabaId: null, status: true,
          createdAt: new Date('2026-08-01'), waba: null,
        },
      ]);

      const keys = await service.findAllByOrgId('sso_org_1');

      expect(keys[0]).toEqual(
        expect.objectContaining({ wabaId: 'waba_1', wabaName: 'OneManPlay Games' }),
      );
      expect(keys[1]).toEqual(expect.objectContaining({ wabaId: null, wabaName: null }));
      expect(keys[0]).not.toHaveProperty('waba');
    });
  });

  describe('revokeApiKey', () => {
    it('throws NotFoundException if key not found', async () => {
      mockPrisma.userApiKey.findFirst.mockResolvedValue(null);
      await expect(service.revokeApiKey(1, 'sso_org_1', 99)).rejects.toThrow(NotFoundException);
    });

    it('scopes the lookup to the organisation, not to who created the key', async () => {
      // The list is the organisation's, so matching on `userId` showed a
      // colleague's key and then 404'd when it was revoked.
      mockPrisma.userApiKey.findFirst.mockResolvedValue({
        id: 99,
        userId: 2,
        ssoOrgId: 'sso_org_1',
        accessKey: 'ak_x',
      });
      mockPrisma.userApiKey.update.mockResolvedValue({});

      await service.revokeApiKey(1, 'sso_org_1', 99);

      expect(mockPrisma.userApiKey.findFirst).toHaveBeenCalledWith({
        where: { id: 99, ssoOrgId: 'sso_org_1' },
      });
    });

    it('deactivates key and removes from Redis cache', async () => {
      mockPrisma.userApiKey.findFirst.mockResolvedValue({
        id: 5,
        userId: 1,
        ssoOrgId: 'sso_org_1',
        accessKey: 'ak_abc',
      });
      mockPrisma.userApiKey.update.mockResolvedValue({});

      await service.revokeApiKey(1, 'sso_org_1', 5);

      expect(mockPrisma.userApiKey.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { status: false },
      });
      expect(mockRedis.deleteApiKeyCache).toHaveBeenCalledWith('ak_abc');
    });
  });
});
