import { Controller, Delete, ForbiddenException, Get, Post, Req, UseGuards, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserService } from './user.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { UserProfileDto } from './dto/user-profile.dto';
import { DeleteAccountResultDto } from './dto/delete-account.dto';
import { RedisService } from 'src/redis/redis.service';
import { SsoService } from 'src/auth/sso.service';
import { ApiWrappedOkResponse } from 'src/common/responses/swagger.decorators';

@ApiTags('User')
@Controller('user')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly ssoService: SsoService,
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

    // The User table is intentionally slim (id + ssoId) — the SSO owns the
    // profile. The login snapshot in Redis is written once and can be a day
    // old, so read through to `GET /users/me` for the live values and keep the
    // snapshot as the fallback when the SSO is unreachable or the session has
    // expired. Every field defaults rather than going undefined, which would
    // break the client's profile view.
    const sessionId = (req as any).sessionId;
    const session = sessionId
      ? await this.redisService.getSsoSession(sessionId)
      : null;

    const live = session?.ssoAccessToken
      ? await this.ssoService.getProfile(session.ssoAccessToken)
      : null;

    return {
      id: user.id,
      ssoId: user.ssoId,
      firstName: live?.firstName ?? session?.firstName ?? '',
      lastName: live?.lastName ?? session?.lastName ?? '',
      email: live?.email ?? session?.email ?? '',
      username: live?.username ?? session?.username ?? '',
      emailVerified: live?.emailVerified ?? session?.emailVerified ?? false,
      imageUrl: live?.imageUrl ?? session?.imageUrl ?? '',
      createdAt: live?.createdAt ?? session?.ssoCreatedAt ?? null,
    };
  }

  @Delete('account')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete this platform account and all of its WhatsApp data',
    description:
      'Removes everything WA Console holds for the caller — WABA connections, Meta access tokens, phone numbers, templates, messages and API keys. The DraskenLabs SSO account is NOT deleted (sign-in elsewhere is unaffected), and the WhatsApp Business Account itself stays with Meta. Irreversible.',
  })
  @ApiWrappedOkResponse({
    dataDto: DeleteAccountResultDto,
    description: 'What was deleted',
  })
  async deleteAccount(@Req() req: Request): Promise<DeleteAccountResultDto> {
    const user = (req as any).user;
    if (!user) {
      throw new UnauthorizedException('User not found in context');
    }
    return this.userService.deleteAccount(user.id, (req as any).sessionId);
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
