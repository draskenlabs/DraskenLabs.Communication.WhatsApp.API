import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AgencyService } from './agency.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { OrganisationSettingsService } from 'src/organisation-settings/organisation-settings.service';
import { organisationSettingsDouble } from 'src/organisation-settings/organisation-settings.test-doubles';
import { OrgDirectoryService } from 'src/org/org-directory.service';
import { orgDirectoryDouble } from 'src/org/org.test-doubles';
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { firstArg } from 'src/common/utils/mock-args';

const mockPrisma = {
  organisationSettings: {
    findMany: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
  },
  wabaOrganisation: { findMany: jest.fn() },
  wabaPhoneNumber: { groupBy: jest.fn() },
  contact: { groupBy: jest.fn() },
  message: { groupBy: jest.fn() },
};

// Rebuilt per test, not shared: `jest.clearAllMocks()` forgets calls but keeps
// implementations, so one test's `mockResolvedValue` would otherwise still be
// answering in the next describe block.
let mockSettings: ReturnType<typeof organisationSettingsDouble>;
let mockOrgDirectory: ReturnType<typeof orgDirectoryDouble>;
const mockPlanLimits = { forOrg: jest.fn() };

/** The settings row `get` should answer for one organisation. */
const settings = (over: Record<string, unknown> = {}) => ({
  ssoOrgId: 'org_x',
  agencyOrgId: null,
  isAgency: false,
  clientName: null,
  payerVersion: 0,
  ...over,
});

describe('AgencyService', () => {
  let service: AgencyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSettings = organisationSettingsDouble();
    mockOrgDirectory = orgDirectoryDouble();
    mockPrisma.organisationSettings.findMany.mockResolvedValue([]);
    mockPrisma.wabaOrganisation.findMany.mockResolvedValue([]);
    mockPrisma.wabaPhoneNumber.groupBy.mockResolvedValue([]);
    mockPrisma.contact.groupBy.mockResolvedValue([]);
    mockPrisma.message.groupBy.mockResolvedValue([]);
    mockPlanLimits.forOrg.mockResolvedValue({
      planName: 'Agency',
      includedClients: 10,
      includedWabas: 20,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgencyService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrganisationSettingsService, useValue: mockSettings },
        { provide: OrgDirectoryService, useValue: mockOrgDirectory },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
      ],
    }).compile();
    service = module.get(AgencyService);
  });

  describe('convert', () => {
    it('marks an organisation an agency and records who did it', async () => {
      await service.convert('org_1', true, 42);

      const { update, create } = firstArg<{
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      }>(mockPrisma.organisationSettings.upsert);
      expect(update.isAgency).toBe(true);
      expect(update.convertedBy).toBe(42);
      expect(create.ssoOrgId).toBe('org_1');
    });

    it('orphans whatever the old status had cached', async () => {
      // Its clients read access off this organisation's version. A conversion
      // that left it alone would keep answering from before the change.
      await service.convert('org_1', true);

      const { update } = firstArg<{ update: { payerVersion: unknown } }>(
        mockPrisma.organisationSettings.upsert,
      );
      expect(update.payerVersion).toEqual({ increment: 1 });
    });

    it('refuses to make an agency out of somebody’s client', async () => {
      // One level, no chains: "who pays" has to stay a lookup, not a walk.
      mockSettings.get.mockResolvedValueOnce(
        settings({ agencyOrgId: 'org_agency' }),
      );

      await expect(service.convert('org_1', true)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.organisationSettings.upsert).not.toHaveBeenCalled();
    });

    it('refuses to demote an agency that still has clients', async () => {
      // They would go on inheriting from an organisation that manages nothing
      // — subscribed to nothing, with no error anyone could act on.
      mockSettings.get.mockResolvedValueOnce(settings({ isAgency: true }));
      mockSettings.clientsOf.mockResolvedValueOnce(['org_a', 'org_b']);

      await expect(service.convert('org_1', false)).rejects.toThrow(
        /still has 2 clients/,
      );
    });

    it('demotes an agency with nobody left on its roster', async () => {
      mockSettings.get.mockResolvedValueOnce(settings({ isAgency: true }));

      await service.convert('org_1', false);

      const { update } = firstArg<{
        update: { isAgency: boolean; convertedAt: unknown };
      }>(mockPrisma.organisationSettings.upsert);
      expect(update.isAgency).toBe(false);
      expect(update.convertedAt).toBeNull();
    });
  });

  describe('attachClient', () => {
    beforeEach(() => {
      mockSettings.get
        .mockResolvedValueOnce(
          settings({ ssoOrgId: 'org_agency', isAgency: true }),
        )
        .mockResolvedValueOnce(settings({ ssoOrgId: 'org_client' }));
    });

    it('points the client at the agency and re-keys its cached access', async () => {
      const summary = await service.attachClient(
        'org_agency',
        'org_client',
        'Kettle Coffee',
      );

      const { update } = firstArg<{
        update: {
          agencyOrgId: string;
          clientName: string;
          payerVersion: unknown;
        };
      }>(mockPrisma.organisationSettings.upsert);
      expect(update.agencyOrgId).toBe('org_agency');
      expect(update.clientName).toBe('Kettle Coffee');
      expect(update.payerVersion).toEqual({ increment: 1 });
      expect(summary.name).toBe('Kettle Coffee');
    });

    it('refuses a client for an organisation that is not an agency', async () => {
      mockSettings.get.mockReset();
      mockSettings.get.mockResolvedValue(settings());

      await expect(service.attachClient('org_1', 'org_client')).rejects.toThrow(
        /not an agency/,
      );
    });

    it('refuses to take on an agency as a client', async () => {
      mockSettings.get.mockReset();
      mockSettings.get
        .mockResolvedValueOnce(settings({ isAgency: true }))
        .mockResolvedValueOnce(settings({ isAgency: true }));

      await expect(
        service.attachClient('org_agency', 'org_other_agency'),
      ).rejects.toThrow(/Demote it first/);
    });

    it('refuses to take a client off another agency', async () => {
      // Moving it silently would change who is billed without either agency
      // being told.
      mockSettings.get.mockReset();
      mockSettings.get
        .mockResolvedValueOnce(settings({ isAgency: true }))
        .mockResolvedValueOnce(settings({ agencyOrgId: 'org_rival' }));

      await expect(
        service.attachClient('org_agency', 'org_client'),
      ).rejects.toThrow(/already belongs to another agency/);
    });

    it('refuses an organisation as its own client', async () => {
      mockSettings.get.mockReset();

      await expect(service.attachClient('org_1', 'org_1')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.organisationSettings.upsert).not.toHaveBeenCalled();
    });
  });

  describe('detachClient', () => {
    it('clears the agency and re-keys the client’s access', async () => {
      mockSettings.get.mockResolvedValueOnce(
        settings({ agencyOrgId: 'org_agency' }),
      );

      await service.detachClient('org_agency', 'org_client');

      expect(mockPrisma.organisationSettings.update).toHaveBeenCalledWith({
        where: { ssoOrgId: 'org_client' },
        data: { agencyOrgId: null, payerVersion: { increment: 1 } },
      });
    });

    it('404s for an organisation that is not this agency’s client', async () => {
      mockSettings.get.mockResolvedValueOnce(
        settings({ agencyOrgId: 'org_rival' }),
      );

      await expect(
        service.detachClient('org_agency', 'org_client'),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrisma.organisationSettings.update).not.toHaveBeenCalled();
    });
  });

  describe('roster', () => {
    beforeEach(() => {
      mockSettings.get.mockResolvedValue(settings({ isAgency: true }));
    });

    it('refuses to answer for an organisation that manages nobody', async () => {
      mockSettings.get.mockResolvedValue(settings());

      await expect(service.roster('org_1')).rejects.toThrow(ForbiddenException);
    });

    it('counts each client’s accounts, numbers, contacts and messages', async () => {
      mockPrisma.organisationSettings.findMany.mockResolvedValue([
        {
          ssoOrgId: 'org_a',
          clientName: 'Kettle',
          createdAt: new Date('2026-01-01'),
        },
        {
          ssoOrgId: 'org_b',
          clientName: 'Loom',
          createdAt: new Date('2026-02-01'),
        },
      ]);
      mockPrisma.wabaOrganisation.findMany.mockResolvedValue([
        { ssoOrgId: 'org_a', wabaId: 'waba_1' },
        { ssoOrgId: 'org_a', wabaId: 'waba_2' },
        { ssoOrgId: 'org_b', wabaId: 'waba_3' },
      ]);
      mockPrisma.wabaPhoneNumber.groupBy.mockResolvedValue([
        { wabaId: 'waba_1', _count: { _all: 2 } },
        { wabaId: 'waba_2', _count: { _all: 1 } },
        { wabaId: 'waba_3', _count: { _all: 4 } },
      ]);
      mockPrisma.contact.groupBy.mockResolvedValue([
        { ssoOrgId: 'org_a', _count: { _all: 900 } },
      ]);
      mockPrisma.message.groupBy.mockResolvedValue([
        { ssoOrgId: 'org_b', _count: { _all: 12 } },
      ]);

      const { clients, totals } = await service.roster('org_agency');

      expect(clients[0]).toEqual(
        expect.objectContaining({
          ssoOrgId: 'org_a',
          name: 'Kettle',
          wabas: 2,
          phoneNumbers: 3,
          contacts: 900,
          messagesThisMonth: 0,
        }),
      );
      expect(clients[1]).toEqual(
        expect.objectContaining({
          wabas: 1,
          phoneNumbers: 4,
          messagesThisMonth: 12,
        }),
      );
      expect(totals).toEqual(
        expect.objectContaining({
          clients: 2,
          wabas: 3,
          phoneNumbers: 7,
          includedClients: 10,
          planName: 'Agency',
        }),
      );
    });

    it('reads the whole roster in a fixed number of queries', async () => {
      // The page exists for an agency with fifty clients. A query per row would
      // make it slowest exactly where it matters.
      mockPrisma.organisationSettings.findMany.mockResolvedValue(
        Array.from({ length: 50 }, (_, i) => ({
          ssoOrgId: `org_${i}`,
          clientName: `Client ${i}`,
          createdAt: new Date('2026-01-01'),
        })),
      );

      await service.roster('org_agency');

      expect(mockPrisma.wabaOrganisation.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.contact.groupBy).toHaveBeenCalledTimes(1);
      expect(mockPrisma.message.groupBy).toHaveBeenCalledTimes(1);
    });

    it('skips the phone-number query when no client has an account', async () => {
      mockPrisma.organisationSettings.findMany.mockResolvedValue([
        { ssoOrgId: 'org_a', clientName: 'Kettle', createdAt: new Date() },
      ]);

      await service.roster('org_agency');

      expect(mockPrisma.wabaPhoneNumber.groupBy).not.toHaveBeenCalled();
    });

    it('falls back to a name we know for a client nobody has labelled', async () => {
      mockPrisma.organisationSettings.findMany.mockResolvedValue([
        { ssoOrgId: 'org_a', clientName: null, createdAt: new Date() },
      ]);
      mockOrgDirectory.name.mockResolvedValueOnce('Kettle Coffee Pvt Ltd');

      const { clients } = await service.roster('org_agency');

      expect(clients[0].name).toBe('Kettle Coffee Pvt Ltd');
    });

    it('answers an empty roster without touching the counters', async () => {
      const { clients, totals } = await service.roster('org_agency');

      expect(clients).toEqual([]);
      expect(totals.clients).toBe(0);
      expect(mockPrisma.wabaOrganisation.findMany).not.toHaveBeenCalled();
    });
  });

  describe('renameClient', () => {
    it('renames a client of this agency', async () => {
      mockSettings.get.mockResolvedValueOnce(
        settings({ agencyOrgId: 'org_agency' }),
      );

      await service.renameClient('org_agency', 'org_client', 'Kettle Coffee');

      expect(mockPrisma.organisationSettings.update).toHaveBeenCalledWith({
        where: { ssoOrgId: 'org_client' },
        data: { clientName: 'Kettle Coffee' },
      });
    });

    it('404s for a client that is not this agency’s', async () => {
      mockSettings.get.mockResolvedValueOnce(
        settings({ agencyOrgId: 'org_rival' }),
      );

      await expect(
        service.renameClient('org_agency', 'org_client', 'Mine Now'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
