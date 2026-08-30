import {
  ForbiddenException,
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { UserService } from '../user.service';
import { RedisService } from 'src/redis/redis.service';
import { SsoTokenService } from 'src/auth/sso-token.service';
import { OrgAccessService } from 'src/auth/org-access.service';

/** The header a console request names the organisation it is working in with. */
export const ORG_HEADER = 'x-org-id';

/**
 * Authenticates a console request with the **SSO's own access token**.
 *
 * This API no longer signs a token of its own. What arrives is the RS256 token
 * the SSO minted for this client, verified offline against the published key
 * ring — so the credential in the browser is the same one the SSO issued, ends
 * when the SSO says it ends, and can be introspected by anyone who needs a
 * definitive answer.
 *
 * That token carries no organisation, because the SSO does not know what one
 * means here. The request names it in `X-Org-Id` and this checks it against the
 * session's grants — a header alone proves nothing, so an organisation the
 * session was never granted is a 403 rather than a silently ignored value.
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    private readonly ssoToken: SsoTokenService,
    private readonly userService: UserService,
    private readonly redisService: RedisService,
    private readonly orgAccess: OrgAccessService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('No token provided');
    }

    const token = authHeader.slice('Bearer '.length).trim();
    const claims = await this.ssoToken.verify(token);

    let user = await this.redisService.getUserBySsoCache(claims.sub);
    if (!user) {
      const dbUser = await this.userService.findBySsoId(claims.sub);
      if (!dbUser) throw new UnauthorizedException('User not found');

      user = { id: dbUser.id, ssoId: dbUser.ssoId };
      await this.redisService.setUserBySsoCache(claims.sub, user);
      await this.redisService.setUserCache(user.id, user);
    }

    (req as any).user = user;
    (req as any).sessionId = claims.sid;
    // Kept on the request so the organisation proxy can forward the caller's
    // own token to the SSO rather than one this API stored for them.
    (req as any).ssoAccessToken = token;

    const orgId = this.orgHeader(req);
    if (orgId) {
      const grant = await this.orgAccess.grantFor(claims.sid, orgId, token);
      if (!grant) {
        throw new ForbiddenException(
          'You are not a member of this organisation',
        );
      }
      (req as any).orgId = orgId;
      (req as any).role = grant.role;
      // Present only when an agency is acting inside one of its clients.
      (req as any).agencyOrgId = grant.agencyOrgId;
    }

    next();
  }

  /** The organisation header, if the request sent a usable one. */
  private orgHeader(req: Request): string | undefined {
    const raw = req.headers[ORG_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  }
}
