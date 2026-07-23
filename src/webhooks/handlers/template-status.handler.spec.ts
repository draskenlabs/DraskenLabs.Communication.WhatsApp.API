import { Test, TestingModule } from '@nestjs/testing';
import { TemplateStatusHandler } from './template-status.handler';
import { PrismaService } from 'src/prisma/prisma.service';

const mockPrisma = {
  messageTemplate: { updateMany: jest.fn() },
};

describe('TemplateStatusHandler', () => {
  let handler: TemplateStatusHandler;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [TemplateStatusHandler, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    handler = module.get<TemplateStatusHandler>(TemplateStatusHandler);
  });

  it('updates template status to APPROVED', async () => {
    mockPrisma.messageTemplate.updateMany.mockResolvedValue({ count: 1 });
    await handler.handle({ event: 'APPROVED', message_template_id: 123, message_template_name: 'hello', message_template_language: 'en_US', reason: 'NONE' });
    expect(mockPrisma.messageTemplate.updateMany).toHaveBeenCalledWith({
      where: { metaTemplateId: '123' },
      data: { status: 'APPROVED' },
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

  it('does nothing for unknown event type', async () => {
    await handler.handle({ event: 'UNKNOWN_EVENT', message_template_id: 1 });
    expect(mockPrisma.messageTemplate.updateMany).not.toHaveBeenCalled();
  });
});
