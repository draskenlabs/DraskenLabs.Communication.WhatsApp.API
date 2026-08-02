import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';

/** A short, readable stand-in for a message that has no text of its own. */
const TYPE_SUMMARY: Record<string, string> = {
  image: 'Sent a photo',
  video: 'Sent a video',
  audio: 'Sent a voice message',
  document: 'Sent a document',
  sticker: 'Sent a sticker',
  location: 'Shared a location',
  contacts: 'Shared a contact',
  reaction: 'Reacted to a message',
};

@Injectable()
export class InboundMessageHandler {
  private readonly logger = new Logger(InboundMessageHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async handle(
    wabaId: string,
    phoneNumberId: string,
    message: any,
    senderName: string | undefined,
  ): Promise<void> {
    const timestamp = new Date(Number(message.timestamp) * 1000);
    const type: string = message.type;
    const payload = message[type] ?? message;
    // Narrowed once so the notification below reads typed values rather than
    // walking the `any` payload again.
    const from = String(message.from ?? '');

    try {
      await this.prisma.inboundMessage.upsert({
        where: { metaMessageId: message.id },
        create: {
          metaMessageId: message.id,
          wabaId,
          phoneNumberId,
          from,
          senderName: senderName ?? null,
          type,
          payload,
          timestamp,
        },
        update: {},
      });
    } catch (err: any) {
      this.logger.error(`Failed to persist inbound message ${message.id}: ${err.message}`);
      // A reply we could not store is still worth telling someone about.
    }

    const preview = this.preview(type, payload);

    await this.notifications.notifyWaba(wabaId, 'inboundMessage', {
      title: senderName || `New message from ${from}`,
      body: preview,
      link: '/messages',
      data: { wabaId, kind: 'inboundMessage' },
    });

    // Push is the only per-reply alert. A reply also shows up in the next
    // daily summary, which is what reaches someone with no device registered.
  }

  /** One line of the message, or a description of what kind it was. */
  private preview(type: string, payload: unknown): string {
    const fields = (payload ?? {}) as { body?: unknown; caption?: unknown };
    const text: unknown = fields.body ?? fields.caption;
    if (typeof text === 'string' && text.trim()) {
      return text.length > 120 ? `${text.slice(0, 117)}…` : text;
    }
    return TYPE_SUMMARY[type] ?? 'Sent a message';
  }
}
