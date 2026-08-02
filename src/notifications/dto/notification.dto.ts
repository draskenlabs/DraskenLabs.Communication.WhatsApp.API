import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Registering a browser or app for push. */
export class RegisterDeviceTokenDto {
  @ApiProperty({
    description: 'Firebase Cloud Messaging registration token for this device',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token: string;

  @ApiPropertyOptional({
    enum: ['web', 'android', 'ios'],
    default: 'web',
    description: 'Where the token came from',
  })
  @IsOptional()
  @IsIn(['web', 'android', 'ios'])
  platform?: string;

  @ApiPropertyOptional({
    description: 'User agent, so a person can recognise the device in a list',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  userAgent?: string;
}

/** Removing a registration — on sign-out, or when push is switched off. */
export class DeleteDeviceTokenDto {
  @ApiProperty({ description: 'The registration token to forget' })
  @IsString()
  @IsNotEmpty()
  token: string;
}

/**
 * Which notifications a user wants. Every field is optional: a PATCH changes
 * only what it names.
 */
export class UpdateNotificationPreferencesDto {
  @ApiPropertyOptional({ description: 'A customer replied on WhatsApp' })
  @IsOptional()
  @IsBoolean()
  inboundMessage?: boolean;

  @ApiPropertyOptional({
    description: 'Meta approved, rejected or paused a template',
  })
  @IsOptional()
  @IsBoolean()
  templateStatus?: boolean;

  @ApiPropertyOptional({ description: 'Email: template decisions and account changes' })
  @IsOptional()
  @IsBoolean()
  emailTemplateStatus?: boolean;

  @ApiPropertyOptional({
    description:
      'Email: yesterday\'s activity, including anything that failed to deliver',
  })
  @IsOptional()
  @IsBoolean()
  emailDailySummary?: boolean;

  @ApiPropertyOptional({ description: 'Email: the weekly activity summary' })
  @IsOptional()
  @IsBoolean()
  emailWeeklySummary?: boolean;

  @ApiPropertyOptional({ description: 'Email: product news and onboarding tips' })
  @IsOptional()
  @IsBoolean()
  emailProductNews?: boolean;
}

export class NotificationPreferencesDto {
  @ApiProperty()
  inboundMessage: boolean;

  @ApiProperty()
  templateStatus: boolean;

  @ApiProperty({ description: 'Email: template decisions and account changes' })
  emailTemplateStatus: boolean;

  @ApiProperty({
    description:
      'Email: yesterday\'s activity, including anything that failed to deliver',
  })
  emailDailySummary: boolean;

  @ApiProperty({ description: 'Email: the weekly activity summary' })
  emailWeeklySummary: boolean;

  @ApiProperty({ description: 'Email: product news and onboarding tips' })
  emailProductNews: boolean;

  @ApiProperty({
    description: 'Devices currently registered for push on this account',
  })
  deviceCount: number;

  @ApiProperty({
    description:
      'False when the server has no Firebase credentials — the console should ' +
      'then say push is unavailable rather than offer a switch that does nothing',
  })
  pushEnabled: boolean;
}

export class DeviceTokenResultDto {
  @ApiProperty({
    description: 'Devices registered for this user after the call',
  })
  deviceCount: number;
}

export class SendTestNotificationResultDto {
  @ApiProperty({ description: 'Devices the test reached' })
  sent: number;

  @ApiProperty({ description: 'Devices that refused it' })
  failed: number;
}

/** One entry in the feed the console's bell shows. */
export class NotificationDto {
  @ApiProperty({ example: 41 })
  id: number;

  @ApiProperty({
    enum: ['inboundMessage', 'templateStatus', 'system'],
    example: 'inboundMessage',
    description: 'What happened, matching the preference switches',
  })
  kind: string;

  @ApiProperty({ example: 'Ada Lovelace' })
  title: string;

  @ApiProperty({ example: 'Is my order on the way?' })
  body: string;

  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: '/messages',
    description: 'Where clicking it should land, relative to the console root',
  })
  link?: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    required: false,
    nullable: true,
    description: 'When it was read. Null means it still counts as unread.',
  })
  readAt?: Date | null;

  @ApiProperty({ format: 'date-time', example: '2026-08-01T18:12:04.000Z' })
  createdAt: Date;
}

export class UnreadCountDto {
  @ApiProperty({
    example: 3,
    description: 'Unread notifications for the caller in this organisation',
  })
  unread: number;
}

/** Marking notifications read — specific ones, or the whole feed. */
export class MarkNotificationsReadDto {
  @ApiPropertyOptional({
    type: [Number],
    description:
      'Notification ids to mark read. Omit to mark everything in this ' +
      'organisation read.',
    example: [41, 42],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  ids?: number[];
}

export class MarkNotificationsReadResultDto {
  @ApiProperty({ description: 'How many rows changed from unread to read' })
  updated: number;

  @ApiProperty({ description: 'Unread notifications left after the call' })
  unread: number;
}
