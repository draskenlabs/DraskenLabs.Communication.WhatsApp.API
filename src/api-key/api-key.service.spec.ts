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
    update: jest.fn(),
  },
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
    it('creates a key, encrypts secret, caches in Redis', async () => {
      mockPrisma.userApiKey.create.mockResolvedValue({});

      const result = await service.createApiKey(1, 'sso_org_1', { name: 'Test Key' } as any);

      expect(result.accessKey).toMatch(/^ak_/);
      expect(result.secretKey).toMatch(/^sk_/);
      expect(mockEncryption.encrypt).toHaveBeenCalled();
      expect(mockPrisma.userApiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: 1, ssoOrgId: 'sso_org_1' }) }),
      );
      expect(mockRedis.setApiKeyCache).toHaveBeenCalledWith(
        expect.stringMatching(/^ak_/), 1, 'sso_org_1', 'enc_secret',
      );
    });
  });

  describe('revokeApiKey', () => {
    it('throws NotFoundException if key not found', async () => {
      mockPrisma.userApiKey.findUnique.mockResolvedValue(null);
      await expect(service.revokeApiKey(1, 99)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException if key belongs to different user', async () => {
      mockPrisma.userApiKey.findUnique.mockResolvedValue({ id: 99, userId: 2, accessKey: 'ak_x' });
      await expect(service.revokeApiKey(1, 99)).rejects.toThrow(NotFoundException);
    });

    it('deactivates key and removes from Redis cache', async () => {
      mockPrisma.userApiKey.findUnique.mockResolvedValue({ id: 5, userId: 1, accessKey: 'ak_abc' });
      mockPrisma.userApiKey.update.mockResolvedValue({});

      await service.revokeApiKey(1, 5);

      expect(mockPrisma.userApiKey.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { status: false },
      });
      expect(mockRedis.deleteApiKeyCache).toHaveBeenCalledWith('ak_abc');
    });
  });
});
