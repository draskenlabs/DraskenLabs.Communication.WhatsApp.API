import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthCallbackDto } from './dto/callback.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { CreateOrgDto, OrgSummaryDto, OrgTokenResponseDto, SelectOrgDto } from './dto/org.dto';
import { ApiStandardErrorResponses, ApiWrappedOkResponse } from 'src/common/responses/swagger.decorators';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly jwtService: JwtService,
  ) {}

  @Post('callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange SSO auth code for a session token',
    description:
      'Completes the PKCE Authorization Code flow. The browser is redirected to DraskenLabs SSO ' +
      '(`${SSO_ACCOUNTS_URL}/authorize`) where the user signs in — this API never sees the password — ' +
      'then sent back to the web app with a single-use `code`. The web app posts that `code` and the ' +
      'original `codeVerifier` here; the API completes the confidential token exchange server-side and ' +
      'returns a **session** JWT (no organisation yet) plus the user\'s organisations. The client then ' +
      'selects one via `POST /auth/select-org` or creates one via `POST /auth/organisations`.',
  })
  @ApiWrappedOkResponse({ dataDto: AuthResponseDto, description: 'Authenticated; organisation selection required' })
  @ApiStandardErrorResponses({ unauthorized: true, validation: true })
  async callback(@Body() dto: AuthCallbackDto): Promise<AuthResponseDto> {
    return this.authService.handleCallback(dto);
  }

  @Get('organisations')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List the organisations the signed-in user can enter' })
  @ApiWrappedOkResponse({ dataDto: OrgSummaryDto, isArray: true, description: 'Organisations for the session user' })
  @ApiStandardErrorResponses({ unauthorized: true })
  async listOrganisations(@Headers('authorization') authHeader?: string): Promise<OrgSummaryDto[]> {
    const { sessionId } = await this.session(authHeader);
    return this.authService.listOrganisations(sessionId);
  }

  @Post('organisations')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new organisation and switch into it' })
  @ApiWrappedOkResponse({ dataDto: OrgTokenResponseDto, description: 'Org created; org-scoped token issued' })
  @ApiStandardErrorResponses({ unauthorized: true, badRequest: true, validation: true })
  async createOrganisation(
    @Body() dto: CreateOrgDto,
    @Headers('authorization') authHeader?: string,
  ): Promise<OrgTokenResponseDto> {
    const { sub, sessionId } = await this.session(authHeader);
    return this.authService.createOrganisation(sub, sessionId, dto.name);
  }

  @Post('select-org')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Switch into one of the user\'s organisations (re-issues the app token)' })
  @ApiWrappedOkResponse({ dataDto: OrgTokenResponseDto, description: 'Org-scoped token issued' })
  @ApiStandardErrorResponses({ unauthorized: true, forbidden: true, validation: true })
  async selectOrg(
    @Body() dto: SelectOrgDto,
    @Headers('authorization') authHeader?: string,
  ): Promise<OrgTokenResponseDto> {
    const { sub, sessionId } = await this.session(authHeader);
    return this.authService.selectOrg(sub, sessionId, dto.orgId);
  }

  /** Verifies the app JWT (session or org-scoped) and extracts the user id + session id. */
  private async session(authHeader?: string): Promise<{ sub: number; sessionId: string }> {
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
    if (!token) throw new UnauthorizedException('No token provided');
    try {
      const payload = await this.jwtService.verifyAsync(token);
      if (!payload?.sub || !payload?.sessionId) {
        throw new UnauthorizedException('Invalid session token');
      }
      return { sub: payload.sub, sessionId: payload.sessionId };
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid token');
    }
  }
}
