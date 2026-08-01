import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhooksService } from './webhooks.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { InboundMessageHandler } from './handlers/inbound-message.handler';
import { StatusUpdateHandler } from './handlers/status-update.handler';
import { AccountHandler } from './handlers/account.handler';
import { TemplateStatusHandler } from './handlers/template-status.handler';

const mockPrisma = {
  webhookEvent: { create: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  waba: { findFirst: jest.fn() },
  $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
};
const mockConfig = { get: jest.fn().mockReturnValue('a-verify-token') };
const mockInbound = { handle: jest.fn() };
const mockStatus = { handle: jest.fn() };
const mockAccount = { handleAccountUpdate: jest.fn(), handlePhoneQualityUpdate: jest.fn(), handlePhoneNameUpdate: jest.fn() };
const mockTemplateStatus = { handle: jest.fn() };

describe('WebhooksService', () => {
  let service: WebhooksService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockConfig.get.mockReturnValue('a-verify-token');
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: InboundMessageHandler, useValue: mockInbound },
        { provide: StatusUpdateHandler, useValue: mockStatus },
        { provide: AccountHandler, useValue: mockAccount },
        { provide: TemplateStatusHandler, useValue: mockTemplateStatus },
      ],
    }).compile();
    service = module.get<WebhooksService>(WebhooksService);
  });

  it('ignores payloads that are not whatsapp_business_account', async () => {
    await service.processPayload({ object: 'instagram', entry: [] });
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it('logs event and routes messages field to inbound and status handlers', async () => {
    mockPrisma.webhookEvent.create.mockResolvedValue({ id: 1 });
    mockPrisma.webhookEvent.update.mockResolvedValue({});
    mockInbound.handle.mockResolvedValue(undefined);
    mockStatus.handle.mockResolvedValue(undefined);

    const payload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba1',
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'p1' },
            contacts: [{ profile: { name: 'Alice' } }],
            messages: [{ id: 'wamid.1', from: '111', timestamp: '1700000000', type: 'text', text: { body: 'Hi' } }],
            statuses: [{ id: 'wamid.2', status: 'delivered', timestamp: '1700000001', recipient_id: '111' }],
          },
        }],
      }],
    };

    await service.processPayload(payload);

    expect(mockPrisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventType: 'messages', wabaId: 'waba1' }) }),
    );
    expect(mockInbound.handle).toHaveBeenCalledWith('waba1', 'p1', payload.entry[0].changes[0].value.messages[0], 'Alice');
    expect(mockStatus.handle).toHaveBeenCalledWith(payload.entry[0].changes[0].value.statuses[0]);
    expect(mockPrisma.webhookEvent.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { processed: true } });
  });

  it('routes account_update to account handler', async () => {
    mockPrisma.webhookEvent.create.mockResolvedValue({ id: 2 });
    mockPrisma.webhookEvent.update.mockResolvedValue({});
    mockAccount.handleAccountUpdate.mockResolvedValue(undefined);

    await service.processPayload({
      object: 'whatsapp_business_account',
      entry: [{ id: 'w1', changes: [{ field: 'account_update', value: { event: 'ACCOUNT_RESTRICTION' } }] }],
    });

    expect(mockAccount.handleAccountUpdate).toHaveBeenCalled();
  });

  it('routes template status update to template status handler', async () => {
    mockPrisma.webhookEvent.create.mockResolvedValue({ id: 3 });
    mockPrisma.webhookEvent.update.mockResolvedValue({});
    mockTemplateStatus.handle.mockResolvedValue(undefined);

    await service.processPayload({
      object: 'whatsapp_business_account',
      entry: [{ id: 'w1', changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED' } }] }],
    });

    expect(mockTemplateStatus.handle).toHaveBeenCalled();
  });

  it('records error on event when handler throws', async () => {
    mockPrisma.webhookEvent.create.mockResolvedValue({ id: 4 });
    mockPrisma.webhookEvent.update.mockResolvedValue({});
    mockAccount.handleAccountUpdate.mockRejectedValue(new Error('handler blew up'));

    await service.processPayload({
      object: 'whatsapp_business_account',
      entry: [{ id: 'w1', changes: [{ field: 'account_update', value: {} }] }],
    });

    expect(mockPrisma.webhookEvent.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { error: 'handler blew up' },
    });
  });

  describe('getConfig', () => {
    it('returns config without exposing the verify token value', () => {
      const config = service.getConfig('https://api.example.com/webhooks');
      expect(config.callbackUrl).toBe('https://api.example.com/webhooks');
      expect(config.signatureHeader).toBe('X-Hub-Signature-256');
      expect(config.subscribed).toBe(true);
      expect(config.verifyTokenConfigured).toBe(true);
      expect(config.fields).toContain('messages');
      expect(JSON.stringify(config)).not.toContain('a-verify-token');
    });

    it('reports not subscribed when the verify token is missing', () => {
      mockConfig.get.mockReturnValue(undefined);
      const config = service.getConfig('https://api.example.com/webhooks');
      expect(config.subscribed).toBe(false);
      expect(config.verifyTokenConfigured).toBe(false);
    });
  });

  describe('getRecentEvents', () => {
    it('rejects a WABA that does not belong to the org', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue(null);
      await expect(service.getRecentEvents('org1', 'wabaX')).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.webhookEvent.findMany).not.toHaveBeenCalled();
    });

    it('describes stored events in terms an operator can read', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ id: 1, wabaId: 'waba1', ssoOrgId: 'org1' });
      const created = new Date('2026-07-27T10:00:00.000Z');
      mockPrisma.webhookEvent.findMany.mockResolvedValue([
        { id: 10, eventType: 'messages', wabaId: 'waba1', processed: true, error: null, createdAt: created,
          payload: { statuses: [{ id: 'wamid.9', status: 'read', recipient_id: '919822010210',
            conversation: { origin: { type: 'marketing' } } }] } },
        { id: 11, eventType: 'messages', wabaId: 'waba1', processed: true, error: null, createdAt: created,
          payload: {
            contacts: [{ profile: { name: 'Aanya' } }],
            messages: [{ from: '919822010210', id: 'wamid.in', type: 'text', text: { body: 'Where is my order?' } }],
          } },
        { id: 12, eventType: 'message_template_status_update', wabaId: 'waba1', processed: false, error: 'x', createdAt: created,
          payload: { message_template_name: 'order_confirmation', message_template_language: 'en_US', event: 'APPROVED', reason: 'NONE' } },
      ]);

      mockPrisma.webhookEvent.count.mockResolvedValue(3);
      const result = await service.getRecentEvents('org1', 'waba1');

      expect(mockPrisma.webhookEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { wabaId: 'waba1' }, orderBy: { createdAt: 'desc' } }),
      );
      expect(result.meta).toEqual({ total: 3, totalPages: 1, page: 1, limit: 20 });

      // The wamid moves out of the headline into its own field — it is an id,
      // not something to read.
      expect(result.data[0]).toMatchObject({
        kind: 'status_update',
        title: 'Message read',
        status: 'read',
        recipient: '919822010210',
        messageId: 'wamid.9',
        detail: 'Marketing conversation',
      });
      expect(result.data[1]).toMatchObject({
        kind: 'inbound_message',
        title: 'Reply received',
        recipient: '919822010210',
        detail: 'Aanya: Where is my order?',
      });
      expect(result.data[2]).toMatchObject({
        kind: 'template_status',
        title: 'Template approved',
        status: 'APPROVED',
        detail: 'order_confirmation · en_US',
        error: 'x',
      });
      // "NONE" is Meta's no-reason sentinel, not a reason.
      expect(result.data[2].reason).toBeUndefined();
    });

    it('surfaces why a message failed', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ id: 1, wabaId: 'waba1', ssoOrgId: 'org1' });
      mockPrisma.webhookEvent.findMany.mockResolvedValue([
        { id: 13, eventType: 'messages', wabaId: 'waba1', processed: true, error: null, createdAt: new Date(),
          payload: { statuses: [{ id: 'wamid.f', status: 'failed', recipient_id: '919822010210',
            errors: [{ code: 131026, title: 'Message undeliverable',
              error_data: { details: 'Receiver is incapable of receiving this message' } }] }] } },
      ]);
      mockPrisma.webhookEvent.count.mockResolvedValue(1);

      const result = await service.getRecentEvents('org1', 'waba1');

      expect(result.data[0]).toMatchObject({
        title: 'Message failed',
        status: 'failed',
        reason: 'Message undeliverable — Receiver is incapable of receiving this message',
      });
    });

    it('clamps the limit to at most 100 and paginates', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ id: 1, wabaId: 'waba1', ssoOrgId: 'org1' });
      mockPrisma.webhookEvent.findMany.mockResolvedValue([]);
      mockPrisma.webhookEvent.count.mockResolvedValue(0);
      await service.getRecentEvents('org1', 'waba1', { page: 3, limit: 500 });
      expect(mockPrisma.webhookEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100, skip: 200 }),
      );
    });
  });
});
