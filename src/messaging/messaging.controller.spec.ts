import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';
import { SendRateGuard } from './send-rate.guard';

const mockMessagingService = {
  sendMessage: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
};

describe('MessagingController', () => {
  let controller: MessagingController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessagingController],
      providers: [{ provide: MessagingService, useValue: mockMessagingService }],
    }).overrideGuard(SendRateGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<MessagingController>(MessagingController);
  });

  describe('send', () => {
    it('sends a message', async () => {
      const req = { user: { id: 1 }, orgId: 2 } as any;
      const dto = { phoneNumberId: 'p1', to: '+1555', type: 'text' } as any;
      const response = { messageId: 'msg_1' };
      mockMessagingService.sendMessage.mockResolvedValue(response);

      await expect(controller.send(req, dto)).resolves.toEqual(response);
      // No API key on this request, so no WABA scope to pass on.
      expect(mockMessagingService.sendMessage).toHaveBeenCalledWith(1, 2, dto, undefined);
    });

    it('throws UnauthorizedException when user or org missing', async () => {
      await expect(controller.send({} as any, {} as any)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('findAll', () => {
    it('returns all messages for org', async () => {
      const req = { orgId: 2 } as any;
      mockMessagingService.findAll.mockResolvedValue([{ id: 1 }]);
      await expect(controller.findAll(req)).resolves.toEqual([{ id: 1 }]);
    });

    it('throws when orgId missing', async () => {
      await expect(controller.findAll({} as any)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('findOne', () => {
    it('returns a single message', async () => {
      const req = { orgId: 2 } as any;
      mockMessagingService.findOne.mockResolvedValue({ id: 5 });
      await expect(controller.findOne(req, 5)).resolves.toEqual({ id: 5 });
      expect(mockMessagingService.findOne).toHaveBeenCalledWith(2, 5, undefined);
    });

    it('throws when orgId missing', async () => {
      await expect(controller.findOne({} as any, 5)).rejects.toThrow(UnauthorizedException);
    });
  });
});
