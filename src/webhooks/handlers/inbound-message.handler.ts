import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { ConversationWriterService } from 'src/inbox/conversation-writer.service';
import { inboundPreview } from 'src/inbox/preview';

@Injectable()
export class InboundMessageHandler {
  private readonly logger = new Logger(InboundMessageHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly conversations: ConversationWriterService,
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

    const preview = inboundPreview(type, payload);

    // The thread this reply belongs to, so the inbox can show it without
    // deriving the conversation list from two message tables on every read.
    // After the message is stored: the summary is of a message that exists.
    await this.conversations.recordInbound({
      wabaId,
      phoneNumberId,
      from,
      senderName,
      type,
      payload,
      timestamp,
    });

    await this.notifications.notifyWaba(wabaId, 'inboundMessage', {
      title: senderName || `New message from ${from}`,
      body: preview,
      link: `/inbox?phone=${encodeURIComponent(from)}`,
      data: { wabaId, kind: 'inboundMessage' },
    });

    // Push is the only per-reply alert. A reply also shows up in the next
    // daily summary, which is what reaches someone with no device registered.
  }
}
