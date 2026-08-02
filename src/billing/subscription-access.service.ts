import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Subscription } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { RazorpayService } from './razorpay.service';

/**
 * The paywall: "may this organisation act on this account right now?"
 *
 * Deliberately separate from `BillingService`. The gate is a cached read that
 * half the application asks for — sending, templates, phone registration — while
 * `BillingService` orchestrates Razorpay and, once a subscription starts paying,
 * provisions the account. Keeping them in one class meant every gated service
 * depended on the orchestration, so the orchestration could not depend on any of
 * them without a cycle. Splitting the read out is what lets provisioning be
 * wired at all.
 */
@Injectable()
export class SubscriptionAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly razorpay: RazorpayService,
  ) {}

  /**
   * Whether a subscription entitles its account to the API right now.
   *
   * The paid month wins over the status. A customer who cancels on day 2 has
   * bought the month, so `cancelled` with a `currentEnd` in the future still
   * gets in; the same rule covers a failed renewal, where the previous month
   * remains paid for while Razorpay retries.
   */
  static grants(sub: Pick<Subscription, 'status' | 'currentEnd'> | null): boolean {
    if (!sub) return false;
    if (sub.currentEnd && sub.currentEnd.getTime() > Date.now()) return true;
    return sub.status === 'active' || sub.status === 'authenticated';
  }

  /** The cache key: one organisation's use of one account. */
  static scope(ssoOrgId: string, wabaId: string): string {
    return `${ssoOrgId}:${wabaId}`;
  }

  /**
   * Access for the API-key path, cached briefly.
   *
   * Keyed by the organisation *and* the account, both of which the API-key
   * middleware has already resolved. The organisation belongs in the key
   * because the same WABA connected in two organisations is two subscriptions:
   * one paying does not carry the other.
   */
  async hasAccess(ssoOrgId: string, wabaId: string): Promise<boolean> {
    const key = SubscriptionAccessService.scope(ssoOrgId, wabaId);
    const cached = await this.redis.getSubscriptionAccess(key);
    if (cached !== null) return cached;

    const sub = await this.prisma.subscription.findUnique({
      where: { wabaId_ssoOrgId: { wabaId, ssoOrgId } },
    });

    const allowed = SubscriptionAccessService.grants(sub);
    await this.redis.setSubscriptionAccess(key, allowed);
    return allowed;
  }

  /**
   * Refuse an operation on an account nobody has paid for.
   *
   * The subscription buys the *account*, not one way of reaching it: sending,
   * creating templates and registering numbers all cost the same whether they
   * come from an API key or from someone clicking in the console. Gating only
   * the key would leave the console as a free way to do the very things being
   * sold.
   *
   * Reads are deliberately not gated. Someone who has stopped paying can still
   * see their history, export it and subscribe again — ending a subscription is
   * not locking someone out of their own data.
   */
  async requireAccess(ssoOrgId: string, wabaId: string): Promise<void> {
    if (!this.razorpay.isConfigured()) return;
    if (await this.hasAccess(ssoOrgId, wabaId)) return;

    throw new HttpException(
      `WhatsApp Business Account ${wabaId} has no active subscription. Subscribe in the console to use it.`,
      HttpStatus.PAYMENT_REQUIRED,
    );
  }

  /** Drop the cached answer, so a state change lands at once. */
  async invalidate(ssoOrgId: string, wabaId: string): Promise<void> {
    await this.redis.invalidateSubscriptionAccess(
      SubscriptionAccessService.scope(ssoOrgId, wabaId),
    );
  }
}
