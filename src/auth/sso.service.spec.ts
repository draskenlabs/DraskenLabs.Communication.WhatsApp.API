import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
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
