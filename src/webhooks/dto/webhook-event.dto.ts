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

  @ApiProperty({ description: 'Human-readable one-line summary derived from the payload' })
  summary: string;

  @ApiProperty()
  wabaId: string;

  @ApiProperty({ description: 'Whether the event was processed successfully' })
  processed: boolean;

  @ApiPropertyOptional({ description: 'Processing error, if any' })
  error?: string;

  @ApiProperty()
  createdAt: Date;
}
