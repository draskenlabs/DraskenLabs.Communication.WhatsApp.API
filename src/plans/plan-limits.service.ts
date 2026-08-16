import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

/** The numbers a plan puts on an organisation. Null is "no limit". */
export interface EffectiveLimits {
  /** Code of the plan these came from, or null when nothing is subscribed. */
  planCode: string | null;
  planName: string | null;
  wabas: number | null;
  phoneNumbersPerWaba: number | null;
  teamMembers: number | null;
  webhookEndpoints: number | null;
  historyDays: number | null;
}

/** Statuses that mean a subscription is paying for something right now. */
const LIVE_STATUSES = ['active', 'authenticated', 'pending', 'halted'] as const;

const NO_PLAN: EffectiveLimits = {
  planCode: null,
  planName: null,
  wabas: null,
  phoneNumbersPerWaba: null,
  teamMembers: null,
  webhookEndpoints: null,
  historyDays: null,
};

/**
 * What an organisation is allowed, according to the plan it pays for.
 *
 * The limits are published on the pricing page, so something has to hold the
 * line — otherwise "5 team members" is a sentence on a card rather than a fact
 * about the product. This is the one place that answers "how many", and every
 * enforcement site asks it rather than keeping a constant of its own.
 *
 * **The best tier the organisation holds wins.** Subscriptions are per WABA, so
 * an organisation running one account on Growth and another on Starter is a
 * Growth customer for anything organisation-wide (accounts, members). Anything
 * per account — numbers, endpoints — is measured against that account's own
 * plan, because that is the subscription being paid for.
 *
 * An organisation with nothing subscribed falls back to the cheapest published
 * plan: it can try the product without being able to exceed what the entry
 * price buys.
 */
@Injectable()
export class PlanLimitsService {
  private readonly logger = new Logger(PlanLimitsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Organisation-wide limits: the best tier anything is subscribed on. */
  async forOrg(ssoOrgId: string): Promise<EffectiveLimits> {
    const subs = await this.prisma.subscription.findMany({
      where: {
        ssoOrgId,
        status: { in: [...LIVE_STATUSES] },
        planRefId: { not: null },
      },
      select: { plan: true },
    });

    const plans = subs.map((s) => s.plan).filter((p) => p !== null);
    if (plans.length === 0) return this.entryLimits();

    // "Best" by price, so an organisation is never held to a cheaper tier it
    // also happens to hold.
    const best = plans.sort((a, b) => (b.price ?? 0) - (a.price ?? 0))[0];
    return this.toLimits(best);
  }

  /** Limits for one account, from the subscription that pays for it. */
  async forWaba(ssoOrgId: string, wabaId: string): Promise<EffectiveLimits> {
    const sub = await this.prisma.subscription.findUnique({
      where: { wabaId_ssoOrgId: { wabaId, ssoOrgId } },
      select: { status: true, plan: true },
    });

    if (
      !sub?.plan ||
      !LIVE_STATUSES.includes(sub.status as (typeof LIVE_STATUSES)[number])
    ) {
      return this.entryLimits();
    }
    return this.toLimits(sub.plan);
  }

  /**
   * Refuse an addition that would take a count past its limit.
   *
   * Phrased as what the customer can do about it — a limit that says only
   * "limit reached" leaves somebody guessing whether they can buy their way
   * out of it or have to delete something.
   */
  assertWithin(
    limits: EffectiveLimits,
    limit: number | null,
    current: number,
    noun: string,
  ): void {
    if (limit === null) return;
    if (current < limit) return;

    const plan = limits.planName ? `The ${limits.planName} plan` : 'Your plan';
    throw new BadRequestException(
      `${plan} includes ${limit} ${noun}${limit === 1 ? '' : 's'}, and you have ${current}. ` +
        'Upgrade the plan or remove one before adding another.',
    );
  }

  /**
   * The cheapest published plan's limits.
   *
   * The floor for anyone not paying yet. If the price list is empty — a
   * deployment that has not seeded one — nothing is limited, because inventing
   * a number here would lock people out of a product that never sold them a
   * plan.
   */
  private async entryLimits(): Promise<EffectiveLimits> {
    const entry = await this.prisma.plan.findFirst({
      where: { active: true, price: { not: null } },
      orderBy: { price: 'asc' },
    });
    if (!entry) {
      this.logger.warn(
        'No published plan to take limits from; nothing is limited',
      );
      return NO_PLAN;
    }
    // Named as the floor it is, not as a plan they are on.
    return { ...this.toLimits(entry), planCode: null, planName: null };
  }

  private toLimits(plan: {
    code: string;
    name: string;
    maxWabas: number | null;
    maxPhoneNumbersPerWaba: number | null;
    maxTeamMembers: number | null;
    maxWebhookEndpoints: number | null;
    historyDays: number | null;
  }): EffectiveLimits {
    return {
      planCode: plan.code,
      planName: plan.name,
      wabas: plan.maxWabas,
      phoneNumbersPerWaba: plan.maxPhoneNumbersPerWaba,
      teamMembers: plan.maxTeamMembers,
      webhookEndpoints: plan.maxWebhookEndpoints,
      historyDays: plan.historyDays,
    };
  }
}
