import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SsoService } from './sso.service';
import { SsoTokenService } from './sso-token.service';
import { OrgAccessService } from './org-access.service';
import { UserService } from 'src/user/user.service';
import { RedisService } from 'src/redis/redis.service';
import { OrgDirectoryService } from 'src/org/org-directory.service';
import { orgDirectoryDouble } from 'src/org/org.test-doubles';

const mockSsoService = {
  exchangeCode: jest.fn(),
  decodeUserInfo: jest.fn(),
  listOrganizations: jest.fn(),
  createOrganization: jest.fn(),
  refreshTokens: jest.fn(),
  logout: jest.fn().mockResolvedValue(undefined),
  getProfile: jest.fn().mockResolvedValue(null),
};

const mockSsoToken = {
  verify: jest.fn().mockResolvedValue({
    sub: 'sso_1',
    email: 'a@b.com',
    sid: 'sess_1',
  }),
};

const mockOrgAccess = {
  grantFor: jest.fn(),
  record: jest.fn().mockResolvedValue(undefined),
  withClients: jest.fn(async (orgs: unknown[]) => orgs),
};

const mockUserService = {
  findOrCreateBySsoId: jest.fn(),
};

const mockRedisService = {
  setSsoSession: jest.fn().mockResolvedValue(undefined),
  getSsoSession: jest.fn(),
  deleteSsoSession: jest.fn().mockResolvedValue(undefined),
  takeRefreshLock: jest.fn().mockResolvedValue(true),
  releaseRefreshLock: jest.fn().mockResolvedValue(undefined),
  setRefreshResult: jest.fn().mockResolvedValue(undefined),
  getRefreshResult: jest.fn().mockResolvedValue(null),
};

const mockOrgDirectory = orgDirectoryDouble();

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSsoToken.verify.mockResolvedValue({
      sub: 'sso_1',
      email: 'a@b.com',
      sid: 'sess_1',
    });
    mockOrgAccess.withClients.mockImplementation(
      async (orgs: unknown[]) => orgs,
    );
    mockRedisService.takeRefreshLock.mockResolvedValue(true);
    mockRedisService.getRefreshResult.mockResolvedValue(null);
    mockSsoService.getProfile.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: SsoService, useValue: mockSsoService },
        { provide: SsoTokenService, useValue: mockSsoToken },
        { provide: OrgAccessService, useValue: mockOrgAccess },
        { provide: UserService, useValue: mockUserService },
        { provide: RedisService, useValue: mockRedisService },
        { provide: OrgDirectoryService, useValue: mockOrgDirectory },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
  });

  describe('handleCallback', () => {
    const dto = { code: 'code_123', codeVerifier: 'verifier_abc' };

    const signedIn = (orgs: unknown[] = []) => {
      mockSsoService.exchangeCode.mockResolvedValue({
        accessToken: 'sso_tok',
        refreshToken: 'sso_refresh',
        expiresIn: 600,
      });
      mockSsoService.decodeUserInfo.mockReturnValue({
        ssoId: 'sso_1',
        email: 'a@b.com',
        firstName: 'A',
        lastName: 'B',
        ssoOrgId: null,
        role: null,
      });
      mockUserService.findOrCreateBySsoId.mockResolvedValue({
        id: 1,
        ssoId: 'sso_1',
        createdAt: new Date(),
      });
      mockSsoService.listOrganizations.mockResolvedValue(orgs);
    };

    /**
     * The whole point of the change: what the browser gets back is the token
     * the SSO minted, not one this API signed over it.
     */
    it('returns the SSO access token rather than one of its own', async () => {
      signedIn([{ id: 'org_1', name: 'Acme', slug: 'acme' }]);

      const { body, tokens } = await service.handleCallback(dto);

      expect(tokens.accessToken).toBe('sso_tok');
      expect(tokens.refreshToken).toBe('sso_refresh');
      expect(tokens.expiresIn).toBe(600);
      expect(tokens.tokenType).toBe('Bearer');
      expect(body.user).toEqual({
        id: 1,
        ssoId: 'sso_1',
        createdAt: expect.any(Date),
      });
      expect(body.organisations).toEqual([
        { id: 'org_1', name: 'Acme', slug: 'acme' },
      ]);
    });

    /**
     * Keyed on the SSO's own session id, so a refreshed token — which keeps the
     * same `sid` — lands on the same record instead of orphaning it.
     */
    it('keys the session record on the SSO sid and stores no token in it', async () => {
      const orgs = [{ id: 'org_1', name: 'Acme', slug: 'acme' }];
      signedIn(orgs);

      await service.handleCallback(dto);

      expect(mockSsoToken.verify).toHaveBeenCalledWith('sso_tok');
      expect(mockRedisService.setSsoSession).toHaveBeenCalledWith('sess_1', {
        ssoId: 'sso_1',
        email: 'a@b.com',
        firstName: 'A',
        lastName: 'B',
        username: '',
        emailVerified: false,
        imageUrl: '',
        ssoCreatedAt: null,
        orgs,
        grants: {},
      });
      const [, record] = mockRedisService.setSsoSession.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(record).not.toHaveProperty('ssoAccessToken');
    });

    it('caches the SSO profile in preference to the token claims', async () => {
      // The access token carries no name claims, so without /users/me the
      // console falls back to showing the email address as the user's name.
      signedIn([]);
      mockSsoService.decodeUserInfo.mockReturnValue({
        ssoId: 'sso_1',
        email: 'a@b.com',
        firstName: '',
        lastName: '',
        ssoOrgId: null,
        role: null,
      });
      mockSsoService.getProfile.mockResolvedValue({
        ssoId: 'sso_1',
        email: 'a@b.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        username: 'ada',
        emailVerified: true,
        imageUrl: 'https://img/ada.png',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: null,
      });

      await service.handleCallback(dto);

      expect(mockSsoService.getProfile).toHaveBeenCalledWith('sso_tok');
      expect(mockRedisService.setSsoSession).toHaveBeenCalledWith(
        'sess_1',
        expect.objectContaining({
          firstName: 'Ada',
          lastName: 'Lovelace',
          username: 'ada',
          emailVerified: true,
          imageUrl: 'https://img/ada.png',
          ssoCreatedAt: '2026-05-01T00:00:00.000Z',
        }),
      );
    });

    it('returns an empty org list for a user who belongs to none (no throw)', async () => {
      signedIn([]);
      const { body } = await service.handleCallback(dto);
      expect(body.organisations).toEqual([]);
    });
  });

  describe('refresh', () => {
    it('trades the refresh token for a new pair', async () => {
      mockSsoService.refreshTokens.mockResolvedValue({
        accessToken: 'new_tok',
        refreshToken: 'new_refresh',
        expiresIn: 600,
      });

      const tokens = await service.refresh('old_refresh');

      expect(mockSsoService.refreshTokens).toHaveBeenCalledWith('old_refresh');
      expect(tokens.accessToken).toBe('new_tok');
      expect(tokens.refreshToken).toBe('new_refresh');
    });

    /**
     * The SSO revokes the whole session family when a spent refresh token is
     * presented twice. Two console tabs share one cookie, so the second one has
     * to be handed the first one's result rather than spending the token again.
     */
    it('hands a concurrent caller the pair already bought, without spending the token twice', async () => {
      mockRedisService.getRefreshResult.mockResolvedValue({
        accessToken: 'new_tok',
        refreshToken: 'new_refresh',
        expiresIn: 600,
      });

      const tokens = await service.refresh('old_refresh');

      expect(tokens.accessToken).toBe('new_tok');
      expect(mockSsoService.refreshTokens).not.toHaveBeenCalled();
    });

    it('releases the lock when the SSO refuses, so the next attempt is not blocked', async () => {
      mockSsoService.refreshTokens.mockRejectedValue(
        new UnauthorizedException('spent'),
      );

      await expect(service.refresh('old_refresh')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mockRedisService.releaseRefreshLock).toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('revokes at the SSO and drops the grants held here', async () => {
      await service.logout('sess_1', 'sso_tok');

      expect(mockSsoService.logout).toHaveBeenCalledWith('sso_tok');
      expect(mockRedisService.deleteSsoSession).toHaveBeenCalledWith('sess_1');
    });
  });

  describe('selectOrg', () => {
    it('records the grant and answers with the id to send in X-Org-Id', async () => {
      mockOrgAccess.grantFor.mockResolvedValue({ role: 'member' });
      mockRedisService.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1',
        orgs: [{ id: 'org_1', name: 'Acme' }],
      });

      const result = await service.selectOrg('sess_1', 'org_1', 'tok');

      expect(result).toEqual({
        orgId: 'org_1',
        organisation: { id: 'org_1', name: 'Acme' },
        role: 'member',
      });
    });

    it('throws when the session has no grant for the organisation', async () => {
      mockOrgAccess.grantFor.mockResolvedValue(null);
      await expect(
        service.selectOrg('sess_1', 'org_other', 'tok'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('reports the agency acting inside a client', async () => {
      mockOrgAccess.grantFor.mockResolvedValue({
        role: 'agency',
        agencyOrgId: 'org_agency',
      });
      mockRedisService.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1',
        orgs: [{ id: 'org_agency', name: 'Bright Reach' }],
      });
      mockOrgAccess.withClients.mockResolvedValue([
        { id: 'org_agency', name: 'Bright Reach' },
        { id: 'org_client', name: 'Kettle Coffee', agencyOrgId: 'org_agency' },
      ]);

      const result = await service.selectOrg('sess_1', 'org_client', 'tok');

      expect(result.role).toBe('agency');
      expect(result.agencyOrgId).toBe('org_agency');
      expect(result.organisation.name).toBe('Kettle Coffee');
    });

    it('leaves the agency field off an ordinary organisation', async () => {
      // Downstream reads it as "an agency is acting inside a client". Sending
      // it on every answer would make that reading meaningless.
      mockOrgAccess.grantFor.mockResolvedValue({ role: 'member' });
      mockRedisService.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1',
        orgs: [{ id: 'org_1', name: 'Acme' }],
      });

      const result = await service.selectOrg('sess_1', 'org_1', 'tok');

      expect(result).not.toHaveProperty('agencyOrgId');
    });
  });

  describe('createOrganisation', () => {
    it('creates the org with the caller’s own token and grants them ownership', async () => {
      mockRedisService.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1',
        orgs: [],
      });
      mockSsoService.createOrganization.mockResolvedValue({
        id: 'org_new',
        name: 'Gamma',
        slug: 'gamma',
      });

      const result = await service.createOrganisation('sess_1', 'Gamma', 'tok');

      expect(mockSsoService.createOrganization).toHaveBeenCalledWith(
        'tok',
        'Gamma',
      );
      expect(mockRedisService.setSsoSession).toHaveBeenCalledWith('sess_1', {
        ssoId: 'sso_1',
        orgs: [{ id: 'org_new', name: 'Gamma', slug: 'gamma' }],
      });
      expect(mockOrgAccess.record).toHaveBeenCalledWith('sess_1', 'org_new', {
        role: 'owner',
      });
      expect(result).toEqual({
        orgId: 'org_new',
        organisation: { id: 'org_new', name: 'Gamma', slug: 'gamma' },
        role: 'owner',
      });
    });
  });

  describe('listOrganisations', () => {
    it('returns the cached org list', async () => {
      const orgs = [{ id: 'org_1', name: 'Acme' }];
      mockRedisService.getSsoSession.mockResolvedValue({
        ssoId: 'sso_1',
        orgs,
      });
      await expect(service.listOrganisations('sess_1', 'tok')).resolves.toEqual(
        orgs,
      );
    });

    /**
     * A valid token stays valid when Redis loses the record: membership is the
     * SSO's answer, so it is asked again rather than the caller being refused.
     */
    it('falls back to the SSO when the record is gone', async () => {
      mockRedisService.getSsoSession.mockResolvedValue(null);
      mockSsoService.listOrganizations.mockResolvedValue([
        { id: 'org_1', name: 'Acme' },
      ]);

      await expect(service.listOrganisations('sess_1', 'tok')).resolves.toEqual(
        [{ id: 'org_1', name: 'Acme' }],
      );
      expect(mockSsoService.listOrganizations).toHaveBeenCalledWith('tok');
    });
  });
});
