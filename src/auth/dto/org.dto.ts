import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class SelectOrgDto {
  @ApiProperty({
    description:
      'Id of the organisation to switch into (must be one the user belongs to)',
  })
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

  @ApiPropertyOptional({
    description:
      'Set only on a client organisation: the agency that manages and pays ' +
      'for it. Absent on an organisation the user belongs to directly.',
  })
  agencyOrgId?: string;
}

/**
 * Response of `POST /auth/select-org` and `POST /auth/organisations`.
 *
 * No token: the credential is the SSO access token the caller already holds,
 * and entering an organisation records a grant against the session rather than
 * minting a second credential. `orgId` is what the caller sends in `X-Org-Id`
 * from here on.
 */
export class OrgAccessResponseDto {
  @ApiProperty({
    description: 'Send this as `X-Org-Id` on subsequent requests',
  })
  orgId: string;

  @ApiProperty({ type: OrgSummaryDto })
  organisation: OrgSummaryDto;

  @ApiProperty({
    description:
      '`owner` or `member` for a membership, `agency` inside a managed client',
  })
  role: string;

  @ApiPropertyOptional({
    description:
      'Present only when an agency is acting inside one of its clients: the ' +
      'agency organisation doing the acting.',
  })
  agencyOrgId?: string;
}
