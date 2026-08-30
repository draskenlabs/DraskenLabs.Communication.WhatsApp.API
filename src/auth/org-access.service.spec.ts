import { Test, TestingModule } from '@nestjs/testing';
import { OrgAccessService } from './org-access.service';
import { SsoService } from './sso.service';
import { RedisService } from 'src/redis/redis.service';
import { OrgDirectoryService } from 'src/org/org-directory.service';
import { orgDirectoryDouble } from 'src/org/org.test-doubles';
import { OrganisationSettingsService } from 'src/organisation-settings/organisation-settings.service';
import { organisationSettingsDouble } from 'src/organisation-settings/organisation-settings.test-doubles';

const mockSso = {
  listOrganizations: jest.fn(),
  decodeUserInfo: jest.fn(),
};

const mockRedis = {
  getSsoSession: jest.fn(),
  setSsoSession: jest.fn().mockResolvedValue(undefined),
};

const mockOrgDirectory = orgDirectoryDouble();
const mockOrgSettings = organisationSettingsDouble();

/** The settings row `get` should answer for one organisation. */
const settings = (over: Record<string, unknown> = {}) => ({
  ssoOrgId: 'org_x',
  agencyOrgId: null,
  isAgency: false,
  clientName: null,
  payerVersion: 0,
  ...over,
});

describe('OrgAccessService', () => {
  let service: OrgAccessService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrgAccessService,
        { provide: SsoService, useValue: mockSso },
        { provide: RedisService, useValue: mockRedis },
        { provide: OrgDirectoryService, useValue: mockOrgDirectory },
        { provide: OrganisationSettingsService, useValue: mockOrgSettings },
      ],
    }).compile();
    service = module.get<OrgAccessService>(OrgAccessService);
  });

  describe('grantFor', () => {
    it('grants membership in an organisation the SSO says the user belongs to', async () => {
      mockRedis.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1',
        orgs: [{ id: 'org_1', name: 'Acme' }],
        grants: {},
      });

      await expect(service.grantFor('sid_1', 'org_1', 'tok')).resolves.toEqual({
        role: 'member',
      });
    });

    it('refuses an organisation the session has nothing to do with', async () => {
      mockRedis.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1',
        orgs: [{ id: 'org_1', name: 'Acme' }],
        grants: {},
      });
      mockOrgSettings.get.mockResolvedValueOnce(
        settings({ ssoOrgId: 'org_other' }),
      );

      await expect(
        service.grantFor('sid_1', 'org_other', 'tok'),
      ).resolves.toBeNull();
    });

    /**
     * Clients are organisations here, and nobody at the agency is a member of
     * one. The relationship is ours to know, so the SSO's answer is not the
     * last word.
     */
    it('lets an agency into a client it does not belong to in the SSO', async () => {
      mockRedis.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1',
        orgs: [{ id: 'org_agency', name: 'Bright Reach' }],
        grants: {},
      });
      mockOrgSettings.get.mockResolvedValueOnce(
        settings({ ssoOrgId: 'org_client', agencyOrgId: 'org_agency' }),
      );

      await expect(
        service.grantFor('sid_1', 'org_client', 'tok'),
      ).resolves.toEqual({ role: 'agency', agencyOrgId: 'org_agency' });
    });

    /**
     * The row says it has an agency; it is not this one. Matching on "has an
     * agency" alone would hand every agency every other agency's clients.
     */
    it('refuses a client belonging to some other agency', async () => {
      mockRedis.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1',
        orgs: [{ id: 'org_agency', name: 'Bright Reach' }],
        grants: {},
      });
      mockOrgSettings.get.mockResolvedValueOnce(
        settings({ ssoOrgId: 'org_client', agencyOrgId: 'org_rival' }),
      );

      await expect(
        service.grantFor('sid_1', 'org_client', 'tok'),
      ).resolves.toBeNull();
    });

    it('writes a resolved grant back so the next request reads it', async () => {
      mockRedis.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1',
        orgs: [{ id: 'org_1', name: 'Acme' }],
        grants: {},
      });

      await service.grantFor('sid_1', 'org_1', 'tok');

      expect(mockRedis.setSsoSession).toHaveBeenCalledWith(
        'sid_1',
        expect.objectContaining({ grants: { org_1: { role: 'member' } } }),
      );
    });

    it('reads a cached grant without resolving it again', async () => {
      mockRedis.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1',
        orgs: [],
        grants: { org_client: { role: 'agency', agencyOrgId: 'org_agency' } },
      });

      await expect(
        service.grantFor('sid_1', 'org_client', 'tok'),
      ).resolves.toEqual({ role: 'agency', agencyOrgId: 'org_agency' });
      expect(mockOrgSettings.get).not.toHaveBeenCalled();
    });

    /**
     * A valid token must not be rejected because a cache is empty. Redis can be
     * evicted, or start cold after a deploy, and membership is the SSO's answer
     * to give back.
     */
    it('rebuilds a missing session from the SSO rather than refusing', async () => {
      mockRedis.getSsoSession.mockResolvedValueOnce(null);
      mockSso.listOrganizations.mockResolvedValue([
        { id: 'org_1', name: 'Acme' },
      ]);
      mockSso.decodeUserInfo.mockReturnValue({ ssoId: 'sso_1' });
      mockRedis.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1',
        orgs: [{ id: 'org_1', name: 'Acme' }],
        grants: {},
      });

      await expect(service.grantFor('sid_1', 'org_1', 'tok')).resolves.toEqual({
        role: 'member',
      });
      expect(mockSso.listOrganizations).toHaveBeenCalledWith('tok');
    });
  });

  describe('withClients', () => {
    it("lists an agency's clients after its own organisations", async () => {
      mockOrgSettings.get.mockResolvedValueOnce(
        settings({ ssoOrgId: 'org_agency', isAgency: true }),
      );
      mockOrgSettings.clientRoster.mockResolvedValueOnce([
        { ssoOrgId: 'org_client', clientName: 'Kettle Coffee' },
      ]);

      await expect(
        service.withClients([{ id: 'org_agency', name: 'Bright Reach' }]),
      ).resolves.toEqual([
        { id: 'org_agency', name: 'Bright Reach' },
        { id: 'org_client', name: 'Kettle Coffee', agencyOrgId: 'org_agency' },
      ]);
    });

    /**
     * A client organisation whose people have never logged in has no name
     * anywhere, and a row of blank entries is not a switcher.
     */
    it('names a client the agency has not labelled', async () => {
      mockOrgSettings.get.mockResolvedValueOnce(
        settings({ ssoOrgId: 'org_agency', isAgency: true }),
      );
      mockOrgSettings.clientRoster.mockResolvedValueOnce([
        { ssoOrgId: 'org_client', clientName: null },
      ]);
      mockOrgDirectory.name.mockResolvedValueOnce('Kettle Coffee Pvt Ltd');

      const orgs = await service.withClients([
        { id: 'org_agency', name: 'Bright Reach' },
      ]);

      expect(orgs[1].name).toBe('Kettle Coffee Pvt Ltd');
    });

    it('adds nothing for an organisation that is not an agency', async () => {
      await service.withClients([{ id: 'org_1', name: 'Acme' }]);
      expect(mockOrgSettings.clientRoster).not.toHaveBeenCalled();
    });
  });
});
