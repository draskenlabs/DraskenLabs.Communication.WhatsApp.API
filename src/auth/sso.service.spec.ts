import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SsoService } from './sso.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockConfig = {
  getOrThrow: jest.fn((key: string) => {
    const map: Record<string, string> = {
      SSO_API_URL: 'https://sso.drasken.dev',
      SSO_CLIENT_ID: 'test-app',
      SSO_CLIENT_SECRET: 'test-secret',
      SSO_REDIRECT_URI: 'https://wa.draskenapis.com/auth/callback',
    };
    return map[key];
  }),
};

describe('SsoService', () => {
  let service: SsoService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SsoService,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get<SsoService>(SsoService);
  });

  describe('exchangeCode', () => {
    it('calls SSO token endpoint with the client secret and returns token data', async () => {
      const tokenData = { accessToken: 'at', refreshToken: 'rt', expiresIn: 86400 };
      mockedAxios.post = jest.fn().mockResolvedValue({ data: { data: tokenData } });

      const result = await service.exchangeCode('code_1', 'verifier_1');

      expect(result).toEqual(tokenData);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://sso.drasken.dev/auth/token',
        {
          clientId: 'test-app',
          clientSecret: 'test-secret',
          code: 'code_1',
          codeVerifier: 'verifier_1',
          redirectUri: 'https://wa.draskenapis.com/auth/callback',
        },
      );
    });

    it('throws UnauthorizedException when SSO returns an error', async () => {
      mockedAxios.post = jest.fn().mockRejectedValue({ response: { data: { message: 'Invalid or expired authorization code' } } });
      await expect(service.exchangeCode('bad', 'v')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('listOrganizations', () => {
    it('maps organisations from GET /organizations', async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({
        data: { data: [{ id: 'org_1', name: 'Acme', slug: 'acme' }, { id: 'org_2', name: 'Beta' }] },
      });

      const result = await service.listOrganizations('sso_tok');

      expect(result).toEqual([
        { id: 'org_1', name: 'Acme', slug: 'acme' },
        { id: 'org_2', name: 'Beta', slug: undefined },
      ]);
      expect(mockedAxios.get).toHaveBeenCalledWith('https://sso.drasken.dev/organizations', {
        headers: { Authorization: 'Bearer sso_tok' },
      });
    });

    it('returns an empty array when the user has no organisations', async () => {
      mockedAxios.get = jest.fn().mockResolvedValue({ data: { data: [] } });
      await expect(service.listOrganizations('sso_tok')).resolves.toEqual([]);
    });

    it('returns an empty array when the request fails', async () => {
      mockedAxios.get = jest.fn().mockRejectedValue({ response: { status: 401 } });
      await expect(service.listOrganizations('sso_tok')).resolves.toEqual([]);
    });
  });

  describe('createOrganization', () => {
    it('creates an organisation via POST /organizations and returns it', async () => {
      mockedAxios.post = jest.fn().mockResolvedValue({
        data: { data: { id: 'org_new', name: 'Gamma', slug: 'gamma' } },
      });

      const result = await service.createOrganization('sso_tok', 'Gamma');

      expect(result).toEqual({ id: 'org_new', name: 'Gamma', slug: 'gamma' });
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://sso.drasken.dev/organizations',
        { name: 'Gamma' },
        { headers: { Authorization: 'Bearer sso_tok' } },
      );
    });

    it('throws UnauthorizedException on a 401 from the SSO', async () => {
      mockedAxios.post = jest.fn().mockRejectedValue({ response: { status: 401, data: { message: 'expired' } } });
      await expect(service.createOrganization('sso_tok', 'X')).rejects.toThrow(UnauthorizedException);
    });

    it('throws BadRequestException on other SSO errors', async () => {
      mockedAxios.post = jest.fn().mockRejectedValue({ response: { status: 409, data: { message: 'name taken' } } });
      await expect(service.createOrganization('sso_tok', 'X')).rejects.toThrow(BadRequestException);
    });
  });

  describe('decodeUserInfo', () => {
    const makeToken = (payload: object) => {
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `header.${encoded}.sig`;
    };

    it('extracts ssoId, email, firstName, lastName from JWT payload', () => {
      const token = makeToken({ sub: 'sso_1', email: 'a@b.com', firstName: 'Alice', lastName: 'Smith' });
      const result = service.decodeUserInfo(token);
      expect(result).toMatchObject({ ssoId: 'sso_1', email: 'a@b.com', firstName: 'Alice', lastName: 'Smith' });
    });

    it('falls back to OIDC given_name / family_name claims', () => {
      const token = makeToken({ sub: 'sso_2', email: 'b@c.com', given_name: 'Bob', family_name: 'Jones' });
      const result = service.decodeUserInfo(token);
      expect(result.firstName).toBe('Bob');
      expect(result.lastName).toBe('Jones');
    });

    it('throws UnauthorizedException when token is malformed', () => {
      expect(() => service.decodeUserInfo('not.valid')).toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when sub or email is missing', () => {
      const token = makeToken({ firstName: 'X' });
      expect(() => service.decodeUserInfo(token)).toThrow(UnauthorizedException);
    });
  });
});
