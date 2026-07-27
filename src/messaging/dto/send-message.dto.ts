import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export enum MessageTypeEnum {
  text = 'text',
  image = 'image',
  video = 'video',
  audio = 'audio',
  document = 'document',
  template = 'template',
  interactive = 'interactive',
  location = 'location',
  reaction = 'reaction',
  contacts = 'contacts',
}

export enum InteractiveTypeEnum {
  button = 'button',
  list = 'list',
  cta_url = 'cta_url',
}

/**
 * A single reply button inside an `interactive.type = button` message.
 *
 * NOTE: the global ValidationPipe runs with `whitelist: true` + `transform: true`,
 * so every field the frontend may send MUST be declared on a typed nested DTO —
 * an untyped array gets stripped to empty objects during transformation.
 */
export class ReplyButtonDto {
  @ApiProperty({ description: 'Unique button id echoed back in the webhook when tapped' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ description: 'Button label (max 20 chars, enforced by Meta)' })
  @IsString()
  @IsNotEmpty()
  title: string;
}

/** A single row inside a list-message section. */
export class ListRowDto {
  @ApiProperty({ description: 'Unique row id echoed back in the webhook when selected' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ description: 'Row title (max 24 chars)' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional({ description: 'Optional row description (max 72 chars)' })
  @IsOptional()
  @IsString()
  description?: string;
}

/** A section grouping rows inside an `interactive.type = list` message. */
export class ListSectionDto {
  @ApiProperty({ description: 'Section title' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ description: 'Rows in this section', type: [ListRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ListRowDto)
  rows: ListRowDto[];
}

export class SendMessageDto {
  @ApiProperty({ description: 'Phone number ID to send from (from your connected WABA)' })
  @IsString()
  @IsNotEmpty()
  phoneNumberId: string;

  @ApiProperty({ description: 'Recipient phone number in E.164 format (e.g. 447911123456)' })
  @IsString()
  @IsNotEmpty()
  to: string;

  @ApiProperty({ enum: MessageTypeEnum, description: 'Message type' })
  @IsEnum(MessageTypeEnum)
  type: MessageTypeEnum;

  @ApiPropertyOptional({ description: 'Message body text (required for type=text)' })
  @ValidateIf((o) => o.type === MessageTypeEnum.text)
  @IsString()
  @IsNotEmpty()
  text?: string;

  @ApiPropertyOptional({ description: 'Media URL (required for image/video/audio/document)' })
  @ValidateIf((o) => ['image', 'video', 'audio', 'document'].includes(o.type))
  @IsString()
  @IsNotEmpty()
  mediaUrl?: string;

  @ApiPropertyOptional({ description: 'Media caption (optional for image/video/document)' })
  @IsOptional()
  @IsString()
  caption?: string;

  @ApiPropertyOptional({ description: 'Template name (required for type=template)' })
  @ValidateIf((o) => o.type === MessageTypeEnum.template)
  @IsString()
  @IsNotEmpty()
  templateName?: string;

  @ApiPropertyOptional({ description: 'Template language code e.g. en_US (required for type=template)' })
  @ValidateIf((o) => o.type === MessageTypeEnum.template)
  @IsString()
  @IsNotEmpty()
  templateLanguage?: string;

  @ApiPropertyOptional({
    description: 'Template component parameters (optional — variable substitutions per component)',
    type: 'array',
    items: { type: 'object' },
  })
  @IsOptional()
  @IsArray()
  templateComponents?: any[];

  // ---- Location (type=location) --------------------------------------------

  @ApiPropertyOptional({ description: 'Latitude (required for type=location)' })
  @ValidateIf((o) => o.type === MessageTypeEnum.location)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({ description: 'Longitude (required for type=location)' })
  @ValidateIf((o) => o.type === MessageTypeEnum.location)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiPropertyOptional({ description: 'Location name (optional)' })
  @IsOptional()
  @IsString()
  locationName?: string;

  @ApiPropertyOptional({ description: 'Location street address (optional)' })
  @IsOptional()
  @IsString()
  locationAddress?: string;

  // ---- Interactive (type=interactive) --------------------------------------

  @ApiPropertyOptional({ enum: InteractiveTypeEnum, description: 'Interactive subtype (required for type=interactive)' })
  @ValidateIf((o) => o.type === MessageTypeEnum.interactive)
  @IsEnum(InteractiveTypeEnum)
  interactiveType?: InteractiveTypeEnum;

  @ApiPropertyOptional({ description: 'Interactive body text (required for type=interactive)' })
  @ValidateIf((o) => o.type === MessageTypeEnum.interactive)
  @IsString()
  @IsNotEmpty()
  interactiveBodyText?: string;

  @ApiPropertyOptional({ description: 'Optional interactive header text' })
  @IsOptional()
  @IsString()
  interactiveHeaderText?: string;

  @ApiPropertyOptional({ description: 'Optional interactive footer text' })
  @IsOptional()
  @IsString()
  interactiveFooterText?: string;

  @ApiPropertyOptional({ description: 'Reply buttons (required for interactiveType=button, 1–3)', type: [ReplyButtonDto] })
  @ValidateIf((o) => o.interactiveType === InteractiveTypeEnum.button)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ReplyButtonDto)
  interactiveButtons?: ReplyButtonDto[];

  @ApiPropertyOptional({ description: 'List menu button label (required for interactiveType=list)' })
  @ValidateIf((o) => o.interactiveType === InteractiveTypeEnum.list)
  @IsString()
  @IsNotEmpty()
  interactiveButtonLabel?: string;

  @ApiPropertyOptional({ description: 'List sections (required for interactiveType=list)', type: [ListSectionDto] })
  @ValidateIf((o) => o.interactiveType === InteractiveTypeEnum.list)
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ListSectionDto)
  interactiveSections?: ListSectionDto[];

  @ApiPropertyOptional({ description: 'CTA button display text (required for interactiveType=cta_url)' })
  @ValidateIf((o) => o.interactiveType === InteractiveTypeEnum.cta_url)
  @IsString()
  @IsNotEmpty()
  interactiveCtaDisplayText?: string;

  @ApiPropertyOptional({ description: 'CTA target URL (required for interactiveType=cta_url)' })
  @ValidateIf((o) => o.interactiveType === InteractiveTypeEnum.cta_url)
  @IsString()
  @IsNotEmpty()
  interactiveCtaUrl?: string;
}
