import { Test, TestingModule } from '@nestjs/testing';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { REFRESH_COOKIE } from './refresh-cookie';

const mockAuthService = {
  handleCallback: jest.fn(),
  refresh: jest.fn(),
  logout: jest.fn(),
  listOrganisations: jest.fn(),
  createOrganisation: jest.fn(),
  selectOrg: jest.fn(),
};

const config: Record<string, unknown> = {
  AUTH_COOKIE_SAMESITE: 'auto',
  AUTH_COOKIE_SECURE: true,
  SSO_REFRESH_TOKEN_TTL: 2592000,
};
const mockConfig = { get: jest.fn((key: string) => config[key]) };

/** Just enough of an Express response to see what the controller sets. */
const makeRes = () => ({
  cookie: jest.fn(),
  clearCookie: jest.fn(),
});

/**
 * A browser request, with the two headers the cookie's `SameSite` is read
 * from. Same host either side unless a test says otherwise.
 */
const browser = (
  over: {
    host?: string;
    origin?: string;
    cookies?: Record<string, string>;
  } = {},
) => ({
  cookies: over.cookies ?? {},
  headers: {
    host: over.host ?? 'api.example.com',
    origin: over.origin ?? 'https://api.example.com',
  },
});

/** A request as `AuthMiddleware` leaves it. */
const authed = (over: Record<string, unknown> = {}) => ({
  headers: {},
  cookies: {},
  sessionId: 'sess_1',
  ssoAccessToken: 'sso_tok',
  ...over,
});

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    controller = module.get<AuthController>(AuthController);
  });

  describe('callback', () => {
    const tokens = {
      accessToken: 'sso_tok',
      refreshToken: 'sso_refresh',
      expiresIn: 600,
      tokenType: 'Bearer',
    };

    beforeEach(() => {
      mockAuthService.handleCallback.mockResolvedValue({
        body: { user: { id: 1 }, organisations: [] },
        tokens,
      });
    });

    it('answers with the SSO access token', async () => {
      const res = makeRes();
      const dto = { code: 'c1', codeVerifier: 'v1' };

      const result = await controller.callback(
        dto as any,
        browser() as any,
        res as any,
      );

      expect(mockAuthService.handleCallback).toHaveBeenCalledWith(dto);
      expect(result).toEqual({
        user: { id: 1 },
        organisations: [],
        accessToken: 'sso_tok',
        expiresIn: 600,
        tokenType: 'Bearer',
      });
    });

    /**
     * A refresh token in the body ends up in `localStorage`, where every script
     * the page loads can read it — and it outlives the access token it buys by
     * a month. HttpOnly is the only place it belongs.
     */
    it('puts the refresh token in an HttpOnly cookie and never in the body', async () => {
      const res = makeRes();

      const result = await controller.callback(
        { code: 'c1', codeVerifier: 'v1' } as any,
        browser() as any,
        res as any,
      );

      expect(result).not.toHaveProperty('refreshToken');
      expect(res.cookie).toHaveBeenCalledWith(
        REFRESH_COOKIE,
        'sso_refresh',
        expect.objectContaining({
          httpOnly: true,
          secure: true,
          path: '/auth',
        }),
      );
    });
  });

  describe('refresh', () => {
    it('reads the cookie and rotates it', async () => {
      mockAuthService.refresh.mockResolvedValue({
        accessToken: 'new_tok',
        refreshToken: 'new_refresh',
        expiresIn: 600,
        tokenType: 'Bearer',
      });
      const res = makeRes();
      const req = browser({ cookies: { [REFRESH_COOKIE]: 'old_refresh' } });

      const result = await controller.refresh(req as any, res as any);

      expect(mockAuthService.refresh).toHaveBeenCalledWith('old_refresh');
      expect(result.accessToken).toBe('new_tok');
      expect(res.cookie).toHaveBeenCalledWith(
        REFRESH_COOKIE,
        'new_refresh',
        expect.any(Object),
      );
    });

    it('refuses when there is no refresh token to spend', async () => {
      await expect(
        controller.refresh(browser() as any, makeRes() as any),
      ).rejects.toThrow(UnauthorizedException);
    });

    /**
     * A cookie the SSO has refused is worse than no cookie: it sends the
     * browser back here on every load to be refused again.
     */
    it('clears the cookie when the refresh is refused', async () => {
      mockAuthService.refresh.mockRejectedValue(
        new UnauthorizedException('spent'),
      );
      const res = makeRes();
      const req = browser({ cookies: { [REFRESH_COOKIE]: 'spent' } });

      await expect(controller.refresh(req as any, res as any)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(res.clearCookie).toHaveBeenCalledWith(
        REFRESH_COOKIE,
        expect.any(Object),
      );
    });

    /**
     * The refresh token is good for thirty days and the SSO never saw this
     * request. Clearing on an outage — which is what this used to do for every
     * failure alike — threw that away: the person was signed out on that visit
     * and on every visit after it, with nothing left to refresh from.
     */
    it('keeps the cookie when the SSO could not be reached', async () => {
      mockAuthService.refresh.mockRejectedValue(
        new ServiceUnavailableException('unavailable'),
      );
      const res = makeRes();
      const req = browser({ cookies: { [REFRESH_COOKIE]: 'still_good' } });

      await expect(controller.refresh(req as any, res as any)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(res.clearCookie).not.toHaveBeenCalled();
    });
  });

  /**
   * A `Lax` cookie is stored at sign-in and then never sent again on a
   * cross-site request, so the console works for one access token's lifetime
   * and signs the person out when it tries to refresh. The attribute is read
   * off the request rather than left to a variable somebody has to know to set.
   */
  describe('the refresh cookie across sites', () => {
    const tokens = {
      accessToken: 'sso_tok',
      refreshToken: 'sso_refresh',
      expiresIn: 600,
      tokenType: 'Bearer',
    };

    const cookieOptions = (res: ReturnType<typeof makeRes>) =>
      (res.cookie.mock.calls[0] as unknown[])[2] as Record<string, unknown>;

    beforeEach(() => {
      mockAuthService.handleCallback.mockResolvedValue({
        body: { user: { id: 1 }, organisations: [] },
        tokens,
      });
    });

    it('sends SameSite=None; Secure to a console on another host', async () => {
      const res = makeRes();

      await controller.callback(
        { code: 'c1', codeVerifier: 'v1' } as any,
        browser({ origin: 'https://wa.example.com' }) as any,
        res as any,
      );

      expect(cookieOptions(res)).toMatchObject({
        sameSite: 'none',
        secure: true,
      });
    });

    it('keeps SameSite=Lax when the console is this host', async () => {
      const res = makeRes();

      await controller.callback(
        { code: 'c1', codeVerifier: 'v1' } as any,
        browser() as any,
        res as any,
      );

      expect(cookieOptions(res)).toMatchObject({ sameSite: 'lax' });
    });

    it('lets a deployment pin the attribute', async () => {
      config.AUTH_COOKIE_SAMESITE = 'lax';
      const res = makeRes();

      await controller.callback(
        { code: 'c1', codeVerifier: 'v1' } as any,
        browser({ origin: 'https://wa.example.com' }) as any,
        res as any,
      );

      expect(cookieOptions(res)).toMatchObject({ sameSite: 'lax' });
      config.AUTH_COOKIE_SAMESITE = 'auto';
    });
  });

  describe('logout', () => {
    it('ends the session and clears the cookie', async () => {
      const res = makeRes();
      await controller.logout(authed() as any, res as any);

      expect(mockAuthService.logout).toHaveBeenCalledWith('sess_1', 'sso_tok');
      expect(res.clearCookie).toHaveBeenCalledWith(
        REFRESH_COOKIE,
        expect.any(Object),
      );
    });
  });

  describe('org endpoints', () => {
    it('listOrganisations passes the session id and the live token', async () => {
      mockAuthService.listOrganisations.mockResolvedValue([]);
      await controller.listOrganisations(authed() as any);
      expect(mockAuthService.listOrganisations).toHaveBeenCalledWith(
        'sess_1',
        'sso_tok',
      );
    });

    it('createOrganisation passes the session id, name and token', async () => {
      mockAuthService.createOrganisation.mockResolvedValue({});
      await controller.createOrganisation(
        { name: 'Gamma' } as any,
        authed() as any,
      );
      expect(mockAuthService.createOrganisation).toHaveBeenCalledWith(
        'sess_1',
        'Gamma',
        'sso_tok',
      );
    });

    it('selectOrg passes the session id, orgId and token', async () => {
      mockAuthService.selectOrg.mockResolvedValue({});
      await controller.selectOrg({ orgId: 'org_1' } as any, authed() as any);
      expect(mockAuthService.selectOrg).toHaveBeenCalledWith(
        'sess_1',
        'org_1',
        'sso_tok',
      );
    });

    it('refuses a request the middleware left without a session', async () => {
      await expect(
        controller.listOrganisations({ headers: {} } as any),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockAuthService.listOrganisations).not.toHaveBeenCalled();
    });
  });
});
