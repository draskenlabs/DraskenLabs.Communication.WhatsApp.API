import { Test, TestingModule } from '@nestjs/testing';
import { StatusUpdateHandler } from './status-update.handler';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';

const mockPrisma = {
  message: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

const mockNotifications = {
  notifyWaba: jest.fn().mockResolvedValue(undefined),
  notifyUsers: jest.fn().mockResolvedValue(undefined),
};

describe('StatusUpdateHandler', () => {
  let handler: StatusUpdateHandler;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatusUpdateHandler,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications }],
    }).compile();
    handler = module.get<StatusUpdateHandler>(StatusUpdateHandler);
  });

  it('does nothing if message not found', async () => {
    mockPrisma.message.findUnique.mockResolvedValue(null);
    await handler.handle({ id: 'wamid.abc', status: 'delivered' });
    expect(mockPrisma.message.update).not.toHaveBeenCalled();
  });

  it('updates status from sent to delivered', async () => {
    mockPrisma.message.findUnique.mockResolvedValue({ id: 1, status: 'sent' });
    mockPrisma.message.update.mockResolvedValue({});
    await handler.handle({ id: 'wamid.abc', status: 'delivered' });
    expect(mockPrisma.message.update).toHaveBeenCalledWith({
      where: { metaMessageId: 'wamid.abc' },
      // Stamped as well as set: `updatedAt` cannot say when a message was
      // delivered once it has also been read.
      data: { status: 'delivered', deliveredAt: expect.any(Date) as Date },
    });
  });

  it('does not downgrade status from read to delivered', async () => {
    mockPrisma.message.findUnique.mockResolvedValue({ id: 1, status: 'read' });
    await handler.handle({ id: 'wamid.abc', status: 'delivered' });
    expect(mockPrisma.message.update).not.toHaveBeenCalled();
  });

  it('advances status to read', async () => {
    mockPrisma.message.findUnique.mockResolvedValue({
      id: 1,
      status: 'delivered',
      deliveredAt: new Date('2026-08-01T10:00:00Z'),
    });
    mockPrisma.message.update.mockResolvedValue({});
    await handler.handle({ id: 'wamid.abc', status: 'read' });
    expect(mockPrisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: 'read',
          readAt: expect.any(Date) as Date,
          // The existing delivery time is kept, not overwritten with now.
          deliveredAt: new Date('2026-08-01T10:00:00Z'),
        },
      }),
    );
  });

  it('treats a read as a delivery when Meta never reported one', async () => {
    mockPrisma.message.findUnique.mockResolvedValue({
      id: 1,
      status: 'sent',
      deliveredAt: null,
    });
    mockPrisma.message.update.mockResolvedValue({});

    await handler.handle({ id: 'wamid.abc', status: 'read' });

    const [call] = mockPrisma.message.update.mock.calls as [
      [{ data: { deliveredAt: Date | null } }],
    ];
    expect(call[0].data.deliveredAt).toBeInstanceOf(Date);
  });

  it('records why a send failed, so causes can be ranked later', async () => {
    mockPrisma.message.findUnique.mockResolvedValue({ id: 1, status: 'sent' });
    mockPrisma.message.update.mockResolvedValue({});

    await handler.handle({
      id: 'wamid.abc',
      status: 'failed',
      errors: [{ title: 'Message undeliverable' }],
    });

    expect(mockPrisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureReason: 'Message undeliverable',
          failedAt: expect.any(Date) as Date,
        }),
      }),
    );
  });

  it("keeps Meta's code and explanation, not just the title", async () => {
    mockPrisma.message.findUnique.mockResolvedValue({ id: 1, status: 'sent' });
    mockPrisma.message.update.mockResolvedValue({});

    await handler.handle({
      id: 'wamid.abc',
      status: 'failed',
      errors: [
        {
          code: 131047,
          title: 'Re-engagement message',
          message: 'Re-engagement message',
          error_data: {
            details:
              'Message failed to send because more than 24 hours have passed ' +
              'since the customer last replied to this number.',
          },
        },
      ],
    });

    expect(mockPrisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureReason: 'Re-engagement message',
          failureCode: 131047,
          failureDetail:
            'Message failed to send because more than 24 hours have passed ' +
            'since the customer last replied to this number.',
        }),
      }),
    );
  });

  it('does not repeat the title as the detail', async () => {
    mockPrisma.message.findUnique.mockResolvedValue({ id: 1, status: 'sent' });
    mockPrisma.message.update.mockResolvedValue({});

    await handler.handle({
      id: 'wamid.abc',
      status: 'failed',
      errors: [
        {
          code: 131026,
          title: 'Message undeliverable',
          message: 'Message undeliverable',
        },
      ],
    });

    expect(mockPrisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureReason: 'Message undeliverable',
          failureCode: 131026,
          failureDetail: null,
        }),
      }),
    );
  });

  it('clears nothing it cannot read — an errorless failure stores nulls', async () => {
    mockPrisma.message.findUnique.mockResolvedValue({ id: 1, status: 'sent' });
    mockPrisma.message.update.mockResolvedValue({});

    await handler.handle({ id: 'wamid.abc', status: 'failed' });

    expect(mockPrisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureReason: null,
          failureCode: null,
          failureDetail: null,
        }),
      }),
    );
  });

  it('ignores unknown status values', async () => {
    mockPrisma.message.findUnique.mockResolvedValue({ id: 1, status: 'sent' });
    await handler.handle({ id: 'wamid.abc', status: 'unknown_status' });
    expect(mockPrisma.message.update).not.toHaveBeenCalled();
  });
});

describe('StatusUpdateHandler notifications', () => {
  let handler: StatusUpdateHandler;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatusUpdateHandler,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();
    handler = module.get<StatusUpdateHandler>(StatusUpdateHandler);
  });

  it("records a failure with Meta's reason and interrupts nobody", async () => {
    // A bad campaign fails hundreds in a row. The failure is stored and
    // reported once, in the next daily summary — not pushed or mailed here.
    mockPrisma.message.findUnique.mockResolvedValue({
      id: 5,
      status: 'sent',
      userId: 9,
      to: '447911111111',
    });
    mockPrisma.message.update.mockResolvedValue({});

    await handler.handle({
      id: 'wamid.1',
      status: 'failed',
      errors: [{ title: 'Message undeliverable' }],
    });

    expect(mockPrisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          failureReason: 'Message undeliverable',
        }),
      }),
    );
    expect(mockNotifications.notifyUsers).not.toHaveBeenCalled();
  });

  it('says nothing for sent, delivered or read — that would be constant noise', async () => {
    mockPrisma.message.findUnique.mockResolvedValue({
      id: 5,
      status: 'sent',
      userId: 9,
      to: '447911111111',
    });
    mockPrisma.message.update.mockResolvedValue({});

    await handler.handle({ id: 'wamid.1', status: 'delivered' });

    expect(mockNotifications.notifyUsers).not.toHaveBeenCalled();
  });
});
