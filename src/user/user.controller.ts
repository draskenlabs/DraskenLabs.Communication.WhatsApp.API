import { Controller, ForbiddenException, Get, Post, Req, UseGuards, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserService } from './user.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { UserProfileDto } from './dto/user-profile.dto';
import { RedisService } from 'src/redis/redis.service';
import { ApiWrappedOkResponse } from 'src/common/responses/swagger.decorators';

@ApiTags('User')
@Controller('user')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {}

  @Get('profile')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiWrappedOkResponse({
    dataDto: UserProfileDto,
    description: 'Get user profile',
  })
  async getProfile(@Req() req: Request): Promise<UserProfileDto> {
    const user = (req as any).user;
    if (!user) {
      throw new UnauthorizedException('User not found in context');
    }

    // The User table is intentionally slim (id + ssoId); the display name and
    // email live in the SSO session keyed by the token's sessionId. Fall back
    // to empty strings when the session has expired so the endpoint never
    // returns undefined fields (which crash the client's profile view).
    const sessionId = (req as any).sessionId;
    const session = sessionId
      ? await this.redisService.getSsoSession(sessionId)
      : null;

    return {
      id: user.id,
      ssoId: user.ssoId,
      firstName: session?.firstName ?? '',
      lastName: session?.lastName ?? '',
      email: session?.email ?? '',
    };
  }

  @Post('test-token')
  @ApiOperation({ summary: 'Generate access token for user id 1 (Testing only)' })
  async generateTestToken() {
    if (this.configService.get('NODE_ENV') === 'production') {
      throw new ForbiddenException('Not available in production');
    }
    const userId = 1;
    const user = await this.userService.findById(userId);
    
    if (!user) {
      throw new UnauthorizedException('Test user with ID 1 not found. Please ensure it exists in the database.');
    }

    const token = await this.jwtService.signAsync({ sub: user.id, orgId: '', role: 'member' });

    return {
      access_token: token,
      user: { id: user.id, ssoId: user.ssoId },
    };
  }
}
