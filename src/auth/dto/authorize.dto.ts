import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class AuthorizeQueryDto {
  @ApiProperty({ description: 'Redirect URI registered with the SSO client — must match the one used at token exchange' })
  @IsString()
  @IsNotEmpty()
  redirectUri: string;

  @ApiProperty({ description: 'PKCE code challenge — SHA-256 hash of codeVerifier, base64url encoded' })
  @IsString()
  @IsNotEmpty()
  codeChallenge: string;
}

export class AuthorizeResponseDto {
  @ApiProperty({ description: 'Single-use authorization code from SSO (expires in 60s) — pass to POST /auth/callback' })
  code: string;

  @ApiProperty({ description: 'State token correlating this authorize request — verify it on the callback' })
  state: string;

  @ApiProperty({ description: 'Redirect URI echoed back by SSO' })
  redirectUri: string;
}
