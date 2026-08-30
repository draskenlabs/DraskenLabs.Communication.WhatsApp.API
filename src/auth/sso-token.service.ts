import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey, JsonWebKey, KeyObject } from 'crypto';
import axios from 'axios';
import * as jwt from 'jsonwebtoken';

/**
 * The claims this API reads off a DraskenLabs SSO access token.
 *
 * Everything else the token carries is ignored on purpose: a claim nothing
 * reads is a claim nobody has to keep working.
 */
export interface SsoClaims {
  /** SSO user id, e.g. `user_2abc123`. Stable for the life of the account. */
  sub: string;
  email: string;
  /** Session id — `sid`, or `sessionId` on tokens minted before the rename. */
  sid: string;
  scope: string;
  /** Present only while an administrator is impersonating this user. */
  impersonatedBy?: string;
  exp: number;
  iat: number;
}

/** One RSA public key from the SSO's published ring. */
interface Jwk {
  kty: string;
  kid: string;
  use?: string;
  alg?: string;
  n: string;
  e: string;
}

/**
 * Verifies DraskenLabs SSO access tokens **offline**, against the public keys
 * the SSO publishes at `/.well-known/jwks.json`.
 *
 * Offline is the point. Introspecting every request would make the SSO a hard
 * availability dependency of every page this API serves, and would add a round
 * trip to each one. The cost is a staleness window: a session revoked at the
 * SSO stays acceptable here until the token expires — ten minutes by default,
 * which is what the short access-token lifetime is for.
 *
 * All four checks the SSO asks for are made, not just the signature:
 *
 * - `iss` is the SSO we were configured against,
 * - `aud` is **our** client id — a token minted for another Drasken
 *   application must not open this one,
 * - `exp` is in the future,
 * - the header `kid` resolves in the key set; an unknown one refetches the
 *   ring, because that is what a key rotation looks like from out here.
 */
@Injectable()
export class SsoTokenService {
  private readonly logger = new Logger(SsoTokenService.name);

  private readonly jwksUrl: string;
  private readonly issuer: string;
  private readonly audience: string;

  private keys = new Map<string, KeyObject>();
  /** When the ring was last asked for because it was empty, success or not. */
  private loadedAt = 0;
  /** When an unknown `kid` last sent us back to the ring, success or not. */
  private rotationCheckedAt = 0;
  /** In-flight fetch, shared so a burst of requests makes one call. */
  private inFlight: Promise<void> | null = null;

  /**
   * The shortest gap between two rotation checks.
   *
   * A rotation is picked up on the first token signed with the new key, because
   * nothing else announces one — but a `kid` that will never resolve looks
   * identical from here, and a forged token would otherwise pull the ring once
   * per request. Timed from the last *rotation check* rather than the last
   * fetch of any kind, so an ordinary key rotation minutes after start-up is
   * still picked up on the first token that needs it.
   */
  private static readonly ROTATION_COOLDOWN_MS = 30_000;

  /**
   * The gap while we hold **no** keys, when nothing can be verified until the
   * fetch succeeds. Short, because this is an outage and every retry matters —
   * but not zero, or an SSO that is down turns each request into a five-second
   * wait on a connection that is not coming.
   */
  private static readonly EMPTY_RING_COOLDOWN_MS = 5_000;

  constructor(private readonly config: ConfigService) {
    const apiBase = this.config
      .getOrThrow<string>('SSO_API_URL')
      .replace(/\/+$/, '');
    this.jwksUrl = `${apiBase}/.well-known/jwks.json`;
    // The issuer the SSO stamps is its own public base URL, which is the API
    // base in every deployment we run. `SSO_ISSUER` exists for the ones where
    // it is not — a private API address behind a public issuer.
    this.issuer = (this.config.get<string>('SSO_ISSUER') || apiBase).replace(
      /\/+$/,
      '',
    );
    this.audience = this.config.getOrThrow<string>('SSO_CLIENT_ID');
  }

  /**
   * Verifies a token and returns its claims, or throws 401.
   *
   * @param token the raw JWT, without the `Bearer ` prefix.
   */
  async verify(token: string): Promise<SsoClaims> {
    const kid = this.kidOf(token);
    let key = await this.keyFor(kid);
    if (!key) {
      // Unknown key: go back to the ring. A rotation is exactly this, and it
      // is not an error — the first token signed with a new key always arrives
      // before anything told us the key existed.
      await this.loadKeys(true);
      key = this.keys.get(kid);
    }
    if (!key) throw new UnauthorizedException('Unknown SSO signing key');

    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, key, {
        algorithms: ['RS256'],
        issuer: this.issuer,
        audience: this.audience,
        // A few seconds of drift between this host and the SSO's, so a clock
        // that is barely fast does not reject a token issued moments ago.
        clockTolerance: 5,
      }) as jwt.JwtPayload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const sub = payload.sub;
    // `sid` is the OIDC name; `sessionId` is the same value under the name the
    // SSO used before it adopted the standard one. Either is the session.
    const sid = (payload.sid ?? payload.sessionId) as string | undefined;
    if (!sub || !sid) {
      throw new UnauthorizedException('SSO token is missing required claims');
    }

    return {
      sub,
      email: (payload.email as string) ?? '',
      sid,
      scope: (payload.scope as string) ?? '',
      impersonatedBy: payload.impersonatedBy as string | undefined,
      exp: payload.exp ?? 0,
      iat: payload.iat ?? 0,
    };
  }

  /** Reads `kid` out of the JWT header without trusting anything else in it. */
  private kidOf(token: string): string {
    const [header] = token.split('.');
    if (!header) throw new UnauthorizedException('Malformed token');
    try {
      const decoded = JSON.parse(
        Buffer.from(header, 'base64url').toString('utf-8'),
      ) as { kid?: string; alg?: string };
      if (decoded.alg !== 'RS256') {
        // Refusing anything else by name rather than by omission: a token
        // presented as `alg: none`, or signed with an HMAC over a key we do
        // hold, must not reach the verifier at all.
        throw new UnauthorizedException('Unsupported token algorithm');
      }
      if (!decoded.kid) throw new UnauthorizedException('Token names no key');
      return decoded.kid;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Malformed token');
    }
  }

  private async keyFor(kid: string): Promise<KeyObject | undefined> {
    if (!this.keys.size) await this.loadKeys(false);
    return this.keys.get(kid);
  }

  /**
   * Fetches the key ring. Concurrent callers share one request, and each reason
   * for fetching has its own floor, so neither an unresolvable `kid` nor an SSO
   * that is down turns into one outbound call per inbound request.
   *
   * @param rotation whether this is a token naming a key we do not hold, as
   *   opposed to the first load of an empty ring.
   */
  private async loadKeys(rotation: boolean): Promise<void> {
    if (this.inFlight) return this.inFlight;

    const now = Date.now();
    if (rotation) {
      if (now - this.rotationCheckedAt < SsoTokenService.ROTATION_COOLDOWN_MS) {
        return;
      }
      this.rotationCheckedAt = now;
    } else {
      if (now - this.loadedAt < SsoTokenService.EMPTY_RING_COOLDOWN_MS) return;
      this.loadedAt = now;
    }

    this.inFlight = (async () => {
      try {
        const { data } = await axios.get<{ keys?: Jwk[] }>(this.jwksUrl, {
          timeout: 5000,
        });
        const next = new Map<string, KeyObject>();
        for (const jwk of data?.keys ?? []) {
          if (jwk.kty !== 'RSA' || !jwk.kid) continue;
          if (jwk.alg && jwk.alg !== 'RS256') continue;
          try {
            next.set(
              jwk.kid,
              createPublicKey({
                key: jwk as unknown as JsonWebKey,
                format: 'jwk',
              }),
            );
          } catch {
            this.logger.warn(`Skipping unusable JWK ${jwk.kid}`);
          }
        }
        if (!next.size) {
          // Keep whatever we already hold: replacing it with nothing would
          // reject every request until the SSO answered again, and the keys we
          // have are still the ones tokens already in flight were signed with.
          this.logger.error('SSO published no usable signing keys');
          return;
        }
        this.keys = next;
      } catch (err) {
        this.logger.error(
          `Could not fetch SSO signing keys: ${(err as Error).message}`,
        );
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }
}
