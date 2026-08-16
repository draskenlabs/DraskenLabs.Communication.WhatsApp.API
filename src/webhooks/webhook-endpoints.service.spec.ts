import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookEndpointsService } from './webhook-endpoints.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';

const mockPrisma = {
  waba: { findFirst: jest.fn() },
  webhookEndpoint: {
    create: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  webhookDelivery: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
};
const mockConfig = { get: jest.fn().mockReturnValue(undefined) };
const mockEncryption = {
  encrypt: jest.fn((value: string) => `enc(${value})`),
  decrypt: jest.fn((value: string) => value.replace(/^enc\(|\)$/g, '')),
};
const mockDispatcher = { sendTest: jest.fn() };

/** The real assertion, so a spec cannot pass a limit the product would refuse. */
const realLimits = new PlanLimitsService({} as never);
const mockLimits = {
  forWaba: jest.fn(),
  assertWithin: realLimits.assertWithin.bind(realLimits),
};
const limitsOf = (webhookEndpoints: number | null) => ({
  planCode: 'starter',
  planName: 'Starter',
  wabas: 1,
  phoneNumbersPerWaba: 1,
  teamMembers: 2,
  webhookEndpoints,
  historyDays: 30,
});

const ORG = 'org_1';
const row = (over: Record<string, unknown> = {}) => ({
  id: 7,
  userId: 1,
  ssoOrgId: ORG,
  wabaId: 'WABA_1',
  url: 'https://api.example.com/hooks',
  label: null,
  secret: null,
  events: [],
  status: true,
  failureCount: 0,
  disabledAt: null,
  lastSuccessAt: null,
  createdAt: new Date('2026-08-01'),
  updatedAt: new Date('2026-08-01'),
  ...over,
});

describe('WebhookEndpointsService', () => {
  let service: WebhookEndpointsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.webhookEndpoint.count.mockResolvedValue(0);
    mockPrisma.webhookEndpoint.findFirst.mockResolvedValue(null);
    mockLimits.forWaba.mockResolvedValue(limitsOf(2));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookEndpointsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: EncryptionService, useValue: mockEncryption },
        { provide: WebhookDispatcherService, useValue: mockDispatcher },
        { provide: PlanLimitsService, useValue: mockLimits },
      ],
    }).compile();
    service = module.get(WebhookEndpointsService);
  });

  describe('create', () => {
    beforeEach(() => {
      mockPrisma.waba.findFirst.mockResolvedValue({
        wabaId: 'WABA_1',
        name: 'OneManPlay',
      });
    });

    it('stores the endpoint and encrypts the secret when one is given', async () => {
      mockPrisma.webhookEndpoint.create.mockResolvedValue(
        row({ secret: 'enc(a-very-long-secret)' }),
      );

      const dto = await service.create(1, ORG, {
        url: 'https://api.example.com/hooks',
        wabaId: 'WABA_1',
        secret: 'a-very-long-secret',
      });

      expect(mockEncryption.encrypt).toHaveBeenCalledWith('a-very-long-secret');
      expect(mockPrisma.webhookEndpoint.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ secret: 'enc(a-very-long-secret)' }),
        }),
      );
      // The secret itself never comes back out.
      expect(dto).not.toHaveProperty('secret');
      expect(dto.hasSecret).toBe(true);
      expect(dto.wabaName).toBe('OneManPlay');
    });

    it('stores no secret when none is given — signing is optional', async () => {
      mockPrisma.webhookEndpoint.create.mockResolvedValue(row());

      const dto = await service.create(1, ORG, {
        url: 'https://api.example.com/hooks',
        wabaId: 'WABA_1',
      });

      expect(mockEncryption.encrypt).not.toHaveBeenCalled();
      expect(mockPrisma.webhookEndpoint.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ secret: null }),
        }),
      );
      expect(dto.hasSecret).toBe(false);
    });

    it('refuses a WABA that is not in the caller organisation', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue(null);

      await expect(
        service.create(1, ORG, {
          url: 'https://a.example.com/h',
          wabaId: 'OTHER',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrisma.webhookEndpoint.create).not.toHaveBeenCalled();
    });

    it('refuses a URL pointing back inside our own network', async () => {
      await expect(
        service.create(1, ORG, {
          url: 'https://169.254.169.254/latest/meta-data/',
          wabaId: 'WABA_1',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.webhookEndpoint.create).not.toHaveBeenCalled();
    });

    it('refuses the same URL twice on one account', async () => {
      mockPrisma.webhookEndpoint.findFirst.mockResolvedValue({ id: 1 });

      await expect(
        service.create(1, ORG, {
          url: 'https://api.example.com/hooks',
          wabaId: 'WABA_1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses more endpoints than an account may have', async () => {
      mockPrisma.webhookEndpoint.count.mockResolvedValue(5);

      await expect(
        service.create(1, ORG, {
          url: 'https://api.example.com/x',
          wabaId: 'WABA_1',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('update', () => {
    it('rotates the secret when one is sent', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(row());
      mockPrisma.webhookEndpoint.update.mockResolvedValue(
        row({ secret: 'enc(x)' }),
      );

      await service.update(ORG, 7, { secret: 'another-long-secret' });

      expect(mockPrisma.webhookEndpoint.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ secret: 'enc(another-long-secret)' }),
        }),
      );
    });

    it('removes the secret when sent an empty string', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(
        row({ secret: 'enc(old)' }),
      );
      mockPrisma.webhookEndpoint.update.mockResolvedValue(row());

      await service.update(ORG, 7, { secret: '   ' });

      expect(mockPrisma.webhookEndpoint.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ secret: null }),
        }),
      );
    });

    it('refuses a secret too short to be worth having', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(row());

      await expect(service.update(ORG, 7, { secret: 'short' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('clears the failure count when an endpoint is switched back on', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(
        row({ status: false, failureCount: 10, disabledAt: new Date() }),
      );
      mockPrisma.webhookEndpoint.update.mockResolvedValue(row());

      await service.update(ORG, 7, { status: true });

      expect(mockPrisma.webhookEndpoint.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: true,
            failureCount: 0,
            disabledAt: null,
          }),
        }),
      );
    });

    it("refuses to touch another organisation's endpoint", async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(
        row({ ssoOrgId: 'org_other' }),
      );

      await expect(
        service.update(ORG, 7, { label: 'mine now' }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.webhookEndpoint.update).not.toHaveBeenCalled();
    });
  });

  describe('test', () => {
    it('posts a ping and reports what came back', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(
        row({ secret: 'enc(s)' }),
      );
      mockDispatcher.sendTest.mockResolvedValue({
        outcome: {
          success: true,
          responseCode: 204,
          error: null,
          durationMs: 91,
        },
        deliveryId: 42,
      });

      const result = await service.test(ORG, 7);

      expect(result).toEqual({
        success: true,
        responseCode: 204,
        error: null,
        durationMs: 91,
        signed: true,
        deliveryId: 42,
      });
    });

    it('refuses to test a disabled endpoint', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(
        row({ status: false }),
      );

      await expect(service.test(ORG, 7)).rejects.toThrow(BadRequestException);
      expect(mockDispatcher.sendTest).not.toHaveBeenCalled();
    });
  });

  describe('redeliver', () => {
    it('requeues a delivery that was given up on', async () => {
      mockPrisma.webhookDelivery.findFirst.mockResolvedValue({
        id: 3,
        status: 'abandoned',
        endpoint: { status: true },
      });
      mockPrisma.webhookDelivery.update.mockResolvedValue({
        id: 3,
        status: 'pending',
      });

      await service.redeliver(ORG, 3);

      expect(mockPrisma.webhookDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'pending', attempts: 0 }),
        }),
      );
    });

    it('refuses one that is already queued', async () => {
      mockPrisma.webhookDelivery.findFirst.mockResolvedValue({
        id: 3,
        status: 'failed',
        endpoint: { status: true },
      });

      await expect(service.redeliver(ORG, 3)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("cannot reach another organisation's delivery", async () => {
      mockPrisma.webhookDelivery.findFirst.mockResolvedValue(null);

      await expect(service.redeliver(ORG, 3)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('deliveries', () => {
    it('pages the log for an endpoint the caller owns', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(row());
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([{ id: 1 }]);
      mockPrisma.webhookDelivery.count.mockResolvedValue(41);

      const res = await service.deliveries(ORG, 7, { page: 2, limit: 20 });

      expect(mockPrisma.webhookDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 20 }),
      );
      expect(res.meta).toEqual({
        total: 41,
        totalPages: 3,
        page: 2,
        limit: 20,
      });
    });
  });
});
