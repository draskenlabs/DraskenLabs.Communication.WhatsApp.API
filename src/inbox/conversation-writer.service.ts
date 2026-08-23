import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { normalisePhone } from 'src/common/utils/phone';
import { inboundPreview, outboundPreview } from './preview';

/**
 * Keeps the conversation list current as messages land.
 *
 * Deliberately not part of the inbox module's read path, and deliberately
 * depending on nothing but Prisma: the two callers are the messages webhook
 * and the send path, and if this imported the inbox module — which imports
 * messaging, to send replies — the graph would be a cycle.
 *
 * Every method here is best-effort. A conversation row is a derived summary of
 * messages that are already stored, so failing to update it must never fail
 * the thing that produced the message: a reply we could not summarise is still
 * a reply that was received, and a send that reached Meta has been sent
 * whatever this table says afterwards.
 */
@Injectable()
export class ConversationWriterService {
  private readonly logger = new Logger(ConversationWriterService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a customer's reply against every organisation that holds the
   * account.
   *
   * One row per organisation, matching how the notification feed fans the same
   * reply out — two organisations connected to one WABA each keep their own
   * unread count, and neither reading a thread marks it read for the other.
   */
  async recordInbound(input: {
    wabaId: string;
    phoneNumberId: string;
    from: string;
    senderName?: string;
    type: string;
    payload: unknown;
    timestamp: Date;
  }): Promise<void> {
    const contactPhone = normalisePhone(input.from);
    if (!contactPhone) return;

    try {
      const orgs = await this.prisma.wabaOrganisation.findMany({
        where: { wabaId: input.wabaId },
        select: { ssoOrgId: true },
      });
      if (orgs.length === 0) return;

      const preview = inboundPreview(input.type, input.payload);

      for (const { ssoOrgId } of orgs) {
        await this.prisma.conversation.upsert({
          where: {
            ssoOrgId_phoneNumberId_contactPhone: {
              ssoOrgId,
              phoneNumberId: input.phoneNumberId,
              contactPhone,
            },
          },
          create: {
            ssoOrgId,
            wabaId: input.wabaId,
            phoneNumberId: input.phoneNumberId,
            contactPhone,
            contactName: input.senderName ?? null,
            lastMessageAt: input.timestamp,
            lastDirection: 'inbound',
            lastPreview: preview,
            lastInboundAt: input.timestamp,
            unreadCount: 1,
          },
          update: {
            // The profile name travels with each reply and people rename
            // themselves; the latest one is the right one. A reply that
            // carries none must not blank the name we already had.
            ...(input.senderName ? { contactName: input.senderName } : {}),
            lastMessageAt: input.timestamp,
            lastDirection: 'inbound',
            lastPreview: preview,
            lastInboundAt: input.timestamp,
            unreadCount: { increment: 1 },
            // A customer writing again reopens a thread someone had closed.
            // Closing means "dealt with", and this is evidence it is not.
            status: 'open',
          },
        });
      }
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Could not record inbound conversation for ${input.phoneNumberId}: ${detail}`,
      );
    }
  }

  /**
   * Record a message we sent.
   *
   * Only for the organisation that sent it — unlike a reply, which the whole
   * account receives, a send belongs to the organisation that made it.
   *
   * Does not touch `unreadCount` or `lastInboundAt`. Answering a customer does
   * not mark their earlier messages read (someone else on the team may still
   * need to see them), and replying certainly does not extend the 24-hour
   * window, which is measured from the customer's own last message.
   */
  async recordOutbound(input: {
    ssoOrgId: string;
    wabaId: string;
    phoneNumberId: string;
    to: string;
    type: string;
    payload: unknown;
    templateName?: string | null;
    sentAt: Date;
  }): Promise<void> {
    const contactPhone = normalisePhone(input.to);
    if (!contactPhone) return;

    const preview = outboundPreview(
      input.type,
      input.payload,
      input.templateName,
    );

    try {
      await this.prisma.conversation.upsert({
        where: {
          ssoOrgId_phoneNumberId_contactPhone: {
            ssoOrgId: input.ssoOrgId,
            phoneNumberId: input.phoneNumberId,
            contactPhone,
          },
        },
        create: {
          ssoOrgId: input.ssoOrgId,
          wabaId: input.wabaId,
          phoneNumberId: input.phoneNumberId,
          contactPhone,
          lastMessageAt: input.sentAt,
          lastDirection: 'outbound',
          lastPreview: preview,
        },
        update: {
          lastMessageAt: input.sentAt,
          lastDirection: 'outbound',
          lastPreview: preview,
        },
      });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Could not record outbound conversation for ${input.phoneNumberId}: ${detail}`,
      );
    }
  }
}
