import { Test, TestingModule } from '@nestjs/testing';
import { TemplateStatusHandler } from './template-status.handler';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import { mailNotificationsDouble } from 'src/mail/mail.test-doubles';

const mockPrisma = {
  messageTemplate: { updateMany: jest.fn(), findFirst: jest.fn() },
};

const mockNotifications = {
  notifyWaba: jest.fn().mockResolvedValue(undefined),
  notifyUsers: jest.fn().mockResolvedValue(undefined),
};

const mockMailNotifications = mailNotificationsDouble();

describe('TemplateStatusHandler', () => {
  let handler: TemplateStatusHandler;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: MailNotifications, useValue: mockMailNotifications },
        TemplateStatusHandler,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications }],
    }).compile();
    handler = module.get<TemplateStatusHandler>(TemplateStatusHandler);
  });

  it('updates template status to APPROVED', async () => {
    mockPrisma.messageTemplate.updateMany.mockResolvedValue({ count: 1 });
    await handler.handle({ event: 'APPROVED', message_template_id: 123, message_template_name: 'hello', message_template_language: 'en_US', reason: 'NONE' });
    expect(mockPrisma.messageTemplate.updateMany).toHaveBeenCalledWith({
      where: { metaTemplateId: '123' },
      data: { status: 'APPROVED', rejectedReason: null },
    });
  });

  it('stores rejectedReason when REJECTED with reason', async () => {
    mockPrisma.messageTemplate.updateMany.mockResolvedValue({ count: 1 });
    await handler.handle({ event: 'REJECTED', message_template_id: 456, message_template_name: 'promo', message_template_language: 'en', reason: 'ABUSIVE_CONTENT' });
    expect(mockPrisma.messageTemplate.updateMany).toHaveBeenCalledWith({
      where: { metaTemplateId: '456' },
      data: { status: 'REJECTED', rejectedReason: 'ABUSIVE_CONTENT' },
    });
  });

  it('ignores Meta\'s "NONE" sentinel rather than storing it as a reason', async () => {
    mockPrisma.messageTemplate.updateMany.mockResolvedValue({ count: 1 });
    await handler.handle({ event: 'FLAGGED', message_template_id: 321, message_template_name: 'promo', message_template_language: 'en', reason: 'NONE' });
    expect(mockPrisma.messageTemplate.updateMany).toHaveBeenCalledWith({
      where: { metaTemplateId: '321' },
      data: { status: 'FLAGGED' },
    });
  });

  it('prefers the sentence in other_info over the enum in reason', async () => {
    // The enum says which rule was broken; `other_info` says what to change.
    // Whoever has to fix the template needs the second one.
    mockPrisma.messageTemplate.updateMany.mockResolvedValue({ count: 1 });
    await handler.handle({
      event: 'REJECTED',
      message_template_id: 457,
      message_template_name: 'promo',
      message_template_language: 'en',
      reason: 'INCORRECT_CATEGORY',
      other_info: {
        title: 'INCORRECT_CATEGORY',
        description: 'Send this as MARKETING rather than UTILITY.',
      },
    });
    expect(mockPrisma.messageTemplate.updateMany).toHaveBeenCalledWith({
      where: { metaTemplateId: '457' },
      data: {
        status: 'REJECTED',
        rejectedReason: 'Send this as MARKETING rather than UTILITY.',
      },
    });
  });

  it('reads other_info when Meta sends it as a JSON string', async () => {
    mockPrisma.messageTemplate.updateMany.mockResolvedValue({ count: 1 });
    await handler.handle({
      event: 'REJECTED',
      message_template_id: 458,
      message_template_name: 'promo',
      message_template_language: 'en',
      reason: 'NONE',
      other_info: '{"title":"SCAM","description":"Looks like a scam."}',
    });
    expect(mockPrisma.messageTemplate.updateMany).toHaveBeenCalledWith({
      where: { metaTemplateId: '458' },
      data: { status: 'REJECTED', rejectedReason: 'Looks like a scam.' },
    });
  });

  it('falls back to other_info when reason is the NONE sentinel', async () => {
    // Meta rejects with `reason: "NONE"` more often than not; reading `reason`
    // alone left the console showing a rejected template and no explanation.
    mockPrisma.messageTemplate.updateMany.mockResolvedValue({ count: 1 });
    await handler.handle({
      event: 'REJECTED',
      message_template_id: 459,
      message_template_name: 'promo',
      message_template_language: 'en',
      reason: 'NONE',
      other_info: { title: 'ABUSIVE_CONTENT' },
    });
    expect(mockPrisma.messageTemplate.updateMany).toHaveBeenCalledWith({
      where: { metaTemplateId: '459' },
      data: { status: 'REJECTED', rejectedReason: 'ABUSIVE_CONTENT' },
    });
  });

  it('maps a PAUSED event to the PAUSED status', async () => {
    mockPrisma.messageTemplate.updateMany.mockResolvedValue({ count: 1 });
    await handler.handle({ event: 'PAUSED', message_template_id: 789, message_template_name: 'promo', message_template_language: 'en_US', reason: 'NONE' });
    expect(mockPrisma.messageTemplate.updateMany).toHaveBeenCalledWith({
      where: { metaTemplateId: '789' },
      data: { status: 'PAUSED' },
    });
  });

  it('maps a PENDING_DELETION event', async () => {
    mockPrisma.messageTemplate.updateMany.mockResolvedValue({ count: 1 });
    await handler.handle({ event: 'PENDING_DELETION', message_template_id: 790, message_template_name: 'promo', message_template_language: 'en_US', reason: 'NONE' });
    expect(mockPrisma.messageTemplate.updateMany).toHaveBeenCalledWith({
      where: { metaTemplateId: '790' },
      data: { status: 'PENDING_DELETION' },
    });
  });

  it('maps an ARCHIVED event, which stops the template being sendable', async () => {
    mockPrisma.messageTemplate.updateMany.mockResolvedValue({ count: 1 });
    await handler.handle({ event: 'ARCHIVED', message_template_id: 791, message_template_name: 'promo', message_template_language: 'en_US', reason: 'NONE' });
    expect(mockPrisma.messageTemplate.updateMany).toHaveBeenCalledWith({
      where: { metaTemplateId: '791' },
      data: { status: 'ARCHIVED' },
    });
  });

  it('does nothing for unknown event type', async () => {
    await handler.handle({ event: 'UNKNOWN_EVENT', message_template_id: 1 });
    expect(mockPrisma.messageTemplate.updateMany).not.toHaveBeenCalled();
  });
});

describe('TemplateStatusHandler notifications', () => {
  let handler: TemplateStatusHandler;

  const event = (over: Record<string, unknown> = {}) => ({
    event: 'APPROVED',
    message_template_id: '123',
    message_template_name: 'order_shipped',
    message_template_language: 'en_US',
    reason: 'NONE',
    ...over,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.messageTemplate.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.messageTemplate.findFirst.mockResolvedValue({
      id: 12,
      wabaId: 'waba1',
      name: 'order_shipped',
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: MailNotifications, useValue: mockMailNotifications },
        TemplateStatusHandler,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();
    handler = module.get<TemplateStatusHandler>(TemplateStatusHandler);
  });

  it('links an approval straight to the template', async () => {
    await handler.handle(event());

    expect(mockNotifications.notifyWaba).toHaveBeenCalledWith(
      'waba1',
      'templateStatus',
      expect.objectContaining({
        title: 'Template approved',
        link: '/templates/12',
      }),
    );
  });

  it("carries Meta's reason on a rejection", async () => {
    await handler.handle(
      event({ event: 'REJECTED', reason: 'INVALID_FORMAT' }),
    );

    expect(mockNotifications.notifyWaba).toHaveBeenCalledWith(
      'waba1',
      'templateStatus',
      expect.objectContaining({
        title: 'Template rejected',
        body: 'order_shipped: INVALID_FORMAT',
      }),
    );
  });

  it('stays quiet for PENDING — that is housekeeping, not news', async () => {
    await handler.handle(event({ event: 'PENDING' }));

    expect(mockNotifications.notifyWaba).not.toHaveBeenCalled();
  });

  it('sends nothing when the template is not one of ours', async () => {
    mockPrisma.messageTemplate.findFirst.mockResolvedValue(null);

    await handler.handle(event({ message_template_id: 'unknown' }));

    expect(mockNotifications.notifyWaba).not.toHaveBeenCalled();
  });
});
