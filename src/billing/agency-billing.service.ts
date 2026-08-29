import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SubscriptionPayment } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { OrganisationSettingsService } from 'src/organisation-settings/organisation-settings.service';
import { RazorpayService } from './razorpay.service';
import { SubscriptionAccessService } from './subscription-access.service';

/** Statuses in which the provider will accept a change to a subscription. */
const UPDATABLE = ['active', 'authenticated'] as const;

/** Unix seconds to a Date, tolerating the nulls sent before a charge. */
function at(seconds: number | null | undefined): Date | null {
  return seconds ? new Date(seconds * 1000) : null;
}

/**
 * What a webhook that turned out to be a group's did.
 *
 * Returned rather than a bare `true` because the caller has one more thing to
 * do with it: a captured debit on an agency's mandate is money that moved, and
 * money that moved gets a document.
 */
export interface AppliedGroupCharge {
  billingGroupId: number;
  agencyOrgId: string;
  /** Who took the mandate out — the person the invoice goes to. */
  userId: number;
  planCode: string | null;
  planName: string | null;
  /** The debit as it was stored, or null for an event that carried none. */
  payment: SubscriptionPayment | null;
  currentStart: Date | null;
  currentEnd: Date | null;
}

/** What the caller is told after a client is put on a plan. */
export interface ClientSubscriptionResult {
  ssoOrgId: string;
  planCode: string;
  planName: string;
  status: string;
  currentEnd: Date | null;
  /**
   * Set when this was the agency's first client on the plan, so the mandate
   * covering it still has to be authorised. Null when an existing mandate
   * simply grew by one, which needs nothing from anybody.
   */
  authorisation: {
    subscriptionId: string;
    shortUrl: string | null;
  } | null;
}

/**
 * What an agency pays, and what each of its clients gets for it.
 *
 * An agency buys a plan *per client*: the client holds the subscription, the
 * agency holds the money. That keeps limits and money moving together — a
 * client on Growth has Growth's limits because somebody is paying Growth's
 * price for it — which the arrangement it replaces did not, since one plan's
 * ceilings applied to every client at once and nothing charged for the
 * multiplication.
 *
 * Underneath, the money is one mandate per *plan* rather than per client. A
 * subscription per client would be an authorisation per client, and nobody
 * would sit through eight of those; instead the agency's subscription for a
 * plan carries a quantity, and taking a client on moves it by one.
 */
@Injectable()
export class AgencyBillingService {
  private readonly logger = new Logger(AgencyBillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpay: RazorpayService,
    private readonly orgSettings: OrganisationSettingsService,
    private readonly access: SubscriptionAccessService,
  ) {}

  /**
   * Put a client on a plan, paid for by its agency.
   *
   * The plan has to be one the agency may actually sell from: a published tier,
   * or one written privately for this agency. Knowing another agency's
   * negotiated code is not enough to buy at their rate.
   */
  async subscribeClient(input: {
    agencyOrgId: string;
    ssoOrgId: string;
    planCode: string;
    userId: number;
  }): Promise<ClientSubscriptionResult> {
    const { agencyOrgId, ssoOrgId, planCode, userId } = input;

    const plan = await this.sellableToAgency(planCode, agencyOrgId);

    const existing = await this.prisma.subscription.findFirst({
      where: { ssoOrgId, wabaId: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, cancelAtCycleEnd: true },
    });
    if (existing && !this.isFinished(existing.status)) {
      throw new BadRequestException(
        'This client already has a subscription. Change its plan rather than starting another.',
      );
    }

    const group = await this.groupFor(agencyOrgId, plan, userId);

    // The row the client is actually entitled by. Written after the provider
    // has agreed to charge for it, so a client is never entitled to something
    // nobody is paying for.
    await this.prisma.subscription.create({
      data: {
        ssoOrgId,
        payerOrgId: agencyOrgId,
        billingGroupId: group.id,
        // No mandate of its own: it is a quantity on the agency's.
        razorpaySubscriptionId: null,
        razorpayCustomerId: group.razorpayCustomerId,
        planId: group.planId,
        planRefId: plan.id,
        status: group.status,
        currentStart: group.currentStart,
        currentEnd: group.currentEnd,
        createdByUserId: userId,
      },
    });

    // Its access is now decided by a subscription of its own rather than by
    // whatever its agency holds, so anything cached under the old answer has
    // to stop matching.
    await this.orgSettings.bumpPayerVersion(ssoOrgId);

    return {
      ssoOrgId,
      planCode: plan.code,
      planName: plan.name,
      status: group.status,
      currentEnd: group.currentEnd,
      authorisation: group.authorisationNeeded
        ? {
            subscriptionId: group.razorpaySubscriptionId,
            shortUrl: group.shortUrl,
          }
        : null,
    };
  }

  /**
   * Stop paying for a client at the end of the month already paid for.
   *
   * Not immediately: the month was bought. Cutting a client off the day it is
   * released takes something the agency has already paid for, and the client
   * is the one who would notice.
   */
  async releaseClient(agencyOrgId: string, ssoOrgId: string): Promise<void> {
    const sub = await this.prisma.subscription.findFirst({
      where: { ssoOrgId, wabaId: null, payerOrgId: agencyOrgId },
      orderBy: { createdAt: 'desc' },
      include: { billingGroup: true },
    });
    if (!sub) {
      throw new NotFoundException(
        `${agencyOrgId} does not pay for a subscription on ${ssoOrgId}`,
      );
    }
    if (sub.cancelAtCycleEnd) return;

    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAtCycleEnd: true },
    });

    const group = sub.billingGroup;
    if (group) {
      const remaining = Math.max(0, group.quantity - 1);
      // At cycle end, to match what the client keeps. Dropping the quantity
      // today would refund the agency for a month its client is still using.
      if (remaining === 0) {
        await this.razorpay.cancelSubscription(
          group.razorpaySubscriptionId,
          true,
        );
        await this.prisma.agencyBillingGroup.update({
          where: { id: group.id },
          data: { quantity: 0, cancelAtCycleEnd: true },
        });
      } else {
        await this.razorpay.setSubscriptionQuantity(
          group.razorpaySubscriptionId,
          remaining,
          { atCycleEnd: true },
        );
        await this.prisma.agencyBillingGroup.update({
          where: { id: group.id },
          data: { quantity: remaining },
        });
      }
    }

    await this.orgSettings.bumpPayerVersion(ssoOrgId);
  }

  /**
   * Bring a group and every client on it up to date with the provider.
   *
   * Called from the webhook. Without the fan-out a client's period never moves
   * and its access lapses a month after it was taken on, which is the quietest
   * way this could possibly break.
   */
  async applyToGroup(
    razorpaySubscriptionId: string,
    entity: {
      status: string;
      current_start?: number | null;
      current_end?: number | null;
    },
    payment?: {
      razorpayPaymentId: string;
      razorpayInvoiceId: string | null;
      amount: number;
      currency: string;
      status: string;
      method: string | null;
      methodDetail: string | null;
      paidAt: Date | null;
    },
  ): Promise<AppliedGroupCharge | null> {
    const group = await this.prisma.agencyBillingGroup.findUnique({
      where: { razorpaySubscriptionId },
      select: {
        id: true,
        agencyOrgId: true,
        createdByUserId: true,
        plan: { select: { code: true, name: true } },
      },
    });
    if (!group) return null;

    const status = entity.status as never;
    const currentStart = at(entity.current_start);
    const currentEnd = at(entity.current_end);

    await this.prisma.agencyBillingGroup.update({
      where: { id: group.id },
      data: {
        status,
        ...(currentStart ? { currentStart } : {}),
        ...(currentEnd ? { currentEnd } : {}),
      },
    });

    // Every client on it moves together — they are one debit.
    const clients = await this.prisma.subscription.findMany({
      where: { billingGroupId: group.id },
      select: { ssoOrgId: true },
    });
    await this.prisma.subscription.updateMany({
      where: { billingGroupId: group.id },
      data: {
        status,
        ...(currentStart ? { currentStart } : {}),
        ...(currentEnd ? { currentEnd } : {}),
      },
    });

    // Handed back rather than acted on here: what a debit is *worth* — the
    // invoice — is the billing service's business, and this service does not
    // know how to raise one.
    const recorded = payment
      ? await this.prisma.subscriptionPayment.upsert({
          where: { razorpayPaymentId: payment.razorpayPaymentId },
          update: { status: payment.status, paidAt: payment.paidAt },
          create: { ...payment, billingGroupId: group.id },
        })
      : null;

    // Each client's answer changes, and each is cached separately.
    for (const client of clients) {
      await this.access.invalidatePayer(client.ssoOrgId);
    }
    await this.access.invalidatePayer(group.agencyOrgId);

    return {
      billingGroupId: group.id,
      agencyOrgId: group.agencyOrgId,
      userId: group.createdByUserId,
      planCode: group.plan?.code ?? null,
      planName: group.plan?.name ?? null,
      payment: recorded,
      currentStart,
      currentEnd,
    };
  }

  /** The groups an agency holds, for its billing page. */
  async groupsFor(agencyOrgId: string) {
    return this.prisma.agencyBillingGroup.findMany({
      where: { agencyOrgId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        quantity: true,
        status: true,
        currentEnd: true,
        cancelAtCycleEnd: true,
        shortUrl: true,
        razorpaySubscriptionId: true,
        plan: {
          select: { code: true, name: true, price: true, currency: true },
        },
      },
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * The plan, if this agency is allowed to put a client on it.
   *
   * Published tiers, plus anything written privately for this agency. A quoted
   * card is not a product and a tier with no provider plan cannot be debited,
   * so neither is offered.
   */
  private async sellableToAgency(planCode: string, agencyOrgId: string) {
    const plan = await this.prisma.plan.findFirst({
      where: {
        code: planCode,
        active: true,
        OR: [{ ssoOrgId: null }, { ssoOrgId: agencyOrgId }],
      },
      select: {
        id: true,
        code: true,
        name: true,
        ctaKind: true,
        razorpayPlanId: true,
      },
    });
    if (!plan) {
      throw new NotFoundException(`Plan ${planCode} is not on offer`);
    }
    if (plan.ctaKind === 'contact') {
      throw new BadRequestException(
        `${plan.name} is priced individually — it cannot be put on a client here.`,
      );
    }
    if (!plan.razorpayPlanId) {
      throw new BadRequestException(
        `${plan.name} is not available for checkout on this deployment yet.`,
      );
    }
    return { ...plan, razorpayPlanId: plan.razorpayPlanId };
  }

  /**
   * The agency's mandate for a plan, grown by one — or a new one to authorise.
   *
   * A group that is not live cannot be updated: the provider refuses a change
   * to a subscription that is retrying or has stopped. Better to say so than to
   * write an entitlement the money will never arrive for.
   */
  private async groupFor(
    agencyOrgId: string,
    plan: { id: number; name: string; razorpayPlanId: string },
    userId: number,
  ) {
    const existing = await this.prisma.agencyBillingGroup.findUnique({
      where: {
        agencyOrgId_planRefId: { agencyOrgId, planRefId: plan.id },
      },
    });

    if (existing && !this.isFinished(existing.status)) {
      if (existing.cancelAtCycleEnd) {
        throw new BadRequestException(
          `The mandate covering ${plan.name} is set to end. It cannot take on another client until that is sorted out.`,
        );
      }

      // Still waiting to be authorised: nothing has been charged, so rather
      // than refusing the second client until somebody pays for the first, the
      // unpaid mandate is replaced by one for the right number. The agency
      // authorises once, for what it actually wants.
      if (existing.status === 'created') {
        return this.replaceUnauthorised(existing, plan, userId);
      }

      if (!UPDATABLE.includes(existing.status as (typeof UPDATABLE)[number])) {
        throw new BadRequestException(
          `The mandate covering ${plan.name} is ${existing.status}. Sort that out before taking on another client on this plan.`,
        );
      }

      const quantity = existing.quantity + 1;
      const updated = await this.razorpay.setSubscriptionQuantity(
        existing.razorpaySubscriptionId,
        quantity,
      );
      if (!updated) {
        throw new BadRequestException(
          `The payment provider would not raise the ${plan.name} mandate to ${quantity}. Nothing has been changed.`,
        );
      }

      const saved = await this.prisma.agencyBillingGroup.update({
        where: { id: existing.id },
        data: { quantity },
      });
      return { ...saved, authorisationNeeded: false };
    }

    // First client on this plan, or the last mandate for it is finished.
    const customerId = await this.customerFor(agencyOrgId, userId);
    const created = await this.razorpay.createSubscription({
      customerId,
      planId: plan.razorpayPlanId,
      quantity: 1,
      notes: {
        agencyOrgId,
        planCode: plan.name,
        purpose: 'agency-clients',
      },
    });

    const group = await this.prisma.agencyBillingGroup.upsert({
      where: {
        agencyOrgId_planRefId: { agencyOrgId, planRefId: plan.id },
      },
      update: {
        razorpayCustomerId: customerId,
        razorpaySubscriptionId: created.id,
        planId: created.plan_id,
        quantity: 1,
        status: created.status as never,
        currentStart: at(created.current_start),
        currentEnd: at(created.current_end),
        cancelAtCycleEnd: false,
        cancelledAt: null,
        shortUrl: created.short_url ?? null,
      },
      create: {
        agencyOrgId,
        planRefId: plan.id,
        razorpayCustomerId: customerId,
        razorpaySubscriptionId: created.id,
        planId: created.plan_id,
        quantity: 1,
        status: created.status as never,
        currentStart: at(created.current_start),
        currentEnd: at(created.current_end),
        shortUrl: created.short_url ?? null,
        createdByUserId: userId,
      },
    });

    return { ...group, authorisationNeeded: true };
  }

  /**
   * Swap an unauthorised mandate for one covering one more client.
   *
   * The provider will not change the quantity on a subscription nobody has
   * authorised, and refusing the second client until the first is paid for
   * would make taking on three at once impossible. Nothing has been charged
   * yet, so the old one is simply cancelled and a new one created for the
   * number actually wanted.
   */
  private async replaceUnauthorised(
    existing: { id: number; razorpaySubscriptionId: string; quantity: number },
    plan: { id: number; name: string; razorpayPlanId: string },
    userId: number,
  ) {
    const quantity = existing.quantity + 1;
    const customerId = await this.customerFor(
      (
        await this.prisma.agencyBillingGroup.findUniqueOrThrow({
          where: { id: existing.id },
          select: { agencyOrgId: true },
        })
      ).agencyOrgId,
      userId,
    );

    const created = await this.razorpay.createSubscription({
      customerId,
      planId: plan.razorpayPlanId,
      quantity,
      notes: { purpose: 'agency-clients', planCode: plan.name },
    });

    // Only once the replacement exists. The other order can leave an agency
    // with nothing at all if the second call fails.
    await this.razorpay
      .cancelSubscription(existing.razorpaySubscriptionId, false)
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Could not cancel the replaced mandate ${existing.razorpaySubscriptionId}: ${detail}`,
        );
      });

    const saved = await this.prisma.agencyBillingGroup.update({
      where: { id: existing.id },
      data: {
        razorpayCustomerId: customerId,
        razorpaySubscriptionId: created.id,
        planId: created.plan_id,
        quantity,
        status: created.status as never,
        currentStart: at(created.current_start),
        currentEnd: at(created.current_end),
        shortUrl: created.short_url ?? null,
      },
    });
    return { ...saved, authorisationNeeded: true };
  }

  /** One provider customer per agency, so its mandates share a history. */
  private async customerFor(
    agencyOrgId: string,
    userId: number,
  ): Promise<string> {
    const known = await this.prisma.agencyBillingGroup.findFirst({
      where: { agencyOrgId, razorpayCustomerId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { razorpayCustomerId: true },
    });
    if (known?.razorpayCustomerId) return known.razorpayCustomerId;

    const own = await this.prisma.subscription.findFirst({
      where: { ssoOrgId: agencyOrgId, razorpayCustomerId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { razorpayCustomerId: true },
    });
    if (own?.razorpayCustomerId) return own.razorpayCustomerId;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, firstName: true, lastName: true },
    });
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ');

    const created = await this.razorpay.createCustomer({
      ...(name ? { name } : {}),
      ...(user?.email ? { email: user.email } : {}),
      notes: { ssoOrgId: agencyOrgId },
    });
    return created.id;
  }

  private isFinished(status: string): boolean {
    return ['cancelled', 'expired', 'completed', 'superseded'].includes(status);
  }
}
