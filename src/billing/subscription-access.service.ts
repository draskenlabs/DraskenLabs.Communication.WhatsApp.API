import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Subscription } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { RazorpayService } from './razorpay.service';
import { OrganisationSettingsService } from 'src/organisation-settings/organisation-settings.service';

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
    private readonly orgSettings: OrganisationSettingsService,
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
    // A superseded row grants nothing whatever its dates say. It was replaced
    // by the organisation's subscription, and letting a paid month on it keep
    // the door open would hand out access the organisation is not paying for.
    if (sub.status === 'superseded') return false;
    if (sub.currentEnd && sub.currentEnd.getTime() > Date.now()) return true;
    return sub.status === 'active' || sub.status === 'authenticated';
  }

  /**
   * The cache key: one organisation's use of one account, at one version of
   * whoever pays for it.
   *
   * The version is what makes an agency workable. A client's access depends on
   * its agency's subscription, so one failed debit has to darken every client
   * of that agency and every account each of them holds. Enumerating those keys
   * is fine at five clients and a problem at five hundred; bumping the payer's
   * version orphans all of them in a single write instead.
   */
  static scope(ssoOrgId: string, wabaId: string, payerVersion = 0): string {
    return `${ssoOrgId}:${wabaId}:v${payerVersion}`;
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
    const version = await this.orgSettings.cacheVersionFor(ssoOrgId);
    const key = SubscriptionAccessService.scope(ssoOrgId, wabaId, version);
    const cached = await this.redis.getSubscriptionAccess(key);
    if (cached !== null) return cached;

    // Whoever pays answers for it. A client organisation holds no subscription
    // of its own; its agency's is the one that decides whether it may send.
    const payer = await this.orgSettings.billingOrgFor(ssoOrgId);

    // An organisation-level subscription covers every account the payer holds,
    // so the account's own row is looked for first and the organisation's is
    // what answers when there is none — which, after the move to org-level
    // billing, is every account.
    const sub =
      (await this.prisma.subscription.findUnique({
        where: { wabaId_ssoOrgId: { wabaId, ssoOrgId: payer } },
      })) ??
      (await this.prisma.subscription.findFirst({
        where: { ssoOrgId: payer, wabaId: null },
        orderBy: { createdAt: 'desc' },
      }));

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

  /** Drop the cached answer for one account, so a state change lands at once. */
  async invalidate(ssoOrgId: string, wabaId: string): Promise<void> {
    const version = await this.orgSettings.cacheVersionFor(ssoOrgId);
    await this.redis.invalidateSubscriptionAccess(
      SubscriptionAccessService.scope(ssoOrgId, wabaId, version),
    );
  }

  /**
   * Drop every cached answer that depends on this organisation's subscription
   * — its own accounts, and every account of every client inheriting from it.
   *
   * One increment rather than a walk: the version is part of each key, so the
   * old ones stop being addressable at once and expire on their own. This is
   * what a failed renewal on an agency has to call, and it must reach the
   * clients or they carry on sending on a subscription that has lapsed.
   */
  async invalidatePayer(ssoOrgId: string): Promise<void> {
    await this.orgSettings.bumpPayerVersion(ssoOrgId);
  }
}
