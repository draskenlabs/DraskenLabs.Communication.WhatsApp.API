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

export interface SsoSessionData {
  ssoId: string;
  ssoAccessToken: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  /** From `GET /users/me` — absent when that call failed at login. */
  username?: string;
  emailVerified?: boolean;
  imageUrl?: string;
  ssoCreatedAt?: string | null;
  orgs: { id: string; name: string; slug?: string }[];
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

  // SSO Session — ssosession:{sessionId} → { ssoId, ssoAccessToken, orgs }.
  // Holds the user's SSO access token + org membership server-side so org
  // list/create/switch can run behind the app JWT without the browser ever
  // seeing the SSO token. TTL defaults to the app JWT lifetime (1 day).
  async createSessionId(): Promise<string> {
    return uuidv7();
  }

  async setSsoSession(sessionId: string, data: SsoSessionData, ttlSeconds = 86400): Promise<void> {
    await this.client.set(`ssosession:${sessionId}`, JSON.stringify(data), 'EX', ttlSeconds);
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
  async getUserCache(userId: number): Promise<{ id: number; ssoId: string } | null> {
    const raw = await this.client.get(`user:${userId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  async setUserCache(userId: number, user: { id: number; ssoId: string }): Promise<void> {
    await this.client.set(`user:${userId}`, JSON.stringify(user), 'EX', 900); // 15 min TTL
  }

  async invalidateUserCache(userId: number): Promise<void> {
    await this.client.del(`user:${userId}`);
  }

  // Phone Cache — phone:{phoneNumberId} → { userId, wabaId, accessToken: encrypted }
  async setPhoneCache(
    phoneNumberId: string,
    userId: number,
    wabaId: string,
    encryptedAccessToken: string,
  ): Promise<void> {
    await this.client.set(
      `phone:${phoneNumberId}`,
      JSON.stringify({ userId, wabaId, accessToken: encryptedAccessToken }),
    );
  }

  async getPhoneCache(
    phoneNumberId: string,
  ): Promise<{ userId: number; wabaId: string; accessToken: string } | null> {
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
      JSON.stringify({ userId, ssoOrgId, wabaId, secretKey: encryptedSecretKey }),
    );
  }

  async getApiKeyCache(
    accessKey: string,
  ): Promise<{ userId: number; ssoOrgId: string; wabaId: string | null; secretKey: string } | null> {
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

  // Mail digests — digest:{kind}:{userId} → a list of JSON items awaiting a
  // batched email. High-frequency events (failed sends, inbound replies) queue
  // here instead of mailing one message each; a scheduled flush drains them.
  async queueDigestItem(
    kind: string,
    userId: number,
    item: unknown,
    ttlSeconds = 172800,
  ): Promise<void> {
    const key = `digest:${kind}:${userId}`;
    await this.client.rpush(key, JSON.stringify(item));
    // Expiry is a backstop: if the flush job stops, queues do not grow forever.
    await this.client.expire(key, ttlSeconds);
  }

  /** Every queue with something in it, as [kind, userId] pairs. */
  async listDigestQueues(kind: string): Promise<number[]> {
    const keys = await this.client.keys(`digest:${kind}:*`);
    return keys
      .map((key) => Number(key.split(':')[2]))
      .filter((id) => Number.isFinite(id));
  }

  /**
   * Read and clear one queue in a single round trip, so a flush running twice
   * cannot send the same digest twice.
   */
  async drainDigest(kind: string, userId: number): Promise<unknown[]> {
    const key = `digest:${kind}:${userId}`;
    const [[, raw]] = (await this.client
      .multi()
      .lrange(key, 0, -1)
      .del(key)
      .exec()) as [[Error | null, string[]], [Error | null, number]];
    return (raw ?? []).map((entry) => JSON.parse(entry) as unknown);
  }
}
