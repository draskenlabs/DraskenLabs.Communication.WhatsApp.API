import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, Subscription, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import { RazorpayService, RazorpaySubscription } from './razorpay.service';
import {
  ConfirmSubscriptionDto,
  SubscriptionRegisteredDto,
  SubscriptionStateDto,
} from './dto/billing.dto';

/** Razorpay's status strings, which are also ours. Anything else is ignored. */
const STATUSES = new Set<string>([
  'created',
  'authenticated',
  'active',
  'pending',
  'halted',
  'cancelled',
  'completed',
  'expired',
]);

/** Unix seconds to a Date, tolerating the nulls Razorpay sends before a charge. */
function at(seconds: number | null | undefined): Date | null {
  return seconds ? new Date(seconds * 1000) : null;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly razorpay: RazorpayService,
    private readonly mail: MailNotifications,
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

  private find(wabaId: string) {
    return this.prisma.subscription.findUnique({ where: { wabaId } });
  }

  /** The WABA, if it belongs to the caller's organisation. */
  private async ownedWaba(ssoOrgId: string, wabaId: string) {
    const waba = await this.prisma.waba.findFirst({
      where: { wabaId, ssoOrgId },
      select: { wabaId: true, name: true },
    });
    if (!waba) {
      throw new NotFoundException(`WABA ${wabaId} not found in this organisation`);
    }
    return waba;
  }

  private toState(
    waba: { wabaId: string; name: string | null },
    sub: Subscription | null,
  ): SubscriptionStateDto {
    const awaiting =
      !!sub && (sub.status === 'created' || sub.status === 'authenticated');

    return {
      wabaId: waba.wabaId,
      wabaName: waba.name,
      active: BillingService.grants(sub),
      status: sub?.status ?? null,
      currentStart: sub?.currentStart ?? null,
      currentEnd: sub?.currentEnd ?? null,
      cancelAtCycleEnd: sub?.cancelAtCycleEnd ?? false,
      // Only worth offering while there is nothing to charge against: once the
      // mandate exists, Checkout has nothing left to authorise.
      subscriptionId: awaiting ? sub.razorpaySubscriptionId : null,
      authorisationUrl: awaiting ? sub.shortUrl : null,
      keyId: awaiting ? (this.razorpay.keyId ?? null) : null,
      billingEnabled: this.razorpay.isConfigured(),
    };
  }

  /**
   * One row per connected account, subscribed or not.
   *
   * Accounts without a subscription are included on purpose: the console's job
   * is to show which ones are paid for and offer the rest, and an account
   * missing from the list would read as "not connected" rather than "not paid".
   */
  async listStates(ssoOrgId: string): Promise<SubscriptionStateDto[]> {
    const [wabas, subs] = await Promise.all([
      this.prisma.waba.findMany({
        where: { ssoOrgId },
        select: { wabaId: true, name: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.subscription.findMany({ where: { ssoOrgId } }),
    ]);

    const byWaba = new Map(subs.filter((s) => s.wabaId).map((s) => [s.wabaId!, s]));
    return wabas.map((waba) => this.toState(waba, byWaba.get(waba.wabaId) ?? null));
  }

  /**
   * Access for the API-key path, cached briefly.
   *
   * Keyed by the account the key is scoped to, which the API-key middleware
   * has already resolved — so "is this request paid for" is one lookup, with
   * no allocation of seats to accounts to get wrong.
   */
  async hasAccess(wabaId: string): Promise<boolean> {
    const cached = await this.redis.getSubscriptionAccess(wabaId);
    if (cached !== null) return cached;

    const allowed = BillingService.grants(await this.find(wabaId));
    await this.redis.setSubscriptionAccess(wabaId, allowed);
    return allowed;
  }

  /**
   * Start a subscription for one account: a Razorpay customer, a monthly
   * subscription against the configured plan, and the hosted page where the
   * customer authorises the mandate. Nothing is charged until they do.
   */
  async register(
    userId: number,
    ssoOrgId: string,
    wabaId: string,
  ): Promise<SubscriptionRegisteredDto> {
    if (!this.razorpay.isConfigured()) {
      throw new BadRequestException('Payments are not configured on this deployment');
    }

    await this.ownedWaba(ssoOrgId, wabaId);
    const existing = await this.find(wabaId);

    // Registering again while one is running would leave two mandates against
    // the same account, and two debits a month.
    if (existing && !this.isFinished(existing)) {
      if (existing.cancelAtCycleEnd) {
        throw new BadRequestException(
          'This subscription is set to end at the close of the paid month. It cannot be replaced until then.',
        );
      }
      throw new BadRequestException('This account already has a subscription');
    }

    // Read the name and email from our own user row. The request only carries
    // an id and an SSO id — everything else was copied from SSO at sign-in and
    // lives here, which is why the first customers reached Razorpay blank.
    const profile = await this.profileFor(userId);

    // One Razorpay customer per organisation, so a customer paying for three
    // accounts still has one payment history rather than three.
    const reused = existing?.razorpayCustomerId ?? (await this.orgCustomerId(ssoOrgId));

    if (reused) {
      // The customer may predate having a name to give it.
      await this.razorpay.updateCustomer(reused, profile);
    }

    const customerId =
      reused ??
      (
        await this.razorpay.createCustomer({
          ...profile,
          notes: { ssoOrgId },
        })
      ).id;

    // The account travels on the subscription so a webhook can be traced back
    // even if the local row were lost.
    const created = await this.razorpay.createSubscription({
      customerId,
      notes: { ssoOrgId, wabaId, userId: String(userId) },
    });

    const data = {
      ssoOrgId,
      razorpayCustomerId: customerId,
      razorpaySubscriptionId: created.id,
      planId: created.plan_id,
      status: this.toStatus(created.status),
      currentStart: at(created.current_start),
      currentEnd: at(created.current_end),
      cancelAtCycleEnd: false,
      cancelledAt: null,
      shortUrl: created.short_url ?? null,
      createdByUserId: userId,
    };

    await this.prisma.subscription.upsert({
      where: { wabaId },
      create: { wabaId, ...data },
      update: data,
    });
    await this.redis.invalidateSubscriptionAccess(wabaId);

    return {
      wabaId,
      // Checkout opens against the subscription itself; the hosted page stays
      // in the response as a fallback for a browser that cannot run it.
      subscriptionId: created.id,
      keyId: this.razorpay.keyId ?? '',
      authorisationUrl: created.short_url ?? '',
      status: data.status,
    };
  }

  /**
   * Record the mandate Checkout just authorised.
   *
   * The browser reports its own success, so the signature is checked before
   * anything is written — otherwise a crafted request would mark a
   * subscription paid. The state itself is then taken from Razorpay rather
   * than from the browser: the payload says a mandate exists, not what period
   * it bought.
   *
   * This duplicates what `subscription.authenticated` and `charged` will say,
   * on purpose. Waiting for a webhook would leave the customer looking at
   * "awaiting authorisation" seconds after paying.
   */
  async confirm(
    ssoOrgId: string,
    wabaId: string,
    dto: ConfirmSubscriptionDto,
  ): Promise<SubscriptionStateDto> {
    const waba = await this.ownedWaba(ssoOrgId, wabaId);
    const sub = await this.find(wabaId);

    if (!sub) throw new NotFoundException('No subscription to confirm');

    // The signature covers the subscription id, so a valid signature for
    // somebody else's subscription must not pass for this account's.
    if (dto.razorpaySubscriptionId !== sub.razorpaySubscriptionId) {
      throw new BadRequestException('That payment belongs to another subscription');
    }

    const verified = this.razorpay.verifyCheckoutSignature({
      paymentId: dto.razorpayPaymentId,
      subscriptionId: dto.razorpaySubscriptionId,
      signature: dto.razorpaySignature,
    });

    if (!verified) {
      this.logger.warn(
        `Rejected an unverified checkout confirmation for ${sub.razorpaySubscriptionId}`,
      );
      throw new BadRequestException('Payment could not be verified');
    }

    const remote = await this.razorpay.fetchSubscription(sub.razorpaySubscriptionId);
    const updated = await this.applyRemote(sub, remote);

    await this.redis.invalidateSubscriptionAccess(wabaId);
    return this.toState(waba, updated);
  }

  /**
   * Write Razorpay's version of a subscription over ours. The one writer for
   * webhooks, checkout confirmations and the reconciliation sweep alike, so
   * the three cannot drift apart.
   *
   * `currentEnd` never moves backwards: events and polls can arrive out of
   * order, and a stale read must not shorten a month a charge already paid for.
   */
  private applyRemote(
    sub: Subscription,
    remote: RazorpaySubscription,
  ): Promise<Subscription> {
    const status = this.toStatus(remote.status);
    const currentEnd = at(remote.current_end);

    return this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status,
        currentStart: at(remote.current_start) ?? sub.currentStart,
        currentEnd:
          currentEnd && (!sub.currentEnd || currentEnd > sub.currentEnd)
            ? currentEnd
            : sub.currentEnd,
        cancelledAt:
          status === 'cancelled' ? (sub.cancelledAt ?? new Date()) : sub.cancelledAt,
        // Once there is a mandate the authorisation page is dead.
        shortUrl: status === 'created' ? sub.shortUrl : null,
      },
    });
  }

  /**
   * Who Razorpay should show against the payment.
   *
   * Both fields are optional on the user — SSO may not have given us a name —
   * and Razorpay rejects an empty string where it accepts an absent field, so
   * blanks are dropped rather than sent.
   */
  private async profileFor(
    userId: number,
  ): Promise<{ name?: string; email?: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, firstName: true, lastName: true },
    });

    const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();

    return {
      ...(name ? { name } : {}),
      ...(user?.email ? { email: user.email } : {}),
    };
  }

  /** Any Razorpay customer already known for this organisation. */
  private async orgCustomerId(ssoOrgId: string): Promise<string | undefined> {
    const previous = await this.prisma.subscription.findFirst({
      where: { ssoOrgId, razorpayCustomerId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { razorpayCustomerId: true },
    });
    return previous?.razorpayCustomerId ?? undefined;
  }

  /**
   * Cancel one account's subscription. The month already paid for is not
   * refunded and not cut short — Razorpay stops at the end of the cycle, and
   * access here follows `currentEnd`. A subscription whose mandate was never
   * authorised has no paid month to protect, so it stops immediately.
   */
  async cancel(ssoOrgId: string, wabaId: string): Promise<SubscriptionStateDto> {
    const waba = await this.ownedWaba(ssoOrgId, wabaId);
    const sub = await this.find(wabaId);

    if (!sub) throw new NotFoundException('No subscription to cancel');
    if (this.isFinished(sub)) {
      throw new BadRequestException('This subscription has already ended');
    }
    if (sub.cancelAtCycleEnd) {
      throw new BadRequestException('This subscription is already set to end');
    }

    const paidMonthLeft = !!sub.currentEnd && sub.currentEnd.getTime() > Date.now();
    const remote = await this.razorpay.cancelSubscription(
      sub.razorpaySubscriptionId,
      paidMonthLeft,
    );

    const updated = await this.prisma.subscription.update({
      where: { wabaId },
      data: {
        status: this.toStatus(remote.status),
        cancelAtCycleEnd: paidMonthLeft,
        cancelledAt: new Date(),
        shortUrl: null,
      },
    });
    await this.redis.invalidateSubscriptionAccess(wabaId);

    void this.mail.subscriptionCancelled(
      sub.createdByUserId,
      waba.name ?? wabaId,
      paidMonthLeft ? sub.currentEnd : null,
    );

    return this.toState(waba, updated);
  }

  /**
   * Apply a Razorpay webhook.
   *
   * Their webhooks retry, and a retry of `subscription.charged` must not be
   * able to move a billing period twice — so the event id is written first and
   * a duplicate stops there.
   */
  async handleWebhook(eventId: string, body: any): Promise<void> {
    const event: string = body?.event ?? 'unknown';
    const entity: RazorpaySubscription | undefined =
      body?.payload?.subscription?.entity;
    const ssoOrgId: string | undefined = entity?.notes?.ssoOrgId;

    try {
      await this.prisma.subscriptionEvent.create({
        data: {
          eventId,
          event,
          ssoOrgId: ssoOrgId ?? null,
          razorpaySubscriptionId: entity?.id ?? null,
          payload: (body ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.log(`Ignoring repeat delivery of ${event} (${eventId})`);
        return;
      }
      throw err;
    }

    if (!entity?.id || !event.startsWith('subscription.')) return;

    const sub = await this.prisma.subscription.findUnique({
      where: { razorpaySubscriptionId: entity.id },
      include: { waba: { select: { name: true } } },
    });

    if (!sub) {
      // A subscription created against another environment sharing the same
      // Razorpay account. Recorded above, then left alone.
      this.logger.warn(`Webhook for unknown subscription ${entity.id}`);
      return;
    }

    const status = this.toStatus(entity.status);
    const currentEnd = at(entity.current_end);

    await this.applyRemote(sub, entity);

    if (sub.wabaId) await this.redis.invalidateSubscriptionAccess(sub.wabaId);
    await this.notify(event, sub, sub.waba?.name ?? sub.wabaId ?? 'your account', status, currentEnd ?? sub.currentEnd);
  }

  /** One email per state a customer would want to hear about. */
  private async notify(
    event: string,
    sub: Subscription,
    account: string,
    status: SubscriptionStatus,
    currentEnd: Date | null,
  ): Promise<void> {
    if (event === 'subscription.charged' || event === 'subscription.activated') {
      // Both fire around the first successful debit; the mail is sent for the
      // one that carries the period, and only when the period actually moved.
      if (status === 'active' && currentEnd && currentEnd > (sub.currentEnd ?? new Date(0))) {
        void this.mail.subscriptionCharged(sub.createdByUserId, account, currentEnd);
      }
      return;
    }

    if (event === 'subscription.pending' || event === 'subscription.halted') {
      void this.mail.subscriptionPaymentFailed(
        sub.createdByUserId,
        account,
        status === 'halted',
        currentEnd,
      );
    }
  }

  /** Nothing more will be charged and nothing more can be reactivated. */
  private isFinished(sub: Subscription): boolean {
    return (
      sub.status === 'cancelled' ||
      sub.status === 'expired' ||
      sub.status === 'completed'
    );
  }

  private toStatus(status: string): SubscriptionStatus {
    return (STATUSES.has(status) ? status : 'created') as SubscriptionStatus;
  }

  /**
   * Hourly reconciliation.
   *
   * Webhooks get missed — a deploy mid-delivery, an outage, a misconfigured
   * endpoint — and a missed `subscription.charged` reads exactly like a lapsed
   * customer, while a missed `halted` reads like a paying one. Anything whose
   * paid month has run out is re-read from Razorpay rather than assumed.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'billing-reconcile' })
  async reconcile(): Promise<void> {
    if (!this.razorpay.isConfigured()) return;

    const stale = await this.prisma.subscription.findMany({
      where: {
        status: { notIn: ['cancelled', 'expired', 'completed'] },
        OR: [{ currentEnd: { lt: new Date() } }, { currentEnd: null }],
      },
      take: 100,
    });

    for (const sub of stale) {
      try {
        const remote = await this.razorpay.fetchSubscription(sub.razorpaySubscriptionId);
        await this.applyRemote(sub, remote);
        if (sub.wabaId) await this.redis.invalidateSubscriptionAccess(sub.wabaId);
      } catch (err) {
        // One unreachable subscription must not stop the rest of the sweep.
        this.logger.error(
          `Reconciliation failed for ${sub.razorpaySubscriptionId}: ${(err as Error).message}`,
        );
      }
    }
  }
}
