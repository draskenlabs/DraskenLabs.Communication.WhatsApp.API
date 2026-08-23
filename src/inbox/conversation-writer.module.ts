import { Module } from '@nestjs/common';
import { ConversationWriterService } from './conversation-writer.service';

/**
 * The conversation write path on its own, so both producers of a message can
 * have it without either depending on the inbox's read path.
 *
 * The webhooks module and the messaging module import this; the inbox module
 * imports messaging. Keeping the writer separate is what stops that from
 * being a cycle.
 */
@Module({
  providers: [ConversationWriterService],
  exports: [ConversationWriterService],
})
export class ConversationWriterModule {}
