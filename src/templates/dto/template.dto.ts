import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TemplateCategory, TemplateStatus } from '@prisma/client';

export class TemplateResponseDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  metaTemplateId: string;

  @ApiProperty()
  wabaId: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  language: string;

  @ApiProperty({ enum: TemplateCategory })
  category: TemplateCategory;

  @ApiProperty({ enum: TemplateStatus })
  status: TemplateStatus;

  @ApiProperty({ description: 'Template components array from Meta' })
  components: any;

  @ApiPropertyOptional()
  rejectedReason?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class TemplateSyncResponseDto {
  @ApiProperty()
  synced: number;

  @ApiProperty()
  wabaId: string;
}

/**
 * How many templates sit behind each status, across every page. The console's
 * status filter shows these next to its options, which client-side counting
 * cannot do once the list is paginated server-side.
 */
export class TemplateStatusCountsDto {
  @ApiProperty({ description: 'Templates in scope, whatever their status' })
  total: number;

  @ApiProperty({
    description: 'Count per status; a status with no templates is omitted',
    example: { APPROVED: 12, PENDING: 1, REJECTED: 3 },
    additionalProperties: { type: 'number' },
  })
  byStatus: Record<string, number>;
}
