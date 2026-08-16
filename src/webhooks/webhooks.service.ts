import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { InboundMessageHandler } from './handlers/inbound-message.handler';
import { StatusUpdateHandler } from './handlers/status-update.handler';
import { AccountHandler } from './handlers/account.handler';
import { TemplateStatusHandler } from './handlers/template-status.handler';
import { WebhookConfigDto } from './dto/webhook-config.dto';
import { WebhookEventDto } from './dto/webhook-event.dto';
import { describeEvent } from './event-describer';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { BaseResponse } from 'src/common/responses/base-response';

/** Meta change fields this server subscribes to and handles. */
const SUBSCRIBED_FIELDS = [
  'messages',
  'message_template_status_update',
  'account_update',
  'phone_number_quality_update',
  'phone_number_name_update',
];

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly inboundHandler: InboundMessageHandler,
    private readonly statusHandler: StatusUpdateHandler,
    private readonly accountHandler: AccountHandler,
    private readonly templateStatusHandler: TemplateStatusHandler,
    private readonly dispatcher: WebhookDispatcherService,
  ) {}

  getConfig(callbackUrl: string): WebhookConfigDto {
    const verifyTokenConfigured = !!this.config.get<string>('WEBHOOK_VERIFY_TOKEN');
    return {
      callbackUrl,
      subscribed: verifyTokenConfigured,
      signatureHeader: 'X-Hub-Signature-256',
      fields: SUBSCRIBED_FIELDS,
      verifyTokenConfigured,
    };
  }

  async getRecentEvents(
    ssoOrgId: string,
    wabaId: string,
    opts: { page?: number; limit?: number } = {},
  ): Promise<BaseResponse<WebhookEventDto[]>> {
    // Authorise: the WABA must belong to the caller's organisation.
    const waba = await this.prisma.waba.findFirst({
      where: { wabaId, WabaOrganisation: { some: { ssoOrgId } } },
    });
    if (!waba) throw new ForbiddenException('WABA does not belong to your organisation');

    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const where = { wabaId };
    const [events, total] = await this.prisma.$transaction([
      this.prisma.webhookEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.webhookEvent.count({ where }),
    ]);

    const data = events.map((e) => {
      const described = describeEvent(e.eventType, e.payload);
      return {
        id: e.id,
        eventType: e.eventType,
        ...described,
        wabaId: e.wabaId,
        processed: e.processed,
        error: e.error ?? undefined,
        createdAt: e.createdAt,
      };
    });

    const totalPages = Math.ceil(total / limit);
    return BaseResponse.paginate(data, total, totalPages, page, limit);
  }

  async processPayload(body: any): Promise<void> {
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry ?? []) {
      const wabaId: string = entry.id;

      for (const change of entry.changes ?? []) {
        const { field, value } = change;

        const event = await this.prisma.webhookEvent.create({
          data: { eventType: field, wabaId, payload: value, processed: false },
        });

        try {
          await this.routeChange(field, wabaId, value);
          await this.prisma.webhookEvent.update({
            where: { id: event.id },
            data: { processed: true },
          });
        } catch (err: any) {
          this.logger.error(`Error processing webhook event ${event.id}: ${err.message}`);
          await this.prisma.webhookEvent.update({
            where: { id: event.id },
            data: { error: err.message },
          });
        }

        // Forwarded whether or not our own handler succeeded. The customer's
        // integration is subscribed to what Meta said, and a failure to write
        // our copy of a message is our problem, not a reason to withhold the
        // event from them. Queued, never posted here: this runs inside the
        // 200 we already sent Meta.
        await this.dispatcher.enqueue(
          wabaId,
          event.id,
          field,
          describeEvent(field, value),
          value,
        );
      }
    }
  }

  private async routeChange(field: string, wabaId: string, value: any): Promise<void> {
    switch (field) {
      case 'messages':
        await this.handleMessagesField(wabaId, value);
        break;
      case 'message_template_status_update':
        await this.templateStatusHandler.handle(value);
        break;
      case 'account_update':
        await this.accountHandler.handleAccountUpdate(value, wabaId);
        break;
      case 'phone_number_quality_update':
        await this.accountHandler.handlePhoneQualityUpdate(value, wabaId);
        break;
      case 'phone_number_name_update':
        await this.accountHandler.handlePhoneNameUpdate(value, wabaId);
        break;
      default:
        this.logger.log(`Unhandled webhook field: ${field}`);
    }
  }

  private async handleMessagesField(wabaId: string, value: any): Promise<void> {
    const phoneNumberId: string = value.metadata?.phone_number_id ?? '';
    const senderName: string | undefined = value.contacts?.[0]?.profile?.name;

    for (const message of value.messages ?? []) {
      await this.inboundHandler.handle(wabaId, phoneNumberId, message, senderName);
    }

    for (const status of value.statuses ?? []) {
      await this.statusHandler.handle(status);
    }

    for (const error of value.errors ?? []) {
      this.logger.error(`Webhook error from Meta: code=${error.code} title=${error.title}`);
    }
  }
}
