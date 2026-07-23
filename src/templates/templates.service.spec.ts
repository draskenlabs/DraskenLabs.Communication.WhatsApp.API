import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { TemplatesService } from './templates.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockPrisma = {
  userWhatsapp: { findFirst: jest.fn() },
  waba: { findFirst: jest.fn(), findMany: jest.fn() },
  messageTemplate: {
    upsert: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  $transaction: jest.fn(),
};
const mockEncryption = { decrypt: jest.fn().mockReturnValue('plain_token') };

const baseTemplate = {
  id: 1, metaTemplateId: '123', wabaId: 'w1', name: 'hello_world',
  language: 'en_US', category: 'UTILITY', status: 'APPROVED',
  components: [], rejectedReason: null, createdAt: new Date(), updatedAt: new Date(),
};

describe('TemplatesService', () => {
  let service: TemplatesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TemplatesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EncryptionService, useValue: mockEncryption },
      ],
    }).compile();
    service = module.get<TemplatesService>(TemplatesService);
  });

  describe('syncTemplates', () => {
    it('throws NotFoundException if no connection for WABA', async () => {
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue(null);
      await expect(service.syncTemplates(1, 'sso_org_1', 'w1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException if WABA not in org', async () => {
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue({ accessToken: 'enc' });
      mockPrisma.waba.findFirst.mockResolvedValue(null);
      await expect(service.syncTemplates(1, 'sso_org_1', 'w1')).rejects.toThrow(NotFoundException);
    });

    it('syncs templates from Meta and returns count', async () => {
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue({ accessToken: 'enc' });
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          data: [
            { id: '123', name: 'hello_world', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [] },
            { id: '456', name: 'promo', language: 'en_US', status: 'PENDING', category: 'MARKETING', components: [] },
          ],
        },
      });
      mockPrisma.messageTemplate.upsert.mockResolvedValue({});

      const result = await service.syncTemplates(1, 'sso_org_1', 'w1');
      expect(result.synced).toBe(2);
      expect(result.wabaId).toBe('w1');
      expect(mockPrisma.messageTemplate.upsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('findAll', () => {
    it('returns all templates for org across all WABAs', async () => {
      mockPrisma.waba.findMany.mockResolvedValue([{ wabaId: 'w1' }, { wabaId: 'w2' }]);
      mockPrisma.messageTemplate.findMany.mockResolvedValue([baseTemplate]);

      const result = await service.findAll('sso_org_1');
      expect(mockPrisma.messageTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { wabaId: { in: ['w1', 'w2'] } } }),
      );
      expect(result.data).toHaveLength(1);
      expect(result.meta).toBeUndefined();
    });

    it('filters by wabaId (verifying org ownership) when provided', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockPrisma.messageTemplate.findMany.mockResolvedValue([baseTemplate]);
      await service.findAll('sso_org_1', { wabaId: 'w1' });
      expect(mockPrisma.waba.findFirst).toHaveBeenCalledWith({
        where: { wabaId: 'w1', ssoOrgId: 'sso_org_1' },
      });
      expect(mockPrisma.messageTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { wabaId: { in: ['w1'] } } }),
      );
    });

    it('throws NotFoundException when the wabaId is not owned by the org', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue(null);
      await expect(service.findAll('sso_org_1', { wabaId: 'other' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('applies status/category filters', async () => {
      mockPrisma.waba.findMany.mockResolvedValue([{ wabaId: 'w1' }]);
      mockPrisma.messageTemplate.findMany.mockResolvedValue([]);
      await service.findAll('sso_org_1', { status: 'APPROVED', category: 'MARKETING' });
      expect(mockPrisma.messageTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { wabaId: { in: ['w1'] }, status: 'APPROVED', category: 'MARKETING' },
        }),
      );
    });

    it('ignores invalid enum filters', async () => {
      mockPrisma.waba.findMany.mockResolvedValue([{ wabaId: 'w1' }]);
      mockPrisma.messageTemplate.findMany.mockResolvedValue([]);
      await service.findAll('sso_org_1', { status: 'BOGUS', category: 'nope' });
      expect(mockPrisma.messageTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { wabaId: { in: ['w1'] } } }),
      );
    });

    it('paginates and returns meta when page/limit are supplied', async () => {
      mockPrisma.waba.findMany.mockResolvedValue([{ wabaId: 'w1' }]);
      mockPrisma.$transaction.mockResolvedValue([[baseTemplate], 5]);

      const result = await service.findAll('sso_org_1', { page: 2, limit: 2 });
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(result.data).toHaveLength(1);
      expect(result.meta).toEqual({ total: 5, totalPages: 3, page: 2, limit: 2 });
    });
  });

  describe('updateTemplate', () => {
    it('throws NotFoundException when the template does not exist', async () => {
      mockPrisma.messageTemplate.findUnique.mockResolvedValue(null);
      await expect(
        service.updateTemplate(1, 'sso_org_1', 1, { category: 'UTILITY' } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('edits via Meta and updates the local record', async () => {
      mockPrisma.messageTemplate.findUnique.mockResolvedValue(baseTemplate);
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue({ accessToken: 'enc' });
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockedAxios.post = jest.fn().mockResolvedValue({ data: {} });
      mockPrisma.messageTemplate.update.mockResolvedValue({ ...baseTemplate, category: 'MARKETING' });

      const result = await service.updateTemplate(1, 'sso_org_1', 1, {
        category: 'MARKETING',
      } as any);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/123'),
        { category: 'MARKETING' },
        expect.any(Object),
      );
      expect(result.category).toBe('MARKETING');
    });
  });

  describe('deleteTemplate', () => {
    it('throws NotFoundException when the template does not exist', async () => {
      mockPrisma.messageTemplate.findUnique.mockResolvedValue(null);
      await expect(service.deleteTemplate(1, 'sso_org_1', 1)).rejects.toThrow(NotFoundException);
    });

    it('deletes from Meta and soft-deletes the local record', async () => {
      mockPrisma.messageTemplate.findUnique.mockResolvedValue(baseTemplate);
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue({ accessToken: 'enc' });
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockedAxios.delete = jest.fn().mockResolvedValue({ data: {} });
      mockPrisma.messageTemplate.update.mockResolvedValue({ ...baseTemplate, status: 'DELETED' });

      await service.deleteTemplate(1, 'sso_org_1', 1);
      expect(mockedAxios.delete).toHaveBeenCalledWith(
        expect.stringContaining('/w1/message_templates'),
        expect.objectContaining({ params: { hsm_id: '123', name: 'hello_world' } }),
      );
      expect(mockPrisma.messageTemplate.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { status: 'DELETED' },
      });
    });
  });

  describe('findOne', () => {
    it('throws NotFoundException if template not found', async () => {
      mockPrisma.messageTemplate.findUnique.mockResolvedValue(null);
      await expect(service.findOne('sso_org_1', 99)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException if template WABA not in org', async () => {
      mockPrisma.messageTemplate.findUnique.mockResolvedValue(baseTemplate);
      mockPrisma.waba.findFirst.mockResolvedValue(null);
      await expect(service.findOne('sso_org_1', 1)).rejects.toThrow(NotFoundException);
    });

    it('returns template when found', async () => {
      mockPrisma.messageTemplate.findUnique.mockResolvedValue(baseTemplate);
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      const result = await service.findOne('sso_org_1', 1);
      expect(result.name).toBe('hello_world');
    });
  });
});
