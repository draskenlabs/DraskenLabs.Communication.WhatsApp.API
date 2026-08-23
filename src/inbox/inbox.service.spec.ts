import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InboxService } from './inbox.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { MessagingService } from 'src/messaging/messaging.service';
import { MessageTypeEnum } from 'src/messaging/dto/send-message.dto';

const mockPrisma = {
  conversation: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  message: { findMany: jest.fn() },
  inboundMessage: { findMany: jest.fn() },
  contact: { findMany: jest.fn() },
  $transaction: jest.fn(),
};

const mockLimits = { forOrg: jest.fn() };
const mockMessaging = { sendMessage: jest.fn() };

const HOUR = 60 * 60 * 1000;

const conversation = (over: Record<string, unknown> = {}) => ({
  id: 7,
  ssoOrgId: 'org-a',
  wabaId: 'w1',
  phoneNumberId: 'p1',
  contactPhone: '919822010210',
  contactName: 'Priya',
  lastMessageAt: new Date('2026-08-23T10:00:00Z'),
  lastDirection: 'inbound',
  lastPreview: 'Thanks!',
  lastInboundAt: new Date(Date.now() - HOUR),
  unreadCount: 2,
  lastReadAt: null,
  status: 'open',
  assigneeUserId: null,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: new Date('2026-08-23T10:00:00Z'),
  ...over,
});

describe('InboxService', () => {
  let service: InboxService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.contact.findMany.mockResolvedValue([]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.inboundMessage.findMany.mockResolvedValue([]);
    mockLimits.forOrg.mockResolvedValue({ historyDays: 30 });
    mockPrisma.$transaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InboxService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: PlanLimitsService, useValue: mockLimits },
        { provide: MessagingService, useValue: mockMessaging },
      ],
    }).compile();
    service = module.get(InboxService);
  });

  /* ------------------------------------------------------------------ */

  describe('the 24-hour window', () => {
    it('is open while the customer wrote within the last day', () => {
      const window = service.windowFor(new Date(Date.now() - HOUR));
      expect(window.open).toBe(true);
      expect(window.expiresAt).toBeInstanceOf(Date);
    });

    it('has closed a day after their last message', () => {
      expect(service.windowFor(new Date(Date.now() - 25 * HOUR))).toEqual({ open: false });
    });

    it('was never open for a customer who has never written', () => {
      // A business cannot open a conversation with a free-form message at all.
      expect(service.windowFor(null)).toEqual({ open: false });
    });

    it('expires exactly 24 hours after the last reply', () => {
      const lastInbound = new Date(Date.now() - HOUR);
      const window = service.windowFor(lastInbound);
      expect(window.expiresAt?.getTime()).toBe(lastInbound.getTime() + 24 * HOUR);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('list', () => {
    it('returns the organisation’s threads, newest activity first', async () => {
      mockPrisma.conversation.findMany.mockResolvedValue([conversation()]);
      mockPrisma.conversation.count.mockResolvedValue(1);

      const result = await service.list('org-a', { page: 1, limit: 30 });

      expect(mockPrisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ ssoOrgId: 'org-a' }),
          orderBy: { lastMessageAt: 'desc' },
        }),
      );
      expect(result.data[0]).toMatchObject({
        id: 7,
        contactName: 'Priya',
        unreadCount: 2,
        lastPreview: 'Thanks!',
      });
      expect(result.data[0].window.open).toBe(true);
      expect(result.meta).toMatchObject({ total: 1, page: 1 });
    });

    it('narrows to the WABA an API key is scoped to', async () => {
      mockPrisma.conversation.findMany.mockResolvedValue([]);
      mockPrisma.conversation.count.mockResolvedValue(0);

      await service.list('org-a', {}, 'w-scoped');

      const { where } = mockPrisma.conversation.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(where.wabaId).toBe('w-scoped');
    });

    it('searches the name and the number at once', async () => {
      mockPrisma.conversation.findMany.mockResolvedValue([]);
      mockPrisma.conversation.count.mockResolvedValue(0);

      await service.list('org-a', { search: '+91 98220' });

      const { where } = mockPrisma.conversation.findMany.mock.calls[0][0] as {
        where: { OR: Record<string, unknown>[] };
      };
      expect(where.OR).toEqual([
        { contactName: { contains: '+91 98220', mode: 'insensitive' } },
        // Punctuation stripped, so a typed number matches how it is stored.
        { contactPhone: { contains: '9198220' } },
      ]);
    });

    it('filters to unread when asked', async () => {
      mockPrisma.conversation.findMany.mockResolvedValue([]);
      mockPrisma.conversation.count.mockResolvedValue(0);

      await service.list('org-a', { unreadOnly: true, status: 'open' });

      const { where } = mockPrisma.conversation.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(where.unreadCount).toEqual({ gt: 0 });
      expect(where.status).toBe('open');
    });

    it('caps the page size, however large a limit is asked for', async () => {
      mockPrisma.conversation.findMany.mockResolvedValue([]);
      mockPrisma.conversation.count.mockResolvedValue(0);

      await service.list('org-a', { limit: 5000 });

      const { take } = mockPrisma.conversation.findMany.mock.calls[0][0] as { take: number };
      expect(take).toBe(100);
    });

    it('shows the saved contact name and an opt-out beside the profile name', async () => {
      mockPrisma.conversation.findMany.mockResolvedValue([conversation()]);
      mockPrisma.conversation.count.mockResolvedValue(1);
      // Stored with punctuation, as it was typed into Contacts.
      mockPrisma.contact.findMany.mockResolvedValue([
        { phone: '+91 98220 10210', name: 'Priya Sharma', optedOut: true },
      ]);

      const result = await service.list('org-a', {});

      expect(result.data[0].savedName).toBe('Priya Sharma');
      expect(result.data[0].optedOut).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('thread', () => {
    beforeEach(() => {
      mockPrisma.conversation.findFirst.mockResolvedValue(conversation());
    });

    it('interleaves both directions in time order, oldest first', async () => {
      mockPrisma.message.findMany.mockResolvedValue([
        {
          id: 1,
          metaMessageId: 'wamid.out',
          type: 'text',
          payload: { text: { body: 'Hello' } },
          status: 'delivered',
          templateName: null,
          failureCode: null,
          failureReason: null,
          failureDetail: null,
          createdAt: new Date('2026-08-23T09:00:00Z'),
        },
      ]);
      mockPrisma.inboundMessage.findMany.mockResolvedValue([
        {
          id: 1,
          metaMessageId: 'wamid.in',
          type: 'text',
          payload: { body: 'Thanks!' },
          senderName: 'Priya',
          timestamp: new Date('2026-08-23T10:00:00Z'),
        },
      ]);

      const thread = await service.thread('org-a', 7);

      expect(thread.messages.map((m) => m.id)).toEqual(['out:1', 'in:1']);
      expect(thread.messages[0]).toMatchObject({ direction: 'outbound', status: 'delivered' });
      expect(thread.messages[1]).toMatchObject({ direction: 'inbound', senderName: 'Priya' });
    });

    it('prefixes ids by direction, so the two tables do not collide', async () => {
      mockPrisma.message.findMany.mockResolvedValue([
        {
          id: 41,
          type: 'text',
          payload: {},
          status: 'sent',
          metaMessageId: null,
          templateName: null,
          failureCode: null,
          failureReason: null,
          failureDetail: null,
          createdAt: new Date('2026-08-23T09:00:00Z'),
        },
      ]);
      mockPrisma.inboundMessage.findMany.mockResolvedValue([
        {
          id: 41,
          metaMessageId: 'wamid.in',
          type: 'text',
          payload: {},
          senderName: null,
          timestamp: new Date('2026-08-23T10:00:00Z'),
        },
      ]);

      const thread = await service.thread('org-a', 7);

      expect(new Set(thread.messages.map((m) => m.id)).size).toBe(2);
    });

    it('asks for both spellings of the number', async () => {
      await service.thread('org-a', 7);

      const outbound = mockPrisma.message.findMany.mock.calls[0][0] as {
        where: { to: { in: string[] } };
      };
      const inbound = mockPrisma.inboundMessage.findMany.mock.calls[0][0] as {
        where: { from: { in: string[] } };
      };
      expect(outbound.where.to.in).toEqual(['919822010210', '+919822010210']);
      expect(inbound.where.from.in).toEqual(['919822010210', '+919822010210']);
    });

    it('offers a media path for a received photo', async () => {
      mockPrisma.inboundMessage.findMany.mockResolvedValue([
        {
          id: 9,
          metaMessageId: 'wamid.in',
          type: 'image',
          payload: { id: 'MEDIA1', mime_type: 'image/jpeg' },
          senderName: 'Priya',
          timestamp: new Date('2026-08-23T10:00:00Z'),
        },
      ]);

      const thread = await service.thread('org-a', 7);

      // Addressed by message, not by media id: the id alone says nothing about
      // who may see it.
      expect(thread.messages[0].mediaUrl).toBe('/inbox/media/9');
    });

    it('offers no media path for a message that carries none', async () => {
      mockPrisma.inboundMessage.findMany.mockResolvedValue([
        {
          id: 9,
          metaMessageId: 'wamid.in',
          type: 'text',
          payload: { body: 'Thanks!' },
          senderName: null,
          timestamp: new Date('2026-08-23T10:00:00Z'),
        },
      ]);

      const thread = await service.thread('org-a', 7);
      expect(thread.messages[0].mediaUrl).toBeUndefined();
    });

    it('carries Meta’s reason for a failed send', async () => {
      mockPrisma.message.findMany.mockResolvedValue([
        {
          id: 2,
          metaMessageId: null,
          type: 'text',
          payload: {},
          status: 'failed',
          templateName: null,
          failureCode: 131047,
          failureReason: 'Re-engagement message',
          failureDetail: 'More than 24 hours have passed.',
          createdAt: new Date('2026-08-23T09:00:00Z'),
        },
      ]);

      const thread = await service.thread('org-a', 7);

      expect(thread.messages[0].error).toEqual({
        code: 131047,
        title: 'Re-engagement message',
        detail: 'More than 24 hours have passed.',
      });
    });

    it('pages backwards from a cursor', async () => {
      await service.thread('org-a', 7, { before: '2026-08-23T09:30:00Z' });

      const outbound = mockPrisma.message.findMany.mock.calls[0][0] as {
        where: { createdAt: { lt: Date } };
      };
      expect(outbound.where.createdAt.lt).toEqual(new Date('2026-08-23T09:30:00Z'));
    });

    it('refuses a cursor that is not a timestamp', async () => {
      await expect(service.thread('org-a', 7, { before: 'yesterday' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('hands back a cursor while there is more to read', async () => {
      mockPrisma.inboundMessage.findMany.mockResolvedValue(
        Array.from({ length: 2 }, (_, i) => ({
          id: i + 1,
          metaMessageId: `wamid.${i}`,
          type: 'text',
          payload: {},
          senderName: null,
          timestamp: new Date(Date.parse('2026-08-23T10:00:00Z') - i * HOUR),
        })),
      );

      const thread = await service.thread('org-a', 7, { limit: 2 });

      expect(thread.messages).toHaveLength(2);
      expect(thread.nextCursor).toBe(thread.messages[0].timestamp.toISOString());
    });

    it('offers no cursor once the thread is read back to its start', async () => {
      mockPrisma.inboundMessage.findMany.mockResolvedValue([
        {
          id: 1,
          metaMessageId: 'wamid.in',
          type: 'text',
          payload: {},
          senderName: null,
          timestamp: new Date('2026-08-23T10:00:00Z'),
        },
      ]);

      const thread = await service.thread('org-a', 7, { limit: 50 });
      expect(thread.nextCursor).toBeUndefined();
    });

    it('says how much history the plan keeps, so a short thread is explicable', async () => {
      const thread = await service.thread('org-a', 7);
      expect(thread.historyDays).toBe(30);
    });

    it('says nothing about history on a plan that keeps everything', async () => {
      mockLimits.forOrg.mockResolvedValue({ historyDays: null });
      const thread = await service.thread('org-a', 7);
      expect(thread.historyDays).toBeUndefined();
    });

    it('hides a conversation belonging to another organisation', async () => {
      mockPrisma.conversation.findFirst.mockResolvedValue(null);
      await expect(service.thread('org-b', 7)).rejects.toThrow(NotFoundException);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('markRead', () => {
    it('clears the count for the calling organisation', async () => {
      mockPrisma.conversation.findFirst.mockResolvedValue(conversation());
      mockPrisma.conversation.update.mockResolvedValue(
        conversation({ unreadCount: 0, lastReadAt: new Date() }),
      );

      const result = await service.markRead('org-a', 7);

      expect(mockPrisma.conversation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 7 },
          data: expect.objectContaining({ unreadCount: 0 }),
        }),
      );
      expect(result.unreadCount).toBe(0);
    });

    it('refuses a conversation the caller cannot see', async () => {
      mockPrisma.conversation.findFirst.mockResolvedValue(null);
      await expect(service.markRead('org-b', 7)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.conversation.update).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    beforeEach(() => {
      mockPrisma.conversation.findFirst.mockResolvedValue(conversation());
      mockPrisma.conversation.update.mockResolvedValue(conversation({ status: 'closed' }));
    });

    it('closes a thread', async () => {
      await service.update('org-a', 7, { status: 'closed' as never });

      const { data } = mockPrisma.conversation.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data.status).toBe('closed');
    });

    it('clears an assignment when told to, and leaves it alone otherwise', async () => {
      await service.update('org-a', 7, { assigneeUserId: null });
      expect(
        (mockPrisma.conversation.update.mock.calls[0][0] as { data: Record<string, unknown> })
          .data.assigneeUserId,
      ).toBeNull();

      mockPrisma.conversation.update.mockClear();
      await service.update('org-a', 7, { status: 'closed' as never });
      expect(
        (mockPrisma.conversation.update.mock.calls[0][0] as { data: Record<string, unknown> })
          .data,
      ).not.toHaveProperty('assigneeUserId');
    });
  });

  /* ------------------------------------------------------------------ */

  describe('reply', () => {
    it('sends to the thread’s own customer and number, not the caller’s idea of them', async () => {
      mockPrisma.conversation.findFirst.mockResolvedValue(conversation());
      mockMessaging.sendMessage.mockResolvedValue({ id: 1 });

      await service.reply(3, 'org-a', 7, { type: MessageTypeEnum.text, text: 'Hi' } as never);

      expect(mockMessaging.sendMessage).toHaveBeenCalledWith(
        3,
        'org-a',
        expect.objectContaining({
          to: '919822010210',
          phoneNumberId: 'p1',
          type: 'text',
          text: 'Hi',
        }),
        undefined,
      );
    });

    it('refuses a free-form reply once the window has closed', async () => {
      mockPrisma.conversation.findFirst.mockResolvedValue(
        conversation({ lastInboundAt: new Date(Date.now() - 25 * HOUR) }),
      );

      await expect(
        service.reply(3, 'org-a', 7, { type: MessageTypeEnum.text, text: 'Hi' } as never),
      ).rejects.toThrow(/24-hour customer service window has closed/);
      expect(mockMessaging.sendMessage).not.toHaveBeenCalled();
    });

    it('allows a template once the window has closed', async () => {
      mockPrisma.conversation.findFirst.mockResolvedValue(
        conversation({ lastInboundAt: new Date(Date.now() - 25 * HOUR) }),
      );
      mockMessaging.sendMessage.mockResolvedValue({ id: 1 });

      await service.reply(3, 'org-a', 7, {
        type: MessageTypeEnum.template,
        templateName: 'order_update',
        templateLanguage: 'en_US',
      } as never);

      expect(mockMessaging.sendMessage).toHaveBeenCalled();
    });

    it('explains a customer who has never written differently', async () => {
      mockPrisma.conversation.findFirst.mockResolvedValue(
        conversation({ lastInboundAt: null }),
      );

      await expect(
        service.reply(3, 'org-a', 7, { type: MessageTypeEnum.text, text: 'Hi' } as never),
      ).rejects.toThrow(/never replied/);
    });

    it('passes the API key’s WABA scope through to the send', async () => {
      mockPrisma.conversation.findFirst.mockResolvedValue(conversation());
      mockMessaging.sendMessage.mockResolvedValue({ id: 1 });

      await service.reply(
        3,
        'org-a',
        7,
        { type: MessageTypeEnum.text, text: 'Hi' } as never,
        'w1',
      );

      expect(mockMessaging.sendMessage).toHaveBeenCalledWith(
        3,
        'org-a',
        expect.anything(),
        'w1',
      );
    });

    it('refuses to reply in a conversation the caller cannot see', async () => {
      mockPrisma.conversation.findFirst.mockResolvedValue(null);
      await expect(
        service.reply(3, 'org-b', 7, { type: MessageTypeEnum.text, text: 'Hi' } as never),
      ).rejects.toThrow(NotFoundException);
      expect(mockMessaging.sendMessage).not.toHaveBeenCalled();
    });
  });
});
