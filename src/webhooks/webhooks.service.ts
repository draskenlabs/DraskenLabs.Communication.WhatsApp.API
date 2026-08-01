import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { InboundMessageHandler } from './handlers/inbound-message.handler';
import { StatusUpdateHandler } from './handlers/status-update.handler';
import { AccountHandler } from './handlers/account.handler';
import { TemplateStatusHandler } from './handlers/template-status.handler';
import { WebhookConfigDto } from './dto/webhook-config.dto';
import { WebhookEventDto, WebhookEventKind } from './dto/webhook-event.dto';
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
    const waba = await this.prisma.waba.findFirst({ where: { wabaId, ssoOrgId } });
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
      const described = this.describeEvent(e.eventType, e.payload);
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

  /**
   * Turn a stored Meta change payload into something a human can read.
   *
   * The raw payload is all ids — a `wamid` is 60-odd characters of base64 and
   * tells an operator nothing. What they actually want to know is: what
   * happened, to which number, and why it failed. Everything below is pulled
   * out into named fields so the console can lay it out rather than parse a
   * sentence back apart.
   */
  private describeEvent(
    eventType: string,
    payload: unknown,
  ): {
    kind: WebhookEventKind;
    title: string;
    detail?: string;
    status?: string;
    recipient?: string;
    messageId?: string;
    reason?: string;
  } {
    const value = (payload ?? {}) as Record<string, any>;

    switch (eventType) {
      case 'messages': {
        const statuses = value.statuses as any[] | undefined;
        if (statuses?.length) {
          const s = statuses[0];
          const status = typeof s.status === 'string' ? s.status : undefined;
          // Meta reports a failure reason as an array; the title is the short
          // form ("Message undeliverable"), the message adds the detail.
          const err = Array.isArray(s.errors) ? s.errors[0] : undefined;
          const reason = err
            ? [err.title, err.error_data?.details ?? err.message]
                .filter((part: unknown): part is string => typeof part === 'string' && part !== '')
                .join(' — ')
            : undefined;
          return {
            kind: 'status_update',
            title: status ? `Message ${status}` : 'Message status updated',
            status,
            recipient: typeof s.recipient_id === 'string' ? s.recipient_id : undefined,
            messageId: typeof s.id === 'string' ? s.id : undefined,
            reason,
            detail: this.conversationDetail(s),
          };
        }

        const messages = value.messages as any[] | undefined;
        if (messages?.length) {
          const m = messages[0];
          const type = typeof m.type === 'string' ? m.type : 'message';
          const contact = (value.contacts as any[] | undefined)?.[0];
          const senderName = contact?.profile?.name as string | undefined;
          return {
            kind: 'inbound_message',
            title: type === 'text' ? 'Reply received' : `Inbound ${type}`,
            recipient: typeof m.from === 'string' ? m.from : undefined,
            messageId: typeof m.id === 'string' ? m.id : undefined,
            detail: this.inboundDetail(m, senderName),
          };
        }
        return { kind: 'status_update', title: 'Message event' };
      }

      case 'message_template_status_update': {
        const event = typeof value.event === 'string' ? value.event : undefined;
        const name = (value.message_template_name as string) ?? 'Template';
        const reason =
          typeof value.reason === 'string' && value.reason.toUpperCase() !== 'NONE'
            ? value.reason
            : undefined;
        return {
          kind: 'template_status',
          title: event ? `Template ${event.toLowerCase()}` : 'Template updated',
          status: event,
          reason,
          detail: [name, value.message_template_language]
            .filter((part: unknown): part is string => typeof part === 'string' && part !== '')
            .join(' · '),
        };
      }

      case 'phone_number_quality_update':
        return {
          kind: 'account_update',
          title: 'Number quality changed',
          status: (value.event as string) ?? undefined,
          recipient: (value.display_phone_number as string) ?? undefined,
          detail: value.current_limit
            ? `Messaging limit now ${String(value.current_limit).replace(/_/g, ' ').toLowerCase()}`
            : undefined,
        };

      case 'phone_number_name_update':
        return {
          kind: 'account_update',
          title: 'Display name review',
          status: (value.decision as string) ?? undefined,
          recipient: (value.display_phone_number as string) ?? undefined,
          detail: (value.requested_verified_name as string) ?? undefined,
        };

      case 'account_update':
        return {
          kind: 'account_update',
          title: value.event
            ? `Account ${String(value.event).replace(/_/g, ' ').toLowerCase()}`
            : 'Account updated',
          status: (value.event as string) ?? undefined,
          detail: (value.ban_info?.waba_ban_state as string) ?? undefined,
        };

      default:
        return {
          kind: 'account_update',
          title: eventType.replace(/_/g, ' '),
        };
    }
  }

  /** "Marketing conversation" / "Free conversation" from a status payload. */
  private conversationDetail(status: Record<string, any>): string | undefined {
    const category = status.conversation?.origin?.type as string | undefined;
    if (!category) return undefined;
    const readable = category.replace(/_/g, ' ');
    return status.pricing?.billable === false
      ? `${readable} conversation · free`
      : `${readable} conversation`;
  }

  /** A short preview of what the customer actually sent. */
  private inboundDetail(
    message: Record<string, any>,
    senderName?: string,
  ): string | undefined {
    const body =
      (message.text?.body as string | undefined) ??
      (message.button?.text as string | undefined) ??
      (message.interactive?.button_reply?.title as string | undefined) ??
      (message.interactive?.list_reply?.title as string | undefined) ??
      (message.image?.caption as string | undefined) ??
      (message.video?.caption as string | undefined);

    const preview = body ? (body.length > 140 ? `${body.slice(0, 139)}…` : body) : undefined;
    return [senderName, preview].filter(Boolean).join(': ') || undefined;
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
        await this.accountHandler.handleAccountUpdate(value);
        break;
      case 'phone_number_quality_update':
        await this.accountHandler.handlePhoneQualityUpdate(value);
        break;
      case 'phone_number_name_update':
        await this.accountHandler.handlePhoneNameUpdate(value);
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
