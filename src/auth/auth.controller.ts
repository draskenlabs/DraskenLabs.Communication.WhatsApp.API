import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AuthService, SessionTokens } from './auth.service';
import { AuthCallbackDto } from './dto/callback.dto';
import { AuthSessionDto, SessionTokenDto } from './dto/auth-response.dto';
import { RefreshDto } from './dto/refresh.dto';
import {
  CreateOrgDto,
  OrgSummaryDto,
  OrgAccessResponseDto,
  SelectOrgDto,
} from './dto/org.dto';
import {
  clearRefreshCookie,
  readRefreshToken,
  setRefreshCookie,
} from './refresh-cookie';
import {
  ApiStandardErrorResponses,
  ApiWrappedOkResponse,
} from 'src/common/responses/swagger.decorators';

/** What `AuthMiddleware` puts on an authenticated request. */
type AuthedRequest = Request & { sessionId?: string; ssoAccessToken?: string };

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange the SSO auth code for the session',
    description:
      'Completes the PKCE Authorization Code flow. The browser is redirected to DraskenLabs SSO ' +
      '(`${SSO_ACCOUNTS_URL}/authorize`) where the user signs in — this API never sees the password — ' +
      'then sent back to the web app with a single-use `code`. The web app posts that `code` and the ' +
      'original `codeVerifier` here; the API completes the confidential token exchange server-side.\n\n' +
      "What comes back is the **SSO's own** access token, not one this API signed: send it as " +
      "`Authorization: Bearer` and it is verified against the SSO's published keys. The refresh token " +
      "is set as an HttpOnly cookie and never appears in the body. The response also lists the user's " +
      'organisations — pick one with `POST /auth/select-org`, then name it in `X-Org-Id`.',
  })
  @ApiWrappedOkResponse({
    dataDto: AuthSessionDto,
    description: 'Signed in; organisation selection required',
  })
  @ApiStandardErrorResponses({ unauthorized: true, validation: true })
  async callback(
    @Body() dto: AuthCallbackDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionDto> {
    const { body, tokens } = await this.authService.handleCallback(dto);
    this.issue(res, tokens);
    return {
      ...body,
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
      tokenType: tokens.tokenType,
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mint a new access token from the refresh token',
    description:
      'Browser callers send nothing — the HttpOnly cookie travels on its own with ' +
      '`credentials: "include"`. A caller that stores the token itself may send it in the body. ' +
      'The refresh token is rotated on every use and the new one replaces the cookie.',
  })
  @ApiWrappedOkResponse({
    dataDto: SessionTokenDto,
    description: 'A fresh access token',
  })
  @ApiStandardErrorResponses({ unauthorized: true })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto?: RefreshDto,
  ): Promise<SessionTokenDto> {
    const refreshToken = readRefreshToken(req, dto?.refreshToken);
    if (!refreshToken) throw new UnauthorizedException('No refresh token');

    try {
      const tokens = await this.authService.refresh(refreshToken);
      this.issue(res, tokens);
      return {
        accessToken: tokens.accessToken,
        expiresIn: tokens.expiresIn,
        tokenType: tokens.tokenType,
      };
    } catch (err) {
      // The cookie is spent or was refused. Leaving it in place would send the
      // browser back here on every load to be refused again — and, if the SSO
      // read it as a replay, the session it names is already gone.
      clearRefreshCookie(res, this.config);
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'End the session, here and at the SSO',
    description:
      'Revokes the session at the SSO — so every Drasken application sharing it is told — drops the ' +
      'organisation grants held here, and clears the refresh cookie.',
  })
  @ApiStandardErrorResponses({ unauthorized: true })
  async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<null> {
    await this.authService.logout(this.sessionId(req), this.ssoToken(req));
    clearRefreshCookie(res, this.config);
    return null;
  }

  @Get('organisations')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List the organisations the signed-in user can enter',
  })
  @ApiWrappedOkResponse({
    dataDto: OrgSummaryDto,
    isArray: true,
    description: 'Organisations for the session user',
  })
  @ApiStandardErrorResponses({ unauthorized: true })
  async listOrganisations(@Req() req: AuthedRequest): Promise<OrgSummaryDto[]> {
    return this.authService.listOrganisations(
      this.sessionId(req),
      this.ssoToken(req),
    );
  }

  @Post('organisations')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new organisation and enter it' })
  @ApiWrappedOkResponse({
    dataDto: OrgAccessResponseDto,
    description: 'Org created; grant recorded',
  })
  @ApiStandardErrorResponses({
    unauthorized: true,
    badRequest: true,
    validation: true,
  })
  async createOrganisation(
    @Body() dto: CreateOrgDto,
    @Req() req: AuthedRequest,
  ): Promise<OrgAccessResponseDto> {
    return this.authService.createOrganisation(
      this.sessionId(req),
      dto.name,
      this.ssoToken(req),
    );
  }

  @Post('select-org')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Enter one of the user's organisations",
    description:
      'Records the grant against the session and answers with the id to send in `X-Org-Id`. ' +
      'No token is issued — the SSO access token you already hold is the credential.',
  })
  @ApiWrappedOkResponse({
    dataDto: OrgAccessResponseDto,
    description: 'Grant recorded',
  })
  @ApiStandardErrorResponses({
    unauthorized: true,
    forbidden: true,
    validation: true,
  })
  async selectOrg(
    @Body() dto: SelectOrgDto,
    @Req() req: AuthedRequest,
  ): Promise<OrgAccessResponseDto> {
    return this.authService.selectOrg(
      this.sessionId(req),
      dto.orgId,
      this.ssoToken(req),
    );
  }

  /** Puts the rotated refresh token back in the cookie. */
  private issue(res: Response, tokens: SessionTokens): void {
    const ttl = Number(
      this.config.get<string>('SSO_REFRESH_TOKEN_TTL') ?? 2592000,
    );
    setRefreshCookie(res, this.config, tokens.refreshToken, ttl);
  }

  private sessionId(req: AuthedRequest): string {
    if (!req.sessionId) throw new UnauthorizedException('Invalid session');
    return req.sessionId;
  }

  private ssoToken(req: AuthedRequest): string {
    if (!req.ssoAccessToken)
      throw new UnauthorizedException('No token provided');
    return req.ssoAccessToken;
  }
}
