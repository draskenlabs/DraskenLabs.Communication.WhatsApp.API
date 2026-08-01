import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * Copying approved templates from one WhatsApp Business Account to another —
 * `POST /{destination-waba-id}/migrate_message_templates`.
 *
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-migration
 */
export class MigrateTemplatesDto {
  @ApiProperty({ description: 'WABA to copy templates from' })
  @IsString()
  @IsNotEmpty()
  sourceWabaId: string;

  @ApiPropertyOptional({
    description: 'Zero-indexed page, for migrating an account in batches',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  pageNumber?: number;

  @ApiPropertyOptional({ description: 'Batch size, max 500' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  count?: number;

  @ApiPropertyOptional({
    description:
      'Specific Meta template ids to migrate, max 500. Omit to migrate everything eligible',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  templateIds?: string[];
}

/** What Meta migrated, and what it would not. */
export class MigrateTemplatesResultDto {
  @ApiProperty({
    type: [String],
    description: 'Meta ids of the templates copied across',
  })
  migratedTemplates: string[];

  @ApiProperty({
    description:
      'Meta id → why it was refused. Templates must be APPROVED with a GREEN or UNKNOWN quality score',
    additionalProperties: { type: 'string' },
  })
  failedTemplates: Record<string, string>;

  @ApiProperty({ description: 'How many were copied' })
  migratedCount: number;

  @ApiProperty({ description: 'How many were refused' })
  failedCount: number;
}
