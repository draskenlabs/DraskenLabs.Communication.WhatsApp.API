import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Whether a free-form reply is allowed right now.
 *
 * Meta lets a business answer freely for 24 hours after the customer's last
 * message; outside that window only an approved template goes through. Until
 * the inbox existed this was only ever learned *after* the fact, as error
 * 131047 on a send that had already failed — so the console could show a
 * composer that was never going to work.
 *
 * Computed on the server, from the server's own clock. The browser's is not
 * reliably right, and being wrong here means either a refused send or a
 * disabled box on a conversation that was open.
 */
export class MessageWindowDto {
  @ApiProperty({
    description: 'Whether a free-form (non-template) message can be sent now',
    example: true,
  })
  open: boolean;

  @ApiPropertyOptional({
    description:
      'When the 24-hour window closes. Null when it is already closed, or ' +
      'when the customer has never written — a business cannot open a ' +
      'conversation with a free-form message at all.',
  })
  expiresAt?: Date;
}

export class ConversationDto {
  @ApiProperty()
  id: number;

  @ApiProperty({
    description: 'The WhatsApp Business Account this thread belongs to',
  })
  wabaId: string;

  @ApiProperty({ description: 'The number the conversation is held on' })
  phoneNumberId: string;

  @ApiProperty({
    description: 'The customer, digits only',
    example: '919822010210',
  })
  contactPhone: string;

  @ApiPropertyOptional({
    description:
      'The WhatsApp profile name from their last reply. Absent for a customer ' +
      'who has never written.',
    example: 'Priya',
  })
  contactName?: string;

  @ApiPropertyOptional({
    description: 'The name this number is saved under in Contacts, if it is',
    example: 'Priya Sharma',
  })
  savedName?: string;

  @ApiPropertyOptional({
    description:
      'Whether this number has opted out. A send to them is refused, so the ' +
      'reply box says so rather than letting someone type into a dead end.',
  })
  optedOut?: boolean;

  @ApiProperty({ description: 'One line of the last message in the thread' })
  lastPreview: string;

  @ApiProperty({ enum: ['inbound', 'outbound'], description: 'Who sent it' })
  lastDirection: string;

  @ApiProperty()
  lastMessageAt: Date;

  @ApiPropertyOptional({ description: 'When the customer last wrote' })
  lastInboundAt?: Date;

  @ApiProperty({
    description: 'Replies received since this thread was last read',
  })
  unreadCount: number;

  @ApiProperty({ enum: ['open', 'closed'] })
  status: string;

  @ApiPropertyOptional({ description: 'Team member dealing with this thread' })
  assigneeUserId?: number;

  @ApiProperty({ type: MessageWindowDto })
  window: MessageWindowDto;
}
