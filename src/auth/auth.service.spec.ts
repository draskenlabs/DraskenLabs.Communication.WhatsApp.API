import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SsoService } from './sso.service';
import { UserService } from 'src/user/user.service';
import { JwtService } from '@nestjs/jwt';
import { RedisService } from 'src/redis/redis.service';
import { OrgDirectoryService } from 'src/org/org-directory.service';
import { orgDirectoryDouble } from 'src/org/org.test-doubles';
import { OrganisationSettingsService } from 'src/organisation-settings/organisation-settings.service';
import { organisationSettingsDouble } from 'src/organisation-settings/organisation-settings.test-doubles';
import { firstArg } from 'src/common/utils/mock-args';

const mockSsoService = {
  exchangeCode: jest.fn(),
  decodeUserInfo: jest.fn(),
  listOrganizations: jest.fn(),
  createOrganization: jest.fn(),
  getProfile: jest.fn().mockResolvedValue(null),
};

const mockUserService = {
  findOrCreateBySsoId: jest.fn(),
};

const mockJwtService = { signAsync: jest.fn().mockResolvedValue('signed_token') };

const mockRedisService = {
  createSessionId: jest.fn().mockResolvedValue('session-1'),
  setSsoSession: jest.fn().mockResolvedValue(undefined),
  getSsoSession: jest.fn(),
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

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: SsoService, useValue: mockSsoService },
        { provide: UserService, useValue: mockUserService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: RedisService, useValue: mockRedisService },
        { provide: OrgDirectoryService, useValue: mockOrgDirectory },
        { provide: OrganisationSettingsService, useValue: mockOrgSettings },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
  });

  describe('handleCallback', () => {
    const dto = { code: 'code_123', codeVerifier: 'verifier_abc' };

    it('exchanges the code, caches the SSO session and returns a session token + orgs', async () => {
      mockSsoService.exchangeCode.mockResolvedValue({ accessToken: 'sso_tok', refreshToken: 'r', expiresIn: 900 });
      mockSsoService.decodeUserInfo.mockReturnValue({
        ssoId: 'sso_1', email: 'a@b.com', firstName: 'A', lastName: 'B', ssoOrgId: null, role: null,
      });
      mockUserService.findOrCreateBySsoId.mockResolvedValue({ id: 1, ssoId: 'sso_1', createdAt: new Date() });
      const orgs = [{ id: 'org_1', name: 'Acme', slug: 'acme' }];
      mockSsoService.listOrganizations.mockResolvedValue(orgs);

      const result = await service.handleCallback(dto);

      expect(mockRedisService.setSsoSession).toHaveBeenCalledWith('session-1', {
        ssoId: 'sso_1', ssoAccessToken: 'sso_tok', email: 'a@b.com', firstName: 'A', lastName: 'B',
        username: '', emailVerified: false, imageUrl: '', ssoCreatedAt: null, orgs,
      });
      expect(mockJwtService.signAsync).toHaveBeenCalledWith({ sub: 1, sessionId: 'session-1' });
      expect(result).toEqual({ access_token: 'signed_token', user: { id: 1, ssoId: 'sso_1', createdAt: expect.any(Date) }, organisations: orgs });
    });

    it('caches the SSO profile in preference to the token claims', async () => {
      // The access token carries no name claims, so without /users/me the
      // console falls back to showing the email address as the user's name.
      mockSsoService.exchangeCode.mockResolvedValue({ accessToken: 'sso_tok' });
      mockSsoService.decodeUserInfo.mockReturnValue({
        ssoId: 'sso_1', email: 'a@b.com', firstName: '', lastName: '', ssoOrgId: null, role: null,
      });
      mockUserService.findOrCreateBySsoId.mockResolvedValue({ id: 1, ssoId: 'sso_1', createdAt: new Date() });
      mockSsoService.listOrganizations.mockResolvedValue([]);
      mockSsoService.getProfile.mockResolvedValue({
        ssoId: 'sso_1', email: 'a@b.com', firstName: 'Ada', lastName: 'Lovelace',
        username: 'ada', emailVerified: true, imageUrl: 'https://img/ada.png',
        createdAt: '2026-05-01T00:00:00.000Z', updatedAt: null,
      });

      await service.handleCallback(dto);

      expect(mockSsoService.getProfile).toHaveBeenCalledWith('sso_tok');
      expect(mockRedisService.setSsoSession).toHaveBeenCalledWith('session-1', expect.objectContaining({
        firstName: 'Ada', lastName: 'Lovelace', username: 'ada',
        emailVerified: true, imageUrl: 'https://img/ada.png',
        ssoCreatedAt: '2026-05-01T00:00:00.000Z',
      }));
    });

    it('returns an empty org list for a user who belongs to none (no throw)', async () => {
      mockSsoService.exchangeCode.mockResolvedValue({ accessToken: 'sso_tok' });
      mockSsoService.decodeUserInfo.mockReturnValue({ ssoId: 'sso_1', email: 'a@b.com', firstName: '', lastName: '', ssoOrgId: null, role: null });
      mockUserService.findOrCreateBySsoId.mockResolvedValue({ id: 1, ssoId: 'sso_1', createdAt: new Date() });
      mockSsoService.listOrganizations.mockResolvedValue([]);

      const result = await service.handleCallback(dto);
      expect(result.organisations).toEqual([]);
    });
  });

  describe('selectOrg', () => {
    it('re-issues an org-scoped token for a member org', async () => {
      mockRedisService.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1', ssoAccessToken: 'sso_tok', orgs: [{ id: 'org_1', name: 'Acme' }],
      });

      const result = await service.selectOrg(1, 'session-1', 'org_1');

      expect(mockJwtService.signAsync).toHaveBeenCalledWith({ sub: 1, orgId: 'org_1', role: 'member', sessionId: 'session-1' });
      expect(result).toEqual({ access_token: 'signed_token', orgId: 'org_1', organisation: { id: 'org_1', name: 'Acme' } });
    });

    it('throws ForbiddenException when the user is not a member', async () => {
      mockRedisService.getSsoSession.mockResolvedValue({ ssoId: 'sso_1', ssoAccessToken: 't', orgs: [{ id: 'org_1', name: 'Acme' }] });
      await expect(service.selectOrg(1, 'session-1', 'org_other')).rejects.toThrow(ForbiddenException);
    });

    it('throws UnauthorizedException when the session expired', async () => {
      mockRedisService.getSsoSession.mockResolvedValue(null);
      await expect(service.selectOrg(1, 'session-1', 'org_1')).rejects.toThrow(UnauthorizedException);
    });

    it('lets an agency into a client it does not belong to in the SSO', async () => {
      // Clients are organisations here, and nobody at the agency is a member of
      // one. The relationship is ours to know, so the SSO's answer is not the
      // last word.
      mockRedisService.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1', ssoAccessToken: 't', orgs: [{ id: 'org_agency', name: 'Bright Reach' }],
      });
      mockOrgSettings.get.mockResolvedValueOnce(
        settings({ ssoOrgId: 'org_client', agencyOrgId: 'org_agency', clientName: 'Kettle Coffee' }),
      );

      const result = await service.selectOrg(1, 'session-1', 'org_client');

      expect(mockJwtService.signAsync).toHaveBeenCalledWith({
        sub: 1, orgId: 'org_client', role: 'agency', sessionId: 'session-1', agencyOrgId: 'org_agency',
      });
      expect(result.organisation.name).toBe('Kettle Coffee');
    });

    it('refuses a client belonging to some other agency', async () => {
      // The row says it has an agency; it is not this one. Matching on "has an
      // agency" alone would hand every agency every other agency's clients.
      mockRedisService.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1', ssoAccessToken: 't', orgs: [{ id: 'org_agency', name: 'Bright Reach' }],
      });
      mockOrgSettings.get.mockResolvedValueOnce(
        settings({ ssoOrgId: 'org_client', agencyOrgId: 'org_rival' }),
      );

      await expect(service.selectOrg(1, 'session-1', 'org_client')).rejects.toThrow(ForbiddenException);
      expect(mockJwtService.signAsync).not.toHaveBeenCalled();
    });

    it('leaves the agency claim off an ordinary organisation', async () => {
      // Downstream reads the claim as "an agency is acting inside a client".
      // Sending it on every token would make that reading meaningless.
      mockRedisService.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1', ssoAccessToken: 't', orgs: [{ id: 'org_1', name: 'Acme' }],
      });

      await service.selectOrg(1, 'session-1', 'org_1');

      const claims = firstArg<Record<string, unknown>>(mockJwtService.signAsync);
      expect(claims).not.toHaveProperty('agencyOrgId');
    });
  });

  describe('createOrganisation', () => {
    it('creates the org, updates the cache and issues an owner-scoped token', async () => {
      mockRedisService.getSsoSession.mockResolvedValue({ ssoId: 'sso_1', ssoAccessToken: 'sso_tok', orgs: [] });
      mockSsoService.createOrganization.mockResolvedValue({ id: 'org_new', name: 'Gamma', slug: 'gamma' });

      const result = await service.createOrganisation(1, 'session-1', 'Gamma');

      expect(mockSsoService.createOrganization).toHaveBeenCalledWith('sso_tok', 'Gamma');
      expect(mockRedisService.setSsoSession).toHaveBeenCalledWith('session-1', {
        ssoId: 'sso_1', ssoAccessToken: 'sso_tok', orgs: [{ id: 'org_new', name: 'Gamma', slug: 'gamma' }],
      });
      expect(mockJwtService.signAsync).toHaveBeenCalledWith({ sub: 1, orgId: 'org_new', role: 'owner', sessionId: 'session-1' });
      expect(result.orgId).toBe('org_new');
    });
  });

  describe('listOrganisations', () => {
    it('returns the cached org list', async () => {
      const orgs = [{ id: 'org_1', name: 'Acme' }];
      mockRedisService.getSsoSession.mockResolvedValue({ ssoId: 'sso_1', ssoAccessToken: 't', orgs });
      await expect(service.listOrganisations('session-1')).resolves.toEqual(orgs);
    });

    it('lists an agency\u2019s clients after its own organisations', async () => {
      mockRedisService.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1', ssoAccessToken: 't', orgs: [{ id: 'org_agency', name: 'Bright Reach' }],
      });
      mockOrgSettings.get.mockResolvedValueOnce(
        settings({ ssoOrgId: 'org_agency', isAgency: true }),
      );
      mockOrgSettings.clientRoster.mockResolvedValueOnce([
        { ssoOrgId: 'org_client', clientName: 'Kettle Coffee' },
      ]);

      const orgs = await service.listOrganisations('session-1');

      expect(orgs).toEqual([
        { id: 'org_agency', name: 'Bright Reach' },
        { id: 'org_client', name: 'Kettle Coffee', agencyOrgId: 'org_agency' },
      ]);
    });

    it('names a client the agency has not labelled', async () => {
      // A client organisation whose people have never logged in has no name
      // anywhere, and a row of blank entries is not a switcher.
      mockRedisService.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1', ssoAccessToken: 't', orgs: [{ id: 'org_agency', name: 'Bright Reach' }],
      });
      mockOrgSettings.get.mockResolvedValueOnce(
        settings({ ssoOrgId: 'org_agency', isAgency: true }),
      );
      mockOrgSettings.clientRoster.mockResolvedValueOnce([
        { ssoOrgId: 'org_client', clientName: null },
      ]);
      mockOrgDirectory.name.mockResolvedValueOnce('Kettle Coffee Pvt Ltd');

      const orgs = await service.listOrganisations('session-1');

      expect(orgs[1].name).toBe('Kettle Coffee Pvt Ltd');
    });

    it('adds nothing for an organisation that is not an agency', async () => {
      mockRedisService.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1', ssoAccessToken: 't', orgs: [{ id: 'org_1', name: 'Acme' }],
      });

      await service.listOrganisations('session-1');

      expect(mockOrgSettings.clientRoster).not.toHaveBeenCalled();
    });

    it('throws UnauthorizedException when the session expired', async () => {
      mockRedisService.getSsoSession.mockResolvedValue(null);
      await expect(service.listOrganisations('session-1')).rejects.toThrow(UnauthorizedException);
    });
  });
});
