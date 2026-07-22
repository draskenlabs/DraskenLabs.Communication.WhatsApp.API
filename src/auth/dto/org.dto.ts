import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class SelectOrgDto {
  @ApiProperty({ description: 'Id of the organisation to switch into (must be one the user belongs to)' })
  @IsString()
  @IsNotEmpty()
  orgId: string;
}

export class CreateOrgDto {
  @ApiProperty({ description: 'Name of the organisation to create' })
  @IsString()
  @IsNotEmpty()
  name: string;
}

export class OrgSummaryDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional() slug?: string;
}

/** Response of `POST /auth/select-org` and `POST /auth/organisations`. */
export class OrgTokenResponseDto {
  @ApiProperty({ description: 'App JWT scoped to the selected organisation' })
  access_token: string;

  @ApiProperty({ description: 'The organisation the token is scoped to' })
  orgId: string;

  @ApiProperty({ type: OrgSummaryDto })
  organisation: OrgSummaryDto;
}
