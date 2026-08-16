import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';

/**
 * How long raw Meta envelopes are kept, in days.
 *
 * 30 is what the published Privacy Policy promises for webhook events, so this
 * is the policy in code rather than a tuning knob. The delivery log follows the
 * same window: it holds the same payloads, forwarded.
 */
const DEFAULT_EVENT_RETENTION_DAYS = 30;

/** Rows per statement, so a first sweep cannot hold locks for minutes. */
const BATCH = 5_000;

/** How many batches one table gets per pass, as a runaway guard. */
const MAX_BATCHES = 20;

function cutoff(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Deleting what we said we would not keep.
 *
 * Two promises were being made and not kept: the Privacy Policy says raw
 * webhook events are held for 30 days, and every plan on the pricing page names
 * a message-history window. Nothing deleted anything, so both were sentences
 * rather than facts about the product.
 *
 * Message history is the destructive half — it is the customer's own record of
 * what they sent — so it is off unless a deployment sets
 * `PLAN_RETENTION_ENFORCED=true`, and it logs what it *would* delete until then.
 * The webhook halves are our own operational logs and run by default.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);
  private readonly eventDays: number;
  private readonly enforcePlanRetention: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly limits: PlanLimitsService,
  ) {
    this.eventDays = Number(
      this.config.get<string>('WEBHOOK_EVENT_RETENTION_DAYS') ??
        DEFAULT_EVENT_RETENTION_DAYS,
    );
    this.enforcePlanRetention =
      String(this.config.get<string>('PLAN_RETENTION_ENFORCED') ?? 'false') ===
      'true';
  }

  /** One nightly pass. Returns what it deleted, for the log line. */
  async sweep(): Promise<{
    events: number;
    deliveries: number;
    messages: number;
    inbound: number;
  }> {
    const before = cutoff(this.eventDays);

    // Deliveries first: each row points at an event, and dropping the event
    // under it would only null the link and leave the row behind.
    const deliveries = await this.deleteBatched(
      (limit) => Prisma.sql`
        DELETE FROM "WebhookDelivery"
        WHERE "id" IN (
          SELECT "id" FROM "WebhookDelivery"
          WHERE "createdAt" < ${before}
            AND "status" IN ('sent', 'abandoned')
          LIMIT ${limit}
        )`,
    );

    const events = await this.deleteBatched(
      (limit) => Prisma.sql`
        DELETE FROM "WebhookEvent"
        WHERE "id" IN (
          SELECT "id" FROM "WebhookEvent"
          WHERE "createdAt" < ${before}
          LIMIT ${limit}
        )`,
    );

    const history = await this.sweepMessageHistory();
    return { events, deliveries, ...history };
  }

  /**
   * Message history, per the plan each organisation is on.
   *
   * Organisation by organisation, because the window belongs to a plan and
   * plans are bought per organisation — one global cutoff would delete a
   * Business customer's year at Starter's thirty days.
   */
  private async sweepMessageHistory(): Promise<{
    messages: number;
    inbound: number;
  }> {
    const orgs = await this.prisma.wabaOrganisation.findMany({
      distinct: ['ssoOrgId'],
      select: { ssoOrgId: true },
    });

    let messages = 0;
    let inbound = 0;

    for (const { ssoOrgId } of orgs) {
      const limits = await this.limits.forOrg(ssoOrgId);
      // No window on the plan means keep it. Agency's retention is negotiated,
      // and a missing number must never be read as "delete everything".
      if (!limits.historyDays) continue;

      const before = cutoff(limits.historyDays);
      const where = {
        outbound: { ssoOrgId, createdAt: { lt: before } },
        inbound: {
          waba: { WabaOrganisation: { some: { ssoOrgId } } },
          createdAt: { lt: before },
        },
      };

      if (!this.enforcePlanRetention) {
        const [out, into] = await Promise.all([
          this.prisma.message.count({ where: where.outbound }),
          this.prisma.inboundMessage.count({ where: where.inbound }),
        ]);
        if (out || into) {
          this.logger.log(
            `Retention (dry run): ${ssoOrgId} would drop ${out} sent and ${into} ` +
              `received messages older than ${limits.historyDays} days. ` +
              'Set PLAN_RETENTION_ENFORCED=true to apply it.',
          );
        }
        continue;
      }

      messages += (
        await this.prisma.message.deleteMany({ where: where.outbound })
      ).count;
      inbound += (
        await this.prisma.inboundMessage.deleteMany({ where: where.inbound })
      ).count;
    }

    return { messages, inbound };
  }

  /**
   * Delete in bounded batches until a pass finds fewer rows than it asked for.
   *
   * The first sweep on a database that never had one can face millions of rows,
   * and one statement over all of them holds locks for as long as it takes.
   * `deleteMany` cannot be limited, so this is raw SQL with a subquery.
   */
  private async deleteBatched(
    statement: (limit: number) => Prisma.Sql,
  ): Promise<number> {
    let deleted = 0;
    for (let pass = 0; pass < MAX_BATCHES; pass++) {
      const count = await this.prisma.$executeRaw(statement(BATCH));
      deleted += count;
      if (count < BATCH) break;
    }
    return deleted;
  }
}
