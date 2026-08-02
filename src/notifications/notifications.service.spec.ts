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
  waba: { findUnique: jest.fn() },
  wabaOrganisation: { findMany: jest.fn() },
  notification: {
    createMany: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    updateMany: jest.fn(),
  },
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
    // One organisation holds the account unless a test says otherwise.
    mockPrisma.wabaOrganisation.findMany.mockResolvedValue([{ ssoOrgId: 'org_1' }]);
    mockFirebase.sendToTokens.mockResolvedValue({
      sent: 1,
      failed: 0,
      staleTokens: [],
    });
    mockPrisma.deviceToken.count.mockResolvedValue(1);
    mockPrisma.notificationPreference.findMany.mockResolvedValue([]);
    mockPrisma.waba.findUnique.mockResolvedValue({ ssoOrgId: 'org_1' });
    mockPrisma.notification.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.notification.count.mockResolvedValue(0);
    mockPrisma.notification.findMany.mockResolvedValue([]);

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
        // Email defaults differ on purpose: the daily summary on, because it
        // is the only thing that reports a failed send, and no marketing until
        // it is asked for.
        emailTemplateStatus: true,
        emailDailySummary: true,
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
      mockPrisma.wabaOrganisation.findMany.mockRejectedValue(new Error('db down'));
      await expect(
        service.notifyWaba('w1', 'inboundMessage', MESSAGE),
      ).resolves.toBeUndefined();
    });

    it('writes a feed entry for every organisation holding the account', async () => {
      // The feed is filtered by the organisation being viewed, so stamping one
      // organisation's id on activity for a shared account left the second
      // looking at an empty bell for its own messages.
      mockPrisma.userWhatsapp.findMany.mockResolvedValue([{ userId: 1 }]);
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
        { ssoOrgId: 'org_1' },
        { ssoOrgId: 'org_2' },
      ]);
      mockPrisma.deviceToken.findMany.mockResolvedValue([{ token: 'a' }]);

      await service.notifyWaba('w1', 'inboundMessage', MESSAGE);

      const orgs = mockPrisma.notification.createMany.mock.calls.map(
        (c: any) => c[0].data[0].ssoOrgId,
      );
      expect(orgs).toEqual(['org_1', 'org_2']);
      // Two records, one interruption: a person is buzzed once.
      expect(mockFirebase.sendToTokens).toHaveBeenCalledTimes(1);
    });

    it('records the feed entry but sends nothing when push is not configured', async () => {
      mockFirebase.enabled = false;
      mockPrisma.userWhatsapp.findMany.mockResolvedValue([{ userId: 1 }]);

      await service.notifyWaba('w1', 'inboundMessage', MESSAGE);

      // The event still happened, and the bell is where someone finds out.
      expect(mockPrisma.notification.createMany).toHaveBeenCalled();
      expect(mockPrisma.deviceToken.findMany).not.toHaveBeenCalled();
      expect(mockFirebase.sendToTokens).not.toHaveBeenCalled();
    });

    it('writes one feed entry per recipient, stamped with the WABA’s organisation', async () => {
      mockPrisma.userWhatsapp.findMany.mockResolvedValue([
        { userId: 1 },
        { userId: 2 },
      ]);
      mockPrisma.deviceToken.findMany.mockResolvedValue([{ token: 'a' }]);

      await service.notifyWaba('w1', 'inboundMessage', {
        ...MESSAGE,
        link: '/messages',
      });

      expect(mockPrisma.notification.createMany).toHaveBeenCalledWith({
        data: [
          {
            userId: 1,
            ssoOrgId: 'org_1',
            kind: 'inboundMessage',
            title: 'Hi',
            body: 'There',
            link: '/messages',
          },
          {
            userId: 2,
            ssoOrgId: 'org_1',
            kind: 'inboundMessage',
            title: 'Hi',
            body: 'There',
            link: '/messages',
          },
        ],
      });
    });

    it('still pushes when the feed write fails', async () => {
      mockPrisma.userWhatsapp.findMany.mockResolvedValue([{ userId: 1 }]);
      mockPrisma.deviceToken.findMany.mockResolvedValue([{ token: 'a' }]);
      mockPrisma.notification.createMany.mockRejectedValue(new Error('db'));

      await service.notifyWaba('w1', 'inboundMessage', MESSAGE);

      expect(mockFirebase.sendToTokens).toHaveBeenCalled();
    });

    it('records the entry even for someone who switched the push off', async () => {
      // The preference silences the interruption, not the record — otherwise
      // turning push off would quietly empty the bell too.
      mockPrisma.userWhatsapp.findMany.mockResolvedValue([{ userId: 2 }]);
      mockPrisma.notificationPreference.findMany.mockResolvedValue([
        { userId: 2 },
      ]);

      await service.notifyWaba('w1', 'inboundMessage', MESSAGE);

      expect(mockPrisma.notification.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ userId: 2 })],
      });
      expect(mockFirebase.sendToTokens).not.toHaveBeenCalled();
    });
  });

  describe('the feed', () => {
    const ROW = {
      id: 4,
      kind: 'inboundMessage',
      title: 'Ada',
      body: 'Hello',
      link: '/messages',
      readAt: null,
      createdAt: new Date('2026-08-01T10:00:00Z'),
    };

    it('returns one organisation’s entries, newest first, with page metadata', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([ROW]);
      mockPrisma.notification.count.mockResolvedValue(31);

      const result = await service.list(7, 'org_1', { page: 2, limit: 10 });

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith({
        // Entries belonging to no organisation stay visible whichever one is
        // selected — an account-level notice is not about a WABA.
        where: { userId: 7, OR: [{ ssoOrgId: 'org_1' }, { ssoOrgId: null }] },
        orderBy: { createdAt: 'desc' },
        skip: 10,
        take: 10,
      });
      expect(result.data).toEqual([ROW]);
      expect(result.meta).toEqual({
        total: 31,
        totalPages: 4,
        page: 2,
        limit: 10,
      });
    });

    it('clamps a nonsense page size rather than reading the whole table', async () => {
      await service.list(7, 'org_1', { page: 0, limit: 5000 });

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 100 }),
      );
    });

    it('counts only what is unread', async () => {
      mockPrisma.notification.count.mockResolvedValue(3);

      await expect(service.unreadCount(7, 'org_1')).resolves.toBe(3);
      expect(mockPrisma.notification.count).toHaveBeenCalledWith({
        where: {
          userId: 7,
          OR: [{ ssoOrgId: 'org_1' }, { ssoOrgId: null }],
          readAt: null,
        },
      });
    });

    it('marks the named entries read and reports what is left', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 2 });
      mockPrisma.notification.count.mockResolvedValue(1);

      await expect(service.markRead(7, 'org_1', [4, 5])).resolves.toEqual({
        updated: 2,
        unread: 1,
      });
      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 7,
          OR: [{ ssoOrgId: 'org_1' }, { ssoOrgId: null }],
          readAt: null,
          id: { in: [4, 5] },
        },
        data: { readAt: expect.any(Date) as Date },
      });
    });

    it('marks the whole feed read when no ids are given', async () => {
      await service.markRead(7, 'org_1');

      const [call] = mockPrisma.notification.updateMany.mock.calls as [
        [{ where: Record<string, unknown> }],
      ];
      expect(call[0].where).not.toHaveProperty('id');
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
