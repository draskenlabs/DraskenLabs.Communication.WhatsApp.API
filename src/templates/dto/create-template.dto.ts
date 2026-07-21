import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
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

  @ApiPropertyOptional({ description: 'BUTTONS only — array of button objects', type: 'array', items: { type: 'object' } })
  @IsOptional()
  @IsArray()
  buttons?: Record<string, unknown>[];
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
