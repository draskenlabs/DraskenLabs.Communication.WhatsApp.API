import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Wires each published tier to the Razorpay plan that charges for it.
 *
 * The price list is seeded by a migration, but a Razorpay plan id is not
 * something a migration can know: they differ between test and live accounts,
 * and an id from the wrong one bills nothing. So the mapping is configuration,
 * applied at boot from `RAZORPAY_PLAN_IDS`:
 *
 *     RAZORPAY_PLAN_IDS=starter:plan_abc,growth:plan_def,business:plan_ghi
 *
 * A code with no entry keeps whatever it has, so a partially configured
 * deployment sells the tiers it can and refuses the rest by name rather than
 * charging the wrong amount. Anything that is not on the price list is logged
 * and ignored — a typo in an env var must not stop the API booting.
 */
@Injectable()
export class PlanSyncService implements OnModuleInit {
  private readonly logger = new Logger(PlanSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.sync();
  }

  /** Apply the configured mapping. Returns how many rows it changed. */
  async sync(): Promise<number> {
    const raw = this.config.get<string>('RAZORPAY_PLAN_IDS');
    const mapping = PlanSyncService.parse(raw);
    if (mapping.size === 0) return 0;

    let updated = 0;
    for (const [code, razorpayPlanId] of mapping) {
      try {
        const result = await this.prisma.plan.updateMany({
          where: { code, NOT: { razorpayPlanId } },
          data: { razorpayPlanId },
        });
        if (result.count === 0) {
          // Either already correct, or the code is not a plan we publish.
          const exists = await this.prisma.plan.count({ where: { code } });
          if (exists === 0) {
            this.logger.warn(
              `RAZORPAY_PLAN_IDS names "${code}", which is not a plan`,
            );
          }
          continue;
        }
        updated += result.count;
        this.logger.log(`Plan ${code} now sells against ${razorpayPlanId}`);
      } catch (err: unknown) {
        // A duplicate id is the one that matters: two tiers pointing at one
        // Razorpay plan would bill the same amount whatever the price list
        // said, and the unique index is what stops it.
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Could not map plan ${code} to ${razorpayPlanId}: ${detail}`,
        );
      }
    }
    return updated;
  }

  /** `"starter:plan_a, growth:plan_b"` → a map. Whitespace and blanks ignored. */
  static parse(raw: string | undefined): Map<string, string> {
    const mapping = new Map<string, string>();
    if (!raw) return mapping;

    for (const entry of raw.split(',')) {
      const [code, planId] = entry.split(':').map((part) => part?.trim());
      if (!code || !planId) continue;
      mapping.set(code.toLowerCase(), planId);
    }
    return mapping;
  }
}
