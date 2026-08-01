import { Test, TestingModule } from '@nestjs/testing';
import { InboundMessageHandler } from './inbound-message.handler';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';

const mockPrisma = {
  inboundMessage: { upsert: jest.fn() },
};

const mockNotifications = {
  notifyWaba: jest.fn().mockResolvedValue(undefined),
  notifyUsers: jest.fn().mockResolvedValue(undefined),
};

describe('InboundMessageHandler', () => {
  let handler: InboundMessageHandler;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InboundMessageHandler,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications }],
    }).compile();
    handler = module.get<InboundMessageHandler>(InboundMessageHandler);
  });

  it('upserts inbound message with parsed timestamp', async () => {
    mockPrisma.inboundMessage.upsert.mockResolvedValue({});

    const message = {
      id: 'wamid.abc',
      from: '447911111111',
      timestamp: '1700000000',
      type: 'text',
      text: { body: 'Hello' },
    };

    await handler.handle('waba1', 'phone1', message, 'Alice');

    expect(mockPrisma.inboundMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { metaMessageId: 'wamid.abc' },
        create: expect.objectContaining({
          metaMessageId: 'wamid.abc',
          wabaId: 'waba1',
          phoneNumberId: 'phone1',
          from: '447911111111',
          senderName: 'Alice',
          type: 'text',
          payload: { body: 'Hello' },
          timestamp: new Date(1700000000 * 1000),
        }),
        update: {},
      }),
    );
  });

  it('is idempotent — update is empty object', async () => {
    mockPrisma.inboundMessage.upsert.mockResolvedValue({});
    const msg = { id: 'wamid.x', from: '111', timestamp: '1700000000', type: 'text', text: {} };
    await handler.handle('w', 'p', msg, undefined);
    const call = mockPrisma.inboundMessage.upsert.mock.calls[0][0];
    expect(call.update).toEqual({});
  });

  it('does not throw if upsert fails — logs error instead', async () => {
    mockPrisma.inboundMessage.upsert.mockRejectedValue(new Error('DB error'));
    const msg = { id: 'wamid.fail', from: '111', timestamp: '1700000000', type: 'text', text: {} };
    await expect(handler.handle('w', 'p', msg, undefined)).resolves.toBeUndefined();
  });
});

describe('InboundMessageHandler notifications', () => {
  let handler: InboundMessageHandler;

  const message = (over: Record<string, unknown> = {}) => ({
    id: 'wamid.n1',
    from: '447911111111',
    timestamp: '1700000000',
    type: 'text',
    text: { body: 'Where is my order?' },
    ...over,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.inboundMessage.upsert.mockResolvedValue({});
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InboundMessageHandler,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();
    handler = module.get<InboundMessageHandler>(InboundMessageHandler);
  });

  it('notifies the WABA with the sender name and a text preview', async () => {
    await handler.handle('waba1', 'phone1', message(), 'Alice');

    expect(mockNotifications.notifyWaba).toHaveBeenCalledWith(
      'waba1',
      'inboundMessage',
      expect.objectContaining({
        title: 'Alice',
        body: 'Where is my order?',
        link: '/messages',
      }),
    );
  });

  it('falls back to the number when WhatsApp gives no profile name', async () => {
    await handler.handle('waba1', 'phone1', message(), undefined);

    expect(mockNotifications.notifyWaba).toHaveBeenCalledWith(
      'waba1',
      'inboundMessage',
      expect.objectContaining({ title: 'New message from 447911111111' }),
    );
  });

  it('describes a media message that carries no text', async () => {
    await handler.handle(
      'waba1',
      'phone1',
      message({ type: 'image', text: undefined, image: { id: 'media1' } }),
      'Alice',
    );

    expect(mockNotifications.notifyWaba).toHaveBeenCalledWith(
      'waba1',
      'inboundMessage',
      expect.objectContaining({ body: 'Sent a photo' }),
    );
  });

  it('truncates a long message rather than pushing an essay', async () => {
    await handler.handle(
      'waba1',
      'phone1',
      message({ text: { body: 'x'.repeat(400) } }),
      'Alice',
    );

    const calls = mockNotifications.notifyWaba.mock.calls as unknown as [
      string,
      string,
      { body: string },
    ][];
    const push = calls[0][2];
    expect(push.body).toHaveLength(118);
    expect(push.body.endsWith('…')).toBe(true);
  });

  it('still notifies when the message could not be stored', async () => {
    // The customer replied whether or not our database accepted the row.
    mockPrisma.inboundMessage.upsert.mockRejectedValue(new Error('DB error'));

    await handler.handle('waba1', 'phone1', message(), 'Alice');

    expect(mockNotifications.notifyWaba).toHaveBeenCalled();
  });
});
