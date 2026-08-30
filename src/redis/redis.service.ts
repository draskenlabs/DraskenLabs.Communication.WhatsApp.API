import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { WABAConnectState } from './dto/waba-connect-state.dto';

/**
 * What the session is allowed to do inside one organisation.
 *
 * Held here rather than stamped into a token: the credential is now the SSO's
 * own access token, and the SSO knows nothing about agencies or about which
 * organisation a console tab is looking at. A request names the organisation
 * in `X-Org-Id`, and this is what says whether it may.
 */
export interface OrgGrant {
  /** `owner` | `member` for a membership, `agency` inside a managed client. */
  role: string;
  /** Set only on a client organisation: the agency acting inside it. */
  agencyOrgId?: string;
}

export interface SsoSessionData {
  ssoId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  /** From `GET /users/me` — absent when that call failed at login. */
  username?: string;
  emailVerified?: boolean;
  imageUrl?: string;
  ssoCreatedAt?: string | null;
  orgs: { id: string; name: string; slug?: string }[];
  /** Organisations this session has entered, and on what basis. */
  grants?: Record<string, OrgGrant>;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis;
  private readonly logger: Logger = new Logger(RedisService.name);

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    // Single connection string (redis[s]://[user][:password]@host:port[/db]) so
    // credentials and TLS come from one URL instead of separate host/port vars.
    const url = this.configService.getOrThrow<string>('REDIS_URL');
    this.client = new Redis(url, {
      lazyConnect: true,
      retryStrategy: (times: number) => {
        if (times > 10) return null;
        return Math.min(times * 100, 3000);
      },
    });
    this.client.on('connect', () => {
      this.logger.log('Redis Connected');
    });
    this.client.on('error', (error) => {
      this.logger.error(`Redis error: ${error.message}`);
    });
    this.client.on('reconnecting', () => {
      this.logger.warn('Redis reconnecting...');
    });
  }

  onModuleDestroy() {
    this.logger.log('Redis disconnecting...');
    this.client.disconnect();
  }

  // Connect State
  async getState(stateId: string): Promise<WABAConnectState | null> {
    const response = await this.client.get(`state:${stateId}`);
    if (response) return JSON.parse(response);
    return null;
  }

  async createState(): Promise<string> {
    const stateId = uuidv7();
    await this.client.set(`state:${stateId}`, JSON.stringify({}), 'EX', 300);
    return stateId;
  }

  async updateState(stateId: string, data: WABAConnectState): Promise<string> {
    await this.client.set(`state:${stateId}`, JSON.stringify(data), 'EX', 300);
    return stateId;
  }

  // SSO Session — ssosession:{sid} → { ssoId, orgs, grants }.
  //
  // Keyed by the SSO's own session id, the `sid` claim on every access token,
  // so a refreshed token lands on the same record and a session survives the
  // ten-minute access-token lifetime. It holds what the SSO cannot answer:
  // which organisations this person may enter here, and on what basis. It
  // deliberately holds no token of theirs — the request carries the live one.
  //
  // TTL matches the SSO refresh-token lifetime (30 days), because that is how
  // long the session can keep producing access tokens.
  async setSsoSession(
    sessionId: string,
    data: SsoSessionData,
    ttlSeconds = 2592000,
  ): Promise<void> {
    await this.client.set(
      `ssosession:${sessionId}`,
      JSON.stringify(data),
      'EX',
      ttlSeconds,
    );
  }

  async getSsoSession(sessionId: string): Promise<SsoSessionData | null> {
    const raw = await this.client.get(`ssosession:${sessionId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  async deleteSsoSession(sessionId: string): Promise<void> {
    await this.client.del(`ssosession:${sessionId}`);
  }

  // User Cache
  async getUserCache(
    userId: number,
  ): Promise<{ id: number; ssoId: string } | null> {
    const raw = await this.client.get(`user:${userId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  async setUserCache(
    userId: number,
    user: { id: number; ssoId: string },
  ): Promise<void> {
    await this.client.set(`user:${userId}`, JSON.stringify(user), 'EX', 900); // 15 min TTL
  }

  async invalidateUserCache(userId: number): Promise<void> {
    await this.client.del(`user:${userId}`);
  }

  // usersso:{ssoId} → { id, ssoId }. The same row as `user:{id}`, reached from
  // the other end: an SSO access token names the person by their SSO id, and
  // the request needs the local one before it can touch anything here.
  async getUserBySsoCache(
    ssoId: string,
  ): Promise<{ id: number; ssoId: string } | null> {
    const raw = await this.client.get(`usersso:${ssoId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  async setUserBySsoCache(
    ssoId: string,
    user: { id: number; ssoId: string },
  ): Promise<void> {
    await this.client.set(`usersso:${ssoId}`, JSON.stringify(user), 'EX', 900);
  }

  async invalidateUserBySsoCache(ssoId: string): Promise<void> {
    await this.client.del(`usersso:${ssoId}`);
  }

  // Refresh replay window — refresh:{hash} → the pair a spent refresh token
  // bought, and refreshlock:{hash} while it is being bought.
  //
  // The SSO rotates refresh tokens and treats a second presentation of one as
  // theft: it revokes the whole session family. Two console tabs waking at the
  // same moment would do exactly that with the same cookie. So the first
  // caller takes the lock, and everyone else holding that same spent token is
  // handed the pair it got instead of spending it again.
  async takeRefreshLock(hash: string, ttlSeconds = 10): Promise<boolean> {
    const res = await this.client.set(
      `refreshlock:${hash}`,
      '1',
      'EX',
      ttlSeconds,
      'NX',
    );
    return res === 'OK';
  }

  async releaseRefreshLock(hash: string): Promise<void> {
    await this.client.del(`refreshlock:${hash}`);
  }

  async setRefreshResult<T>(
    hash: string,
    data: T,
    ttlSeconds = 60,
  ): Promise<void> {
    await this.client.set(
      `refresh:${hash}`,
      JSON.stringify(data),
      'EX',
      ttlSeconds,
    );
  }

  async getRefreshResult<T>(hash: string): Promise<T | null> {
    const raw = await this.client.get(`refresh:${hash}`);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  }

  // Organisation names — orgName:{ssoOrgId} → the display name.
  //
  // Organisations live in the SSO, so this is the only copy anything without a
  // user's token can reach. Long TTL: a name changes rarely, and a stale one is
  // a better email than no name at all.
  async setOrgName(ssoOrgId: string, name: string): Promise<void> {
    await this.client.set(`orgName:${ssoOrgId}`, name, 'EX', 30 * 24 * 60 * 60);
  }

  async getOrgName(ssoOrgId: string): Promise<string | null> {
    return this.client.get(`orgName:${ssoOrgId}`);
  }

  // Phone Cache — phone:{phoneNumberId} → { wabaId, accessToken: encrypted }
  //
  // A phone number belongs to an account, and the account is what decides who
  // may send from it. The entry used to carry the `userId` of whoever synced
  // last, and sending compared the caller against it — so on an account two
  // people had connected, the loser of that race was refused a number their own
  // organisation owned. Who may send is a membership question now; this cache
  // answers only "which account, and with what token".
  async setPhoneCache(
    phoneNumberId: string,
    wabaId: string,
    encryptedAccessToken: string,
  ): Promise<void> {
    await this.client.set(
      `phone:${phoneNumberId}`,
      JSON.stringify({ wabaId, accessToken: encryptedAccessToken }),
    );
  }

  async getPhoneCache(
    phoneNumberId: string,
  ): Promise<{ wabaId: string; accessToken: string } | null> {
    const raw = await this.client.get(`phone:${phoneNumberId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  async invalidatePhoneCache(phoneNumberId: string): Promise<void> {
    await this.client.del(`phone:${phoneNumberId}`);
  }

  // API Key Cache — apiKey:{accessKey} → { userId, ssoOrgId, wabaId, secretKey: encrypted }
  async setApiKeyCache(
    accessKey: string,
    userId: number,
    ssoOrgId: string,
    encryptedSecretKey: string,
    wabaId: string | null,
  ): Promise<void> {
    await this.client.set(
      `apiKey:${accessKey}`,
      JSON.stringify({
        userId,
        ssoOrgId,
        wabaId,
        secretKey: encryptedSecretKey,
      }),
    );
  }

  async getApiKeyCache(accessKey: string): Promise<{
    userId: number;
    ssoOrgId: string;
    wabaId: string | null;
    secretKey: string;
  } | null> {
    const raw = await this.client.get(`apiKey:${accessKey}`);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // These entries are written without a TTL, so a cache filled before keys
    // carried a WABA would otherwise survive the deploy and authenticate
    // unscoped. A missing field means "stale" — the caller re-reads the row.
    if (!('wabaId' in parsed)) return null;

    return parsed as unknown as {
      userId: number;
      ssoOrgId: string;
      wabaId: string | null;
      secretKey: string;
    };
  }

  async deleteApiKeyCache(accessKey: string): Promise<void> {
    await this.client.del(`apiKey:${accessKey}`);
  }

  // Subscription access — sub:{ssoOrgId}:{wabaId} → "1" | "0".
  //
  // `scope` is what is paid for: one organisation's use of one account. Both
  // halves belong in the key — the same WABA can be connected by two
  // organisations, and one of them paying must not answer for the other.
  //
  // Short TTL *and* explicit invalidation: the webhook clears it so a
  // cancellation or a failed debit takes effect at once, and the expiry is the
  // backstop for a webhook that never arrives. Never cache this without a TTL.
  /**
   * Count one request against a fixed window, returning the running total.
   *
   * A fixed window rather than a sliding one: it is one round trip, it cannot
   * drift between instances, and the worst it allows is a burst across a window
   * boundary — which for a send limit is a nicer failure than the bookkeeping a
   * sliding window needs on the hot path.
   *
   * The counter lives in Redis rather than in the process, because the limit is
   * a promise about the whole deployment: keeping it per instance would quietly
   * multiply it by however many are running.
   */
  async countInWindow(key: string, windowSeconds: number): Promise<number> {
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
    const redisKey = `ratelimit:${key}:${bucket}`;
    const count = await this.client.incr(redisKey);
    // Only on the first increment: re-setting it on every request would keep
    // pushing the expiry out and the window would never close.
    if (count === 1) {
      await this.client.expire(redisKey, windowSeconds + 1);
    }
    return count;
  }

  /** Seconds until the current window closes, for a `Retry-After` header. */
  secondsUntilWindowEnds(windowSeconds: number): number {
    const elapsed = Math.floor(Date.now() / 1000) % windowSeconds;
    return Math.max(1, windowSeconds - elapsed);
  }

  async setSubscriptionAccess(
    scope: string,
    allowed: boolean,
    ttlSeconds = 60,
  ): Promise<void> {
    await this.client.set(
      `sub:${scope}`,
      allowed ? '1' : '0',
      'EX',
      ttlSeconds,
    );
  }

  async getSubscriptionAccess(scope: string): Promise<boolean | null> {
    const raw = await this.client.get(`sub:${scope}`);
    if (raw === null) return null;
    return raw === '1';
  }

  async invalidateSubscriptionAccess(scope: string): Promise<void> {
    await this.client.del(`sub:${scope}`);
  }

  // Inbound media — media:{mediaId} → the download URL Meta resolved it to.
  //
  // Fetching a photo in a thread costs two calls to Meta: one to turn the media
  // id into a URL, then the download itself. The first answer is stable for as
  // long as the URL is, so a thread being scrolled does not need to ask again
  // for every image on screen.
  //
  // Always with a TTL, and a short one. Meta's URLs expire on their own, and a
  // cached link that has outlived its signature is a broken image rather than
  // a stale one — five minutes is comfortably inside the window they hold for.
  async setMediaUrl(
    mediaId: string,
    url: string,
    ttlSeconds = 300,
  ): Promise<void> {
    await this.client.set(`media:${mediaId}`, url, 'EX', ttlSeconds);
  }

  async getMediaUrl(mediaId: string): Promise<string | null> {
    return this.client.get(`media:${mediaId}`);
  }
}
