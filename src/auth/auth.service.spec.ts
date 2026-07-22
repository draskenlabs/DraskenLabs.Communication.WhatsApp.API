import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SsoService } from './sso.service';
import { UserService } from 'src/user/user.service';
import { JwtService } from '@nestjs/jwt';

const mockSsoService = {
  exchangeCode: jest.fn(),
  decodeUserInfo: jest.fn(),
};

const mockUserService = {
  findOrCreateBySsoId: jest.fn(),
};

const mockJwtService = { signAsync: jest.fn().mockResolvedValue('signed_token') };

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: SsoService, useValue: mockSsoService },
        { provide: UserService, useValue: mockUserService },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile();
    service = module.get<AuthService>(AuthService);
  });

  const dto = { code: 'code_123', codeVerifier: 'verifier_abc' };

  describe('handleCallback', () => {
    it('exchanges code, provisions user and returns signed JWT', async () => {
      mockSsoService.exchangeCode.mockResolvedValue({ accessToken: 'sso_tok', refreshToken: 'ref', expiresIn: 86400 });
      mockSsoService.decodeUserInfo.mockReturnValue({
        ssoId: 'sso_1', email: 'a@b.com', firstName: 'A', lastName: 'B',
        ssoOrgId: 'org_uuid_1', role: 'owner',
      });
      mockUserService.findOrCreateBySsoId.mockResolvedValue({ id: 1, ssoId: 'sso_1', createdAt: new Date() });

      const result = await service.handleCallback(dto);

      expect(result.access_token).toBe('signed_token');
      expect(mockSsoService.exchangeCode).toHaveBeenCalledWith(dto.code, dto.codeVerifier);
      expect(mockUserService.findOrCreateBySsoId).toHaveBeenCalledWith('sso_1');
      expect(mockJwtService.signAsync).toHaveBeenCalledWith({
        sub: 1, orgId: 'org_uuid_1', role: 'owner',
      });
    });

    it('throws UnauthorizedException when SSO token has no org', async () => {
      mockSsoService.exchangeCode.mockResolvedValue({ accessToken: 'sso_tok' });
      mockSsoService.decodeUserInfo.mockReturnValue({
        ssoId: 'sso_1', email: 'a@b.com', firstName: 'A', lastName: 'B',
        ssoOrgId: null, role: null,
      });

      await expect(service.handleCallback(dto)).rejects.toThrow(UnauthorizedException);
    });

    it('defaults role to "member" when SSO token has no role claim', async () => {
      mockSsoService.exchangeCode.mockResolvedValue({ accessToken: 'sso_tok' });
      mockSsoService.decodeUserInfo.mockReturnValue({
        ssoId: 'sso_1', email: 'a@b.com', firstName: 'A', lastName: 'B',
        ssoOrgId: 'org_uuid_1', role: null,
      });
      mockUserService.findOrCreateBySsoId.mockResolvedValue({ id: 1, ssoId: 'sso_1', createdAt: new Date() });

      await service.handleCallback(dto);

      expect(mockJwtService.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'member' }),
      );
    });

    it('throws when SSO exchange fails', async () => {
      mockSsoService.exchangeCode.mockRejectedValue(new UnauthorizedException('SSO token exchange failed'));
      await expect(service.handleCallback(dto)).rejects.toThrow(UnauthorizedException);
    });
  });
});
