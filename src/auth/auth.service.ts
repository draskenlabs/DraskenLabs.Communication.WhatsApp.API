import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SsoService, OrgSummary } from './sso.service';
import { UserService } from 'src/user/user.service';
import { RedisService } from 'src/redis/redis.service';
import { OrgDirectoryService } from 'src/org/org-directory.service';
import { AuthCallbackDto } from './dto/callback.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { OrgTokenResponseDto } from './dto/org.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly ssoService: SsoService,
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
    private readonly orgDirectory: OrgDirectoryService,
  ) {}

  /**
   * Completes the PKCE exchange and starts a session. Returns a **session** JWT
   * (no org) plus the user's organisations. The client then selects or creates
   * an org to obtain an org-scoped token. The user's SSO access token + org
   * membership are cached server-side so org list/create/switch can run behind
   * the app JWT without exposing the SSO token to the browser.
   */
  async handleCallback(dto: AuthCallbackDto): Promise<AuthResponseDto> {
    const tokens = await this.ssoService.exchangeCode(dto.code, dto.codeVerifier);
    const ssoUser = this.ssoService.decodeUserInfo(tokens.accessToken);

    const organisations = await this.ssoService.listOrganizations(tokens.accessToken);
    // The access token has no name claims, so the display name has to come
    // from the SSO profile endpoint. Best-effort: login still succeeds without
    // it, falling back to what the token does carry.
    const profile = await this.ssoService.getProfile(tokens.accessToken);

    // Contact details are stored locally so background jobs and webhooks can
    // email this person without a token of theirs to call SSO with.
    const user = await this.userService.findOrCreateBySsoId(ssoUser.ssoId, {
      email: profile?.email || ssoUser.email,
      firstName: profile?.firstName || ssoUser.firstName,
      lastName: profile?.lastName || ssoUser.lastName,
    });

    const sessionId = await this.redisService.createSessionId();
    await this.redisService.setSsoSession(sessionId, {
      ssoId: ssoUser.ssoId,
      ssoAccessToken: tokens.accessToken,
      email: profile?.email || ssoUser.email,
      firstName: profile?.firstName || ssoUser.firstName,
      lastName: profile?.lastName || ssoUser.lastName,
      username: profile?.username ?? '',
      emailVerified: profile?.emailVerified ?? false,
      imageUrl: profile?.imageUrl ?? '',
      ssoCreatedAt: profile?.createdAt ?? null,
      orgs: organisations,
    });

    // The only moment anything here learns what an organisation is called.
    // Cached now so a webhook or a billing cron can name it later.
    await this.orgDirectory.remember(organisations);

    const access_token = await this.jwtService.signAsync({ sub: user.id, sessionId });
    return { access_token, user, organisations };
  }

  /** Lists the organisations the session user can enter. */
  async listOrganisations(sessionId: string): Promise<OrgSummary[]> {
    const session = await this.getSession(sessionId);
    return session.orgs;
  }

  /** Re-issues an org-scoped token for an organisation the user belongs to. */
  async selectOrg(userId: number, sessionId: string, orgId: string): Promise<OrgTokenResponseDto> {
    const session = await this.getSession(sessionId);
    const org = session.orgs.find((o) => o.id === orgId);
    if (!org) {
      throw new ForbiddenException('You are not a member of this organisation');
    }
    return this.issueOrgToken(userId, sessionId, org, 'member');
  }

  /** Creates a new organisation in the SSO and returns an org-scoped token for it. */
  async createOrganisation(userId: number, sessionId: string, name: string): Promise<OrgTokenResponseDto> {
    const session = await this.getSession(sessionId);
    const org = await this.ssoService.createOrganization(session.ssoAccessToken, name);

    const orgs = [...session.orgs.filter((o) => o.id !== org.id), org];
    await this.redisService.setSsoSession(sessionId, { ...session, orgs });

    return this.issueOrgToken(userId, sessionId, org, 'owner');
  }

  private async getSession(sessionId: string) {
    const session = await this.redisService.getSsoSession(sessionId);
    if (!session) {
      throw new UnauthorizedException('Session expired — please sign in again');
    }
    return session;
  }

  private async issueOrgToken(
    userId: number,
    sessionId: string,
    org: OrgSummary,
    role: string,
  ): Promise<OrgTokenResponseDto> {
    await this.orgDirectory.remember([org]);
    const access_token = await this.jwtService.signAsync({ sub: userId, orgId: org.id, role, sessionId });
    return { access_token, orgId: org.id, organisation: org };
  }
}
