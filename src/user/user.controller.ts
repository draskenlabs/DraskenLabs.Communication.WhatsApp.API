import { Controller, Get, Post, Req, UseGuards, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserService } from './user.service';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { UserProfileDto } from './dto/user-profile.dto';

@ApiTags('User')
@Controller('user')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
  ) {}

  @Get('profile')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  async getProfile(@Req() req: Request): Promise<UserProfileDto> {
    const user = (req as any).user;
    if (!user) {
      throw new UnauthorizedException('User not found in context');
    }
    return user;
  }

  @Post('test-token')
  @ApiOperation({ summary: 'Generate access token for user id 1 (Testing only)' })
  async generateTestToken() {
    // For testing purposes, we use user id 1
    const userId = 1;
    const user = await this.userService.findById(userId);
    
    if (!user) {
      throw new UnauthorizedException('Test user with ID 1 not found. Please ensure it exists in the database.');
    }

    const payload = { sub: user.id, email: user.email };
    const token = await this.jwtService.signAsync(payload);

    return {
      access_token: token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName
      }
    };
  }
}
