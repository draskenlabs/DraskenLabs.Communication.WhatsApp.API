import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { TemplateCategory } from '@prisma/client';

export enum TemplateParameterFormat {
  POSITIONAL = 'POSITIONAL',
  NAMED = 'NAMED',
}

/**
 * A single button inside a BUTTONS component. Covers Meta's call-to-action,
 * quick-reply and AUTHENTICATION (OTP) button shapes.
 *
 * IMPORTANT: every field the frontend may send MUST be declared here. The
 * global ValidationPipe runs with `whitelist: true` + `transform: true`, and an
 * untyped `Record<string, unknown>[]` gets stripped to empty objects during
 * transformation — which made Meta reject templates with
 * `components[..]['buttons'][0]['type'] is required`. A typed nested DTO keeps
 * the fields intact.
 */
export class TemplateButtonDto {
  @ApiProperty({ description: 'QUICK_REPLY | URL | PHONE_NUMBER | OTP | COPY_CODE | FLOW' })
  @IsString()
  @IsNotEmpty()
  type: string;

  @ApiPropertyOptional({ description: 'Button label (not used for OTP creation)' })
  @IsOptional()
  @IsString()
  text?: string;

  @ApiPropertyOptional({ description: 'URL buttons — may contain a trailing {{1}} variable' })
  @IsOptional()
  @IsString()
  url?: string;

  @ApiPropertyOptional({ description: 'PHONE_NUMBER buttons — E.164 number' })
  @IsOptional()
  @IsString()
  phone_number?: string;

  @ApiPropertyOptional({ description: 'URL button variable example values', type: [String] })
  @IsOptional()
  @IsArray()
  example?: string[];

  @ApiPropertyOptional({ description: 'OTP buttons — COPY_CODE | ONE_TAP | ZERO_TAP' })
  @IsOptional()
  @IsString()
  otp_type?: string;

  @ApiPropertyOptional({ description: 'ONE_TAP/ZERO_TAP autofill button label' })
  @IsOptional()
  @IsString()
  autofill_text?: string;

  @ApiPropertyOptional({ description: 'ONE_TAP/ZERO_TAP — Android app package name' })
  @IsOptional()
  @IsString()
  package_name?: string;

  @ApiPropertyOptional({ description: 'ONE_TAP/ZERO_TAP — app signing-key hash' })
  @IsOptional()
  @IsString()
  signature_hash?: string;
}

/**
 * A single template component. Mirrors the Meta Cloud API `components[]` items
 * (HEADER / BODY / FOOTER / BUTTONS). Kept permissive on the inner shape —
 * Meta performs the authoritative validation and returns actionable errors.
 */
export class TemplateComponentDto {
  @ApiProperty({ description: 'HEADER | BODY | FOOTER | BUTTONS' })
  @IsString()
  @IsNotEmpty()
  type: string;

  @ApiPropertyOptional({ description: 'HEADER only — TEXT | IMAGE | VIDEO | DOCUMENT | LOCATION' })
  @IsOptional()
  @IsString()
  format?: string;

  @ApiPropertyOptional({ description: 'Text for HEADER/BODY/FOOTER (may contain {{n}} variables)' })
  @IsOptional()
  @IsString()
  text?: string;

  @ApiPropertyOptional({
    description: 'Example values, e.g. { body_text: [["Aanya","#123"]] } or { header_text: ["Sale"] }',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  example?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'AUTHENTICATION BODY — appends a security advisory' })
  @IsOptional()
  @IsBoolean()
  add_security_recommendation?: boolean;

  @ApiPropertyOptional({ description: 'AUTHENTICATION FOOTER — code expiry in minutes (1–90)' })
  @IsOptional()
  @IsInt()
  code_expiration_minutes?: number;

  @ApiPropertyOptional({ description: 'BUTTONS only — array of button objects', type: [TemplateButtonDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateButtonDto)
  buttons?: TemplateButtonDto[];
}

/**
 * Body for creating a message template.
 * Maps to Meta `POST /{waba-id}/message_templates`.
 */
export class CreateTemplateDto {
  @ApiProperty({ description: 'Lowercase letters, numbers and underscores only', maxLength: 512, example: 'order_shipped' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  @Matches(/^[a-z0-9_]+$/, {
    message: 'name must contain only lowercase letters, numbers and underscores',
  })
  name: string;

  @ApiProperty({ enum: TemplateCategory })
  @IsEnum(TemplateCategory)
  category: TemplateCategory;

  @ApiProperty({ description: 'BCP-47 language / locale code', example: 'en_US' })
  @IsString()
  @IsNotEmpty()
  language: string;

  @ApiPropertyOptional({ enum: TemplateParameterFormat, description: 'Variable style — POSITIONAL ({{1}}) or NAMED ({{name}})' })
  @IsOptional()
  @IsEnum(TemplateParameterFormat)
  parameterFormat?: TemplateParameterFormat;

  @ApiProperty({ type: [TemplateComponentDto], description: 'HEADER / BODY / FOOTER / BUTTONS components' })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TemplateComponentDto)
  components: TemplateComponentDto[];
}
