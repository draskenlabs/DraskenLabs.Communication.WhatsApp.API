import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** A message sent from the console's support page. */
export class SupportRequestDto {
  @ApiProperty({ description: 'Reply-to address' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ description: 'Who is asking' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiProperty({ description: 'One line describing the problem' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  subject: string;

  @ApiProperty({ description: 'The message itself' })
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  message: string;

  @ApiPropertyOptional({
    enum: ['support', 'privacy', 'security', 'abuse', 'legal'],
    default: 'support',
    description: 'Which mailbox should receive it',
  })
  @IsOptional()
  @IsIn(['support', 'privacy', 'security', 'abuse', 'legal'])
  topic?: string;
}

export class SupportRequestResultDto {
  @ApiProperty({ description: 'True when the message reached our mailbox' })
  received: boolean;

  @ApiProperty({
    description: 'What happens next, in words the console can show',
  })
  message: string;
}

/** One-click unsubscribe, from a signed link in an email. */
export class UnsubscribeDto {
  @ApiProperty({ description: 'User id from the link' })
  @IsInt()
  userId: number;

  @ApiProperty({
    description: 'Preference to switch off, or "all" to stop every email',
  })
  @IsString()
  @IsNotEmpty()
  kind: string;

  @ApiProperty({ description: 'Signature from the link' })
  @IsString()
  @IsNotEmpty()
  token: string;
}

export class UnsubscribeResultDto {
  @ApiProperty()
  ok: boolean;

  @ApiProperty()
  message: string;
}

/** An operational broadcast — policy change, sub-processor change, breach. */
export class BroadcastDto {
  @ApiProperty({ description: 'Subject line' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  subject: string;

  @ApiProperty({ description: 'Heading inside the email' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  heading: string;

  @ApiProperty({ description: 'Opening paragraph' })
  @IsString()
  @IsNotEmpty()
  intro: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Further paragraphs, in order',
  })
  @IsOptional()
  paragraphs?: string[];

  @ApiPropertyOptional({ description: 'Console path a button should link to' })
  @IsOptional()
  @IsString()
  actionPath?: string;

  @ApiPropertyOptional({ description: 'Label for that button' })
  @IsOptional()
  @IsString()
  actionLabel?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Preview only — resolves the audience and returns the count without sending',
  })
  @IsOptional()
  dryRun?: boolean;
}

export class BroadcastResultDto {
  @ApiProperty({
    description: 'Accounts the broadcast reached (or would reach)',
  })
  recipients: number;

  @ApiProperty({ description: 'Emails actually delivered to SES' })
  sent: number;
}
