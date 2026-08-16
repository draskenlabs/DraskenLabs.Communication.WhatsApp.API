import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookEndpointsService } from './webhook-endpoints.service';
import { ConfigService } from '@nestjs/config';

const mockWebhooksService = { processPayload: jest.fn() };
const mockEndpointsService = {
  create: jest.fn(),
  findAll: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  test: jest.fn(),
  deliveries: jest.fn(),
  redeliver: jest.fn(),
};
const mockConfigService = { get: jest.fn().mockReturnValue('my_verify_token') };

describe('WebhooksController', () => {
  let controller: WebhooksController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        { provide: WebhooksService, useValue: mockWebhooksService },
        { provide: WebhookEndpointsService, useValue: mockEndpointsService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();
    controller = module.get<WebhooksController>(WebhooksController);
  });

  describe('verify', () => {
    const mockRes = () => {
      const res: any = {};
      res.status = jest.fn().mockReturnValue(res);
      res.send = jest.fn().mockReturnValue(res);
      return res;
    };

    it('echoes challenge when mode and token match', () => {
      const res = mockRes();
      controller.verify('subscribe', 'my_verify_token', '12345', res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith('12345');
    });

    it('throws ForbiddenException when mode is wrong', () => {
      const res = mockRes();
      expect(() =>
        controller.verify('unsubscribe', 'my_verify_token', '12345', res),
      ).toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when token does not match', () => {
      const res = mockRes();
      expect(() =>
        controller.verify('subscribe', 'wrong_token', '12345', res),
      ).toThrow(ForbiddenException);
    });
  });

  describe('endpoints', () => {
    const req = (over: Record<string, unknown> = {}) =>
      ({ user: { id: 7 }, orgId: 'org_1', ...over }) as any;

    it('creates an endpoint for the caller and their organisation', async () => {
      mockEndpointsService.create.mockResolvedValue({ id: 1 });

      await controller.createEndpoint(req(), {
        url: 'https://api.example.com/hooks',
        wabaId: 'WABA_1',
      });

      expect(mockEndpointsService.create).toHaveBeenCalledWith(7, 'org_1', {
        url: 'https://api.example.com/hooks',
        wabaId: 'WABA_1',
      });
    });

    it('refuses a request with no organisation in context', async () => {
      await expect(
        controller.createEndpoint(req({ orgId: undefined }), {
          url: 'https://api.example.com/hooks',
          wabaId: 'WABA_1',
        }),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockEndpointsService.create).not.toHaveBeenCalled();
    });

    it('passes the WABA filter through when listing', async () => {
      mockEndpointsService.findAll.mockResolvedValue([]);

      await controller.listEndpoints(req(), 'WABA_1');

      expect(mockEndpointsService.findAll).toHaveBeenCalledWith(
        'org_1',
        'WABA_1',
      );
    });

    it('scopes update, delete and test to the organisation', async () => {
      mockEndpointsService.update.mockResolvedValue({ id: 1 });
      mockEndpointsService.remove.mockResolvedValue(undefined);
      mockEndpointsService.test.mockResolvedValue({ success: true });

      await controller.updateEndpoint(req(), 1, { status: false });
      await controller.deleteEndpoint(req(), 1);
      await controller.testEndpoint(req(), 1);

      expect(mockEndpointsService.update).toHaveBeenCalledWith('org_1', 1, {
        status: false,
      });
      expect(mockEndpointsService.remove).toHaveBeenCalledWith('org_1', 1);
      expect(mockEndpointsService.test).toHaveBeenCalledWith('org_1', 1);
    });

    it('parses paging for the delivery log', async () => {
      mockEndpointsService.deliveries.mockResolvedValue({ data: [] });

      await controller.endpointDeliveries(req(), 1, '2', '50');

      expect(mockEndpointsService.deliveries).toHaveBeenCalledWith('org_1', 1, {
        page: 2,
        limit: 50,
      });
    });

    it('requeues a delivery', async () => {
      mockEndpointsService.redeliver.mockResolvedValue({ id: 3 });

      await controller.redeliver(req(), 3);

      expect(mockEndpointsService.redeliver).toHaveBeenCalledWith('org_1', 3);
    });
  });

  describe('receive', () => {
    it('responds immediately with EVENT_RECEIVED and processes async', async () => {
      const res: any = {};
      res.status = jest.fn().mockReturnValue(res);
      res.send = jest.fn().mockReturnValue(res);
      mockWebhooksService.processPayload.mockResolvedValue(undefined);

      controller.receive({ entry: [] }, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith('EVENT_RECEIVED');
    });
  });
});
