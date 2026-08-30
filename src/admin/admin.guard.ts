import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from 'src/prisma/prisma.service';
import { SsoTokenService } from 'src/auth/sso-token.service';

/** The operator behind an admin request, attached to it once verified. */
export interface AdminActor {
  id: number;
  email: string | null;
  name: string | null;
}

/** Read the actor off a request the guard has already let through. */
export function actorOf(req: Request): AdminActor {
  const actor = (req as Request & { admin?: AdminActor }).admin;
  if (!actor) {
    // Unreachable through the guard; a programming error if it happens.
    throw new NotFoundException();
  }
  return actor;
}

/**
 * Who may use the operator console — and, for everybody else, the fact that
 * there is one.
 *
 * **Every refusal is a 404.** No token, an expired token, a user we do not
 * know, a user who is not an admin: all of them get "not found", the same
 * answer an unknown path gets. A 401 would confirm that `/admin` is a real
 * route worth attacking, and a 403 would confirm it to somebody already
 * holding a valid customer token. Nothing here is secret enough to justify
 * that trade being made the other way.
 *
 * **The flag is read from the database, never from the user cache.** The
 * session cache exists to keep ordinary requests off the database, and it lives
 * for as long as its TTL; an admin flag cached the same way would mean a
 * demoted operator keeps the console until it expires. Admin requests are rare
 * and this check is one indexed read.
 *
 * The token is verified here rather than by `AuthMiddleware` for the same
 * reason: that middleware answers 401, which is the one thing these routes must
 * never say.
 *
 * What is verified is the SSO's own access token, against the SSO's published
 * keys — this API signs nothing of its own. The token names the person by
 * their SSO id, so that is what the admin flag is looked up by.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly ssoToken: SsoTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new NotFoundException();

    let ssoId: string;
    try {
      const claims = await this.ssoToken.verify(header.slice('Bearer '.length));
      ssoId = claims.sub;
    } catch {
      throw new NotFoundException();
    }

    const user = await this.prisma.user.findUnique({
      where: { ssoId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isAdmin: true,
      },
    });
    if (!user?.isAdmin) throw new NotFoundException();

    const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
    (req as Request & { admin?: AdminActor }).admin = {
      id: user.id,
      email: user.email,
      name: name || null,
    };
    return true;
  }
}
