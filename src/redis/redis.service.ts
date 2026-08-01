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

  // API Key Cache — apiKey:{accessKey} → { userId, ssoOrgId, secretKey: encrypted }
  async setApiKeyCache(accessKey: string, userId: number, ssoOrgId: string, encryptedSecretKey: string): Promise<void> {
    await this.client.set(
      `apiKey:${accessKey}`,
      JSON.stringify({ userId, ssoOrgId, secretKey: encryptedSecretKey }),
    );
  }

  async getApiKeyCache(accessKey: string): Promise<{ userId: number; ssoOrgId: string; secretKey: string } | null> {
    const raw = await this.client.get(`apiKey:${accessKey}`);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  async deleteApiKeyCache(accessKey: string): Promise<void> {
    await this.client.del(`apiKey:${accessKey}`);
  }

}
