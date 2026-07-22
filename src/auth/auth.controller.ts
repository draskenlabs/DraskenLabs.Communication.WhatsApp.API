import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { AuthCallbackDto } from './dto/callback.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { AuthorizeQueryDto, AuthorizeResponseDto } from './dto/authorize.dto';
import { ApiStandardErrorResponses, ApiWrappedOkResponse } from 'src/common/responses/swagger.decorators';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('authorize')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get an SSO authorization code',
    description:
      'Requests a single-use authorization code from DraskenLabs SSO on behalf of the user. ' +
      'Pass the **user\'s SSO access token** as `Authorization: Bearer <sso_access_token>` — the API forwards it ' +
      'to the SSO. Provide the `codeChallenge` (SHA-256 hash of your locally generated `codeVerifier`, base64url ' +
      'encoded) and the `redirectUri`. Returns a `code` (expires in 60s) and a `state` to verify, which you then ' +
      'exchange via `POST /auth/callback` with the matching `codeVerifier`.',
  })
  @ApiWrappedOkResponse({ dataDto: AuthorizeResponseDto, description: 'SSO authorization code and state token' })
  @ApiStandardErrorResponses({ unauthorized: true, validation: true })
  async authorize(
    @Query() query: AuthorizeQueryDto,
    @Headers('authorization') authHeader?: string,
  ): Promise<AuthorizeResponseDto> {
    const ssoToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
    if (!ssoToken) {
      throw new UnauthorizedException('Missing SSO access token');
    }
    return this.authService.authorize(ssoToken, query.redirectUri, query.codeChallenge);
  }

  @Post('callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange SSO auth code for an access token',
    description:
      'Completes the PKCE flow. After obtaining a `code` from `GET /auth/authorize`, call this endpoint ' +
      'with the code and the original `codeVerifier` to exchange it (server-side, with the confidential ' +
      'client secret) for a signed JWT scoped to this API.',
  })
  @ApiWrappedOkResponse({ dataDto: AuthResponseDto, description: 'Authenticated successfully' })
  @ApiStandardErrorResponses({ unauthorized: true, validation: true })
  async callback(@Body() dto: AuthCallbackDto): Promise<AuthResponseDto> {
    return this.authService.handleCallback(dto);
  }
}
