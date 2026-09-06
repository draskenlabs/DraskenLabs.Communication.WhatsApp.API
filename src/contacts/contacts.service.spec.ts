import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';

const mockPrisma = {
  contact: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  $transaction: jest.fn(),
};

const baseContact = {
  id: 1, ssoOrgId: 'sso_org_1', phone: '447911111111', name: 'Alice', email: 'a@b.com',
  optedOut: false, metadata: null, createdAt: new Date(), updatedAt: new Date(),
};

const mockPlanLimits = {
  forOrg: jest.fn(),
  // Advisory: the refusal is asserted on, the suggestion after it is not, and
  // a double that answers "no tier would help" keeps the message the one this
  // spec was written against.
  cheapestPlanAllowing: jest.fn().mockResolvedValue(null),
};

describe('ContactsService', () => {
  let service: ContactsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPlanLimits.forOrg.mockResolvedValue({
      planCode: 'growth',
      planName: 'Growth',
      contacts: 10000,
    });
    mockPrisma.contact.count.mockResolvedValue(0);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
      ],
    }).compile();
    service = module.get<ContactsService>(ContactsService);
  });

  describe('create', () => {
    it('refuses a contact past the plan limit', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue(null);
      mockPlanLimits.forOrg.mockResolvedValue({
        planCode: 'starter',
        planName: 'Starter',
        contacts: 1000,
      });
      mockPrisma.contact.count.mockResolvedValue(1000);

      await expect(
        service.create('org_1', { phone: '911234567890' } as never),
      ).rejects.toThrow(/Starter plan includes 1000 contacts/);
      expect(mockPrisma.contact.create).not.toHaveBeenCalled();
    });

    it('checks a whole batch before importing any of it', async () => {
      // Row by row would leave a five-thousand-line file half in the database
      // and half refused, which is worse than not importing it at all.
      mockPlanLimits.forOrg.mockResolvedValue({
        planCode: 'growth',
        planName: 'Growth',
        contacts: 10000,
      });
      mockPrisma.contact.count.mockResolvedValue(9500);

      await expect(
        service.assertRoomFor('org_1', 400),
      ).resolves.toBeUndefined();
      await expect(service.assertRoomFor('org_1', 600)).rejects.toThrow(
        /Importing 600 would take you past it/,
      );
    });

    it('allows anything on a plan that names no contact limit', async () => {
      mockPlanLimits.forOrg.mockResolvedValue({
        planCode: 'agency',
        planName: 'Agency',
        contacts: null,
      });
      mockPrisma.contact.count.mockResolvedValue(500000);

      await expect(
        service.assertRoomFor('org_1', 10000),
      ).resolves.toBeUndefined();
    });

    it('throws BadRequestException if phone already exists in org', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue(baseContact);
      await expect(service.create('sso_org_1', { phone: '447911111111' })).rejects.toThrow(BadRequestException);
    });

    it('creates and returns contact', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue(null);
      mockPrisma.contact.create.mockResolvedValue(baseContact);
      const result = await service.create('sso_org_1', { phone: '447911111111', name: 'Alice' });
      expect(result.phone).toBe('447911111111');
      expect(result.optedOut).toBe(false);
    });
  });

  describe('findAll', () => {
    it('returns every contact when unpaginated (no meta)', async () => {
      mockPrisma.contact.findMany.mockResolvedValue([baseContact]);
      const result = await service.findAll('sso_org_1');
      expect(mockPrisma.contact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ssoOrgId: 'sso_org_1' } }),
      );
      expect(result.data).toHaveLength(1);
      expect(result.meta).toBeUndefined();
    });

    it('paginates and returns meta when page/limit supplied', async () => {
      mockPrisma.$transaction.mockResolvedValue([[baseContact], 5]);
      const result = await service.findAll('sso_org_1', { page: 1, limit: 2 });
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(result.data).toHaveLength(1);
      expect(result.meta).toEqual({ total: 5, totalPages: 3, page: 1, limit: 2 });
    });
  });

  describe('findOne', () => {
    it('throws NotFoundException if contact not in org', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue({ ...baseContact, ssoOrgId: 'sso_org_99' });
      await expect(service.findOne('sso_org_1', 1)).rejects.toThrow(NotFoundException);
    });

    it('returns contact when found', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue(baseContact);
      const result = await service.findOne('sso_org_1', 1);
      expect(result.id).toBe(1);
    });
  });

  describe('update', () => {
    it('throws NotFoundException if not found', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue(null);
      await expect(service.update('sso_org_1', 1, { optedOut: true })).rejects.toThrow(NotFoundException);
    });

    it('updates optedOut flag', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue(baseContact);
      mockPrisma.contact.update.mockResolvedValue({ ...baseContact, optedOut: true });
      const result = await service.update('sso_org_1', 1, { optedOut: true });
      expect(result.optedOut).toBe(true);
    });
  });

  describe('remove', () => {
    it('throws NotFoundException for missing contact', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue(null);
      await expect(service.remove('sso_org_1', 1)).rejects.toThrow(NotFoundException);
    });

    it('deletes the contact', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue(baseContact);
      mockPrisma.contact.delete.mockResolvedValue({});
      await service.remove('sso_org_1', 1);
      expect(mockPrisma.contact.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });
  });

  describe('isOptedOut', () => {
    it('returns false when contact does not exist', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue(null);
      expect(await service.isOptedOut('sso_org_1', '447911111111')).toBe(false);
    });

    it('returns true when contact has opted out', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue({ optedOut: true });
      expect(await service.isOptedOut('sso_org_1', '447911111111')).toBe(true);
    });

    it('returns false when contact has not opted out', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue({ optedOut: false });
      expect(await service.isOptedOut('sso_org_1', '447911111111')).toBe(false);
    });
  });
});
