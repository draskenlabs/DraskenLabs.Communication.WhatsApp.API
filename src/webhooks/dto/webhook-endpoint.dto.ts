import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Event kinds an endpoint may subscribe to.
 *
 * The console's own grouping rather than Meta's change fields: an integrator
 * cares that a customer replied, not that it arrived under the `messages`
 * field alongside delivery receipts.
 */
export const SUBSCRIBABLE_EVENTS = [
  'inbound_message',
  'status_update',
  'template_status',
  'account_update',
] as const;

/** The event name on a test ping. It belongs to no WABA event. */
export const TEST_EVENT = 'endpoint.test';

export class CreateWebhookEndpointDto {
  @ApiProperty({
    description: 'HTTPS URL we post events to. Must be publicly reachable.',
    example: 'https://api.example.com/hooks/whatsapp',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  url: string;

  @ApiProperty({
    description: 'WABA whose events this endpoint receives.',
    example: '220011334455',
  })
  @IsString()
  @IsNotEmpty()
  wabaId: string;

  @ApiPropertyOptional({ description: 'A name for your own reference' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @ApiPropertyOptional({
    description:
      'Signing secret. Optional: supply one and every delivery carries an ' +
      'X-Drasken-Signature-256 HMAC you can verify; leave it out and the body ' +
      'is posted unsigned. It is stored encrypted and never returned again.',
    minLength: 16,
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(200)
  secret?: string;

  @ApiPropertyOptional({
    description: 'Event kinds to receive. Omit or leave empty for every kind.',
    enum: SUBSCRIBABLE_EVENTS,
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(SUBSCRIBABLE_EVENTS as unknown as string[], { each: true })
  events?: string[];
}

export class UpdateWebhookEndpointDto {
  @ApiPropertyOptional({ description: 'New HTTPS URL' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @ApiPropertyOptional({
    description:
      'Rotate the signing secret. Send an empty string to remove it and go ' +
      'back to unsigned deliveries.',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  secret?: string;

  @ApiPropertyOptional({ enum: SUBSCRIBABLE_EVENTS, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(SUBSCRIBABLE_EVENTS as unknown as string[], { each: true })
  events?: string[];

  @ApiPropertyOptional({
    description:
      'Enable or disable. Enabling one we disabled ourselves also clears its ' +
      'failure count, so it gets a clean run of retries.',
  })
  @IsOptional()
  @IsBoolean()
  status?: boolean;
}

export class WebhookEndpointDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  url: string;

  @ApiProperty({ nullable: true })
  label: string | null;

  @ApiProperty()
  wabaId: string;

  @ApiProperty({
    nullable: true,
    description: 'Name of that WABA, for display',
  })
  wabaName: string | null;

  @ApiProperty({
    description: 'Kinds subscribed to. Empty means every kind.',
    type: [String],
  })
  events: string[];

  @ApiProperty()
  status: boolean;

  @ApiProperty({
    description:
      'Whether a signing secret is configured. The secret itself is never returned.',
  })
  hasSecret: boolean;

  @ApiProperty({
    description: 'Consecutive deliveries we gave up on, since the last success',
  })
  failureCount: number;

  @ApiProperty({
    nullable: true,
    description:
      'When we disabled it ourselves. Null if a person did, or if it is on.',
  })
  disabledAt: Date | null;

  @ApiProperty({ nullable: true })
  lastSuccessAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}

export class WebhookDeliveryDto {
  @ApiProperty()
  id: number;

  @ApiProperty({
    description: 'Event kind delivered, or `endpoint.test` for a test ping',
  })
  eventType: string;

  @ApiProperty({ description: 'pending | sent | failed | abandoned' })
  status: string;

  @ApiProperty({ description: 'Attempts made so far' })
  attempts: number;

  @ApiProperty({
    nullable: true,
    description: 'HTTP status the endpoint answered with',
  })
  responseCode: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Transport error or the start of a failing body',
  })
  error: string | null;

  @ApiProperty({ nullable: true })
  durationMs: number | null;

  @ApiProperty({ nullable: true, description: 'When the next attempt is due' })
  retryAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class WebhookTestResultDto {
  @ApiProperty({ description: 'Whether the endpoint answered 2xx' })
  success: boolean;

  @ApiProperty({ nullable: true })
  responseCode: number | null;

  @ApiProperty({ nullable: true })
  error: string | null;

  @ApiProperty({ nullable: true, description: 'Round trip in milliseconds' })
  durationMs: number | null;

  @ApiProperty({ description: 'Whether the ping was signed' })
  signed: boolean;

  @ApiProperty({ description: 'Delivery log row for this ping' })
  deliveryId: number;
}
