import { Test, TestingModule } from '@nestjs/testing';
import { UserService } from './user.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';

const deleteMany = () => jest.fn().mockResolvedValue({ count: 0 });

const mockTx = {
  messageTemplate: { deleteMany: deleteMany() },
  inboundMessage: { deleteMany: deleteMany() },
  wabaPhoneNumber: { deleteMany: deleteMany() },
  webhookEvent: { deleteMany: deleteMany() },
  userWhatsapp: { deleteMany: deleteMany() },
  message: { deleteMany: deleteMany() },
  userApiKey: { deleteMany: deleteMany() },
  deviceToken: { deleteMany: deleteMany() },
  notificationPreference: { deleteMany: deleteMany() },
  contact: { deleteMany: deleteMany() },
  waba: { deleteMany: deleteMany() },
  user: { delete: jest.fn().mockResolvedValue({ id: 1 }) },
};

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  waba: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  userApiKey: { findMany: jest.fn().mockResolvedValue([]) },
  wabaPhoneNumber: { findMany: jest.fn().mockResolvedValue([]) },
  $transaction: jest.fn((cb: any) => cb(mockTx)),
};

const mockRedis = {
  invalidateUserCache: jest.fn(),
  deleteSsoSession: jest.fn(),
  deleteApiKeyCache: jest.fn(),
  invalidatePhoneCache: jest.fn(),
};

describe('UserService', () => {
  let service: UserService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();
    service = module.get<UserService>(UserService);
  });

  describe('findById', () => {
    it('returns user when found', async () => {
      const user = { id: 1, email: 'a@b.com' };
      mockPrisma.user.findUnique.mockResolvedValue(user);
      await expect(service.findById(1)).resolves.toEqual(user);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('returns null when not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.findById(99)).resolves.toBeNull();
    });
  });

  describe('findBySsoId', () => {
    it('returns user by ssoId', async () => {
      const user = { id: 1, ssoId: 'sso_123' };
      mockPrisma.user.findUnique.mockResolvedValue(user);
      await expect(service.findBySsoId('sso_123')).resolves.toEqual(user);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({ where: { ssoId: 'sso_123' } });
    });

    it('returns null when not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.findBySsoId('missing')).resolves.toBeNull();
    });
  });

  describe('findOrCreateBySsoId', () => {
    it('returns existing user if found', async () => {
      const existing = { id: 1, ssoId: 'sso_1', createdAt: new Date() };
      mockPrisma.user.findUnique.mockResolvedValue(existing);
      const result = await service.findOrCreateBySsoId('sso_1');
      expect(result).toEqual(existing);
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('creates and returns new user when not found', async () => {
      const created = { id: 2, ssoId: 'sso_1', createdAt: new Date() };
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue(created);
      const result = await service.findOrCreateBySsoId('sso_1');
      expect(result).toEqual(created);
      expect(mockPrisma.user.create).toHaveBeenCalledWith({ data: { ssoId: 'sso_1' } });
    });
  });

  describe('deleteAccount', () => {
    const withWabas = () => {
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'w1', ssoOrgId: 'org_1' },
        { wabaId: 'w2', ssoOrgId: 'org_1' },
      ]);
      mockPrisma.userApiKey.findMany.mockResolvedValue([{ accessKey: 'ak_1' }]);
      mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue([{ phoneNumberId: 'p1' }]);
    };

    it('deletes only this platform\'s data, scoped to the user', async () => {
      withWabas();
      mockPrisma.waba.count.mockResolvedValue(0);
      mockTx.waba.deleteMany.mockResolvedValue({ count: 2 });
      mockTx.message.deleteMany.mockResolvedValue({ count: 7 });

      const result = await service.deleteAccount(1, 'sess_1');

      const byWaba = { wabaId: { in: ['w1', 'w2'] } };
      expect(mockTx.messageTemplate.deleteMany).toHaveBeenCalledWith({ where: byWaba });
      expect(mockTx.wabaPhoneNumber.deleteMany).toHaveBeenCalledWith({ where: byWaba });
      expect(mockTx.message.deleteMany).toHaveBeenCalledWith({ where: { userId: 1 } });
      expect(mockTx.userApiKey.deleteMany).toHaveBeenCalledWith({ where: { userId: 1 } });
      expect(mockTx.waba.deleteMany).toHaveBeenCalledWith({ where: { userId: 1 } });
      expect(mockTx.user.delete).toHaveBeenCalledWith({ where: { id: 1 } });
      expect(result.wabas).toBe(2);
      expect(result.messages).toBe(7);
    });

    it('runs the whole delete in one transaction', async () => {
      withWabas();
      mockPrisma.waba.count.mockResolvedValue(0);
      await service.deleteAccount(1);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('keeps contacts when another user still holds a WABA in the organisation', async () => {
      // Contacts are org-scoped, not user-owned — deleting one member's account
      // must never wipe a colleague's contact list.
      withWabas();
      mockPrisma.waba.count.mockResolvedValue(1);

      const result = await service.deleteAccount(1);

      expect(mockTx.contact.deleteMany).not.toHaveBeenCalled();
      expect(result.contacts).toBe(0);
    });

    it('deletes contacts once no other user of this platform is left in the org', async () => {
      withWabas();
      mockPrisma.waba.count.mockResolvedValue(0);
      mockTx.contact.deleteMany.mockResolvedValue({ count: 4 });

      const result = await service.deleteAccount(1);

      expect(mockTx.contact.deleteMany).toHaveBeenCalledWith({
        where: { ssoOrgId: { in: ['org_1'] } },
      });
      expect(result.contacts).toBe(4);
    });

    it('purges the caches that would otherwise outlive the rows', async () => {
      withWabas();
      mockPrisma.waba.count.mockResolvedValue(0);

      await service.deleteAccount(1, 'sess_1');

      expect(mockRedis.invalidateUserCache).toHaveBeenCalledWith(1);
      expect(mockRedis.deleteSsoSession).toHaveBeenCalledWith('sess_1');
      expect(mockRedis.deleteApiKeyCache).toHaveBeenCalledWith('ak_1');
      expect(mockRedis.invalidatePhoneCache).toHaveBeenCalledWith('p1');
    });

    it('still deletes an account that never connected a WABA', async () => {
      mockPrisma.waba.findMany.mockResolvedValue([]);
      mockPrisma.userApiKey.findMany.mockResolvedValue([]);
      mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue([]);
      mockTx.waba.deleteMany.mockResolvedValue({ count: 0 });

      const result = await service.deleteAccount(2);

      expect(mockTx.messageTemplate.deleteMany).not.toHaveBeenCalled();
      expect(mockTx.userWhatsapp.deleteMany).toHaveBeenCalledWith({ where: { userId: 2 } });
      expect(mockTx.user.delete).toHaveBeenCalledWith({ where: { id: 2 } });
      expect(result.wabas).toBe(0);
    });
  });
});
