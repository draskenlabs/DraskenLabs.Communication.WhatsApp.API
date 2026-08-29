import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AgencyController } from './agency.controller';
import { AgencyService } from './agency.service';
import { InvoiceService } from 'src/billing/invoice.service';

const mockAgency = {
  roster: jest.fn().mockResolvedValue({ clients: [], totals: {} }),
  renameClient: jest.fn().mockResolvedValue({}),
  convert: jest.fn().mockResolvedValue({}),
  attachClient: jest.fn().mockResolvedValue({}),
  detachClient: jest.fn().mockResolvedValue(undefined),
};

const config: Record<string, string | undefined> = {};
const mockConfig = { get: jest.fn((key: string) => config[key]) };
// The controller only renders a document; which ones it may render is the
// service's decision, and is tested there.
const mockInvoices = {
  pdf: jest.fn(() => Buffer.from('%PDF-1.4')),
  filename: jest.fn(() => 'INV-WAC-2627-0001.pdf'),
};

describe('AgencyController', () => {
  let controller: AgencyController;

  beforeEach(async () => {
    jest.clearAllMocks();
    config.AGENCY_ADMIN_TOKEN = 'operator-secret';
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgencyController],
      providers: [
        { provide: AgencyService, useValue: mockAgency },
        { provide: ConfigService, useValue: mockConfig },
        { provide: InvoiceService, useValue: mockInvoices },
      ],
    }).compile();
    controller = module.get(AgencyController);
  });

  describe('the agency’s own routes', () => {
    it('reads the roster of the organisation the token is scoped to', async () => {
      await controller.clients({ orgId: 'org_agency' } as never);

      expect(mockAgency.roster).toHaveBeenCalledWith('org_agency');
    });

    it('refuses a token carrying no organisation', async () => {
      await expect(controller.clients({} as never)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('renames a client under the caller’s own agency, not one it names', async () => {
      // The agency comes from the token. Taking it from the body would let any
      // agency rename any other agency's clients.
      await controller.rename({ orgId: 'org_agency' } as never, 'org_client', {
        clientName: 'Kettle Coffee',
      });

      expect(mockAgency.renameClient).toHaveBeenCalledWith(
        'org_agency',
        'org_client',
        'Kettle Coffee',
      );
    });
  });

  describe('the operator routes', () => {
    it('converts an organisation for a caller holding the token', async () => {
      await controller.convert('operator-secret', {
        ssoOrgId: 'org_1',
        convertedBy: 42,
      });

      expect(mockAgency.convert).toHaveBeenCalledWith('org_1', true, 42);
    });

    it('treats a conversion with no flag as a promotion', async () => {
      await controller.convert('operator-secret', { ssoOrgId: 'org_1' });

      expect(mockAgency.convert).toHaveBeenCalledWith('org_1', true, undefined);
    });

    it('refuses a wrong token', async () => {
      await expect(
        controller.convert('guess', { ssoOrgId: 'org_1' }),
      ).rejects.toThrow(/Invalid admin token/);
      expect(mockAgency.convert).not.toHaveBeenCalled();
    });

    it('refuses a missing token', async () => {
      await expect(
        controller.attach(undefined, {
          agencyOrgId: 'org_agency',
          ssoOrgId: 'org_client',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockAgency.attachClient).not.toHaveBeenCalled();
    });

    it('stays shut on a deployment that configured no token', async () => {
      // Off by default: a self-hosted install should not ship an endpoint that
      // hands out the right to read another organisation's messages.
      config.AGENCY_ADMIN_TOKEN = undefined;

      await expect(
        controller.convert('', { ssoOrgId: 'org_1' }),
      ).rejects.toThrow(/not enabled on this server/);
    });

    it('detaches a client of the agency named in the path', async () => {
      const result = await controller.detach(
        'operator-secret',
        'org_agency',
        'org_client',
      );

      expect(mockAgency.detachClient).toHaveBeenCalledWith(
        'org_agency',
        'org_client',
      );
      expect(result).toEqual({ ok: true });
    });
  });
});
