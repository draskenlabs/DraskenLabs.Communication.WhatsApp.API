import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import type { AdminActor } from './admin.guard';

export interface AuditEntry {
  action: string;
  targetType: 'organisation' | 'plan' | 'user';
  targetId: string;
  summary: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
}

/**
 * A record of everything an operator changed.
 *
 * Written for every mutation the console makes, because the questions this
 * answers only ever get asked afterwards: who turned this customer's limit up,
 * who made that organisation an agency, who granted this person admin. Without
 * it those have no answer at all — the change is simply in the database, with
 * nothing saying it was ever made.
 *
 * Recording it is not allowed to fail the action it describes. An action that
 * succeeded and was not recorded is a gap in the log; an action refused because
 * the log was unavailable is a broken console, and the operator retries and
 * risks doing it twice. So a failure here is logged loudly and swallowed.
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(actor: AdminActor, entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.adminAuditLog.create({
        data: {
          actorUserId: actor.id,
          // Copied, not joined: the row has to keep naming who did it after
          // the account is gone, which is when somebody comes looking.
          actorEmail: actor.email,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          summary: entry.summary,
          before: entry.before,
          after: entry.after,
        },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Could not record ${entry.action} on ${entry.targetType} ${entry.targetId} by user ${actor.id}: ${detail}`,
      );
    }
  }
}
