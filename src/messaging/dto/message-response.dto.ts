import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendMessageResponseDto {
  @ApiProperty()
  id: number;

  @ApiPropertyOptional()
  metaMessageId?: string;

  @ApiProperty()
  phoneNumberId: string;

  @ApiProperty()
  to: string;

  @ApiProperty()
  type: string;

  @ApiProperty()
  status: string;

  @ApiPropertyOptional({
    description:
      'Template used, for template messages sent after the name started being ' +
      'recorded. Lets a list say which template went out rather than just ' +
      '"template".',
    example: 'order_shipped',
  })
  templateName?: string;

  @ApiProperty()
  createdAt: Date;
}

/** Why a send failed, exactly as Meta's status webhook reported it. */
export class MessageErrorDto {
  @ApiPropertyOptional({
    description: "Meta's error code — see their error-code reference",
    example: 131047,
  })
  code?: number;

  @ApiPropertyOptional({
    description: 'Short label',
    example: 'Re-engagement message',
  })
  title?: string;

  @ApiPropertyOptional({
    description: "Meta's explanation of the failure",
    example:
      'Message failed to send because more than 24 hours have passed since the ' +
      'customer last replied to this number.',
  })
  detail?: string;
}

export class MessageListItemDto {
  @ApiProperty()
  id: number;

  @ApiPropertyOptional()
  metaMessageId?: string;

  @ApiProperty()
  phoneNumberId: string;

  @ApiProperty()
  to: string;

  @ApiProperty()
  type: string;

  @ApiProperty()
  status: string;

  @ApiPropertyOptional({
    description:
      'Template used, for template messages sent after the name started being ' +
      'recorded. Lets a list say which template went out rather than just ' +
      '"template".',
    example: 'order_shipped',
  })
  templateName?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiPropertyOptional({
    description:
      'The Meta message payload as sent (text body, media link, template, etc.). ' +
      'Populated on the single-message detail endpoint; omitted from list responses.',
    type: 'object',
    additionalProperties: true,
  })
  payload?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      "Why the send failed, from Meta's status webhook. Present only on failed " +
      'messages, and only for those that failed after this was recorded.',
    type: MessageErrorDto,
  })
  error?: MessageErrorDto;
}
