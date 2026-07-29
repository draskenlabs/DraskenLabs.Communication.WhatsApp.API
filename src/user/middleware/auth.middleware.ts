import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';
import { UserService } from '../user.service';
import { RedisService } from 'src/redis/redis.service';

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
    private readonly redisService: RedisService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('No token provided');
    }

    const token = authHeader.split(' ')[1];
    try {
      const payload = await this.jwtService.verifyAsync(token);
      const userId: number = payload.sub;

      let user = await this.redisService.getUserCache(userId);

      if (!user) {
        const dbUser = await this.userService.findById(userId);
        if (!dbUser) throw new UnauthorizedException('User not found');

        user = { id: dbUser.id, ssoId: dbUser.ssoId };
        await this.redisService.setUserCache(userId, user);
      }

      (req as any).user = user;
      (req as any).orgId = payload.orgId;
      (req as any).role = payload.role;
      (req as any).sessionId = payload.sessionId;
      next();
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid token');
    }
  }
}
