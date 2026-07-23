import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

const mockTemplatesService = {
  syncTemplates: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  updateTemplate: jest.fn(),
  deleteTemplate: jest.fn(),
};

describe('TemplatesController', () => {
  let controller: TemplatesController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TemplatesController],
      providers: [{ provide: TemplatesService, useValue: mockTemplatesService }],
    }).compile();
    controller = module.get<TemplatesController>(TemplatesController);
  });

  describe('sync', () => {
    it('syncs templates from Meta', async () => {
      const req = { user: { id: 1 }, orgId: 2 } as any;
      const response = { synced: 3, total: 3 };
      mockTemplatesService.syncTemplates.mockResolvedValue(response);

      await expect(controller.sync(req, 'w1')).resolves.toEqual(response);
      expect(mockTemplatesService.syncTemplates).toHaveBeenCalledWith(1, 2, 'w1');
    });

    it('throws when user or org missing', async () => {
      await expect(controller.sync({} as any, 'w1')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('findAll', () => {
    it('returns all templates for org', async () => {
      const req = { orgId: 2 } as any;
      mockTemplatesService.findAll.mockResolvedValue([{ id: 1 }]);
      await expect(controller.findAll(req, undefined)).resolves.toEqual([{ id: 1 }]);
      expect(mockTemplatesService.findAll).toHaveBeenCalledWith(2, {
        wabaId: undefined,
        status: undefined,
        category: undefined,
        page: undefined,
        limit: undefined,
      });
    });

    it('passes filters and pagination through to the service', async () => {
      const req = { orgId: 2 } as any;
      mockTemplatesService.findAll.mockResolvedValue([]);
      await controller.findAll(req, 'w1', 'APPROVED', 'MARKETING', '2', '20');
      expect(mockTemplatesService.findAll).toHaveBeenCalledWith(2, {
        wabaId: 'w1',
        status: 'APPROVED',
        category: 'MARKETING',
        page: 2,
        limit: 20,
      });
    });

    it('throws when orgId missing', async () => {
      await expect(controller.findAll({} as any, undefined)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('findOne', () => {
    it('returns a single template', async () => {
      const req = { orgId: 2 } as any;
      mockTemplatesService.findOne.mockResolvedValue({ id: 3 });
      await expect(controller.findOne(req, 3)).resolves.toEqual({ id: 3 });
      expect(mockTemplatesService.findOne).toHaveBeenCalledWith(2, 3);
    });

    it('throws when orgId missing', async () => {
      await expect(controller.findOne({} as any, 3)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('update', () => {
    it('edits a template', async () => {
      const req = { user: { id: 1 }, orgId: 2 } as any;
      const dto = { category: 'UTILITY' } as any;
      mockTemplatesService.updateTemplate.mockResolvedValue({ id: 3 });
      await expect(controller.update(req, 3, dto)).resolves.toEqual({ id: 3 });
      expect(mockTemplatesService.updateTemplate).toHaveBeenCalledWith(1, 2, 3, dto);
    });

    it('throws when user or org missing', async () => {
      await expect(controller.update({} as any, 3, {} as any)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('remove', () => {
    it('deletes a template', async () => {
      const req = { user: { id: 1 }, orgId: 2 } as any;
      mockTemplatesService.deleteTemplate.mockResolvedValue(undefined);
      await expect(controller.remove(req, 3)).resolves.toBeUndefined();
      expect(mockTemplatesService.deleteTemplate).toHaveBeenCalledWith(1, 2, 3);
    });

    it('throws when user or org missing', async () => {
      await expect(controller.remove({} as any, 3)).rejects.toThrow(UnauthorizedException);
    });
  });
});
