import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TemplateStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { normalizeRejectedReason } from 'src/common/utils/rejected-reason';
import { NotificationsService } from 'src/notifications/notifications.service';

const STATUS_MAP: Record<string, TemplateStatus> = {
  PENDING: TemplateStatus.PENDING,
  APPROVED: TemplateStatus.APPROVED,
  REJECTED: TemplateStatus.REJECTED,
  FLAGGED: TemplateStatus.FLAGGED,
  DELETED: TemplateStatus.DELETED,
  DISABLED: TemplateStatus.DISABLED,
  IN_APPEAL: TemplateStatus.IN_APPEAL,
  PAUSED: TemplateStatus.PAUSED,
  PENDING_DELETION: TemplateStatus.PENDING_DELETION,
  // Meta archives a template after 12 months of inactivity and deletes it 28
  // days later; unarchiving restores the previous status.
  ARCHIVED: TemplateStatus.ARCHIVED,
  UNARCHIVED: TemplateStatus.APPROVED,
};

/** How each decision reads to a person, and whether it is worth a push. */
const STATUS_HEADLINE: Partial<Record<TemplateStatus, string>> = {
  APPROVED: 'Template approved',
  REJECTED: 'Template rejected',
  PAUSED: 'Template paused by Meta',
  DISABLED: 'Template disabled by Meta',
  FLAGGED: 'Template flagged for quality',
  ARCHIVED: 'Template archived',
};

@Injectable()
export class TemplateStatusHandler {
  private readonly logger = new Logger(TemplateStatusHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async handle(value: any): Promise<void> {
    const { event, message_template_id, message_template_name, message_template_language, reason } = value;
    const status = STATUS_MAP[event];

    if (!status) {
      this.logger.warn(`Unknown template status event: ${event}`);
      return;
    }

    // Meta sends `reason: "NONE"` on every non-rejection event, so only a
    // normalised, non-null reason represents an actual rejection. An approval
    // supersedes whatever reason a previous rejection left behind.
    const rejectedReason = normalizeRejectedReason(reason);
    const data: Prisma.MessageTemplateUpdateManyMutationInput = { status };
    if (rejectedReason) data.rejectedReason = rejectedReason;
    else if (status === TemplateStatus.APPROVED) data.rejectedReason = null;

    try {
      await this.prisma.messageTemplate.updateMany({
        where: { metaTemplateId: String(message_template_id) },
        data,
      });
      this.logger.log(`Template ${message_template_name}/${message_template_language} → ${status}`);
    } catch (err: any) {
      this.logger.error(`Failed to update template status for ${message_template_id}: ${err.message}`);
    }

    await this.notify(
      String(message_template_id),
      String(message_template_name ?? ''),
      status,
      rejectedReason,
    );
  }

  /**
   * Tell whoever owns the WABA. The template row carries the WABA id, so it is
   * read back rather than taken from the webhook, which does not include one.
   */
  private async notify(
    metaTemplateId: string,
    name: string,
    status: TemplateStatus,
    rejectedReason: string | null,
  ): Promise<void> {
    const headline = STATUS_HEADLINE[status];
    // PENDING and the deletion states are housekeeping, not news.
    if (!headline) return;

    const template = await this.prisma.messageTemplate.findFirst({
      where: { metaTemplateId },
      select: { id: true, wabaId: true, name: true },
    });
    if (!template) return;

    await this.notifications.notifyWaba(template.wabaId, 'templateStatus', {
      title: headline,
      body: rejectedReason
        ? `${template.name || name}: ${rejectedReason}`
        : `${template.name || name} is now ${status.toLowerCase().replace(/_/g, ' ')}.`,
      link: `/templates/${template.id}`,
      data: { wabaId: template.wabaId, kind: 'templateStatus' },
    });
  }
}
