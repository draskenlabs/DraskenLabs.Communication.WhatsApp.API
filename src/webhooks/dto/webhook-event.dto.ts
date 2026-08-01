import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Frontend-friendly classification of a stored webhook event. */
export type WebhookEventKind =
  | 'inbound_message'
  | 'status_update'
  | 'template_status'
  | 'account_update';

export class WebhookEventDto {
  @ApiProperty()
  id: number;

  @ApiProperty({ description: 'Raw Meta change field, e.g. messages / account_update' })
  eventType: string;

  @ApiProperty({ description: 'Grouped kind used for display' })
  kind: WebhookEventKind;

  @ApiProperty({ description: 'Human-readable headline derived from the payload' })
  title: string;

  @ApiPropertyOptional({
    description: 'Secondary line — message preview, template name, quality tier, etc.',
  })
  detail?: string;

  @ApiPropertyOptional({
    description:
      'Delivery status (sent / delivered / read / failed) or template decision (APPROVED / REJECTED / …)',
  })
  status?: string;

  @ApiPropertyOptional({ description: "The other party's phone number, in E.164 digits" })
  recipient?: string;

  @ApiPropertyOptional({ description: "Meta's message id (wamid) this event concerns" })
  messageId?: string;

  @ApiPropertyOptional({
    description: 'Why Meta rejected or failed to deliver — the reason it reported',
  })
  reason?: string;

  @ApiProperty()
  wabaId: string;

  @ApiProperty({ description: 'Whether the event was processed successfully' })
  processed: boolean;

  @ApiPropertyOptional({ description: 'Processing error, if any' })
  error?: string;

  @ApiProperty()
  createdAt: Date;
}
