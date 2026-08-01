import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, Subscription, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import { RazorpayService, RazorpaySubscription } from './razorpay.service';
import { SubscriptionStateDto, SubscriptionRegisteredDto } from './dto/billing.dto';

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
   * Whether a subscription entitles its organisation to the API right now.
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

  /** The org's subscription, or null when it never had one. */
  private find(ssoOrgId: string) {
    return this.prisma.subscription.findUnique({ where: { ssoOrgId } });
  }

  async getState(ssoOrgId: string): Promise<SubscriptionStateDto> {
    const sub = await this.find(ssoOrgId);

    return {
      active: BillingService.grants(sub),
      status: sub?.status ?? null,
      currentStart: sub?.currentStart ?? null,
      currentEnd: sub?.currentEnd ?? null,
      cancelAtCycleEnd: sub?.cancelAtCycleEnd ?? false,
      // Only worth showing while there is nothing to charge against.
      authorisationUrl:
        sub && (sub.status === 'created' || sub.status === 'authenticated')
          ? sub.shortUrl
          : null,
      billingEnabled: this.razorpay.isConfigured(),
    };
  }

  /**
   * Access for the API-key path, cached briefly.
   *
   * Called on every API request, so it must not be a database read each time;
   * it must also not be stale for long, which is why the entry is both short
   * lived and dropped by the webhook.
   */
  async hasAccess(ssoOrgId: string): Promise<boolean> {
    const cached = await this.redis.getSubscriptionAccess(ssoOrgId);
    if (cached !== null) return cached;

    const allowed = BillingService.grants(await this.find(ssoOrgId));
    await this.redis.setSubscriptionAccess(ssoOrgId, allowed);
    return allowed;
  }

  /**
   * Start a subscription: a Razorpay customer, a monthly subscription against
   * the configured plan, and the hosted page where the customer authorises the
   * mandate. Nothing is charged until they do.
   */
  async register(
    userId: number,
    ssoOrgId: string,
    profile: { name?: string; email?: string },
  ): Promise<SubscriptionRegisteredDto> {
    if (!this.razorpay.isConfigured()) {
      throw new BadRequestException('Payments are not configured on this deployment');
    }

    const existing = await this.find(ssoOrgId);

    // Registering again while one is running would leave two mandates against
    // the same organisation, and two debits a month.
    if (existing && !this.isFinished(existing)) {
      if (existing.cancelAtCycleEnd) {
        throw new BadRequestException(
          'This subscription is set to end at the close of the paid month. It cannot be replaced until then.',
        );
      }
      throw new BadRequestException('This organisation already has a subscription');
    }

    const customerId =
      existing?.razorpayCustomerId ??
      (
        await this.razorpay.createCustomer({
          name: profile.name,
          email: profile.email,
          notes: { ssoOrgId },
        })
      ).id;

    // The org id travels on the subscription so a webhook can be traced back
    // even if the local row were lost.
    const created = await this.razorpay.createSubscription({
      customerId,
      notes: { ssoOrgId, userId: String(userId) },
    });

    const data = {
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
      where: { ssoOrgId },
      create: { ssoOrgId, ...data },
      update: data,
    });
    await this.redis.invalidateSubscriptionAccess(ssoOrgId);

    return {
      authorisationUrl: created.short_url ?? '',
      status: data.status,
    };
  }

  /**
   * Cancel. The month already paid for is not refunded and not cut short —
   * Razorpay stops at the end of the cycle, and access here follows
   * `currentEnd`. A subscription whose mandate was never authorised has no
   * paid month to protect, so it stops immediately.
   */
  async cancel(ssoOrgId: string): Promise<SubscriptionStateDto> {
    const sub = await this.find(ssoOrgId);
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

    await this.prisma.subscription.update({
      where: { ssoOrgId },
      data: {
        status: this.toStatus(remote.status),
        cancelAtCycleEnd: paidMonthLeft,
        cancelledAt: new Date(),
        shortUrl: null,
      },
    });
    await this.redis.invalidateSubscriptionAccess(ssoOrgId);

    void this.mail.subscriptionCancelled(
      sub.createdByUserId,
      paidMonthLeft ? sub.currentEnd : null,
    );

    return this.getState(ssoOrgId);
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
    });

    if (!sub) {
      // A subscription created against another environment sharing the same
      // Razorpay account. Recorded above, then left alone.
      this.logger.warn(`Webhook for unknown subscription ${entity.id}`);
      return;
    }

    const status = this.toStatus(entity.status);
    const currentEnd = at(entity.current_end);

    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status,
        currentStart: at(entity.current_start) ?? sub.currentStart,
        // Never move the paid-until date backwards: a late-arriving
        // `authenticated` must not shorten a month a `charged` already paid for.
        currentEnd:
          currentEnd && (!sub.currentEnd || currentEnd > sub.currentEnd)
            ? currentEnd
            : sub.currentEnd,
        cancelledAt: status === 'cancelled' ? (sub.cancelledAt ?? new Date()) : sub.cancelledAt,
        // Once there is a mandate the authorisation page is dead.
        shortUrl: status === 'created' ? sub.shortUrl : null,
      },
    });

    await this.redis.invalidateSubscriptionAccess(sub.ssoOrgId);
    await this.notify(event, sub, status, currentEnd ?? sub.currentEnd);
  }

  /** One email per state a customer would want to hear about. */
  private async notify(
    event: string,
    sub: Subscription,
    status: SubscriptionStatus,
    currentEnd: Date | null,
  ): Promise<void> {
    if (event === 'subscription.charged' || event === 'subscription.activated') {
      // Both fire around the first successful debit; the mail is sent for the
      // one that carries the period, and only when the period actually moved.
      if (status === 'active' && currentEnd && currentEnd > (sub.currentEnd ?? new Date(0))) {
        void this.mail.subscriptionCharged(sub.createdByUserId, currentEnd);
      }
      return;
    }

    if (event === 'subscription.pending' || event === 'subscription.halted') {
      void this.mail.subscriptionPaymentFailed(
        sub.createdByUserId,
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
    return (
      STATUSES.has(status) ? status : 'created'
    ) as SubscriptionStatus;
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
        const currentEnd = at(remote.current_end);

        await this.prisma.subscription.update({
          where: { id: sub.id },
          data: {
            status: this.toStatus(remote.status),
            currentStart: at(remote.current_start) ?? sub.currentStart,
            currentEnd:
              currentEnd && (!sub.currentEnd || currentEnd > sub.currentEnd)
                ? currentEnd
                : sub.currentEnd,
          },
        });
        await this.redis.invalidateSubscriptionAccess(sub.ssoOrgId);
      } catch (err) {
        // One unreachable subscription must not stop the rest of the sweep.
        this.logger.error(
          `Reconciliation failed for ${sub.razorpaySubscriptionId}: ${(err as Error).message}`,
        );
      }
    }
  }
}
