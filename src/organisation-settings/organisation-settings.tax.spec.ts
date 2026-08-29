import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { OrganisationSettingsService } from './organisation-settings.service';

const mockPrisma = {
  organisationSettings: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
};

/** Real registrations, both with a correct check digit. */
const KARNATAKA = '29AAPFU0939F1ZR';
const MAHARASHTRA = '27AAPFU0939F1ZV';

describe('OrganisationSettingsService — tax details', () => {
  let service: OrganisationSettingsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.organisationSettings.findUnique.mockResolvedValue(null);
    mockPrisma.organisationSettings.upsert.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganisationSettingsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(OrganisationSettingsService);
  });

  describe('reading', () => {
    it('answers empty fields for an organisation that has entered nothing', async () => {
      const details = await service.taxDetails('org_1');

      expect(details.gstin).toBeNull();
      expect(details.stateCode).toBeNull();
      expect(details.stateName).toBeNull();
    });

    it('reads the state off the registration where none was chosen', async () => {
      // Asking twice for something we can read off what they already typed is
      // how forms get abandoned.
      mockPrisma.organisationSettings.findUnique.mockResolvedValue({
        gstin: KARNATAKA,
        legalName: null,
        billingAddress: null,
        billingCity: null,
        billingPostalCode: null,
        stateCode: null,
      });

      const details = await service.taxDetails('org_1');

      expect(details.stateCode).toBe('29');
      expect(details.stateName).toBe('Karnataka');
    });
  });

  describe('writing', () => {
    it('stores a valid registration and derives the state from it', async () => {
      const details = await service.setTaxDetails('org_1', {
        gstin: KARNATAKA,
        legalName: 'Acme Retail Private Limited',
      });

      expect(details.stateCode).toBe('29');
      expect(details.stateName).toBe('Karnataka');
      expect(mockPrisma.organisationSettings.upsert).toHaveBeenCalled();
    });

    it('upper-cases a registration typed in lower case', async () => {
      const details = await service.setTaxDetails('org_1', {
        gstin: KARNATAKA.toLowerCase(),
      });

      expect(details.gstin).toBe(KARNATAKA);
    });

    it('refuses a registration whose check digit does not follow', async () => {
      // The character an auditor would catch and a regex would not.
      await expect(
        service.setTaxDetails('org_1', { gstin: KARNATAKA.slice(0, 14) + 'X' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.organisationSettings.upsert).not.toHaveBeenCalled();
    });

    it('refuses a state code that does not exist', async () => {
      await expect(
        service.setTaxDetails('org_1', { stateCode: '88' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a registration and a state that disagree', async () => {
      // One of the two is wrong. Guessing which would put the wrong heads of
      // tax on every invoice from here on.
      await expect(
        service.setTaxDetails('org_1', {
          gstin: MAHARASHTRA,
          stateCode: '29',
        }),
      ).rejects.toThrow(/Maharashtra/);
    });

    it('takes a state on its own, for a customer with no registration', async () => {
      // Unregistered customers still have a place of supply, and the split
      // still depends on it.
      const details = await service.setTaxDetails('org_1', {
        stateCode: '27',
        billingCity: 'Mumbai',
      });

      expect(details.gstin).toBeNull();
      expect(details.stateCode).toBe('27');
      expect(details.stateName).toBe('Maharashtra');
    });

    it('treats an emptied field as cleared rather than as text', async () => {
      const details = await service.setTaxDetails('org_1', {
        gstin: '   ',
        legalName: '',
        billingCity: '  Bengaluru  ',
      });

      expect(details.gstin).toBeNull();
      expect(details.legalName).toBeNull();
      expect(details.billingCity).toBe('Bengaluru');
    });
  });
});
