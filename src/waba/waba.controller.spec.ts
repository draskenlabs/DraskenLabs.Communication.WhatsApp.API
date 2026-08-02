import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { WabaController } from './waba.controller';
import { WabaService } from './waba.service';

const mockWabaService = {
  findAllByOrgId: jest.fn(),
  getWabaDetailsFromMeta: jest.fn(),
  createOrUpdateWaba: jest.fn(),
  disconnectWaba: jest.fn(),
  deleteWaba: jest.fn(),
  subscribeExistingWaba: jest.fn().mockResolvedValue(true),
};

describe('WabaController', () => {
  let controller: WabaController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WabaController],
      providers: [{ provide: WabaService, useValue: mockWabaService }],
    }).compile();
    controller = module.get<WabaController>(WabaController);
  });

  describe('findAll', () => {
    it('returns WABAs for the org', async () => {
      const req = { orgId: 'sso_org_1', user: { id: 1 } } as any;
      mockWabaService.findAllByOrgId.mockResolvedValue([{ wabaId: 'w1' }]);
      await expect(controller.findAll(req)).resolves.toEqual([{ wabaId: 'w1' }]);
      // The user id decides whether each WABA counts as connected for them.
      expect(mockWabaService.findAllByOrgId).toHaveBeenCalledWith('sso_org_1', 1);
    });

    it('throws UnauthorizedException when orgId missing', async () => {
      await expect(controller.findAll({} as any)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('findDetails', () => {
    it('returns WABA details from Meta', async () => {
      const req = { user: { id: 1 }, orgId: 'sso_org_1' } as any;
      mockWabaService.getWabaDetailsFromMeta.mockResolvedValue({ id: 'w1', name: 'Test' });
      await expect(controller.findDetails('w1', req)).resolves.toEqual({ id: 'w1', name: 'Test' });
      // The organisation leads: reading an account is scoped to the org being
      // viewed, not to whichever one the caller's token happens to reach.
      expect(mockWabaService.getWabaDetailsFromMeta).toHaveBeenCalledWith(
        'sso_org_1',
        'w1',
        1,
      );
    });

    it('throws UnauthorizedException when user missing', async () => {
      await expect(controller.findDetails('w1', {} as any)).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when the organisation is missing', async () => {
      await expect(
        controller.findDetails('w1', { user: { id: 1 } } as any),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('syncWaba', () => {
    it('syncs WABA details from Meta to DB', async () => {
      const req = { user: { id: 1 }, orgId: 'sso_org_1' } as any;
      const metaDetails = { id: 'w1', name: 'Test', currency: 'USD', timezone_id: '1', message_template_namespace: 'ns' };
      mockWabaService.getWabaDetailsFromMeta.mockResolvedValue(metaDetails);
      mockWabaService.createOrUpdateWaba.mockResolvedValue({ wabaId: 'w1' });

      // A successful sync proves the caller's token works, so the result is
      // reported as connected.
      await expect(controller.syncWaba('w1', req)).resolves.toEqual({
        wabaId: 'w1',
        connected: true,
      });
      expect(mockWabaService.createOrUpdateWaba).toHaveBeenCalledWith(
        expect.objectContaining({ wabaId: 'w1', userId: 1, ssoOrgId: 'sso_org_1' }),
      );
    });

    it('throws UnauthorizedException when user missing', async () => {
      await expect(controller.syncWaba('w1', {} as any)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('disconnect', () => {
    it('disconnects a WABA', async () => {
      const req = { user: { id: 1 }, orgId: 'sso_org_1' } as any;
      mockWabaService.disconnectWaba.mockResolvedValue(undefined);
      await expect(controller.disconnect('w1', req)).resolves.toBeUndefined();
      expect(mockWabaService.disconnectWaba).toHaveBeenCalledWith(1, 'sso_org_1', 'w1');
    });

    it('throws UnauthorizedException when user or org missing', async () => {
      await expect(controller.disconnect('w1', {} as any)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('remove', () => {
    it('deletes the account and reports what went', async () => {
      const req = {
        user: { id: 1 },
        orgId: 'sso_org_1',
      } as unknown as Parameters<typeof controller.remove>[1];
      const counts = {
        phoneNumbers: 2,
        templates: 14,
        messages: 320,
        inboundMessages: 187,
        metaConnections: 1,
        webhookEvents: 512,
      };
      mockWabaService.deleteWaba.mockResolvedValue(counts);

      await expect(controller.remove('w1', req)).resolves.toEqual(counts);
      expect(mockWabaService.deleteWaba).toHaveBeenCalledWith(
        1,
        'sso_org_1',
        'w1',
      );
    });

    it('throws UnauthorizedException when user or org missing', async () => {
      const req = {} as Parameters<typeof controller.remove>[1];
      await expect(controller.remove('w1', req)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
