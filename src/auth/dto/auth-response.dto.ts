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
 * `accessToken` is the **SSO's own** RS256 access token — this API signs
 * nothing of its own any more. It is short-lived (ten minutes by default);
 * `POST /auth/refresh` mints the next one from the refresh token, which stays
 * in an HttpOnly cookie and never reaches page scripts.
 *
 * It carries no organisation, because the SSO does not know what one means
 * here. `organisations` is what the user may enter; the client picks one via
 * `/auth/select-org` (or `/auth/organisations`) and then names it in the
 * `X-Org-Id` header on every request.
 */
export class AuthResponseDto {
  @ApiProperty({ type: AuthUserDto })
  user: AuthUserDto;

  @ApiProperty({ type: OrgSummaryDto, isArray: true })
  organisations: OrgSummaryDto[];
}

/** The half of a token pair a browser is allowed to hold. */
export class SessionTokenDto {
  @ApiProperty({
    description: 'SSO access token — verify it against the SSO JWKS',
  })
  accessToken: string;

  @ApiProperty({ description: 'Seconds until the access token expires' })
  expiresIn: number;

  @ApiProperty({ example: 'Bearer' })
  tokenType: string;
}

/** Response of `POST /auth/callback` — the session plus its access token. */
export class AuthSessionDto extends AuthResponseDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty()
  expiresIn: number;

  @ApiProperty({ example: 'Bearer' })
  tokenType: string;
}
