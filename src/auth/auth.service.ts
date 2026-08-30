import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { SsoService, OrgSummary, SsoTokenData } from './sso.service';
import { SsoTokenService } from './sso-token.service';
import { OrgAccessService } from './org-access.service';
import { UserService } from 'src/user/user.service';
import { RedisService } from 'src/redis/redis.service';
import { OrgDirectoryService } from 'src/org/org-directory.service';
import { AuthCallbackDto } from './dto/callback.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { OrgAccessResponseDto } from './dto/org.dto';

/** What a caller needs to keep a session alive, and where to put each half. */
export interface SessionTokens {
  accessToken: string;
  /** Never returned to the browser — the controller puts it in a cookie. */
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}

/** How long a concurrent refresh waits for the one that took the lock. */
const REFRESH_WAIT_MS = 2000;
const REFRESH_POLL_MS = 100;

@Injectable()
export class AuthService {
  constructor(
    private readonly ssoService: SsoService,
    private readonly ssoToken: SsoTokenService,
    private readonly orgAccess: OrgAccessService,
    private readonly userService: UserService,
    private readonly redisService: RedisService,
    private readonly orgDirectory: OrgDirectoryService,
  ) {}

  /**
   * Completes the PKCE exchange and starts a session.
   *
   * What comes back is the **SSO's** access token, not one this API signed.
   * Everything downstream verifies it against the SSO's published keys, so
   * there is one credential in play rather than two, and it ends when the SSO
   * says it ends instead of when a locally-issued copy happens to expire.
   *
   * The session record keyed by the token's `sid` holds what the SSO cannot
   * answer: which organisations this person may enter here. It holds no token
   * of theirs — every request now carries the live one.
   */
  async handleCallback(
    dto: AuthCallbackDto,
  ): Promise<{ body: AuthResponseDto; tokens: SessionTokens }> {
    const tokens = await this.ssoService.exchangeCode(
      dto.code,
      dto.codeVerifier,
    );
    // Verified rather than merely decoded: this is the first time the token is
    // seen, and the `sid` the whole session is keyed on has to be one the SSO
    // actually signed for this client.
    const claims = await this.ssoToken.verify(tokens.accessToken);
    const ssoUser = this.ssoService.decodeUserInfo(tokens.accessToken);

    const organisations = await this.ssoService.listOrganizations(
      tokens.accessToken,
    );
    // The access token has no name claims, so the display name has to come
    // from the SSO profile endpoint. Best-effort: login still succeeds without
    // it, falling back to what the token does carry.
    const profile = await this.ssoService.getProfile(tokens.accessToken);

    // Contact details are stored locally so background jobs and webhooks can
    // email this person without a token of theirs to call SSO with.
    const user = await this.userService.findOrCreateBySsoId(ssoUser.ssoId, {
      email: profile?.email || claims.email || ssoUser.email,
      firstName: profile?.firstName || ssoUser.firstName,
      lastName: profile?.lastName || ssoUser.lastName,
    });

    await this.redisService.setSsoSession(claims.sid, {
      ssoId: ssoUser.ssoId,
      email: profile?.email || claims.email || ssoUser.email,
      firstName: profile?.firstName || ssoUser.firstName,
      lastName: profile?.lastName || ssoUser.lastName,
      username: profile?.username ?? '',
      emailVerified: profile?.emailVerified ?? false,
      imageUrl: profile?.imageUrl ?? '',
      ssoCreatedAt: profile?.createdAt ?? null,
      orgs: organisations,
      grants: {},
    });

    // The only moment anything here learns what an organisation is called.
    // Cached now so a webhook or a billing cron can name it later.
    await this.orgDirectory.remember(organisations);

    return {
      body: {
        user,
        organisations: await this.orgAccess.withClients(organisations),
      },
      tokens: this.sessionTokens(tokens),
    };
  }

  /**
   * Trades the refresh token for a new access token.
   *
   * Serialised per token, because the SSO rotates on use and reads a second
   * presentation of the same token as theft — it revokes the entire session
   * family. Two tabs waking together share one cookie, so without this they
   * would sign the user out between them. The winner's pair is cached for a
   * minute and handed to anyone still holding the token it spent.
   */
  async refresh(refreshToken: string): Promise<SessionTokens> {
    const hash = createHash('sha256').update(refreshToken).digest('hex');

    const cached = await this.redisService.getRefreshResult<SsoTokenData>(hash);
    if (cached) return this.sessionTokens(cached);

    if (!(await this.redisService.takeRefreshLock(hash))) {
      const shared = await this.waitForRefresh(hash);
      if (shared) return this.sessionTokens(shared);
      throw new UnauthorizedException('Could not refresh the session');
    }

    try {
      const tokens = await this.ssoService.refreshTokens(refreshToken);
      await this.redisService.setRefreshResult(hash, tokens);
      return this.sessionTokens(tokens);
    } catch (err) {
      // Released rather than left to expire: a refresh that failed because the
      // SSO was briefly unreachable should be retryable on the next request,
      // not ten seconds later.
      await this.redisService.releaseRefreshLock(hash);
      throw err;
    }
  }

  /**
   * Ends the session — at the SSO, so every application sharing it is told,
   * and here, so the grants go with it.
   */
  async logout(sessionId: string, ssoAccessToken: string): Promise<void> {
    await this.ssoService.logout(ssoAccessToken);
    await this.redisService.deleteSsoSession(sessionId);
  }

  /** Lists the organisations the session user can enter. */
  async listOrganisations(
    sessionId: string,
    ssoAccessToken: string,
  ): Promise<OrgSummary[]> {
    const session = await this.redisService.getSsoSession(sessionId);
    const orgs =
      session?.orgs ??
      (await this.ssoService.listOrganizations(ssoAccessToken));
    return this.orgAccess.withClients(orgs);
  }

  /**
   * Enters an organisation the user may enter.
   *
   * This used to re-issue a token with the organisation baked in. It no longer
   * issues anything: the credential is the SSO's, so what this does is record
   * the grant against the session and tell the caller what it may send in
   * `X-Org-Id`. Switching organisation is now a fact about the session, not a
   * second token to keep in step with the first.
   */
  async selectOrg(
    sessionId: string,
    orgId: string,
    ssoAccessToken: string,
  ): Promise<OrgAccessResponseDto> {
    const grant = await this.orgAccess.grantFor(
      sessionId,
      orgId,
      ssoAccessToken,
    );
    if (!grant) {
      throw new UnauthorizedException(
        'You are not a member of this organisation',
      );
    }

    const org = await this.describe(sessionId, orgId, grant.agencyOrgId);
    await this.orgDirectory.remember([org]);
    return {
      orgId,
      organisation: org,
      role: grant.role,
      ...(grant.agencyOrgId ? { agencyOrgId: grant.agencyOrgId } : {}),
    };
  }

  /** Creates a new organisation in the SSO and enters it. */
  async createOrganisation(
    sessionId: string,
    name: string,
    ssoAccessToken: string,
  ): Promise<OrgAccessResponseDto> {
    const org = await this.ssoService.createOrganization(ssoAccessToken, name);

    const session = await this.redisService.getSsoSession(sessionId);
    if (session) {
      await this.redisService.setSsoSession(sessionId, {
        ...session,
        orgs: [...session.orgs.filter((o) => o.id !== org.id), org],
      });
    }
    // Recorded rather than resolved: the SSO's membership list is a moment
    // behind a creation this request made, and the creator is its owner.
    await this.orgAccess.record(sessionId, org.id, { role: 'owner' });
    await this.orgDirectory.remember([org]);

    return { orgId: org.id, organisation: org, role: 'owner' };
  }

  /** The organisation as the switcher should show it. */
  private async describe(
    sessionId: string,
    orgId: string,
    agencyOrgId?: string,
  ): Promise<OrgSummary> {
    const session = await this.redisService.getSsoSession(sessionId);
    // Through the same list the switcher is built from, so an organisation is
    // named identically whether it was picked from that list or entered here.
    const known = await this.orgAccess.withClients(session?.orgs ?? []);
    const found = known.find((o) => o.id === orgId);
    if (found) return found;
    return {
      id: orgId,
      name: (await this.orgDirectory.name(orgId)) ?? 'Client',
      ...(agencyOrgId ? { agencyOrgId } : {}),
    };
  }

  private sessionTokens(tokens: SsoTokenData): SessionTokens {
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      tokenType: tokens.tokenType ?? 'Bearer',
    };
  }

  /** Polls for the pair the caller holding the lock is fetching. */
  private async waitForRefresh(hash: string): Promise<SsoTokenData | null> {
    const deadline = Date.now() + REFRESH_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
      const cached =
        await this.redisService.getRefreshResult<SsoTokenData>(hash);
      if (cached) return cached;
    }
    return null;
  }
}
