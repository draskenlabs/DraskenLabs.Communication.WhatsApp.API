import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { OrganisationSettingsService } from 'src/organisation-settings/organisation-settings.service';

/**
 * The numbers a plan puts on an organisation.
 *
 * Two kinds sit here and they read `null` differently, which is why the names
 * differ. `included*` is **what the price covers** — beyond it the add-on price
 * applies and nothing is refused, so `null` means nothing is included and
 * everything bills. Everything else is a **ceiling** that refuses, where `null`
 * means no limit.
 */
export interface EffectiveLimits {
  /** Code of the plan these came from, or null when nothing is subscribed. */
  planCode: string | null;
  planName: string | null;

  /* Billable — inclusion counts. */
  includedWabas: number | null;
  includedPhoneNumbersPerWaba: number | null;
  /**
   * Clients an agency plan includes.
   *
   * Sits with the inclusions because the intention is to sell clients by the
   * unit, but it is the one that currently *refuses* — there is no per-client
   * price to charge beyond it, and each client carries a full set of the
   * plan's limits, so an unbounded roster is an unbounded estate on one
   * subscription. `AgencyService.attachClient` enforces it as a ceiling until
   * there is a price to move it back to the other column.
   */
  includedClients: number | null;
  additionalWabaPrice: number | null;
  additionalNumberPrice: number | null;

  /* Ceilings — refuse when reached. */
  teamMembers: number | null;
  webhookEndpoints: number | null;
  apiKeysPerWaba: number | null;
  contacts: number | null;
  messagesPerMinute: number | null;
  historyDays: number | null;
}

/**
 * The `Plan` columns a ceiling can be looked up under.
 *
 * Named as they are in the schema rather than as `EffectiveLimits` renames
 * them, because this is what the upgrade query filters on. Only the ceilings
 * are here: an inclusion is not something a customer can be refused for, so
 * there is no upgrade to point them at.
 */
export type LimitField =
  | 'maxTeamMembers'
  | 'maxWebhookEndpoints'
  | 'maxApiKeysPerWaba'
  | 'maxContacts'
  | 'includedClients';

/** A tier worth suggesting, with the number that makes it worth suggesting. */
export interface PlanOffer {
  code: string;
  name: string;
  /** In paise. Null for a tier with no published amount. */
  price: number | null;
  currency: string;
  unit: string;
  /** What the tier allows of the thing that was refused. Null is no limit. */
  value: number | null;
}

/** "₹999" for 99900 paise. Only the symbol we sell in gets one. */
function formatAmount(paise: number, currency: string): string {
  const amount = (paise / 100).toLocaleString('en-IN', {
    maximumFractionDigits: 2,
  });
  return currency.toUpperCase() === 'INR'
    ? `\u20b9${amount}`
    : `${amount} ${currency.toUpperCase()}`;
}

/** Statuses that mean a subscription is paying for something right now. */
const LIVE_STATUSES = ['active', 'authenticated', 'pending', 'halted'] as const;

const NO_PLAN: EffectiveLimits = {
  planCode: null,
  planName: null,
  includedWabas: null,
  includedPhoneNumbersPerWaba: null,
  includedClients: null,
  additionalWabaPrice: null,
  additionalNumberPrice: null,
  teamMembers: null,
  webhookEndpoints: null,
  apiKeysPerWaba: null,
  contacts: null,
  messagesPerMinute: null,
  historyDays: null,
};

/** The columns every limit answer is built from. */
const PLAN_SELECT = {
  code: true,
  name: true,
  includedWabas: true,
  includedPhoneNumbersPerWaba: true,
  includedClients: true,
  additionalWabaPrice: true,
  additionalNumberPrice: true,
  maxTeamMembers: true,
  maxWebhookEndpoints: true,
  maxApiKeysPerWaba: true,
  maxContacts: true,
  maxMessagesPerMinute: true,
  historyDays: true,
  rank: true,
} as const;

type PlanRow = {
  code: string;
  name: string;
  includedWabas: number | null;
  includedPhoneNumbersPerWaba: number | null;
  includedClients: number | null;
  additionalWabaPrice: number | null;
  additionalNumberPrice: number | null;
  maxTeamMembers: number | null;
  maxWebhookEndpoints: number | null;
  maxApiKeysPerWaba: number | null;
  maxContacts: number | null;
  maxMessagesPerMinute: number | null;
  historyDays: number | null;
  rank: number;
};

/**
 * What an organisation is allowed, according to the plan it pays for.
 *
 * The limits are published on the pricing page, so something has to hold the
 * line — otherwise "5 team members" is a sentence on a card rather than a fact
 * about the product. This is the one place that answers "how many", and every
 * enforcement site asks it rather than keeping a constant of its own.
 *
 * **The payer is resolved first.** An agency buys once and its clients inherit,
 * so a client organisation's limits are its agency's. For everybody else the
 * payer is themselves, which is why the lookup is unconditional.
 *
 * **The best-ranked plan the payer holds wins**, for the ordinary case of an
 * organisation part-way through a change. Rank rather than price: a negotiated
 * plan has no price, and `price ?? 0` sorted the customer paying us most as the
 * cheapest.
 *
 * An organisation with nothing subscribed falls back to the cheapest published
 * plan: it can try the product without being able to exceed what the entry
 * price buys.
 */
@Injectable()
export class PlanLimitsService {
  private readonly logger = new Logger(PlanLimitsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgSettings: OrganisationSettingsService,
  ) {}

  /**
   * Organisation-wide limits: the best tier this organisation is on.
   *
   * **Its own subscription answers first.** An agency that buys a plan for each
   * client gives that client a subscription of its own, and the client is held
   * to what was bought for it — not to whatever the agency happens to hold.
   *
   * Falling back to the payer keeps the older arrangement working: a client
   * attached before per-client subscriptions existed has none of its own and
   * inherits the agency's, exactly as it did. Both shapes are live at once
   * during the move, which is the point of looking in this order.
   */
  async forOrg(ssoOrgId: string): Promise<EffectiveLimits> {
    const own = await this.subscribedPlans(ssoOrgId);
    if (own.length > 0) return this.best(own);

    const payer = await this.orgSettings.billingOrgFor(ssoOrgId);
    const plans = payer === ssoOrgId ? [] : await this.subscribedPlans(payer);
    if (plans.length === 0) return this.entryLimits();

    return this.best(plans);
  }

  /** The plans an organisation is paying for right now, in no order. */
  private async subscribedPlans(ssoOrgId: string): Promise<PlanRow[]> {
    const subs = await this.prisma.subscription.findMany({
      where: {
        ssoOrgId,
        status: { in: [...LIVE_STATUSES] },
        planRefId: { not: null },
      },
      select: { plan: { select: PLAN_SELECT } },
    });
    return subs.map((s) => s.plan).filter((p): p is PlanRow => p !== null);
  }

  /**
   * Best by rank, so a quoted plan — which has no price to compare — is not
   * treated as the cheapest thing the organisation holds.
   */
  private best(plans: PlanRow[]): EffectiveLimits {
    return this.toLimits([...plans].sort((a, b) => b.rank - a.rank)[0]);
  }

  /**
   * Limits for one account.
   *
   * Falls back to the organisation's plan rather than to entry limits: under an
   * organisation-level subscription no WABA has one of its own, and answering
   * "the cheapest published tier" for every account would quietly hold a paying
   * customer to Starter.
   */
  async forWaba(ssoOrgId: string, wabaId: string): Promise<EffectiveLimits> {
    const payer = await this.orgSettings.billingOrgFor(ssoOrgId);

    const sub = await this.prisma.subscription.findUnique({
      where: { wabaId_ssoOrgId: { wabaId, ssoOrgId: payer } },
      select: { status: true, plan: { select: PLAN_SELECT } },
    });

    if (
      !sub?.plan ||
      !LIVE_STATUSES.includes(sub.status as (typeof LIVE_STATUSES)[number])
    ) {
      return this.forOrg(ssoOrgId);
    }
    return this.toLimits(sub.plan);
  }

  /**
   * Refuse an addition that would take a count past its limit.
   *
   * Phrased as what the customer can do about it — a limit that says only
   * "limit reached" leaves somebody guessing whether they can buy their way
   * out of it or have to delete something. When the caller names the column
   * the limit came from, the refusal goes one further and names the cheapest
   * tier that would allow it: "upgrade the plan" is advice nobody can act on
   * without opening the price list and comparing two numbers themselves.
   */
  async assertWithin(
    limits: EffectiveLimits,
    limit: number | null,
    current: number,
    noun: string,
    field?: LimitField,
  ): Promise<void> {
    if (limit === null) return;
    if (current < limit) return;

    const plan = limits.planName ? `The ${limits.planName} plan` : 'Your plan';
    const held = `${plan} includes ${limit} ${noun}${limit === 1 ? '' : 's'}, and you have ${current}.`;

    throw new BadRequestException(
      `${held} ${await this.wayOut(field, current + 1, noun)}`,
    );
  }

  /**
   * What to do about a limit, in the customer's own terms.
   *
   * The cheapest tier that would actually take the addition, named with its
   * price — or, when nothing published would, the plain truth that no upgrade
   * fixes this one. Both beat "upgrade the plan", which is only useful to
   * somebody who already knows which tier to upgrade to.
   */
  private async wayOut(
    field: LimitField | undefined,
    need: number,
    noun: string,
  ): Promise<string> {
    const upgrade = field ? await this.cheapestPlanAllowing(field, need) : null;
    if (!upgrade)
      return 'Upgrade the plan or remove one before adding another.';

    const allows =
      upgrade.value === null
        ? `any number of ${noun}s`
        : `${upgrade.value} ${noun}${upgrade.value === 1 ? '' : 's'}`;
    const price =
      upgrade.price === null
        ? ''
        : ` (${formatAmount(upgrade.price, upgrade.currency)}${upgrade.unit})`;

    return (
      `${upgrade.name}${price} includes ${allows} — ` +
      `move to it from your subscription page, or remove one before adding another.`
    );
  }

  /**
   * The cheapest published tier whose ceiling would take `need`.
   *
   * Published and sellable only. A negotiated plan is somebody else's
   * contract, and pointing a customer at a tier this deployment cannot charge
   * for is an upgrade they would be refused at checkout — the same dead end
   * that made the refusal worth rewriting in the first place.
   *
   * `null` in the column is no limit, which allows anything, so those sort
   * last and win only when no finite tier is large enough.
   */
  async cheapestPlanAllowing(
    field: LimitField,
    need: number,
  ): Promise<PlanOffer | null> {
    try {
      return await this.lookUpPlanAllowing(field, need);
    } catch (err: unknown) {
      // Advisory only. The refusal is what the caller asked for and it is
      // already correct; a price list that could not be read turns the
      // sentence after it back into the generic one rather than turning a
      // clean 400 into a 500.
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not suggest a plan for ${field}: ${detail}`);
      return null;
    }
  }

  private async lookUpPlanAllowing(
    field: LimitField,
    need: number,
  ): Promise<PlanOffer | null> {
    const candidates = await this.prisma.plan.findMany({
      where: {
        active: true,
        ssoOrgId: null,
        ctaKind: 'subscribe',
        razorpayPlanId: { not: null },
        OR: [{ [field]: null }, { [field]: { gte: need } }],
      },
      select: {
        code: true,
        name: true,
        price: true,
        currency: true,
        unit: true,
        [field]: true,
      },
      orderBy: [{ price: 'asc' }],
    });

    const rows = candidates as unknown as (PlanOffer & {
      [key: string]: unknown;
    })[];
    // A finite allowance beats an unlimited one at the same price: it is the
    // smaller step, and the customer asked for room rather than for infinity.
    const ordered = rows.sort((a, b) => {
      const av = a[field] === null ? 1 : 0;
      const bv = b[field] === null ? 1 : 0;
      if (av !== bv) return av - bv;
      return (a.price ?? 0) - (b.price ?? 0);
    });

    const best = ordered[0];
    if (!best) return null;
    return {
      code: best.code,
      name: best.name,
      price: best.price,
      currency: best.currency,
      unit: best.unit,
      value: (best[field] as number | null) ?? null,
    };
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
      // Published tiers only: a negotiated plan is not an entry price, and
      // taking limits from somebody else's contract would be nonsense.
      where: { active: true, price: { not: null }, ssoOrgId: null },
      orderBy: { price: 'asc' },
      select: PLAN_SELECT,
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

  private toLimits(plan: PlanRow): EffectiveLimits {
    return {
      planCode: plan.code,
      planName: plan.name,
      includedWabas: plan.includedWabas,
      includedPhoneNumbersPerWaba: plan.includedPhoneNumbersPerWaba,
      includedClients: plan.includedClients,
      additionalWabaPrice: plan.additionalWabaPrice,
      additionalNumberPrice: plan.additionalNumberPrice,
      teamMembers: plan.maxTeamMembers,
      webhookEndpoints: plan.maxWebhookEndpoints,
      apiKeysPerWaba: plan.maxApiKeysPerWaba,
      contacts: plan.maxContacts,
      messagesPerMinute: plan.maxMessagesPerMinute,
      historyDays: plan.historyDays,
    };
  }
}
