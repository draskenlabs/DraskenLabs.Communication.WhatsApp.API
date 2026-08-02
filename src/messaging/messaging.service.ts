import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { Message } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { ContactsService } from 'src/contacts/contacts.service';
import { BillingService } from 'src/billing/billing.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import {
  isMetaAuthFailure,
  metaErrorMessage,
} from 'src/common/utils/meta-error';
import { SendMessageDto, MessageTypeEnum, InteractiveTypeEnum } from './dto/send-message.dto';
import { SendMessageResponseDto, MessageListItemDto } from './dto/message-response.dto';
import { MessageAnalyticsDto } from './dto/message-analytics.dto';
import { BaseResponse } from 'src/common/responses/base-response';

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);
  private readonly metaApiVersion = 'v21.0';

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly encryptionService: EncryptionService,
    private readonly contactsService: ContactsService,
    private readonly mail: MailNotifications,
    private readonly billing: BillingService,
  ) {}

  /**
   * @param scopedWabaId The WABA an API key is limited to, when the caller
   * authenticated with one. Undefined for console requests, where the user
   * chooses the account in the interface and every account is theirs to use.
   */
  async sendMessage(
    userId: number,
    ssoOrgId: string,
    dto: SendMessageDto,
    scopedWabaId?: string,
  ): Promise<SendMessageResponseDto> {
    const phoneCache = await this.redisService.getPhoneCache(dto.phoneNumberId);

    if (!phoneCache) {
      throw new NotFoundException(
        `Phone number ${dto.phoneNumberId} not found. Run a phone sync first.`,
      );
    }

    if (phoneCache.userId !== userId) {
      throw new ForbiddenException('Phone number does not belong to your account');
    }

    // The number decides the WABA, so without this a key issued for one
    // account could send from any number the organisation owns.
    if (scopedWabaId && phoneCache.wabaId !== scopedWabaId) {
      throw new ForbiddenException(
        `Phone number ${dto.phoneNumberId} belongs to WABA ${phoneCache.wabaId}; this API key is scoped to ${scopedWabaId}`,
      );
    }

    // Sending is what the subscription buys, whoever is asking. The API-key
    // middleware has already checked this for its own path; the console
    // reaches here without passing it, and must not be a free way to send.
    await this.billing.requireAccess(ssoOrgId, phoneCache.wabaId);

    const optedOut = await this.contactsService.isOptedOut(ssoOrgId, dto.to);
    if (optedOut) throw new BadRequestException(`Recipient ${dto.to} has opted out of messages`);

    const plainToken = this.encryptionService.decrypt(phoneCache.accessToken);
    const metaPayload = this.buildMetaPayload(dto);

    let metaMessageId: string | undefined;
    try {
      const metaResponse = await axios.post(
        `https://graph.facebook.com/${this.metaApiVersion}/${dto.phoneNumberId}/messages`,
        metaPayload,
        {
          headers: {
            Authorization: `Bearer ${plainToken}`,
            'Content-Type': 'application/json',
          },
        },
      );
      metaMessageId = metaResponse.data?.messages?.[0]?.id;
    } catch (err: any) {
      const metaMessage = this.logMetaError(
        `Meta send failed for ${dto.type} to ${dto.to} on phone ${dto.phoneNumberId}`,
        err,
        phoneCache.wabaId,
      );
      throw new BadRequestException(metaMessage || 'Failed to send message');
    }

    const message = await this.prisma.message.create({
      data: {
        metaMessageId,
        phoneNumberId: dto.phoneNumberId,
        to: dto.to,
        type: dto.type,
        payload: metaPayload as object,
        status: 'sent',
        userId,
        ssoOrgId,
        // Denormalised out of the payload: per-template reporting cannot scan
        // a JSON column, and this is the only moment the name is known cheaply.
        templateName:
          dto.type === MessageTypeEnum.template
            ? (dto.templateName ?? null)
            : null,
      },
    });

    return {
      id: message.id,
      metaMessageId: message.metaMessageId ?? undefined,
      phoneNumberId: message.phoneNumberId,
      to: message.to,
      type: message.type,
      status: message.status,
      createdAt: message.createdAt,
    };
  }

  /**
   * The numbers a WABA-scoped caller may see.
   *
   * Messages carry a phone number and not a WABA, so the scope has to be
   * resolved into numbers before it can be applied — the same shape the
   * analytics module uses for its WABA filter.
   */
  private async scopedNumbers(wabaId: string): Promise<string[]> {
    const numbers = await this.prisma.wabaPhoneNumber.findMany({
      where: { wabaId },
      select: { phoneNumberId: true },
    });
    return numbers.map((n) => n.phoneNumberId);
  }

  async findAll(
    ssoOrgId: string,
    opts: { page?: number; limit?: number } = {},
    scopedWabaId?: string,
  ): Promise<BaseResponse<MessageListItemDto[]>> {
    // A key that can only send from one account has no business reading the
    // rest of the organisation's traffic.
    const where = scopedWabaId
      ? { ssoOrgId, phoneNumberId: { in: await this.scopedNumbers(scopedWabaId) } }
      : { ssoOrgId };

    // Paginate only when asked (keeps existing API-key clients that pull the
    // full history unaffected); otherwise return every message.
    if (opts.page !== undefined || opts.limit !== undefined) {
      const page = Math.max(1, opts.page ?? 1);
      const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
      const [rows, total] = await this.prisma.$transaction([
        this.prisma.message.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.message.count({ where }),
      ]);
      const totalPages = Math.ceil(total / limit);
      return BaseResponse.paginate(rows.map(this.toListItem), total, totalPages, page, limit);
    }

    const messages = await this.prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    return BaseResponse.success(messages.map(this.toListItem));
  }

  private toListItem(m: Message): MessageListItemDto {
    return {
      id: m.id,
      metaMessageId: m.metaMessageId ?? undefined,
      phoneNumberId: m.phoneNumberId,
      to: m.to,
      type: m.type,
      status: m.status,
      // Only set for template sends, and only for those sent since the name
      // started being recorded — a list can say which template went out rather
      // than just "template".
      templateName: m.templateName ?? undefined,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  async findOne(
    ssoOrgId: string,
    messageId: number,
    scopedWabaId?: string,
  ): Promise<MessageListItemDto> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!message || message.ssoOrgId !== ssoOrgId) {
      throw new NotFoundException('Message not found');
    }

    // Not found rather than forbidden: whether a message exists on another of
    // the organisation's accounts is not this key's business either.
    if (scopedWabaId) {
      const numbers = await this.scopedNumbers(scopedWabaId);
      if (!numbers.includes(message.phoneNumberId)) {
        throw new NotFoundException('Message not found');
      }
    }

    return {
      ...this.toListItem(message),
      // Detail view shows what was actually sent (text body, media, template).
      payload: (message.payload ?? undefined) as Record<string, unknown> | undefined,
    };
  }

  async analytics(
    ssoOrgId: string,
    days = 14,
    scopedWabaId?: string,
  ): Promise<MessageAnalyticsDto> {
    const range = Math.min(Math.max(days, 1), 90);
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (range - 1));

    const messages = await this.prisma.message.findMany({
      where: {
        ssoOrgId,
        createdAt: { gte: since },
        ...(scopedWabaId && {
          phoneNumberId: { in: await this.scopedNumbers(scopedWabaId) },
        }),
      },
      select: { status: true, createdAt: true },
    });

    const totals = { sent: 0, delivered: 0, read: 0, failed: 0, total: 0 };

    // Pre-seed one bucket per day so the series has no gaps.
    const buckets = new Map<string, { delivered: number; failed: number }>();
    for (let i = 0; i < range; i++) {
      const d = new Date(since);
      d.setDate(since.getDate() + i);
      buckets.set(d.toISOString().slice(0, 10), { delivered: 0, failed: 0 });
    }

    for (const m of messages) {
      totals.total++;
      totals[m.status as keyof typeof totals]++;

      const key = m.createdAt.toISOString().slice(0, 10);
      const bucket = buckets.get(key);
      if (bucket) {
        // "read" implies delivered for charting purposes.
        if (m.status === 'delivered' || m.status === 'read') bucket.delivered++;
        else if (m.status === 'failed') bucket.failed++;
      }
    }

    const round = (n: number) => Math.round(n * 1000) / 1000;
    const deliveredOrRead = totals.delivered + totals.read;

    return {
      rangeDays: range,
      totals,
      deliveryRate: totals.total ? round(deliveredOrRead / totals.total) : 0,
      readRate: deliveredOrRead ? round(totals.read / deliveredOrRead) : 0,
      series: [...buckets.entries()].map(([date, v]) => ({ date, ...v })),
    };
  }

  /**
   * Log the full Meta Graph API error and return the human-facing message.
   * Keeps the diagnostic detail (code/subcode/fbtrace_id) server-side while
   * surfacing a friendly message to the caller.
   */
  /**
   * Log a Meta failure, and when Meta rejected our credentials rather than the
   * message, email whoever owns the account: sending stays broken until they
   * reconnect, and nobody reads server logs.
   */
  private logMetaError(context: string, err: any, wabaId?: string): string {
    const metaError = err?.response?.data?.error;
    const userMessage =
      metaError?.error_user_msg ?? metaError?.message ?? err?.message;
    if (metaError) {
      this.logger.warn(
        `${context}: ${userMessage} ` +
          `[code=${metaError.code} subcode=${metaError.error_subcode} ` +
          `type=${metaError.type} fbtrace_id=${metaError.fbtrace_id}` +
          (metaError.error_data
            ? ` error_data=${JSON.stringify(metaError.error_data)}`
            : '') +
          ']',
      );
    } else {
      this.logger.warn(`${context}: ${userMessage}`);
    }

    if (wabaId && isMetaAuthFailure(err)) {
      void this.mail.metaTokenRejected(wabaId, metaErrorMessage(err));
    }

    return userMessage;
  }

  private buildMetaPayload(dto: SendMessageDto): Record<string, unknown> {
    const base: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: dto.to,
      type: dto.type,
    };

    switch (dto.type) {
      case MessageTypeEnum.text:
        base.text = { body: dto.text };
        break;
      case MessageTypeEnum.image:
        base.image = dto.caption
          ? { link: dto.mediaUrl, caption: dto.caption }
          : { link: dto.mediaUrl };
        break;
      case MessageTypeEnum.video:
        base.video = dto.caption
          ? { link: dto.mediaUrl, caption: dto.caption }
          : { link: dto.mediaUrl };
        break;
      case MessageTypeEnum.audio:
        base.audio = { link: dto.mediaUrl };
        break;
      case MessageTypeEnum.document:
        base.document = dto.caption
          ? { link: dto.mediaUrl, caption: dto.caption }
          : { link: dto.mediaUrl };
        break;
      case MessageTypeEnum.template:
        base.template = {
          name: dto.templateName,
          language: { code: dto.templateLanguage },
          ...(dto.templateComponents?.length ? { components: dto.templateComponents } : {}),
        };
        break;
      case MessageTypeEnum.location:
        base.location = {
          latitude: dto.latitude,
          longitude: dto.longitude,
          ...(dto.locationName ? { name: dto.locationName } : {}),
          ...(dto.locationAddress ? { address: dto.locationAddress } : {}),
        };
        break;
      case MessageTypeEnum.interactive:
        base.interactive = this.buildInteractivePayload(dto);
        break;
      default:
        break;
    }

    return base;
  }

  private buildInteractivePayload(dto: SendMessageDto): Record<string, unknown> {
    const interactive: Record<string, unknown> = {
      type: dto.interactiveType,
      body: { text: dto.interactiveBodyText },
      ...(dto.interactiveHeaderText
        ? { header: { type: 'text', text: dto.interactiveHeaderText } }
        : {}),
      ...(dto.interactiveFooterText ? { footer: { text: dto.interactiveFooterText } } : {}),
    };

    switch (dto.interactiveType) {
      case InteractiveTypeEnum.button:
        interactive.action = {
          buttons: (dto.interactiveButtons ?? []).map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        };
        break;
      case InteractiveTypeEnum.list:
        interactive.action = {
          button: dto.interactiveButtonLabel,
          sections: (dto.interactiveSections ?? []).map((s) => ({
            title: s.title,
            rows: s.rows.map((r) => ({
              id: r.id,
              title: r.title,
              ...(r.description ? { description: r.description } : {}),
            })),
          })),
        };
        break;
      case InteractiveTypeEnum.cta_url:
        interactive.action = {
          name: 'cta_url',
          parameters: {
            display_text: dto.interactiveCtaDisplayText,
            url: dto.interactiveCtaUrl,
          },
        };
        break;
      default:
        break;
    }

    return interactive;
  }
}
