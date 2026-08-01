import { Injectable, Logger } from '@nestjs/common';
import { MessageStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { MailService } from 'src/mail/mail.service';

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
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
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

      const reason =
        status === 'failed' ? this.failureReason(statusUpdate) : null;
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
          ...(status === 'failed' && { failedAt: now, failureReason: reason }),
        },
      });

      // Only a failure is worth interrupting someone for; sent/delivered/read
      // are the happy path and would be constant noise.
      if (status === 'failed') {
        // Queued rather than mailed: a bad campaign can fail hundreds of
        // messages, and that must arrive as one email, not hundreds.
        void this.mail.queueFailedSend(existing.userId, {
          to: existing.to,
          reason,
        });
        await this.notifications.notifyUsers(
          [existing.userId],
          'messageFailed',
          {
            title: 'Message failed to deliver',
            body: reason
              ? `To ${existing.to}: ${reason}`
              : `WhatsApp could not deliver your message to ${existing.to}.`,
            link: `/messages/${existing.id}`,
            data: { kind: 'messageFailed' },
          },
        );
      }
    } catch (err: any) {
      this.logger.error(`Failed to update status for ${metaMessageId}: ${err.message}`);
    }
  }

  /** Meta's own words for why a send failed, when it gives any. */
  private failureReason(statusUpdate: unknown): string | null {
    const { errors } = (statusUpdate ?? {}) as { errors?: unknown };
    if (!Array.isArray(errors) || errors.length === 0) return null;
    const first = errors[0] as { title?: unknown; message?: unknown };
    const text: unknown = first.title ?? first.message;
    return typeof text === 'string' && text.trim() ? text : null;
  }
}
