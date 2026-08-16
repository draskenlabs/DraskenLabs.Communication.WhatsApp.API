import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { PlanDto } from './dto/plan.dto';

/** The row shape the mapper needs — the query below selects exactly this. */
interface PlanRow {
  code: string;
  name: string;
  audience: string;
  price: number | null;
  priceLabel: string | null;
  currency: string;
  unit: string;
  additionalNumberPrice: number | null;
  maxWabas: number | null;
  maxPhoneNumbersPerWaba: number | null;
  maxTeamMembers: number | null;
  maxWebhookEndpoints: number | null;
  historyDays: number | null;
  recommended: boolean;
  ctaKind: string;
  ctaLabel: string;
  razorpayPlanId: string | null;
  inherits: { code: string } | null;
  features: { label: string }[];
}

/**
 * The published price list.
 *
 * Read-only and unauthenticated: a price list nobody can read without an
 * account is not a price list. Deliberately separate from `BillingService`,
 * which sells a subscription against a Razorpay plan — this answers "what is
 * on offer", that one answers "what has this account paid for".
 */
@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  /** What the pricing page renders: active plans, in published order. */
  async findAll(): Promise<PlanDto[]> {
    const plans = await this.prisma.plan.findMany({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
      select: this.selection,
    });
    return plans.map((plan) => this.toDto(plan));
  }

  async findByCode(code: string): Promise<PlanDto> {
    const plan = await this.prisma.plan.findFirst({
      where: { code, active: true },
      select: this.selection,
    });
    if (!plan) throw new NotFoundException(`Plan ${code} not found`);
    return this.toDto(plan);
  }

  /**
   * Everything the console is told about a plan — and nothing else.
   *
   * `razorpayPlanId` is read but never sent: the browser is told whether a
   * tier can be bought, not the provider's identifier for it, and a plan id in
   * a public payload is one more thing to keep consistent between test and
   * live accounts.
   */
  private readonly selection = {
    code: true,
    name: true,
    audience: true,
    price: true,
    priceLabel: true,
    currency: true,
    unit: true,
    additionalNumberPrice: true,
    maxWabas: true,
    maxPhoneNumbersPerWaba: true,
    maxTeamMembers: true,
    maxWebhookEndpoints: true,
    historyDays: true,
    recommended: true,
    ctaKind: true,
    ctaLabel: true,
    // Read to answer "can this be bought", never sent on.
    razorpayPlanId: true,
    inherits: { select: { code: true } },
    features: {
      orderBy: { sortOrder: 'asc' as const },
      select: { label: true },
    },
  };

  private toDto(plan: PlanRow): PlanDto {
    return {
      code: plan.code,
      name: plan.name,
      audience: plan.audience,
      price: plan.price,
      priceLabel: plan.priceLabel,
      currency: plan.currency,
      unit: plan.unit,
      additionalNumberPrice: plan.additionalNumberPrice,
      limits: {
        wabas: plan.maxWabas,
        phoneNumbersPerWaba: plan.maxPhoneNumbersPerWaba,
        teamMembers: plan.maxTeamMembers,
        webhookEndpoints: plan.maxWebhookEndpoints,
        historyDays: plan.historyDays,
      },
      features: plan.features.map((feature) => feature.label),
      inherits: plan.inherits?.code ?? null,
      recommended: plan.recommended,
      ctaKind: plan.ctaKind,
      ctaLabel: plan.ctaLabel,
      // The id itself stays here; only the yes/no goes out.
      available: plan.ctaKind === 'subscribe' && !!plan.razorpayPlanId,
    };
  }
}
