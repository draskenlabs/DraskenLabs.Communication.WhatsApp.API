import { Injectable, Logger } from '@nestjs/common';
import { MessageStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

const STATUS_ORDER: Record<string, number> = {
  sent: 0,
  delivered: 1,
  read: 2,
  failed: 3,
};

@Injectable()
export class StatusUpdateHandler {
  private readonly logger = new Logger(StatusUpdateHandler.name);

  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async handle(statusUpdate: any): Promise<void> {
    const { id: metaMessageId, status } = statusUpdate;

    if (!Object.keys(STATUS_ORDER).includes(status)) {
      this.logger.warn(`Unknown status value: ${status} for message ${metaMessageId}`);
      return;
    }

    try {
      const existing = await this.prisma.message.findUnique({
        where: { metaMessageId },
        select: {
          id: true,
          status: true,
          userId: true,
          to: true,
          deliveredAt: true,
        },
      });

      if (!existing) return;

      // Only advance status forward — never go read → delivered
      if (STATUS_ORDER[status] <= STATUS_ORDER[existing.status]) return;

      const failure = status === 'failed' ? this.failure(statusUpdate) : null;
      const now = new Date();

      await this.prisma.message.update({
        where: { metaMessageId },
        data: {
          status: status as MessageStatus,
          // Stamped per status rather than relying on `updatedAt`, which only
          // holds the most recent change — it cannot say when a message was
          // delivered once it has also been read.
          ...(status === 'delivered' && { deliveredAt: now }),
          // A read implies a delivery Meta may never have reported separately.
          ...(status === 'read' && {
            readAt: now,
            deliveredAt: existing.deliveredAt ?? now,
          }),
          ...(status === 'failed' && {
            failedAt: now,
            failureReason: failure?.title ?? null,
            failureCode: failure?.code ?? null,
            failureDetail: failure?.detail ?? null,
          }),
        },
      });

      // Nothing is sent from here. A failure is recorded and reported in the
      // daily summary instead: a bad campaign fails hundreds of messages in a
      // row, and a push and an email per failure made that a stream of
      // interruptions about something nobody can act on one message at a time.
    } catch (err: any) {
      this.logger.error(`Failed to update status for ${metaMessageId}: ${err.message}`);
    }
  }

  /**
   * Meta's own account of why a send failed, when it gives one.
   *
   * The title is the short label ("Re-engagement message"); `error_data.details`
   * is the sentence that actually tells a sender what went wrong ("more than 24
   * hours have passed since the customer last replied to this number"). Both
   * are kept: the title groups in the analytics, the detail is what the console
   * shows.
   */
  private failure(statusUpdate: unknown): {
    code: number | null;
    title: string | null;
    detail: string | null;
  } | null {
    const { errors } = (statusUpdate ?? {}) as { errors?: unknown };
    if (!Array.isArray(errors) || errors.length === 0) return null;

    const first = (errors[0] ?? {}) as {
      code?: unknown;
      title?: unknown;
      message?: unknown;
      error_data?: { details?: unknown };
    };

    const text = (value: unknown): string | null =>
      typeof value === 'string' && value.trim() ? value.trim() : null;

    return {
      code: typeof first.code === 'number' ? first.code : null,
      title: text(first.title) ?? text(first.message),
      // Meta repeats the title in `message` on some errors, so it is only a
      // detail when it says something the title did not.
      detail:
        text(first.error_data?.details) ??
        (text(first.message) !== text(first.title)
          ? text(first.message)
          : null),
    };
  }
}
