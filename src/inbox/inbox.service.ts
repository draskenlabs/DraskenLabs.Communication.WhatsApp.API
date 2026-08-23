import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Conversation, InboundMessage, Message, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { MessagingService } from 'src/messaging/messaging.service';
import { MessageTypeEnum } from 'src/messaging/dto/send-message.dto';
import { SendMessageResponseDto } from 'src/messaging/dto/message-response.dto';
import { BaseResponse } from 'src/common/responses/base-response';
import { normalisePhone } from 'src/common/utils/phone';
import { ConversationDto, MessageWindowDto } from './dto/conversation.dto';
import { ThreadDto, ThreadMessageDto } from './dto/thread.dto';
import { SendReplyDto } from './dto/reply.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';

/**
 * Meta's customer service window: 24 hours from the customer's last message,
 * during which a business may answer freely. Outside it only an approved
 * template is delivered.
 */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** The inbound types whose payload names a Meta media id rather than a URL. */
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

/** How many messages a thread page holds. */
const THREAD_PAGE = 50;

export interface ConversationQuery {
  page?: number;
  limit?: number;
  status?: string;
  search?: string;
  phoneNumberId?: string;
  wabaId?: string;
  unreadOnly?: boolean;
}

@Injectable()
export class InboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: PlanLimitsService,
    private readonly messaging: MessagingService,
  ) {}

  /* ---------------------------------------------------------------- *
   * The conversation list                                             *
   * ---------------------------------------------------------------- */

  async list(
    ssoOrgId: string,
    query: ConversationQuery = {},
    scopedWabaId?: string,
  ): Promise<BaseResponse<ConversationDto[]>> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 30));

    const where: Prisma.ConversationWhereInput = {
      ssoOrgId,
      ...(scopedWabaId ? { wabaId: scopedWabaId } : {}),
      ...(query.wabaId ? { wabaId: query.wabaId } : {}),
      ...(query.phoneNumberId ? { phoneNumberId: query.phoneNumberId } : {}),
      ...(query.status
        ? { status: query.status as Prisma.EnumConversationStatusFilter }
        : {}),
      ...(query.unreadOnly ? { unreadCount: { gt: 0 } } : {}),
      ...(query.search ? this.searchFilter(query.search) : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.conversation.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.conversation.count({ where }),
    ]);

    const contacts = await this.contactsFor(ssoOrgId, rows);
    const dtos = rows.map((row) =>
      this.toConversationDto(row, contacts.get(row.contactPhone)),
    );

    return BaseResponse.paginate(
      dtos,
      total,
      Math.ceil(total / limit),
      page,
      limit,
    );
  }

  /**
   * Search across the name and the number at once.
   *
   * Both are what someone types into the box above a conversation list, and
   * which one they meant is not worth asking. The number is matched on digits
   * so that searching "+91 98220" finds a thread stored as `919822010210`.
   */
  private searchFilter(search: string): Prisma.ConversationWhereInput {
    const digits = normalisePhone(search);
    return {
      OR: [
        { contactName: { contains: search, mode: 'insensitive' } },
        ...(digits ? [{ contactPhone: { contains: digits } }] : []),
      ],
    };
  }

  /**
   * The saved contact behind each thread, in one query rather than per row.
   *
   * A conversation knows the WhatsApp profile name, which is whatever the
   * customer calls themselves. The name the business filed them under lives in
   * Contacts, and so does the opt-out that would refuse a reply — worth
   * knowing before someone types one.
   */
  private async contactsFor(
    ssoOrgId: string,
    rows: Conversation[],
  ): Promise<Map<string, { name: string | null; optedOut: boolean }>> {
    if (rows.length === 0) return new Map();

    const contacts = await this.prisma.contact.findMany({
      where: { ssoOrgId },
      select: { phone: true, name: true, optedOut: true },
    });

    // Keyed on the normalised number: Contacts stores whatever spelling was
    // typed when the contact was created, which is rarely the bare digits a
    // conversation is keyed by.
    const wanted = new Set(rows.map((r) => r.contactPhone));
    const byPhone = new Map<
      string,
      { name: string | null; optedOut: boolean }
    >();
    for (const contact of contacts) {
      const key = normalisePhone(contact.phone);
      if (wanted.has(key))
        byPhone.set(key, { name: contact.name, optedOut: contact.optedOut });
    }
    return byPhone;
  }

  /* ---------------------------------------------------------------- *
   * One thread                                                        *
   * ---------------------------------------------------------------- */

  /**
   * A conversation's messages, both directions, newest page first.
   *
   * Paged by timestamp rather than by offset. A thread grows from the bottom
   * while it is being read, and an offset into a list that is being prepended
   * to skips or repeats messages; a cursor asks for "older than this", which
   * stays true however much arrives meanwhile.
   */
  async thread(
    ssoOrgId: string,
    conversationId: number,
    opts: { before?: string; limit?: number } = {},
    scopedWabaId?: string,
  ): Promise<ThreadDto> {
    const conversation = await this.requireConversation(
      ssoOrgId,
      conversationId,
      scopedWabaId,
    );
    const limit = Math.min(100, Math.max(1, opts.limit ?? THREAD_PAGE));
    const before = this.parseCursor(opts.before);

    // One page from each side, merged and then cut back to one page. Asking
    // each table for `limit` is what makes the merge correct: the newest
    // `limit` messages overall cannot contain more than `limit` from either.
    const [outbound, inbound] = await Promise.all([
      this.prisma.message.findMany({
        where: {
          ssoOrgId,
          phoneNumberId: conversation.phoneNumberId,
          // Stored as the caller spelled it, so both spellings are asked for.
          to: { in: this.spellingsOf(conversation.contactPhone) },
          ...(before ? { createdAt: { lt: before } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.inboundMessage.findMany({
        where: {
          phoneNumberId: conversation.phoneNumberId,
          from: { in: this.spellingsOf(conversation.contactPhone) },
          ...(before ? { timestamp: { lt: before } } : {}),
        },
        orderBy: { timestamp: 'desc' },
        take: limit,
      }),
    ]);

    const merged = [
      ...outbound.map((m) => this.toOutboundMessage(m)),
      ...inbound.map((m) => this.toInboundMessage(m)),
    ].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const page = merged.slice(0, limit);
    // A full page means there is probably more behind it. The cursor is the
    // oldest message shown, so the next page continues from exactly there.
    const more = merged.length > limit || page.length === limit;
    const oldest = page[page.length - 1];

    const contacts = await this.contactsFor(ssoOrgId, [conversation]);
    const planLimits = await this.limits.forOrg(ssoOrgId);

    return {
      conversation: this.toConversationDto(
        conversation,
        contacts.get(conversation.contactPhone),
      ),
      // Oldest first: a chat screen reads downwards and appends new messages
      // at the bottom.
      messages: page.reverse(),
      ...(more && oldest ? { nextCursor: oldest.timestamp.toISOString() } : {}),
      ...(planLimits.historyDays
        ? { historyDays: planLimits.historyDays }
        : {}),
    };
  }

  /**
   * Both spellings a number is stored under.
   *
   * Conversations are keyed on bare digits, but the message tables hold
   * whatever arrived: Meta writes `from` bare, while `to` is however the
   * caller sent it. Matching on the two forms Meta accepts covers every
   * message this system has ever written, and a `LIKE` over a normalised
   * column would cost the index.
   */
  private spellingsOf(contactPhone: string): string[] {
    return [contactPhone, `+${contactPhone}`];
  }

  private parseCursor(before?: string): Date | undefined {
    if (!before) return undefined;
    const at = new Date(before);
    if (Number.isNaN(at.getTime())) {
      throw new BadRequestException('`before` must be an ISO 8601 timestamp');
    }
    return at;
  }

  /* ---------------------------------------------------------------- *
   * Acting on a thread                                                *
   * ---------------------------------------------------------------- */

  /** Mark everything up to now as seen. */
  async markRead(
    ssoOrgId: string,
    conversationId: number,
    scopedWabaId?: string,
  ): Promise<ConversationDto> {
    await this.requireConversation(ssoOrgId, conversationId, scopedWabaId);

    const updated = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { unreadCount: 0, lastReadAt: new Date() },
    });

    const contacts = await this.contactsFor(ssoOrgId, [updated]);
    return this.toConversationDto(updated, contacts.get(updated.contactPhone));
  }

  async update(
    ssoOrgId: string,
    conversationId: number,
    dto: UpdateConversationDto,
    scopedWabaId?: string,
  ): Promise<ConversationDto> {
    await this.requireConversation(ssoOrgId, conversationId, scopedWabaId);

    const updated = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        ...(dto.status ? { status: dto.status } : {}),
        // `undefined` leaves the assignment alone; an explicit null clears it.
        ...(dto.assigneeUserId !== undefined
          ? { assigneeUserId: dto.assigneeUserId }
          : {}),
      },
    });

    const contacts = await this.contactsFor(ssoOrgId, [updated]);
    return this.toConversationDto(updated, contacts.get(updated.contactPhone));
  }

  /**
   * Reply in a thread.
   *
   * The send itself is `MessagingService.sendMessage`, unchanged — membership,
   * the API key's WABA scope, the subscription and the recipient's opt-out are
   * all checked there, and duplicating any of them here would be a second
   * place for them to be wrong.
   *
   * What this adds is the window. Meta refuses a free-form message more than
   * 24 hours after the customer's last one, and it refuses it *after* the
   * send, as error 131047 against a message that appears in the log as failed.
   * Refusing it here costs nothing and can say why.
   */
  async reply(
    userId: number,
    ssoOrgId: string,
    conversationId: number,
    dto: SendReplyDto,
    scopedWabaId?: string,
  ): Promise<SendMessageResponseDto> {
    const conversation = await this.requireConversation(
      ssoOrgId,
      conversationId,
      scopedWabaId,
    );
    const window = this.windowFor(conversation.lastInboundAt);

    if (!window.open && dto.type !== MessageTypeEnum.template) {
      throw new BadRequestException(
        conversation.lastInboundAt
          ? 'The 24-hour customer service window has closed. Only an approved ' +
              'template can be sent until the customer replies again.'
          : 'This customer has never replied, so only an approved template can ' +
              'be sent to open the conversation.',
      );
    }

    return this.messaging.sendMessage(
      userId,
      ssoOrgId,
      {
        ...dto,
        to: conversation.contactPhone,
        phoneNumberId: conversation.phoneNumberId,
      },
      scopedWabaId,
    );
  }

  /* ---------------------------------------------------------------- *
   * Shared                                                            *
   * ---------------------------------------------------------------- */

  /**
   * The conversation, if this caller may see it.
   *
   * Phrased as "not found" rather than "forbidden", like the membership
   * service: an organisation has no business learning that an id it cannot see
   * exists. A WABA-scoped API key is narrowed the same way it is on the
   * message list — a key that can only send from one account has no business
   * reading the rest of the organisation's conversations.
   */
  async requireConversation(
    ssoOrgId: string,
    conversationId: number,
    scopedWabaId?: string,
  ): Promise<Conversation> {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        ssoOrgId,
        ...(scopedWabaId ? { wabaId: scopedWabaId } : {}),
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  /** Whether a free-form reply is allowed, and until when. */
  windowFor(lastInboundAt: Date | null): MessageWindowDto {
    if (!lastInboundAt) return { open: false };

    const expiresAt = new Date(lastInboundAt.getTime() + WINDOW_MS);
    return expiresAt.getTime() > Date.now()
      ? { open: true, expiresAt }
      : { open: false };
  }

  private toConversationDto(
    row: Conversation,
    contact?: { name: string | null; optedOut: boolean },
  ): ConversationDto {
    return {
      id: row.id,
      wabaId: row.wabaId,
      phoneNumberId: row.phoneNumberId,
      contactPhone: row.contactPhone,
      ...(row.contactName ? { contactName: row.contactName } : {}),
      ...(contact?.name ? { savedName: contact.name } : {}),
      ...(contact?.optedOut ? { optedOut: true } : {}),
      lastPreview: row.lastPreview ?? '',
      lastDirection: row.lastDirection,
      lastMessageAt: row.lastMessageAt,
      ...(row.lastInboundAt ? { lastInboundAt: row.lastInboundAt } : {}),
      unreadCount: row.unreadCount,
      status: row.status,
      ...(row.assigneeUserId !== null
        ? { assigneeUserId: row.assigneeUserId }
        : {}),
      window: this.windowFor(row.lastInboundAt),
    };
  }

  private toOutboundMessage(m: Message): ThreadMessageDto {
    return {
      // Prefixed: the two tables number their rows independently, so `41`
      // alone names two different messages.
      id: `out:${m.id}`,
      direction: 'outbound',
      ...(m.metaMessageId ? { metaMessageId: m.metaMessageId } : {}),
      type: m.type,
      payload: (m.payload ?? {}) as Record<string, unknown>,
      timestamp: m.createdAt,
      status: m.status,
      ...(m.templateName ? { templateName: m.templateName } : {}),
      ...(m.status === 'failed' &&
      (m.failureReason || m.failureDetail || m.failureCode)
        ? {
            error: {
              ...(m.failureCode !== null ? { code: m.failureCode } : {}),
              ...(m.failureReason ? { title: m.failureReason } : {}),
              ...(m.failureDetail ? { detail: m.failureDetail } : {}),
            },
          }
        : {}),
    };
  }

  private toInboundMessage(m: InboundMessage): ThreadMessageDto {
    const payload = (m.payload ?? {}) as Record<string, unknown>;
    const hasMedia = MEDIA_TYPES.has(m.type) && typeof payload.id === 'string';

    return {
      id: `in:${m.id}`,
      direction: 'inbound',
      metaMessageId: m.metaMessageId,
      type: m.type,
      payload,
      timestamp: m.timestamp,
      ...(m.senderName ? { senderName: m.senderName } : {}),
      // A path rather than a URL: Meta's own link needs the account's token and
      // expires, so the browser fetches it back through this API instead.
      //
      // Addressed by *this message*, not by the media id it carries. A media id
      // on its own says nothing about which account it arrived on, so nothing
      // could check who is allowed to see it.
      ...(hasMedia ? { mediaUrl: `/inbox/media/${m.id}` } : {}),
    };
  }
}
