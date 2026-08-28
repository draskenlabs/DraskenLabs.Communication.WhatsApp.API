import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { RedisService } from 'src/redis/redis.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';

/** One minute, which is what the plan's number is per. */
const WINDOW_SECONDS = 60;

interface AuthedRequest extends Request {
  orgId?: string;
  apiKeyWabaId?: string;
  accessKey?: string;
  authType?: string;
}

/**
 * How fast one API key may send.
 *
 * Keyed on the **key**, not the caller's address. Nest's own throttler tracks
 * by IP, which is wrong in both directions for server-to-server traffic: a
 * customer's whole fleet behind one address shares a bucket, and the number
 * cannot vary by what they pay. The API-key middleware has already resolved
 * the key, its organisation and its account, so the identity is there to use.
 *
 * The console is deliberately not limited here. Someone clicking send is
 * bounded by how fast they can click, and the number on the price list is sold
 * as an API rate.
 */
@Injectable()
export class SendRateGuard implements CanActivate {
  private readonly logger = new Logger(SendRateGuard.name);

  constructor(
    private readonly redis: RedisService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();

    // Not an API-key request: nothing to key on, and nothing sold by rate.
    const accessKey = req.headers['x-access-key'];
    if (req.authType !== 'apiKey' || typeof accessKey !== 'string') return true;

    const ssoOrgId = req.orgId;
    const wabaId = req.apiKeyWabaId;
    if (!ssoOrgId || !wabaId) return true;

    const limits = await this.planLimits.forWaba(ssoOrgId, wabaId);
    const perMinute = limits.messagesPerMinute;
    if (perMinute === null) return true;

    let used: number;
    try {
      used = await this.redis.countInWindow(accessKey, WINDOW_SECONDS);
    } catch (err: unknown) {
      // Redis unreachable. Refusing every send because the counter is down
      // would turn a cache outage into an outage of the product; the limit is
      // there to protect the send path, not to be the send path.
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Rate limit could not be counted, allowing: ${detail}`);
      return true;
    }

    if (used <= perMinute) return true;

    // A bare 429 gets retried immediately, which makes the problem worse. The
    // header is what lets a well-behaved integration back off correctly.
    const retryAfter = this.redis.secondsUntilWindowEnds(WINDOW_SECONDS);
    const res = context.switchToHttp().getResponse<Response>();
    res.setHeader('Retry-After', String(retryAfter));

    const plan = limits.planName ? `The ${limits.planName} plan` : 'Your plan';
    throw new HttpException(
      `${plan} allows ${perMinute} messages a minute on one API key. ` +
        `Try again in ${retryAfter}s, or upgrade the plan for a higher rate.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
