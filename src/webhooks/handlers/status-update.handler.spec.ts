import { Test, TestingModule } from '@nestjs/testing';
import { StatusUpdateHandler } from './status-update.handler';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { MailService } from 'src/mail/mail.service';
import { mailServiceDouble } from 'src/mail/mail.test-doubles';

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

const mockMail = mailServiceDouble();

describe('StatusUpdateHandler', () => {
  let handler: StatusUpdateHandler;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: MailService, useValue: mockMail },
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
        { provide: MailService, useValue: mockMail },
        StatusUpdateHandler,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();
    handler = module.get<StatusUpdateHandler>(StatusUpdateHandler);
  });

  it("notifies the sender when a message fails, quoting Meta's reason", async () => {
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

    expect(mockNotifications.notifyUsers).toHaveBeenCalledWith(
      [9],
      'messageFailed',
      expect.objectContaining({
        title: 'Message failed to deliver',
        body: 'To 447911111111: Message undeliverable',
        link: '/messages/5',
      }),
    );
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
