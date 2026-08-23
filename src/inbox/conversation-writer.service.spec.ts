import { Test, TestingModule } from '@nestjs/testing';
import { ConversationWriterService } from './conversation-writer.service';
import { PrismaService } from 'src/prisma/prisma.service';

const mockPrisma = {
  conversation: { upsert: jest.fn() },
  wabaOrganisation: { findMany: jest.fn() },
};

describe('ConversationWriterService', () => {
  let service: ConversationWriterService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.conversation.upsert.mockResolvedValue({});
    mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
      { ssoOrgId: 'org-a' },
    ]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationWriterService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(ConversationWriterService);
  });

  const inbound = (over: Record<string, unknown> = {}) => ({
    wabaId: 'w1',
    phoneNumberId: 'p1',
    from: '919822010210',
    senderName: 'Priya',
    type: 'text',
    payload: { body: 'Thanks!' },
    timestamp: new Date('2026-08-23T10:00:00Z'),
    ...over,
  });

  const outbound = (over: Record<string, unknown> = {}) => ({
    ssoOrgId: 'org-a',
    wabaId: 'w1',
    phoneNumberId: 'p1',
    to: '919822010210',
    type: 'text',
    payload: { text: { body: 'Hello there' } },
    sentAt: new Date('2026-08-23T09:00:00Z'),
    ...over,
  });

  describe('recordInbound', () => {
    it('opens the thread with one unread and the window started', async () => {
      await service.recordInbound(inbound());

      expect(mockPrisma.conversation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            ssoOrgId_phoneNumberId_contactPhone: {
              ssoOrgId: 'org-a',
              phoneNumberId: 'p1',
              contactPhone: '919822010210',
            },
          },
          create: expect.objectContaining({
            contactName: 'Priya',
            lastDirection: 'inbound',
            lastPreview: 'Thanks!',
            lastInboundAt: new Date('2026-08-23T10:00:00Z'),
            unreadCount: 1,
          }),
        }),
      );
    });

    it('counts up, and reopens a thread someone had closed', async () => {
      await service.recordInbound(inbound());

      const { update } = mockPrisma.conversation.upsert.mock.calls[0][0];
      expect(update.unreadCount).toEqual({ increment: 1 });
      expect(update.status).toBe('open');
      expect(update.lastInboundAt).toEqual(new Date('2026-08-23T10:00:00Z'));
    });

    it('writes one row per organisation holding the account', async () => {
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
        { ssoOrgId: 'org-a' },
        { ssoOrgId: 'org-b' },
      ]);

      await service.recordInbound(inbound());

      expect(mockPrisma.conversation.upsert).toHaveBeenCalledTimes(2);
      const orgs = mockPrisma.conversation.upsert.mock.calls.map(
        (c) => c[0].where.ssoOrgId_phoneNumberId_contactPhone.ssoOrgId,
      );
      expect(orgs).toEqual(['org-a', 'org-b']);
    });

    it('does not blank a name we already have when a reply carries none', async () => {
      await service.recordInbound(inbound({ senderName: undefined }));

      const { update } = mockPrisma.conversation.upsert.mock.calls[0][0];
      expect(update).not.toHaveProperty('contactName');
    });

    it('normalises the sender, so one person is one thread', async () => {
      await service.recordInbound(inbound({ from: '+91 98220 10210' }));

      const { where } = mockPrisma.conversation.upsert.mock.calls[0][0];
      expect(where.ssoOrgId_phoneNumberId_contactPhone.contactPhone).toBe(
        '919822010210',
      );
    });

    it('ignores a reply with no usable sender', async () => {
      await service.recordInbound(inbound({ from: '' }));
      expect(mockPrisma.conversation.upsert).not.toHaveBeenCalled();
    });

    it('writes nothing for an account no organisation holds', async () => {
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([]);
      await service.recordInbound(inbound());
      expect(mockPrisma.conversation.upsert).not.toHaveBeenCalled();
    });

    it('swallows a write failure — the reply is already stored', async () => {
      mockPrisma.conversation.upsert.mockRejectedValue(new Error('deadlock'));
      await expect(service.recordInbound(inbound())).resolves.toBeUndefined();
    });
  });

  describe('recordOutbound', () => {
    it('records the send against the organisation that made it', async () => {
      await service.recordOutbound(outbound());

      expect(mockPrisma.conversation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            ssoOrgId: 'org-a',
            lastDirection: 'outbound',
            lastPreview: 'Hello there',
          }),
        }),
      );
      // Not fanned out: a send belongs to its sender, unlike a reply, which
      // the whole account receives.
      expect(mockPrisma.wabaOrganisation.findMany).not.toHaveBeenCalled();
    });

    it('leaves unread and the 24-hour window alone', async () => {
      await service.recordOutbound(outbound());

      const { create, update } =
        mockPrisma.conversation.upsert.mock.calls[0][0];
      for (const shape of [create, update]) {
        expect(shape).not.toHaveProperty('unreadCount');
        expect(shape).not.toHaveProperty('lastInboundAt');
        expect(shape).not.toHaveProperty('lastReadAt');
      }
    });

    it('names the template it sent', async () => {
      await service.recordOutbound(
        outbound({
          type: 'template',
          payload: { template: { name: 'welcome' } },
          templateName: 'order_update',
        }),
      );

      const { update } = mockPrisma.conversation.upsert.mock.calls[0][0];
      expect(update.lastPreview).toBe('Template · order_update');
    });

    it('normalises the recipient the caller spelled their own way', async () => {
      await service.recordOutbound(outbound({ to: '+91 98220 10210' }));

      const { where } = mockPrisma.conversation.upsert.mock.calls[0][0];
      expect(where.ssoOrgId_phoneNumberId_contactPhone.contactPhone).toBe(
        '919822010210',
      );
    });

    it('swallows a write failure — the message has already reached Meta', async () => {
      mockPrisma.conversation.upsert.mockRejectedValue(new Error('deadlock'));
      await expect(service.recordOutbound(outbound())).resolves.toBeUndefined();
    });
  });
});
