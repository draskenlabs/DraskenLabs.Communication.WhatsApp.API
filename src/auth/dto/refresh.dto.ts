import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class RefreshDto {
  @ApiPropertyOptional({
    description:
      'Omit in a browser — the HttpOnly cookie is used. Required only for a ' +
      'caller that stores the refresh token itself.',
  })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
