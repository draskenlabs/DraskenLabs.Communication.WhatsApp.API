import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey, generateKeyPairSync, KeyObject } from 'crypto';
import axios from 'axios';
import * as jwt from 'jsonwebtoken';
import { SsoTokenService } from './sso-token.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const ISSUER = 'https://sso.drasken.com';
const CLIENT_ID = 'd18a1ed28e3e6c154710544b8fd5528a';

const config: Record<string, string> = {
  SSO_API_URL: ISSUER,
  SSO_CLIENT_ID: CLIENT_ID,
};
const configService = {
  get: (key: string) => config[key],
  getOrThrow: (key: string) => config[key],
} as unknown as ConfigService;

/** One signing key, and the JWK the SSO would publish for it. */
function makeKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid,
    alg: 'RS256',
    use: 'sig',
  };
  return { kid, privateKey, publicKey, jwk };
}

const KEY = makeKey('key_1');
const ROTATED = makeKey('key_2');

/** Signs a token the way the SSO would. */
function sign(
  key: { privateKey: KeyObject; kid: string },
  claims: Record<string, unknown> = {},
  options: jwt.SignOptions = {},
): string {
  return jwt.sign(
    {
      email: 'ada@example.com',
      sid: 'sess_1',
      scope: 'openid profile email',
      ...claims,
    },
    key.privateKey,
    {
      algorithm: 'RS256',
      keyid: key.kid,
      subject: 'user_2abc123',
      issuer: ISSUER,
      audience: CLIENT_ID,
      expiresIn: '10m',
      ...options,
    },
  );
}

/** The key ring the SSO serves, for this test. */
function serves(...keys: { jwk: unknown }[]) {
  mockedAxios.get.mockResolvedValue({ data: { keys: keys.map((k) => k.jwk) } });
}

describe('SsoTokenService', () => {
  let service: SsoTokenService;

  beforeEach(() => {
    jest.clearAllMocks();
    serves(KEY);
    service = new SsoTokenService(configService);
  });

  it('accepts a token the SSO signed, and reads its claims', async () => {
    await expect(service.verify(sign(KEY))).resolves.toEqual(
      expect.objectContaining({
        sub: 'user_2abc123',
        email: 'ada@example.com',
        sid: 'sess_1',
        scope: 'openid profile email',
      }),
    );
  });

  /**
   * The one check the audience binding exists for. Without it, a token minted
   * for the billing console would open this one.
   */
  it('refuses a token minted for another application', async () => {
    const other = sign(KEY, {}, { audience: 'some_other_client' });
    await expect(service.verify(other)).rejects.toThrow(UnauthorizedException);
  });

  it('refuses a token from a different issuer', async () => {
    const foreign = sign(KEY, {}, { issuer: 'https://sso.example.com' });
    await expect(service.verify(foreign)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses an expired token', async () => {
    const expired = sign(KEY, {}, { expiresIn: '-1m' });
    await expect(service.verify(expired)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  /**
   * A signature that verifies against a key the SSO never published is not a
   * signature — it is whatever the presenter chose to sign with.
   */
  it('refuses a token signed by a key the SSO does not publish', async () => {
    const impostor = makeKey('key_1'); // same kid, different key
    await expect(service.verify(sign(impostor))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a token that names no key', async () => {
    const noKid = jwt.sign({ sid: 's' }, KEY.privateKey, {
      algorithm: 'RS256',
      issuer: ISSUER,
      audience: CLIENT_ID,
      subject: 'user_2abc123',
    });
    await expect(service.verify(noKid)).rejects.toThrow(UnauthorizedException);
  });

  /**
   * `alg: none` and an HMAC signed with something we hold are the two classic
   * ways a JWT verifier is talked out of verifying. Neither reaches the key.
   */
  it('refuses anything that is not RS256', async () => {
    const hmac = jwt.sign({ sid: 's' }, 'a-shared-secret', {
      algorithm: 'HS256',
      keyid: KEY.kid,
      issuer: ISSUER,
      audience: CLIENT_ID,
      subject: 'user_2abc123',
    });
    await expect(service.verify(hmac)).rejects.toThrow(UnauthorizedException);
  });

  it('refuses a token with no session claim', async () => {
    const noSid = jwt.sign({ email: 'a@b.com' }, KEY.privateKey, {
      algorithm: 'RS256',
      keyid: KEY.kid,
      issuer: ISSUER,
      audience: CLIENT_ID,
      subject: 'user_2abc123',
    });
    await expect(service.verify(noSid)).rejects.toThrow(UnauthorizedException);
  });

  /** `sessionId` is what the SSO called `sid` before it adopted the OIDC name. */
  it('reads the session from the older sessionId claim', async () => {
    const legacy = sign(KEY, { sid: undefined, sessionId: 'sess_legacy' });
    await expect(service.verify(legacy)).resolves.toEqual(
      expect.objectContaining({ sid: 'sess_legacy' }),
    );
  });

  /**
   * A rotation looks like this from outside: a token arrives signed with a key
   * nothing has told us about yet. Refetching is the whole handling.
   */
  it('refetches the ring when a token names a key it has not seen', async () => {
    await service.verify(sign(KEY));
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);

    serves(KEY, ROTATED);
    await expect(service.verify(sign(ROTATED))).resolves.toEqual(
      expect.objectContaining({ sub: 'user_2abc123' }),
    );
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  /**
   * A `kid` that will never resolve — a forgery — would otherwise pull the
   * ring once per request, turning a bad token into an outbound flood.
   */
  it('does not refetch the ring for every unresolvable key', async () => {
    await service.verify(sign(KEY));
    const impostor = makeKey('key_never');

    await expect(service.verify(sign(impostor))).rejects.toThrow();
    await expect(service.verify(sign(impostor))).rejects.toThrow();
    await expect(service.verify(sign(impostor))).rejects.toThrow();

    // One for the first load, one for the first unknown kid. No more.
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  /**
   * Keeping the old ring beats replacing it with nothing: tokens already in
   * flight were signed with those keys, and an empty ring rejects everybody.
   */
  it('keeps the keys it has when the SSO answers with none', async () => {
    await service.verify(sign(KEY));

    mockedAxios.get.mockResolvedValue({ data: { keys: [] } });
    await expect(service.verify(sign(KEY))).resolves.toEqual(
      expect.objectContaining({ sub: 'user_2abc123' }),
    );
  });

  it('publishes a usable public key for each JWK it is served', () => {
    // Guards the JWK → KeyObject conversion the whole verifier rests on.
    expect(() =>
      createPublicKey({ key: KEY.jwk as never, format: 'jwk' }),
    ).not.toThrow();
  });
});
