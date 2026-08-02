import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { WabaMembershipService } from './waba-membership.service';
import { PrismaService } from 'src/prisma/prisma.service';

const mockPrisma = {
  waba: { findFirst: jest.fn() },
  wabaOrganisation: { count: jest.fn(), findUnique: jest.fn() },
  userWhatsapp: { findFirst: jest.fn() },
};

describe('WabaMembershipService', () => {
  let service: WabaMembershipService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WabaMembershipService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(WabaMembershipService);
  });

  describe('require', () => {
    it('asks membership, not the account`s first connector', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1', name: 'Games' });

      await expect(service.require('org_2', 'w1')).resolves.toEqual({
        wabaId: 'w1',
        name: 'Games',
      });
      expect(mockPrisma.waba.findFirst).toHaveBeenCalledWith({
        where: { wabaId: 'w1', WabaOrganisation: { some: { ssoOrgId: 'org_2' } } },
        select: { wabaId: true, name: true },
      });
    });

    it('refuses an account this organisation does not hold', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue(null);
      await expect(service.require('org_2', 'w1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('connection', () => {
    beforeEach(() => {
      mockPrisma.waba.findFirst.mockResolvedValue({ wabaId: 'w1', name: 'Games' });
    });

    it('prefers the caller`s own connection', async () => {
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue({ userId: 7, accessToken: 'mine' });

      await expect(service.connection('org_1', 'w1', 7)).resolves.toMatchObject({
        accessToken: 'mine',
      });
      expect(mockPrisma.wabaOrganisation.findUnique).not.toHaveBeenCalled();
    });

    it('falls back to the organisation`s own connection for a colleague', async () => {
      // A colleague who never completed signup has no token of their own.
      // Refusing them would be refusing an account their organisation holds.
      mockPrisma.userWhatsapp.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ userId: 3, accessToken: 'the_org_one' });
      mockPrisma.wabaOrganisation.findUnique.mockResolvedValue({ userId: 3 });

      await expect(service.connection('org_1', 'w1', 42)).resolves.toMatchObject({
        accessToken: 'the_org_one',
      });
      expect(mockPrisma.wabaOrganisation.findUnique).toHaveBeenCalledWith({
        where: { wabaId_ssoOrgId: { wabaId: 'w1', ssoOrgId: 'org_1' } },
        select: { userId: true },
      });
    });

    it('never reaches for a connection outside the organisation', async () => {
      // The account exists and another organisation has a token for it, but
      // this organisation's own membership row has none — borrowing the other
      // one's token is exactly what must not happen.
      mockPrisma.userWhatsapp.findFirst.mockResolvedValue(null);
      mockPrisma.wabaOrganisation.findUnique.mockResolvedValue({ userId: 3 });

      await expect(service.connection('org_2', 'w1', 42)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses before looking for a token when the org does not hold the account', async () => {
      mockPrisma.waba.findFirst.mockResolvedValue(null);

      await expect(service.connection('org_3', 'w1', 1)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.userWhatsapp.findFirst).not.toHaveBeenCalled();
    });
  });

  it('holds() answers without throwing', async () => {
    mockPrisma.wabaOrganisation.count.mockResolvedValue(0);
    await expect(service.holds('org_2', 'w1')).resolves.toBe(false);
    mockPrisma.wabaOrganisation.count.mockResolvedValue(1);
    await expect(service.holds('org_1', 'w1')).resolves.toBe(true);
  });
});
