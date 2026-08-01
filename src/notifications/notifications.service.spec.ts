import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import { FirebaseService } from './firebase.service';
import { PrismaService } from 'src/prisma/prisma.service';

const mockPrisma = {
  deviceToken: {
    upsert: jest.fn(),
    count: jest.fn(),
    deleteMany: jest.fn(),
    findMany: jest.fn(),
  },
  notificationPreference: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    upsert: jest.fn(),
  },
  userWhatsapp: { findMany: jest.fn() },
};

const mockFirebase = {
  enabled: true,
  sendToTokens: jest.fn(),
};

const MESSAGE = { title: 'Hi', body: 'There' };

describe('NotificationsService', () => {
  let service: NotificationsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFirebase.enabled = true;
    mockFirebase.sendToTokens.mockResolvedValue({
      sent: 1,
      failed: 0,
      staleTokens: [],
    });
    mockPrisma.deviceToken.count.mockResolvedValue(1);
    mockPrisma.notificationPreference.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: FirebaseService, useValue: mockFirebase },
      ],
    }).compile();
    service = module.get<NotificationsService>(NotificationsService);
  });

  describe('registerToken', () => {
    it('upserts on the token so the same browser never duplicates', async () => {
      await service.registerToken(7, 'org_1', {
        token: 'tok',
        platform: 'web',
      });

      expect(mockPrisma.deviceToken.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { token: 'tok' },
          create: expect.objectContaining({ userId: 7, ssoOrgId: 'org_1' }),
          // Re-registering moves the device to the current user/org.
          update: expect.objectContaining({ userId: 7, ssoOrgId: 'org_1' }),
        }),
      );
    });
  });

  describe('removeToken', () => {
    it('scopes the delete to the caller, so one user cannot unregister another', async () => {
      await service.removeToken(7, 'tok');
      expect(mockPrisma.deviceToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 7, token: 'tok' },
      });
    });
  });

  describe('getPreferences', () => {
    it('treats a missing row as everything on', async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);
      mockPrisma.deviceToken.count.mockResolvedValue(2);

      const prefs = await service.getPreferences(7);

      expect(prefs).toEqual({
        inboundMessage: true,
        templateStatus: true,
        messageFailed: true,
        // Email defaults differ on purpose: nothing that would mail on every
        // reply, and no marketing until it is asked for.
        emailInboundMessage: false,
        emailTemplateStatus: true,
        emailMessageFailed: true,
        emailWeeklySummary: false,
        emailProductNews: false,
        deviceCount: 2,
        pushEnabled: true,
      });
    });

    it('reports push as unavailable when the server has no credentials', async () => {
      mockFirebase.enabled = false;
      mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);

      expect((await service.getPreferences(7)).pushEnabled).toBe(false);
    });
  });

  describe('notifyWaba', () => {
    it('sends to every device of every user connected to the WABA', async () => {
      mockPrisma.userWhatsapp.findMany.mockResolvedValue([
        { userId: 1 },
        { userId: 2 },
        { userId: 1 },
      ]);
      mockPrisma.deviceToken.findMany.mockResolvedValue([
        { token: 'a' },
        { token: 'b' },
      ]);

      await service.notifyWaba('w1', 'inboundMessage', MESSAGE);

      // The duplicate connection must not become a duplicate recipient.
      expect(mockPrisma.notificationPreference.findMany).toHaveBeenCalledWith({
        where: { userId: { in: [1, 2] }, inboundMessage: false },
        select: { userId: true },
      });
      expect(mockFirebase.sendToTokens).toHaveBeenCalledWith(
        ['a', 'b'],
        MESSAGE,
      );
    });

    it('skips users who switched that notification off', async () => {
      mockPrisma.userWhatsapp.findMany.mockResolvedValue([
        { userId: 1 },
        { userId: 2 },
      ]);
      mockPrisma.notificationPreference.findMany.mockResolvedValue([
        { userId: 2 },
      ]);
      mockPrisma.deviceToken.findMany.mockResolvedValue([{ token: 'a' }]);

      await service.notifyWaba('w1', 'inboundMessage', MESSAGE);

      expect(mockPrisma.deviceToken.findMany).toHaveBeenCalledWith({
        where: { userId: { in: [1] } },
        select: { token: true },
      });
    });

    it('does nothing when nobody is connected to the WABA', async () => {
      mockPrisma.userWhatsapp.findMany.mockResolvedValue([]);
      await service.notifyWaba('w1', 'inboundMessage', MESSAGE);
      expect(mockFirebase.sendToTokens).not.toHaveBeenCalled();
    });

    it('swallows a database failure — a webhook must still be acknowledged', async () => {
      mockPrisma.userWhatsapp.findMany.mockRejectedValue(new Error('db down'));
      await expect(
        service.notifyWaba('w1', 'inboundMessage', MESSAGE),
      ).resolves.toBeUndefined();
    });

    it('does not query anything when push is not configured', async () => {
      mockFirebase.enabled = false;
      mockPrisma.userWhatsapp.findMany.mockResolvedValue([{ userId: 1 }]);

      await service.notifyWaba('w1', 'inboundMessage', MESSAGE);

      expect(mockPrisma.deviceToken.findMany).not.toHaveBeenCalled();
      expect(mockFirebase.sendToTokens).not.toHaveBeenCalled();
    });
  });

  describe('stale tokens', () => {
    it('deletes the registrations Firebase says are dead', async () => {
      mockPrisma.deviceToken.findMany.mockResolvedValue([
        { token: 'live' },
        { token: 'dead' },
      ]);
      mockFirebase.sendToTokens.mockResolvedValue({
        sent: 1,
        failed: 1,
        staleTokens: ['dead'],
      });

      await service.sendToUser(7, MESSAGE);

      expect(mockPrisma.deviceToken.deleteMany).toHaveBeenCalledWith({
        where: { token: { in: ['dead'] } },
      });
    });

    it('still reports the send when pruning fails', async () => {
      mockPrisma.deviceToken.findMany.mockResolvedValue([{ token: 'dead' }]);
      mockFirebase.sendToTokens.mockResolvedValue({
        sent: 0,
        failed: 1,
        staleTokens: ['dead'],
      });
      mockPrisma.deviceToken.deleteMany.mockRejectedValue(new Error('nope'));

      await expect(service.sendToUser(7, MESSAGE)).resolves.toEqual({
        sent: 0,
        failed: 1,
      });
    });
  });
});
