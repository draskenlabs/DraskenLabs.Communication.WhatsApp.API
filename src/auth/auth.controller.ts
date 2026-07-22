import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { AuthCallbackDto } from './dto/callback.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { ApiStandardErrorResponses, ApiWrappedOkResponse } from 'src/common/responses/swagger.decorators';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange SSO auth code for an access token',
    description:
      'Completes the PKCE Authorization Code flow. The browser is redirected to DraskenLabs SSO ' +
      '(`${SSO_ACCOUNTS_URL}/authorize`) where the user signs in — this API never sees the password — ' +
      'then sent back to the web app with a single-use `code`. The web app posts that `code` and the ' +
      'original `codeVerifier` here; the API completes the confidential token exchange server-side (with ' +
      'the client secret) and returns a signed JWT scoped to this API.',
  })
  @ApiWrappedOkResponse({ dataDto: AuthResponseDto, description: 'Authenticated successfully' })
  @ApiStandardErrorResponses({ unauthorized: true, validation: true })
  async callback(@Body() dto: AuthCallbackDto): Promise<AuthResponseDto> {
    return this.authService.handleCallback(dto);
  }
}
