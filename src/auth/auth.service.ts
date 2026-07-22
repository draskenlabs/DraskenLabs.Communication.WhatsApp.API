import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SsoService } from './sso.service';
import { UserService } from 'src/user/user.service';
import { AuthCallbackDto } from './dto/callback.dto';
import { AuthResponseDto } from './dto/auth-response.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly ssoService: SsoService,
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
  ) {}

  async handleCallback(dto: AuthCallbackDto): Promise<AuthResponseDto> {
    const tokens = await this.ssoService.exchangeCode(dto.code, dto.codeVerifier);
    const ssoUser = this.ssoService.decodeUserInfo(tokens.accessToken);

    if (!ssoUser.ssoOrgId) {
      throw new UnauthorizedException('No organisation found in SSO token');
    }

    const user = await this.userService.findOrCreateBySsoId(ssoUser.ssoId);

    const access_token = await this.jwtService.signAsync({
      sub: user.id,
      orgId: ssoUser.ssoOrgId,
      role: ssoUser.role ?? 'member',
    });

    return { access_token, user };
  }
}
