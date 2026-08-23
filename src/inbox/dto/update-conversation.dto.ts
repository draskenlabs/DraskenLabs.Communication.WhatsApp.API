import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, ValidateIf } from 'class-validator';

export enum ConversationStatusEnum {
  open = 'open',
  closed = 'closed',
}

/** How a team marks a thread up: dealt with, or someone's to deal with. */
export class UpdateConversationDto {
  @ApiPropertyOptional({
    enum: ConversationStatusEnum,
    description:
      'Closing means "dealt with". A new reply from the customer reopens it — ' +
      'their writing again is evidence that it was not.',
  })
  @IsOptional()
  @IsEnum(ConversationStatusEnum)
  status?: ConversationStatusEnum;

  @ApiPropertyOptional({
    description:
      'Team member dealing with this thread. Null clears the assignment.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  assigneeUserId?: number | null;
}
