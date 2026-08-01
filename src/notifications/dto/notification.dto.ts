import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
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

  @ApiPropertyOptional({ description: 'An outbound message failed to deliver' })
  @IsOptional()
  @IsBoolean()
  messageFailed?: boolean;

  @ApiPropertyOptional({ description: 'Email: a summary of new customer messages' })
  @IsOptional()
  @IsBoolean()
  emailInboundMessage?: boolean;

  @ApiPropertyOptional({ description: 'Email: template decisions and account changes' })
  @IsOptional()
  @IsBoolean()
  emailTemplateStatus?: boolean;

  @ApiPropertyOptional({ description: 'Email: a summary of failed sends' })
  @IsOptional()
  @IsBoolean()
  emailMessageFailed?: boolean;

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

  @ApiProperty()
  messageFailed: boolean;

  @ApiProperty({ description: 'Email: a summary of new customer messages' })
  emailInboundMessage: boolean;

  @ApiProperty({ description: 'Email: template decisions and account changes' })
  emailTemplateStatus: boolean;

  @ApiProperty({ description: 'Email: a summary of failed sends' })
  emailMessageFailed: boolean;

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
