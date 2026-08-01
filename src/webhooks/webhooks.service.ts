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

/** The display fields the console renders for one stored webhook event. */
interface DescribedEvent {
  kind: WebhookEventKind;
  title: string;
  detail?: string;
  status?: string;
  recipient?: string;
  messageId?: string;
  reason?: string;
}

/** Narrowing helpers — webhook payloads are untrusted and loosely shaped. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** "marketing" → "Marketing", "TIER_1K" → "Tier 1k". */
function humanise(value: string): string {
  const words = value.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A short preview of what the customer actually sent. */
function inboundPreview(
  message: Record<string, unknown>,
  senderName?: string,
): string | undefined {
  const body =
    asString(asObject(message.text)?.body) ??
    asString(asObject(message.button)?.text) ??
    asString(asObject(asObject(message.interactive)?.button_reply)?.title) ??
    asString(asObject(asObject(message.interactive)?.list_reply)?.title) ??
    asString(asObject(message.image)?.caption) ??
    asString(asObject(message.video)?.caption);

  const preview = body && body.length > 140 ? `${body.slice(0, 139)}…` : body;
  return [senderName, preview].filter(Boolean).join(': ') || undefined;
}

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
   * tells an operator nothing. What they want to know is what happened, to
   * which number, and why it failed. Everything below is pulled out into named
   * fields so the console can lay it out rather than parse a sentence back
   * apart.
   *
   * Payloads are untrusted input from a webhook, so every access is narrowed
   * rather than asserted.
   */
  private describeEvent(
    eventType: string,
    payload: unknown,
  ): DescribedEvent {
    const value = asObject(payload) ?? {};

    switch (eventType) {
      case 'messages': {
        const status = asObject(asArray(value.statuses)[0]);
        if (status) return this.describeStatus(status);

        const message = asObject(asArray(value.messages)[0]);
        if (message) {
          const contact = asObject(asArray(value.contacts)[0]);
          const senderName = asString(asObject(contact?.profile)?.name);
          const type = asString(message.type) ?? 'message';
          return {
            kind: 'inbound_message',
            title: type === 'text' ? 'Reply received' : `Inbound ${type}`,
            recipient: asString(message.from),
            messageId: asString(message.id),
            detail: inboundPreview(message, senderName),
          };
        }
        return { kind: 'status_update', title: 'Message event' };
      }

      case 'message_template_status_update': {
        const event = asString(value.event);
        const reason = asString(value.reason);
        return {
          kind: 'template_status',
          title: event ? `Template ${event.toLowerCase()}` : 'Template updated',
          status: event,
          // "NONE" is Meta's no-reason sentinel, not a reason.
          reason: reason && reason.toUpperCase() !== 'NONE' ? reason : undefined,
          detail: [asString(value.message_template_name), asString(value.message_template_language)]
            .filter((part): part is string => part !== undefined)
            .join(' · '),
        };
      }

      case 'phone_number_quality_update': {
        const limit = asString(value.current_limit);
        return {
          kind: 'account_update',
          title: 'Number quality changed',
          status: asString(value.event),
          recipient: asString(value.display_phone_number),
          detail: limit ? `Messaging limit now ${humanise(limit)}` : undefined,
        };
      }

      case 'phone_number_name_update':
        return {
          kind: 'account_update',
          title: 'Display name review',
          status: asString(value.decision),
          recipient: asString(value.display_phone_number),
          detail: asString(value.requested_verified_name),
        };

      case 'account_update': {
        const event = asString(value.event);
        return {
          kind: 'account_update',
          title: event ? `Account ${humanise(event)}` : 'Account updated',
          status: event,
          detail: asString(asObject(value.ban_info)?.waba_ban_state),
        };
      }

      default:
        return { kind: 'account_update', title: eventType.replace(/_/g, ' ') };
    }
  }

  /** A delivery status update: who it was for, and why it failed. */
  private describeStatus(status: Record<string, unknown>): DescribedEvent {
    const state = asString(status.status);
    // Meta reports a failure as an array; the title is the short form
    // ("Message undeliverable") and the details add the specifics.
    const error = asObject(asArray(status.errors)[0]);
    const reason = error
      ? [asString(error.title), asString(asObject(error.error_data)?.details) ?? asString(error.message)]
          .filter((part): part is string => part !== undefined)
          .join(' — ')
      : undefined;

    const category = asString(asObject(asObject(status.conversation)?.origin)?.type);
    const billable = asObject(status.pricing)?.billable;
    const detail = category
      ? billable === false
        ? `${humanise(category)} conversation · free`
        : `${humanise(category)} conversation`
      : undefined;

    return {
      kind: 'status_update',
      title: state ? `Message ${state}` : 'Message status updated',
      status: state,
      recipient: asString(status.recipient_id),
      messageId: asString(status.id),
      reason: reason || undefined,
      detail,
    };
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
