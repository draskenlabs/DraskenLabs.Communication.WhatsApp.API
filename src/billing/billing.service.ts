import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, Subscription, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import {
  RazorpayPayment,
  RazorpayService,
  RazorpaySubscription,
} from './razorpay.service';
import { SubscriptionAccessService } from './subscription-access.service';
import { WabaProvisioningService } from 'src/provisioning/waba-provisioning.service';
import {
  ConfirmSubscriptionDto,
  SubscriptionPaymentDto,
  SubscriptionPlanDto,
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

/**
 * Enough of the instrument to recognise it, and no more.
 *
 * "Visa ···· 4242" tells the customer which card was debited. The number, the
 * token and everything else stay at Razorpay — there is nothing here worth
 * stealing and nothing that could be replayed.
 */
function describeMethod(payment: RazorpayPayment): string | null {
  if (payment.card?.last4) {
    const network = payment.card.network ?? payment.card.issuer ?? 'Card';
    return `${network} ···· ${payment.card.last4}`;
  }
  if (payment.vpa) return payment.vpa;
  if (payment.bank) return payment.bank;
  if (payment.wallet) return payment.wallet;
  return null;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly razorpay: RazorpayService,
    private readonly mail: MailNotifications,
    private readonly access: SubscriptionAccessService,
    private readonly provisioning: WabaProvisioningService,
  ) {}

  /**
   * The subscription for one organisation's use of one account.
   *
   * Both halves matter. An account can be connected by more than one
   * organisation, and each pays for its own use of it — keying on the account
   * alone told the second organisation the account was already subscribed, and
   * would have let it call the API on the first one's payment.
   */
  private find(ssoOrgId: string, wabaId: string) {
    return this.prisma.subscription.findUnique({
      where: { wabaId_ssoOrgId: { wabaId, ssoOrgId } },
      include: { plan: { select: { code: true, name: true } } },
    });
  }

  /**
   * The tier being bought, checked against what can actually be charged.
   *
   * Null for a request that names no plan: a deployment with a single
   * configured Razorpay plan carries on exactly as it did.
   */
  private async sellablePlan(planCode?: string) {
    if (!planCode) return null;

    const plan = await this.prisma.plan.findFirst({
      where: { code: planCode, active: true },
      select: {
        id: true,
        name: true,
        code: true,
        ctaKind: true,
        razorpayPlanId: true,
      },
    });
    if (!plan) throw new NotFoundException(`Plan ${planCode} is not on offer`);

    // Agency is quoted, not sold. Letting Checkout open on it would charge
    // whatever plan happened to be wired up, which is nobody's agreed price.
    if (plan.ctaKind === 'contact') {
      throw new BadRequestException(
        `${plan.name} is priced individually — contact sales rather than subscribing here.`,
      );
    }
    // A tier with no Razorpay plan behind it cannot be debited. Better to say
    // so than to sell it against the default plan at the wrong price.
    if (!plan.razorpayPlanId) {
      throw new BadRequestException(
        `${plan.name} is not available for checkout on this deployment yet.`,
      );
    }
    return plan;
  }

  /** The WABA, if it belongs to the caller's organisation. */
  private async ownedWaba(ssoOrgId: string, wabaId: string) {
    const waba = await this.prisma.waba.findFirst({
      where: { wabaId, WabaOrganisation: { some: { ssoOrgId } } },
      select: { wabaId: true, name: true },
    });
    if (!waba) {
      throw new NotFoundException(
        `WABA ${wabaId} not found in this organisation`,
      );
    }
    return waba;
  }

  private toState(
    waba: { wabaId: string; name: string | null },
    sub:
      | (Subscription & { plan?: { code: string; name: string } | null })
      | null,
    extras: {
      plan?: SubscriptionPlanDto | null;
      payments?: SubscriptionPaymentDto[];
    } = {},
  ): SubscriptionStateDto {
    const awaiting =
      !!sub && (sub.status === 'created' || sub.status === 'authenticated');
    const payments = extras.payments ?? [];

    return {
      wabaId: waba.wabaId,
      wabaName: waba.name,
      active: SubscriptionAccessService.grants(sub),
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
      // Which published tier this was sold as. Null for a subscription taken
      // out before the price list existed — it is on the deployment's single
      // configured plan, and `plan` below still says what that costs.
      planCode: sub?.plan?.code ?? null,
      planName: sub?.plan?.name ?? null,
      plan: extras.plan ?? null,
      lastPayment: payments[0] ?? null,
      payments,
      // The renewal date *is* the next debit, until there is not going to be
      // one: a cancelled subscription runs to the end of the month already
      // paid for and then stops, so showing a date would be a lie.
      nextChargeAt:
        sub && !sub.cancelAtCycleEnd && !this.isFinished(sub)
          ? sub.currentEnd
          : null,
      paidCount: payments.filter((p) => p.status === 'captured').length,
    };
  }

  /** The stored debits for a subscription, newest first. */
  private async paymentsFor(
    subscriptionId: number | undefined,
  ): Promise<SubscriptionPaymentDto[]> {
    if (!subscriptionId) return [];
    return this.prisma.subscriptionPayment.findMany({
      where: { subscriptionId },
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
      take: 12,
      select: {
        razorpayPaymentId: true,
        razorpayInvoiceId: true,
        amount: true,
        currency: true,
        status: true,
        method: true,
        methodDetail: true,
        paidAt: true,
      },
    });
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
        where: { WabaOrganisation: { some: { ssoOrgId } } },
        select: { wabaId: true, name: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.subscription.findMany({
        where: { ssoOrgId },
        include: { plan: { select: { code: true, name: true } } },
      }),
    ]);

    // One lookup per distinct tier rather than per account: an organisation
    // with six accounts on Growth asks Razorpay about Growth once, and the
    // answers are cached for the process after that.
    const planIds = [...new Set(subs.map((s) => s.planId).filter(Boolean))];
    const plans = new Map<string, SubscriptionPlanDto | null>(
      await Promise.all(
        planIds.map(
          async (id) =>
            [id, await this.plan(id)] as [string, SubscriptionPlanDto | null],
        ),
      ),
    );

    // One query for the debits of every subscription in the organisation,
    // rather than one per account.
    const payments = await this.prisma.subscriptionPayment.findMany({
      where: { subscriptionId: { in: subs.map((s) => s.id) } },
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
      select: {
        subscriptionId: true,
        razorpayPaymentId: true,
        razorpayInvoiceId: true,
        amount: true,
        currency: true,
        status: true,
        method: true,
        methodDetail: true,
        paidAt: true,
      },
    });

    const bySub = new Map<number, SubscriptionPaymentDto[]>();
    for (const { subscriptionId, ...payment } of payments) {
      const list = bySub.get(subscriptionId) ?? [];
      if (list.length < 12) list.push(payment);
      bySub.set(subscriptionId, list);
    }

    const byWaba = new Map(
      subs.filter((s) => s.wabaId).map((s) => [s.wabaId!, s]),
    );
    return wabas.map((waba) => {
      const sub = byWaba.get(waba.wabaId) ?? null;
      return this.toState(waba, sub, {
        // An account with no subscription has no price of its own — what it
        // would cost depends on the tier nobody has chosen yet, and the
        // console sends the reader to the price list for that.
        plan: sub ? (plans.get(sub.planId) ?? null) : null,
        payments: sub ? (bySub.get(sub.id) ?? []) : [],
      });
    });
  }

  /**
   * What a subscription costs, in the shape the console shows it.
   *
   * Read per subscription rather than once for the deployment: with more than
   * one tier on sale, a single price would show a Growth customer the Starter
   * amount. Falls back to the configured plan when no id is given.
   *
   * Null rather than an error when Razorpay cannot be reached: the page's job
   * is to say whether an account is paid for, and it can still do that without
   * a price.
   */
  private async plan(planId?: string): Promise<SubscriptionPlanDto | null> {
    const plan = await this.razorpay.fetchPlan(planId);
    if (!plan) return null;

    return {
      planId: plan.id,
      name: plan.item?.name ?? null,
      amount: plan.item?.amount ?? 0,
      currency: plan.item?.currency ?? 'INR',
      period: plan.period,
      interval: plan.interval,
    };
  }

  /**
   * Start a subscription for one account: a Razorpay customer, a monthly
   * subscription against the chosen tier, and the hosted page where the
   * customer authorises the mandate. Nothing is charged until they do.
   *
   * @param planCode The tier from the published price list. Omitted, the
   * deployment's configured Razorpay plan is used — which is what an
   * installation selling a single price has always done.
   */
  async register(
    userId: number,
    ssoOrgId: string,
    wabaId: string,
    planCode?: string,
  ): Promise<SubscriptionRegisteredDto> {
    if (!this.razorpay.isConfigured()) {
      throw new BadRequestException(
        'Payments are not configured on this deployment',
      );
    }

    await this.ownedWaba(ssoOrgId, wabaId);
    // Checked before anything is created at Razorpay: a bad tier must fail
    // without leaving a customer or a half-made subscription behind.
    const plan = await this.sellablePlan(planCode);
    const existing = await this.find(ssoOrgId, wabaId);

    // Registering again while one is running would leave two mandates against
    // the same account, and two debits a month.
    if (existing && !this.isFinished(existing)) {
      if (existing.cancelAtCycleEnd) {
        throw new BadRequestException(
          'This subscription is set to end at the close of the paid month. It cannot be replaced until then.',
        );
      }
      throw new BadRequestException(
        'This organisation already has a subscription for this account',
      );
    }

    // Read the name and email from our own user row. The request only carries
    // an id and an SSO id — everything else was copied from SSO at sign-in and
    // lives here, which is why the first customers reached Razorpay blank.
    const profile = await this.profileFor(userId);

    // One Razorpay customer per organisation, so a customer paying for three
    // accounts still has one payment history rather than three. Razorpay
    // dedupes by email across the merchant account, so one person running two
    // organisations gets one customer for both whatever we ask for; the
    // subscription's notes are what tie a payment back to an organisation.
    const reused =
      existing?.razorpayCustomerId ?? (await this.orgCustomerId(ssoOrgId));

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

    // The account and the tier travel on the subscription so a webhook — or a
    // support question against Razorpay's dashboard — can be traced back even
    // if the local row were lost.
    const created = await this.razorpay.createSubscription({
      customerId,
      planId: plan?.razorpayPlanId ?? undefined,
      notes: {
        ssoOrgId,
        wabaId,
        userId: String(userId),
        ...(plan ? { planCode: plan.code } : {}),
      },
    });

    const data = {
      ssoOrgId,
      razorpayCustomerId: customerId,
      razorpaySubscriptionId: created.id,
      // What Razorpay says it will charge, and which published tier that was
      // sold as. The first is the record of the agreement; the second is how
      // the console names it.
      planId: created.plan_id,
      planRefId: plan?.id ?? null,
      status: this.toStatus(created.status),
      currentStart: at(created.current_start),
      currentEnd: at(created.current_end),
      cancelAtCycleEnd: false,
      cancelledAt: null,
      shortUrl: created.short_url ?? null,
      createdByUserId: userId,
    };

    await this.prisma.subscription.upsert({
      where: { wabaId_ssoOrgId: { wabaId, ssoOrgId } },
      create: { wabaId, ...data },
      update: data,
    });
    await this.access.invalidate(ssoOrgId, wabaId);

    return {
      wabaId,
      // Checkout opens against the subscription itself; the hosted page stays
      // in the response as a fallback for a browser that cannot run it.
      subscriptionId: created.id,
      keyId: this.razorpay.keyId ?? '',
      authorisationUrl: created.short_url ?? '',
      status: data.status,
      planCode: plan?.code ?? null,
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
    const sub = await this.find(ssoOrgId, wabaId);

    if (!sub) throw new NotFoundException('No subscription to confirm');

    // The signature covers the subscription id, so a valid signature for
    // somebody else's subscription must not pass for this account's.
    if (dto.razorpaySubscriptionId !== sub.razorpaySubscriptionId) {
      throw new BadRequestException(
        'That payment belongs to another subscription',
      );
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

    const remote = await this.razorpay.fetchSubscription(
      sub.razorpaySubscriptionId,
    );
    const updated = await this.applyRemote(sub, remote);

    await this.access.invalidate(ssoOrgId, wabaId);
    return this.toState(waba, updated, {
      plan: await this.plan(updated.planId),
      payments: await this.paymentsFor(updated.id),
    });
  }

  /**
   * Write Razorpay's version of a subscription over ours. The one writer for
   * webhooks, checkout confirmations and the reconciliation sweep alike, so
   * the three cannot drift apart.
   *
   * `currentEnd` never moves backwards: events and polls can arrive out of
   * order, and a stale read must not shorten a month a charge already paid for.
   */
  private async applyRemote(
    sub: Subscription,
    remote: RazorpaySubscription,
  ): Promise<Subscription> {
    const status = this.toStatus(remote.status);
    const currentEnd = at(remote.current_end);

    const updated = await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status,
        currentStart: at(remote.current_start) ?? sub.currentStart,
        currentEnd:
          currentEnd && (!sub.currentEnd || currentEnd > sub.currentEnd)
            ? currentEnd
            : sub.currentEnd,
        cancelledAt:
          status === 'cancelled'
            ? (sub.cancelledAt ?? new Date())
            : sub.cancelledAt,
        // Once there is a mandate the authorisation page is dead.
        shortUrl: status === 'created' ? sub.shortUrl : null,
      },
    });

    await this.provisionIfNewlyPaid(sub, updated);
    return updated;
  }

  /**
   * Fill the account in the first time it is paid for.
   *
   * Connecting deliberately syncs nothing, so this is what turns a connected
   * account into a working one. It fires on the edge — not-granting to granting
   * — so a renewal, a reconciliation sweep or a replayed webhook does not set it
   * off again; `isProvisioned` is the second guard, for the case where the edge
   * itself is replayed after the data is already there.
   *
   * Deliberately not awaited by the caller's transaction and never allowed to
   * throw: Razorpay has taken the money either way, and a Meta outage must not
   * turn a successful payment into a failed request.
   */
  private async provisionIfNewlyPaid(
    before: Subscription,
    after: Subscription,
  ): Promise<void> {
    if (!after.wabaId) return;
    if (SubscriptionAccessService.grants(before)) return;
    if (!SubscriptionAccessService.grants(after)) return;

    const { ssoOrgId, wabaId } = {
      ssoOrgId: after.ssoOrgId,
      wabaId: after.wabaId,
    };

    try {
      if (await this.provisioning.isProvisioned(wabaId)) return;
      await this.provisioning.provision(ssoOrgId, wabaId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Subscription for ${wabaId} in ${ssoOrgId} is paid but provisioning failed: ${detail}`,
      );
    }
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

    const name = [user?.firstName, user?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();

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
  async cancel(
    ssoOrgId: string,
    wabaId: string,
  ): Promise<SubscriptionStateDto> {
    const waba = await this.ownedWaba(ssoOrgId, wabaId);
    const sub = await this.find(ssoOrgId, wabaId);

    if (!sub) throw new NotFoundException('No subscription to cancel');
    if (this.isFinished(sub)) {
      throw new BadRequestException('This subscription has already ended');
    }
    if (sub.cancelAtCycleEnd) {
      throw new BadRequestException('This subscription is already set to end');
    }

    const paidMonthLeft =
      !!sub.currentEnd && sub.currentEnd.getTime() > Date.now();
    const remote = await this.razorpay.cancelSubscription(
      sub.razorpaySubscriptionId,
      paidMonthLeft,
    );

    const updated = await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: this.toStatus(remote.status),
        cancelAtCycleEnd: paidMonthLeft,
        cancelledAt: new Date(),
        shortUrl: null,
      },
    });
    await this.access.invalidate(ssoOrgId, wabaId);

    void this.mail.subscriptionCancelled(
      sub.createdByUserId,
      ssoOrgId,
      waba.name ?? wabaId,
      paidMonthLeft ? sub.currentEnd : null,
    );

    return this.toState(waba, updated, {
      plan: await this.plan(updated.planId),
      payments: await this.paymentsFor(updated.id),
    });
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
    // `subscription.charged` carries the payment alongside the subscription;
    // the other events have no payment half.
    const payment: RazorpayPayment | undefined = body?.payload?.payment?.entity;
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
    await this.recordPayment(sub.id, payment);

    if (sub.wabaId) {
      await this.access.invalidate(sub.ssoOrgId, sub.wabaId);
    }
    await this.notify(
      event,
      sub,
      sub.waba?.name ?? sub.wabaId ?? 'your account',
      status,
      currentEnd ?? sub.currentEnd,
    );
  }

  /**
   * Keep a copy of what was taken.
   *
   * Razorpay is the ledger and this is not trying to replace it; it is what
   * lets the console answer "what was I charged, when, on which card" without
   * a round trip, and after a payment has scrolled out of their dashboard.
   *
   * Keyed on their payment id, so a retried webhook updates the row it already
   * wrote rather than billing history growing a duplicate every retry.
   */
  private async recordPayment(
    subscriptionId: number,
    payment: RazorpayPayment | undefined,
  ): Promise<void> {
    if (!payment?.id) return;

    const data = {
      razorpayInvoiceId: payment.invoice_id ?? null,
      amount: payment.amount ?? 0,
      currency: payment.currency ?? 'INR',
      status: payment.status ?? 'captured',
      method: payment.method ?? null,
      methodDetail: describeMethod(payment),
      paidAt: at(payment.created_at),
    };

    try {
      await this.prisma.subscriptionPayment.upsert({
        where: { razorpayPaymentId: payment.id },
        create: { subscriptionId, razorpayPaymentId: payment.id, ...data },
        update: data,
      });
    } catch (err) {
      // Billing history is worth having, not worth failing a webhook over —
      // Razorpay would retry the whole delivery and re-apply the state.
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not record payment ${payment.id}: ${detail}`);
    }
  }

  /** One email per state a customer would want to hear about. */
  private async notify(
    event: string,
    sub: Subscription,
    account: string,
    status: SubscriptionStatus,
    currentEnd: Date | null,
  ): Promise<void> {
    if (
      event === 'subscription.charged' ||
      event === 'subscription.activated'
    ) {
      // Both fire around the first successful debit; the mail is sent for the
      // one that carries the period, and only when the period actually moved.
      if (
        status === 'active' &&
        currentEnd &&
        currentEnd > (sub.currentEnd ?? new Date(0))
      ) {
        void this.mail.subscriptionCharged(
          sub.createdByUserId,
          sub.ssoOrgId,
          account,
          currentEnd,
        );
      }
      return;
    }

    if (event === 'subscription.pending' || event === 'subscription.halted') {
      void this.mail.subscriptionPaymentFailed(
        sub.createdByUserId,
        sub.ssoOrgId,
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
        const remote = await this.razorpay.fetchSubscription(
          sub.razorpaySubscriptionId,
        );
        await this.applyRemote(sub, remote);
        if (sub.wabaId) {
          await this.access.invalidate(sub.ssoOrgId, sub.wabaId);
        }
      } catch (err) {
        // One unreachable subscription must not stop the rest of the sweep.
        this.logger.error(
          `Reconciliation failed for ${sub.razorpaySubscriptionId}: ${(err as Error).message}`,
        );
      }
    }
  }
}
