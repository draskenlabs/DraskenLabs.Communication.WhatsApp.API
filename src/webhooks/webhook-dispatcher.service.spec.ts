import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHmac } from 'crypto';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { MailNotifications } from 'src/mail/mail.notifications';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockPrisma = {
  webhookEndpoint: { findMany: jest.fn(), update: jest.fn() },
  webhookDelivery: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
};
const mockConfig = { get: jest.fn().mockReturnValue(undefined) };
const mockEncryption = {
  decrypt: jest.fn((v: string) => v.replace('enc:', '')),
};
const mockMail = { webhookEndpointDisabled: jest.fn() };

const described = {
  kind: 'status_update' as const,
  title: 'Message delivered',
  status: 'delivered',
  recipient: '919822010210',
};

describe('WebhookDispatcherService', () => {
  let service: WebhookDispatcherService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.webhookDelivery.update.mockResolvedValue({});
    mockPrisma.webhookEndpoint.update.mockResolvedValue({
      id: 1,
      url: 'https://api.example.com/hooks',
      userId: 1,
      ssoOrgId: 'org_1',
      failureCount: 1,
      status: true,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDispatcherService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: EncryptionService, useValue: mockEncryption },
        { provide: MailNotifications, useValue: mockMail },
      ],
    }).compile();
    service = module.get(WebhookDispatcherService);
  });

  describe('enqueue', () => {
    it('writes one delivery per listening endpoint', async () => {
      mockPrisma.webhookEndpoint.findMany.mockResolvedValue([
        { id: 1 },
        { id: 2 },
      ]);
      mockPrisma.webhookDelivery.create.mockResolvedValue({ id: 9 });

      await service.enqueue('WABA_1', 5, 'messages', described, {
        statuses: [],
      });

      expect(mockPrisma.webhookDelivery.create).toHaveBeenCalledTimes(2);
      const { data } = mockPrisma.webhookDelivery.create.mock.calls[0][0];
      expect(data).toMatchObject({
        endpointId: 1,
        eventId: 5,
        eventType: 'status_update',
        status: 'pending',
      });
      // The raw Meta payload rides along, so an integrator can read the parts
      // we did not name.
      expect(data.payload.data).toMatchObject({ metaField: 'messages' });
    });

    it('asks only for endpoints subscribed to this kind, or to everything', async () => {
      mockPrisma.webhookEndpoint.findMany.mockResolvedValue([]);

      await service.enqueue('WABA_1', 5, 'messages', described, {});

      expect(mockPrisma.webhookEndpoint.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            wabaId: 'WABA_1',
            status: true,
            OR: [
              { events: { isEmpty: true } },
              { events: { has: 'status_update' } },
            ],
          }),
        }),
      );
    });

    it('never throws — a fan-out failure must not fail the event', async () => {
      mockPrisma.webhookEndpoint.findMany.mockRejectedValue(
        new Error('db down'),
      );

      await expect(
        service.enqueue('WABA_1', 5, 'messages', described, {}),
      ).resolves.toBeUndefined();
    });
  });

  describe('sweep', () => {
    const dueRow = { id: 3, attempts: 0, status: 'pending', endpointId: 1 };
    const delivery = (over: Record<string, unknown> = {}) => ({
      id: 3,
      endpointId: 1,
      attempts: 0,
      payload: {
        event: 'status_update',
        wabaId: 'WABA_1',
        occurredAt: 'x',
        data: {},
      },
      endpoint: {
        id: 1,
        url: 'https://api.example.com/hooks',
        secret: null,
        status: true,
      },
      ...over,
    });

    it('marks a 2xx as sent and clears the endpoint failure count', async () => {
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([dueRow]);
      mockPrisma.webhookDelivery.findUnique.mockResolvedValue(delivery());
      mockedAxios.post.mockResolvedValue({ status: 200, data: 'ok' });

      const result = await service.sweep();

      expect(result).toMatchObject({ attempted: 1, sent: 1, abandoned: 0 });
      expect(mockPrisma.webhookDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'sent',
            attempts: 1,
            retryAt: null,
          }),
        }),
      );
      expect(mockPrisma.webhookEndpoint.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ failureCount: 0 }),
        }),
      );
    });

    it('schedules another attempt on a 500', async () => {
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([dueRow]);
      mockPrisma.webhookDelivery.findUnique.mockResolvedValue(delivery());
      mockedAxios.post.mockResolvedValue({ status: 500, data: 'boom' });

      const result = await service.sweep();

      expect(result).toMatchObject({ attempted: 1, sent: 0, abandoned: 0 });
      const { data } = mockPrisma.webhookDelivery.update.mock.calls.at(-1)![0];
      expect(data).toMatchObject({
        status: 'failed',
        attempts: 1,
        responseCode: 500,
      });
      expect(data.retryAt).toBeInstanceOf(Date);
    });

    it('gives up after the last retry and counts it against the endpoint', async () => {
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([
        { ...dueRow, attempts: 5, status: 'failed' },
      ]);
      mockPrisma.webhookDelivery.findUnique.mockResolvedValue(
        delivery({ attempts: 5 }),
      );
      mockedAxios.post.mockRejectedValue(
        new Error('timeout of 10000ms exceeded'),
      );

      const result = await service.sweep();

      expect(result).toMatchObject({ abandoned: 1 });
      const { data } = mockPrisma.webhookDelivery.update.mock.calls.at(-1)![0];
      expect(data).toMatchObject({
        status: 'abandoned',
        retryAt: null,
        attempts: 6,
      });
      expect(mockPrisma.webhookEndpoint.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { failureCount: { increment: 1 } } }),
      );
    });

    it('disables an endpoint that keeps failing, and says so by email', async () => {
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([
        { ...dueRow, attempts: 5, status: 'failed' },
      ]);
      mockPrisma.webhookDelivery.findUnique.mockResolvedValue(
        delivery({ attempts: 5 }),
      );
      mockedAxios.post.mockResolvedValue({ status: 502, data: '' });
      mockPrisma.webhookEndpoint.update.mockResolvedValueOnce({
        id: 1,
        url: 'https://api.example.com/hooks',
        userId: 4,
        ssoOrgId: 'org_1',
        failureCount: 10,
        status: true,
      });

      await service.sweep();

      expect(mockPrisma.webhookEndpoint.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: false }),
        }),
      );
      expect(mockMail.webhookEndpointDisabled).toHaveBeenCalledWith(
        4,
        'org_1',
        'https://api.example.com/hooks',
        10,
      );
    });

    it('skips a row another replica already claimed', async () => {
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([dueRow]);
      mockPrisma.webhookDelivery.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.sweep();

      expect(result.attempted).toBe(0);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('drops a queued delivery whose endpoint was switched off in the meantime', async () => {
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([dueRow]);
      mockPrisma.webhookDelivery.findUnique.mockResolvedValue(
        delivery({
          endpoint: {
            id: 1,
            url: 'https://x.example.com',
            secret: null,
            status: false,
          },
        }),
      );

      const result = await service.sweep();

      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(result.abandoned).toBe(1);
    });

    it('signs the body when the endpoint has a secret, and not otherwise', async () => {
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([dueRow]);
      mockPrisma.webhookDelivery.findUnique.mockResolvedValue(
        delivery({
          endpoint: {
            id: 1,
            url: 'https://api.example.com/hooks',
            secret: 'enc:top-secret',
            status: true,
          },
        }),
      );
      mockedAxios.post.mockResolvedValue({ status: 200, data: '' });

      await service.sweep();

      const [, body, options] = mockedAxios.post.mock.calls[0] as [
        string,
        string,
        { headers: Record<string, string> },
      ];
      const timestamp = options.headers['X-Drasken-Timestamp'];
      const expected =
        'sha256=' +
        createHmac('sha256', 'top-secret')
          .update(`${timestamp}.${body}`)
          .digest('hex');
      expect(options.headers['X-Drasken-Signature-256']).toBe(expected);
      // The delivery id is in the body and the header, for deduplication.
      expect(JSON.parse(body).id).toBe(3);
      expect(options.headers['X-Drasken-Delivery-Id']).toBe('3');

      // ...and unsigned when there is no secret.
      jest.clearAllMocks();
      mockPrisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([dueRow]);
      mockPrisma.webhookDelivery.findUnique.mockResolvedValue(delivery());
      mockedAxios.post.mockResolvedValue({ status: 200, data: '' });

      await service.sweep();

      const opts = mockedAxios.post.mock.calls[0][2] as {
        headers: Record<string, string>;
      };
      expect(opts.headers['X-Drasken-Signature-256']).toBeUndefined();
    });

    it('never follows a redirect — that is the way around the URL check', async () => {
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([dueRow]);
      mockPrisma.webhookDelivery.findUnique.mockResolvedValue(delivery());
      mockedAxios.post.mockResolvedValue({ status: 200, data: '' });

      await service.sweep();

      expect(mockedAxios.post.mock.calls[0][2]).toMatchObject({
        maxRedirects: 0,
      });
    });
  });

  describe('sendTest', () => {
    it('posts immediately, logs the result and never queues a retry', async () => {
      mockPrisma.webhookDelivery.create.mockResolvedValue({
        id: 11,
        payload: {
          event: 'endpoint.test',
          wabaId: 'WABA_1',
          occurredAt: 'x',
          data: {},
        },
      });
      mockedAxios.post.mockResolvedValue({ status: 204, data: '' });

      const { outcome, deliveryId } = await service.sendTest({
        id: 1,
        url: 'https://api.example.com/hooks',
        secret: null,
        wabaId: 'WABA_1',
      });

      expect(deliveryId).toBe(11);
      expect(outcome).toMatchObject({ success: true, responseCode: 204 });
      expect(mockPrisma.webhookDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'sent', retryAt: null }),
        }),
      );
    });

    it('reports a refused connection rather than throwing', async () => {
      mockPrisma.webhookDelivery.create.mockResolvedValue({
        id: 12,
        payload: {
          event: 'endpoint.test',
          wabaId: 'WABA_1',
          occurredAt: 'x',
          data: {},
        },
      });
      mockedAxios.post.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const { outcome } = await service.sendTest({
        id: 1,
        url: 'https://api.example.com/hooks',
        secret: null,
        wabaId: 'WABA_1',
      });

      expect(outcome.success).toBe(false);
      expect(outcome.responseCode).toBeNull();
      expect(outcome.error).toContain('ECONNREFUSED');
      // A failed test is a result, not a backlog.
      expect(mockPrisma.webhookDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'abandoned', retryAt: null }),
        }),
      );
    });
  });
});
