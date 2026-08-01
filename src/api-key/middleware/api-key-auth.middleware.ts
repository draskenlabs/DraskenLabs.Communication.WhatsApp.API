import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { RedisService } from 'src/redis/redis.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { UserService } from 'src/user/user.service';

@Injectable()
export class ApiKeyAuthMiddleware implements NestMiddleware {
  constructor(
    private readonly redisService: RedisService,
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly userService: UserService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const accessKey = req.headers['x-access-key'] as string;
    const secretKey = req.headers['x-secret-key'] as string;

    if (!accessKey || !secretKey) {
      throw new UnauthorizedException('API key headers missing');
    }

    let cachedKey = await this.redisService.getApiKeyCache(accessKey);

    if (!cachedKey) {
      const dbKey = await this.prisma.userApiKey.findUnique({
        where: { accessKey },
      });

      if (!dbKey || !dbKey.status) {
        throw new UnauthorizedException('Invalid API key');
      }

      await this.redisService.setApiKeyCache(
        accessKey,
        dbKey.userId,
        dbKey.ssoOrgId,
        dbKey.secretKey,
        dbKey.wabaId,
      );
      cachedKey = {
        userId: dbKey.userId,
        ssoOrgId: dbKey.ssoOrgId,
        wabaId: dbKey.wabaId,
        secretKey: dbKey.secretKey,
      };
    }

    // A key names the account it acts on. The ones without a WABA were issued
    // before that was true, or had theirs deleted; either way there is no
    // account to act on, so they are refused rather than quietly let through
    // with the run of the organisation.
    if (!cachedKey.wabaId) {
      throw new UnauthorizedException(
        'This API key is not scoped to a WhatsApp Business Account. Create a new key for the account you want to use.',
      );
    }

    let decryptedSecret: string;
    try {
      decryptedSecret = this.encryptionService.decrypt(cachedKey.secretKey);
    } catch {
      throw new UnauthorizedException('Invalid API key');
    }

    if (decryptedSecret !== secretKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    let user = await this.redisService.getUserCache(cachedKey.userId);

    if (!user) {
      const dbUser = await this.userService.findById(cachedKey.userId);
      if (!dbUser) throw new UnauthorizedException('User not found');

      user = { id: dbUser.id, ssoId: dbUser.ssoId };
      await this.redisService.setUserCache(cachedKey.userId, user);
    }

    (req as any).user = user;
    (req as any).orgId = cachedKey.ssoOrgId;
    // Downstream handlers read this to keep the request inside one account.
    // The JWT path leaves it undefined, which is what makes the console — where
    // the user picks the account themselves — unaffected by key scoping.
    (req as any).apiKeyWabaId = cachedKey.wabaId;
    (req as any).authType = 'apiKey';
    next();
  }
}
