import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { TemplateCategory } from '@prisma/client';
import { TemplateComponentDto } from './create-template.dto';

/**
 * Body for editing an existing message template.
 * Maps to Meta `POST /{message-template-id}` — only `components` and `category`
 * are editable, and only while the template is not APPROVED (category may be
 * changed on approved templates). Name and language are immutable after
 * creation, so they are intentionally absent here.
 */
export class UpdateTemplateDto {
  @ApiPropertyOptional({ enum: TemplateCategory })
  @IsOptional()
  @IsEnum(TemplateCategory)
  category?: TemplateCategory;

  @ApiPropertyOptional({ type: [TemplateComponentDto], description: 'Replacement HEADER / BODY / FOOTER / BUTTONS components' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TemplateComponentDto)
  components?: TemplateComponentDto[];
}
