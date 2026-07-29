import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SsoService } from './sso.service';
import { UserService } from 'src/user/user.service';
import { JwtService } from '@nestjs/jwt';
import { RedisService } from 'src/redis/redis.service';

const mockSsoService = {
  exchangeCode: jest.fn(),
  decodeUserInfo: jest.fn(),
  listOrganizations: jest.fn(),
  createOrganization: jest.fn(),
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
        ssoId: 'sso_1', ssoAccessToken: 'sso_tok', email: 'a@b.com', firstName: 'A', lastName: 'B', orgs,
      });
      expect(mockJwtService.signAsync).toHaveBeenCalledWith({ sub: 1, sessionId: 'session-1' });
      expect(result).toEqual({ access_token: 'signed_token', user: { id: 1, ssoId: 'sso_1', createdAt: expect.any(Date) }, organisations: orgs });
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

    it('throws UnauthorizedException when the session expired', async () => {
      mockRedisService.getSsoSession.mockResolvedValue(null);
      await expect(service.listOrganisations('session-1')).rejects.toThrow(UnauthorizedException);
    });
  });
});
