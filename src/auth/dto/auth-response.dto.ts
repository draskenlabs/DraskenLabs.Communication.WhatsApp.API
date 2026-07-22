import { ApiProperty } from '@nestjs/swagger';
import { OrgSummaryDto } from './org.dto';

export class AuthUserDto {
  @ApiProperty() id: number;
  @ApiProperty() ssoId: string;
  @ApiProperty() createdAt: Date;
}

/**
 * Response of `POST /auth/callback`.
 *
 * The `access_token` is a **session** JWT (identifies the user, carries no
 * organisation) — the client must select or create an organisation via
 * `/auth/select-org` or `/auth/organisations` to obtain an org-scoped token
 * before calling business endpoints. `organisations` lists what the user can
 * choose from (empty → they must create one).
 */
export class AuthResponseDto {
  @ApiProperty({ description: 'Session JWT — not yet scoped to an organisation' })
  access_token: string;

  @ApiProperty({ type: AuthUserDto })
  user: AuthUserDto;

  @ApiProperty({ type: OrgSummaryDto, isArray: true })
  organisations: OrgSummaryDto[];
}
