import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class AuthCallbackDto {
  @ApiProperty({ description: 'Single-use authorization code returned by the SSO redirect to the web app' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ description: 'PKCE code verifier that matches the codeChallenge sent on the authorize redirect' })
  @IsString()
  @IsNotEmpty()
  codeVerifier: string;
}
