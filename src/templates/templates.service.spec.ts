import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { TemplatesService } from './templates.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { BillingService } from 'src/billing/billing.service';
import { billingServiceDouble } from 'src/billing/billing.test-doubles';
import { EncryptionService } from 'src/common/services/crypto.service';
import axios from 'axios';
import { MailNotifications } from 'src/mail/mail.notifications';
import { mailNotificationsDouble } from 'src/mail/mail.test-doubles';

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
    groupBy: jest.fn(),
  },
  $transaction: jest.fn(),
};
const mockEncryption = { decrypt: jest.fn().mockReturnValue('plain_token') };

const baseTemplate = {
  id: 1, metaTemplateId: '123', wabaId: 'w1', name: 'hello_world',
  language: 'en_US', category: 'UTILITY', status: 'APPROVED',
  components: [], rejectedReason: null, createdAt: new Date(), updatedAt: new Date(),
};

const mockMailNotifications = mailNotificationsDouble();
const mockBilling = billingServiceDouble();

describe('TemplatesService', () => {
  let service: TemplatesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: MailNotifications, useValue: mockMailNotifications },
        TemplatesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: BillingService, useValue: mockBilling },
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

    it('stores Meta\'s "NONE" rejected_reason sentinel as null', async () => {
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue({ accessToken: 'enc' });
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          data: [
            { id: '123', name: 'hello_world', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [], rejected_reason: 'NONE' },
            { id: '456', name: 'promo', language: 'en_US', status: 'REJECTED', category: 'MARKETING', components: [], rejected_reason: 'ABUSIVE_CONTENT' },
          ],
        },
      });
      mockPrisma.messageTemplate.upsert.mockResolvedValue({});

      await service.syncTemplates(1, 'sso_org_1', 'w1');

      const [approved, rejected] = mockPrisma.messageTemplate.upsert.mock.calls;
      expect(approved[0].create.rejectedReason).toBeNull();
      expect(approved[0].update.rejectedReason).toBeNull();
      expect(rejected[0].create.rejectedReason).toBe('ABUSIVE_CONTENT');
      expect(rejected[0].update.rejectedReason).toBe('ABUSIVE_CONTENT');
    });

    it('does not leak the sentinel out of rows written before the fix', async () => {
      mockPrisma.waba.findMany.mockResolvedValue([{ wabaId: 'w1' }]);
      mockPrisma.messageTemplate.findMany.mockResolvedValue([
        { ...baseTemplate, rejectedReason: 'NONE' },
      ]);

      const result = await service.findAll('sso_org_1');
      expect(result.data?.[0].rejectedReason).toBeUndefined();
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
        where: { wabaId: 'w1', WabaOrganisation: { some: { ssoOrgId: 'sso_org_1' } } },
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

  describe('template library', () => {
    beforeEach(() => {
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue({ accessToken: 'enc' });
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
    });

    it('passes the filters through and normalises Meta\'s rows', async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: {
          data: [
            {
              id: '714701', name: 'low_balance_warning_1', language: 'en_US', category: 'UTILITY',
              topic: 'PAYMENTS', usecase: 'LOW_BALANCE_WARNING', industry: ['FINANCIAL_SERVICES'],
              header: 'Your account balance is low',
              body: 'Hi {{1}}, your {{2}} is below {{3}}.',
              body_params: ['Jim', 'balance', '$75.00'],
              body_param_types: ['TEXT', 'TEXT', 'AMOUNT'],
              buttons: [{ type: 'URL', text: 'Make a deposit', url: 'https://example.com/' }],
            },
          ],
        },
      });

      const result = await service.listLibrary(1, 'sso_org_1', 'w1', { search: 'balance', topic: 'PAYMENTS' });

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/message_template_library'),
        expect.objectContaining({
          params: expect.objectContaining({ search: 'balance', topic: 'PAYMENTS' }),
        }),
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: '714701',
        name: 'low_balance_warning_1',
        bodyParams: ['Jim', 'balance', '$75.00'],
        bodyParamTypes: ['TEXT', 'TEXT', 'AMOUNT'],
      });
    });

    it('omits filters the caller did not set', async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({ data: { data: [] } });
      await service.listLibrary(1, 'sso_org_1', 'w1', {});
      const params = (mockedAxios.get as jest.Mock).mock.calls[0][1].params;
      expect(params).toEqual({ limit: '100' });
    });

    it('sends only the library name and button inputs when adopting', async () => {
      mockedAxios.post = jest.fn().mockResolvedValue({ data: { id: '99', status: 'PENDING', category: 'UTILITY' } });
      mockPrisma.messageTemplate.upsert.mockResolvedValue({
        ...baseTemplate, id: 5, name: 'my_delivery_update', status: 'PENDING',
      });

      await service.createFromLibrary(1, 'sso_org_1', 'w1', {
        name: 'my_delivery_update',
        language: 'en_US',
        libraryTemplateName: 'delivery_update_1',
        libraryTemplateButtonInputs: [
          { type: 'URL', url: { base_url: 'https://example.com/{{1}}', url_suffix_example: 'https://example.com/123' } },
        ],
      });

      const [, body] = (mockedAxios.post as jest.Mock).mock.calls[0];
      expect(body).toMatchObject({
        name: 'my_delivery_update',
        language: 'en_US',
        category: 'UTILITY',
        library_template_name: 'delivery_update_1',
      });
      // Meta wants these JSON-encoded on this endpoint, not as nested objects.
      expect(typeof body.library_template_button_inputs).toBe('string');
      expect(JSON.parse(body.library_template_button_inputs)[0].type).toBe('URL');
      // The body is fixed by Meta — we must never send one.
      expect(body).not.toHaveProperty('components');
      expect(body).not.toHaveProperty('body');
    });

    it('surfaces Meta\'s rejection message', async () => {
      mockedAxios.post = jest.fn().mockRejectedValue({
        response: { status: 400, data: { error: { message: 'Library template not found' } } },
      });

      await expect(
        service.createFromLibrary(1, 'sso_org_1', 'w1', {
          name: 'x', language: 'en_US', libraryTemplateName: 'nope',
        }),
      ).rejects.toThrow('Library template not found');
    });
  });

  describe('migrateTemplates', () => {
    beforeEach(() => {
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue({ accessToken: 'enc' });
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'dest' });
    });

    it('refuses to migrate a WABA into itself', async () => {
      await expect(
        service.migrateTemplates(1, 'sso_org_1', 'w1', { sourceWabaId: 'w1' }),
      ).rejects.toThrow('Source and destination must be different');
    });

    it('reports what Meta copied and what it refused', async () => {
      mockedAxios.post = jest.fn().mockResolvedValue({
        data: {
          migrated_templates: ['111', '222'],
          failed_templates: { '333': 'Template is not approved' },
        },
      });
      // The follow-up sync runs against the destination.
      mockedAxios.get = jest.fn().mockResolvedValue({ data: { data: [] } });
      mockPrisma.messageTemplate.upsert.mockResolvedValue({});

      const result = await service.migrateTemplates(1, 'sso_org_1', 'dest', {
        sourceWabaId: 'src',
        count: 100,
      });

      const [url, body] = (mockedAxios.post as jest.Mock).mock.calls[0];
      expect(url).toContain('/dest/migrate_message_templates');
      expect(body).toEqual({ source_waba_id: 'src', count: 100 });
      expect(result).toEqual({
        migratedTemplates: ['111', '222'],
        failedTemplates: { '333': 'Template is not approved' },
        migratedCount: 2,
        failedCount: 1,
      });
    });

    it('still reports success when the follow-up sync fails', async () => {
      // A migration that worked must not look like it failed because the
      // convenience sync afterwards did.
      mockedAxios.post = jest.fn().mockResolvedValue({
        data: { migrated_templates: ['111'], failed_templates: {} },
      });
      mockedAxios.get = jest.fn().mockRejectedValue(new Error('Graph API down'));

      const result = await service.migrateTemplates(1, 'sso_org_1', 'dest', {
        sourceWabaId: 'src',
      });

      expect(result.migratedCount).toBe(1);
    });

    it('surfaces Meta\'s rejection', async () => {
      mockedAxios.post = jest.fn().mockRejectedValue({
        response: { status: 400, data: { error: { message: 'Source WABA not owned by this business' } } },
      });

      await expect(
        service.migrateTemplates(1, 'sso_org_1', 'dest', { sourceWabaId: 'src' }),
      ).rejects.toThrow('Source WABA not owned by this business');
    });
  });

  describe('statusCounts', () => {
    it('totals every status across the org, ignoring pagination', async () => {
      mockPrisma.waba.findMany.mockResolvedValue([
        { wabaId: 'w1' },
        { wabaId: 'w2' },
      ]);
      mockPrisma.messageTemplate.groupBy.mockResolvedValue([
        { status: 'APPROVED', _count: { _all: 12 } },
        { status: 'REJECTED', _count: { _all: 3 } },
      ]);

      const result = await service.statusCounts('sso_org_1');

      expect(mockPrisma.messageTemplate.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { wabaId: { in: ['w1', 'w2'] } } }),
      );
      expect(result).toEqual({
        total: 15,
        byStatus: { APPROVED: 12, REJECTED: 3 },
      });
    });

    it('scopes the counts to one WABA when asked, checking ownership', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1' });
      mockPrisma.messageTemplate.groupBy.mockResolvedValue([]);

      const result = await service.statusCounts('sso_org_1', 'w1');

      expect(mockPrisma.waba.findFirst).toHaveBeenCalledWith({
        where: { wabaId: 'w1', WabaOrganisation: { some: { ssoOrgId: 'sso_org_1' } } },
      });
      // No templates yet is a zero, not a missing block the console has to guess at.
      expect(result).toEqual({ total: 0, byStatus: {} });
    });

    it('counts within a category, so the numbers match a list filtered the same way', async () => {
      mockPrisma.waba.findMany.mockResolvedValue([{ wabaId: 'w1' }]);
      mockPrisma.messageTemplate.groupBy.mockResolvedValue([
        { status: 'APPROVED', _count: { _all: 4 } },
      ]);

      await service.statusCounts('sso_org_1', undefined, 'MARKETING');

      expect(mockPrisma.messageTemplate.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { wabaId: { in: ['w1'] }, category: 'MARKETING' },
        }),
      );
    });

    it('ignores a category it does not recognise rather than failing the count', async () => {
      mockPrisma.waba.findMany.mockResolvedValue([{ wabaId: 'w1' }]);
      mockPrisma.messageTemplate.groupBy.mockResolvedValue([]);

      await service.statusCounts('sso_org_1', undefined, 'NONSENSE');

      expect(mockPrisma.messageTemplate.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { wabaId: { in: ['w1'] } } }),
      );
    });
  });

  describe('paywall', () => {
    it('refuses a sync on an account with no subscription', async () => {
      // Managing an account's templates is part of what the subscription buys,
      // in the console as much as through an API key.
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue({ accessToken: 'enc' });
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1', ssoOrgId: 'org_1' });
      mockBilling.requireAccess.mockRejectedValueOnce(
        new HttpException('no subscription', HttpStatus.PAYMENT_REQUIRED),
      );

      await expect(service.syncTemplates(1, 'org_1', 'w1')).rejects.toMatchObject({
        status: 402,
      });
      expect(mockBilling.requireAccess).toHaveBeenCalledWith('org_1', 'w1');
    });
  });
});
