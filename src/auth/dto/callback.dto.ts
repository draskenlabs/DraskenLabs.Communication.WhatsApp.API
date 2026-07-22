import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class AuthCallbackDto {
  @ApiProperty({ description: 'Authorization code received from GET /auth/authorize' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ description: 'PKCE code verifier that matches the codeChallenge sent to authorize' })
  @IsString()
  @IsNotEmpty()
  codeVerifier: string;
}
