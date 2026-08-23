import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MessageErrorDto } from 'src/messaging/dto/message-response.dto';
import { ConversationDto } from './conversation.dto';

/**
 * One message in a thread, whichever direction it went.
 *
 * A single shape on purpose. The two halves live in different tables with
 * different columns — a send has a delivery status and a failure reason, a
 * reply has a profile name and media that has to be fetched from Meta — but a
 * chat screen renders one list in time order. Making the client interleave two
 * differently-shaped arrays would put the ordering logic in the browser, where
 * every client would have to get it right separately.
 */
export class ThreadMessageDto {
  @ApiProperty({
    description:
      'Unique within the thread. Prefixed by direction because the two tables ' +
      'number their rows independently — `out:41` and `in:41` are different ' +
      'messages.',
    example: 'out:4821',
  })
  id: string;

  @ApiProperty({ enum: ['inbound', 'outbound'] })
  direction: string;

  @ApiPropertyOptional({ description: "Meta's own id for the message" })
  metaMessageId?: string;

  @ApiProperty({ description: 'text, image, template, interactive, …' })
  type: string;

  @ApiProperty({
    description:
      'The Meta payload. For a send, exactly what was posted; for a reply, ' +
      "the message's own type block as Meta delivered it.",
    type: 'object',
    additionalProperties: true,
  })
  payload: Record<string, unknown>;

  @ApiProperty({ description: 'When it was sent or received' })
  timestamp: Date;

  @ApiPropertyOptional({
    description: 'sent / delivered / read / failed. Outbound only.',
  })
  status?: string;

  @ApiPropertyOptional({
    description: 'Template used, for template sends. Outbound only.',
  })
  templateName?: string;

  @ApiPropertyOptional({
    type: MessageErrorDto,
    description: 'Why the send failed, in Meta’s words. Outbound only.',
  })
  error?: MessageErrorDto;

  @ApiPropertyOptional({
    description: 'The WhatsApp profile name on the reply. Inbound only.',
  })
  senderName?: string;

  @ApiPropertyOptional({
    description:
      'Path to fetch this message’s media through the API, for the inbound ' +
      'types that carry a Meta media id. Meta’s own URL needs the account ' +
      'token and expires, so a browser cannot fetch it directly.',
    example: '/inbox/media/1234567890',
  })
  mediaUrl?: string;
}

export class ThreadDto {
  @ApiProperty({ type: ConversationDto })
  conversation: ConversationDto;

  @ApiProperty({
    type: ThreadMessageDto,
    isArray: true,
    description: 'Oldest first, so a chat screen appends downwards',
  })
  messages: ThreadMessageDto[];

  @ApiPropertyOptional({
    description:
      'Cursor for the page before this one. Absent when the thread has been ' +
      'read back to its beginning.',
  })
  nextCursor?: string;

  @ApiPropertyOptional({
    description:
      'How many days of history the organisation’s plan keeps. A thread that ' +
      'starts abruptly starts there, and the screen can say so instead of ' +
      'looking broken.',
    example: 30,
  })
  historyDays?: number;
}
