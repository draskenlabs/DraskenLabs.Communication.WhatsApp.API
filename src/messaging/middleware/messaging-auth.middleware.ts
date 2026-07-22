import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';
import { ApiKeyAuthMiddleware } from 'src/api-key/middleware/api-key-auth.middleware';

/**
 * Messaging routes serve two audiences: the user-facing console (Bearer JWT)
 * and server-to-server integrations (API key). This middleware accepts either —
 * it uses the API-key path when `x-access-key`/`x-secret-key` are present,
 * otherwise the JWT path. Both underlying middlewares populate `req.user` and
 * `req.orgId` identically, so downstream handlers are unaffected.
 */
@Injectable()
export class MessagingAuthMiddleware implements NestMiddleware {
  constructor(
    private readonly jwtAuth: AuthMiddleware,
    private readonly apiKeyAuth: ApiKeyAuthMiddleware,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const hasApiKey = !!(req.headers['x-access-key'] || req.headers['x-secret-key']);
    if (hasApiKey) {
      return this.apiKeyAuth.use(req, res, next);
    }
    return this.jwtAuth.use(req, res, next);
  }
}
