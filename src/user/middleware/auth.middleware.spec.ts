import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthMiddleware } from './auth.middleware';
import { UserService } from '../user.service';
import { RedisService } from 'src/redis/redis.service';
import { SsoTokenService } from 'src/auth/sso-token.service';
import { OrgAccessService } from 'src/auth/org-access.service';

const mockSsoToken = { verify: jest.fn() };
const mockUserService = { findBySsoId: jest.fn() };
const mockRedis = {
  getUserBySsoCache: jest.fn(),
  setUserBySsoCache: jest.fn(),
  setUserCache: jest.fn(),
};
const mockOrgAccess = { grantFor: jest.fn() };

const baseUser = { id: 1, ssoId: 'user_2abc' };
const claims = { sub: 'user_2abc', email: 'a@b.com', sid: 'sess_1' };

describe('AuthMiddleware', () => {
  let middleware: AuthMiddleware;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthMiddleware,
        { provide: SsoTokenService, useValue: mockSsoToken },
        { provide: UserService, useValue: mockUserService },
        { provide: RedisService, useValue: mockRedis },
        { provide: OrgAccessService, useValue: mockOrgAccess },
      ],
    }).compile();
    middleware = module.get<AuthMiddleware>(AuthMiddleware);
  });

  const makeReq = (token?: string, orgId?: string) => ({
    headers: {
      authorization: token ? `Bearer ${token}` : undefined,
      ...(orgId ? { 'x-org-id': orgId } : {}),
    },
  });

  it('throws UnauthorizedException if no authorization header', async () => {
    await expect(
      middleware.use(makeReq() as any, {} as any, jest.fn()),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when the SSO token does not verify', async () => {
    mockSsoToken.verify.mockRejectedValue(
      new UnauthorizedException('Invalid or expired token'),
    );
    await expect(
      middleware.use(makeReq('bad.token') as any, {} as any, jest.fn()),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('uses the cached user and calls next()', async () => {
    mockSsoToken.verify.mockResolvedValue(claims);
    mockRedis.getUserBySsoCache.mockResolvedValue(baseUser);

    const req: any = makeReq('valid.token');
    const next = jest.fn();

    await middleware.use(req, {} as any, next);

    expect(req.user).toEqual(baseUser);
    expect(req.sessionId).toBe('sess_1');
    expect(req.ssoAccessToken).toBe('valid.token');
    expect(next).toHaveBeenCalled();
    expect(mockUserService.findBySsoId).not.toHaveBeenCalled();
  });

  it('looks the user up by SSO id on a cache miss and caches the result', async () => {
    mockSsoToken.verify.mockResolvedValue(claims);
    mockRedis.getUserBySsoCache.mockResolvedValue(null);
    mockUserService.findBySsoId.mockResolvedValue(baseUser);

    const req: any = makeReq('valid.token');
    const next = jest.fn();

    await middleware.use(req, {} as any, next);

    expect(mockUserService.findBySsoId).toHaveBeenCalledWith('user_2abc');
    expect(mockRedis.setUserBySsoCache).toHaveBeenCalledWith(
      'user_2abc',
      baseUser,
    );
    expect(next).toHaveBeenCalled();
  });

  it('attaches the organisation the session was granted', async () => {
    mockSsoToken.verify.mockResolvedValue(claims);
    mockRedis.getUserBySsoCache.mockResolvedValue(baseUser);
    mockOrgAccess.grantFor.mockResolvedValue({
      role: 'agency',
      agencyOrgId: 'org_agency',
    });

    const req: any = makeReq('valid.token', 'org_client');
    await middleware.use(req, {} as any, jest.fn());

    expect(mockOrgAccess.grantFor).toHaveBeenCalledWith(
      'sess_1',
      'org_client',
      'valid.token',
    );
    expect(req.orgId).toBe('org_client');
    expect(req.role).toBe('agency');
    expect(req.agencyOrgId).toBe('org_agency');
  });

  /**
   * The header is the only thing naming the organisation now, and anyone can
   * write a header. An organisation the session was never granted has to be a
   * refusal — quietly dropping it would leave `orgId` undefined on a request
   * the handler believes is scoped.
   */
  it('refuses an organisation the session has no grant for', async () => {
    mockSsoToken.verify.mockResolvedValue(claims);
    mockRedis.getUserBySsoCache.mockResolvedValue(baseUser);
    mockOrgAccess.grantFor.mockResolvedValue(null);

    const next = jest.fn();
    await expect(
      middleware.use(
        makeReq('valid.token', 'org_other') as any,
        {} as any,
        next,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(next).not.toHaveBeenCalled();
  });

  it('leaves the organisation unset when no header is sent', async () => {
    mockSsoToken.verify.mockResolvedValue(claims);
    mockRedis.getUserBySsoCache.mockResolvedValue(baseUser);

    const req: any = makeReq('valid.token');
    await middleware.use(req, {} as any, jest.fn());

    expect(req.orgId).toBeUndefined();
    expect(mockOrgAccess.grantFor).not.toHaveBeenCalled();
  });
});
