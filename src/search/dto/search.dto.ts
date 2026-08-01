import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** The things a console search can turn up. */
export const SEARCH_TYPES = [
  'contact',
  'template',
  'message',
  'waba',
  'phoneNumber',
] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

/** Query for `GET /search`. */
export class SearchQueryDto {
  @ApiProperty({
    description: 'What to look for — a name, a phone number, an ID, a template',
    example: 'jane',
  })
  @IsString()
  q: string;

  @ApiPropertyOptional({
    description:
      'How many results per type, 1–20 (default 5). The overlay shows a few ' +
      'of each rather than a hundred of one.',
    minimum: 1,
    maximum: 20,
    default: 5,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'Restrict to these types. Repeat the parameter or pass a comma-' +
      'separated list. Omit to search everything.',
    isArray: true,
    enum: SEARCH_TYPES,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Type(() => String)
  types?: string[];
}

/** One hit, in the shape the console renders it. */
export class SearchResultDto {
  @ApiProperty({ enum: SEARCH_TYPES })
  type: SearchType;

  @ApiProperty({
    description: 'Identifier for the link — a row id, a WABA id, a phone id',
    example: '42',
  })
  id: string;

  @ApiProperty({
    description: 'The headline — a contact name, a template name',
    example: 'Jane Doe',
  })
  title: string;

  @ApiPropertyOptional({
    description: 'Supporting line — a phone number, a recipient, a language',
    example: '+44 7911 123456',
  })
  subtitle?: string;

  @ApiPropertyOptional({
    description: 'A third line, only where there is something worth saying',
    example: 'jane@example.com',
  })
  description?: string;

  @ApiPropertyOptional({
    description: 'Status or category, rendered as a pill',
    example: 'APPROVED',
  })
  badge?: string;

  @ApiPropertyOptional({
    description: 'When it happened, for results where recency is meaningful',
  })
  timestamp?: Date;
}

/** Hits of one type, kept together so the console can label the section. */
export class SearchGroupDto {
  @ApiProperty({ enum: SEARCH_TYPES })
  type: SearchType;

  @ApiProperty({
    description: 'How many matched in total, which may exceed `items.length`',
    example: 37,
  })
  total: number;

  @ApiProperty({ type: [SearchResultDto] })
  items: SearchResultDto[];
}

/** Response of `GET /search`. */
export class SearchResponseDto {
  @ApiProperty({ description: 'The query as it was searched, trimmed' })
  query: string;

  @ApiProperty({
    description: 'Total matches across every type, before the per-type limit',
    example: 41,
  })
  total: number;

  @ApiProperty({
    type: [SearchGroupDto],
    description: 'Only types with at least one hit, most useful first',
  })
  groups: SearchGroupDto[];
}
