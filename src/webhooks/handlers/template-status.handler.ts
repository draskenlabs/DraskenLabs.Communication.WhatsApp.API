import { Injectable, Logger } from '@nestjs/common';
import { TemplateStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

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
};

@Injectable()
export class TemplateStatusHandler {
  private readonly logger = new Logger(TemplateStatusHandler.name);

  constructor(private readonly prisma: PrismaService) {}

  async handle(value: any): Promise<void> {
    const { event, message_template_id, message_template_name, message_template_language, reason } = value;
    const status = STATUS_MAP[event];

    if (!status) {
      this.logger.warn(`Unknown template status event: ${event}`);
      return;
    }

    try {
      await this.prisma.messageTemplate.updateMany({
        where: { metaTemplateId: String(message_template_id) },
        data: {
          status,
          ...(reason && reason !== 'NONE' ? { rejectedReason: reason } : {}),
        },
      });
      this.logger.log(`Template ${message_template_name}/${message_template_language} → ${status}`);
    } catch (err: any) {
      this.logger.error(`Failed to update template status for ${message_template_id}: ${err.message}`);
    }
  }
}
