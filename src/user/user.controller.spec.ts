import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RedisService } from 'src/redis/redis.service';
import { SsoService } from 'src/auth/sso.service';

const mockUserService = { findById: jest.fn() };
const mockJwtService = { signAsync: jest.fn().mockResolvedValue('signed_token') };
const mockConfigService = { get: jest.fn() };
const mockRedisService = { getSsoSession: jest.fn() };
const mockSsoService = { getProfile: jest.fn() };

describe('UserController', () => {
  let controller: UserController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserController],
      providers: [
        { provide: UserService, useValue: mockUserService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: RedisService, useValue: mockRedisService },
        { provide: SsoService, useValue: mockSsoService },
      ],
    }).compile();
    controller = module.get<UserController>(UserController);
  });

  describe('getProfile', () => {
    it('reads the live SSO profile through the session token', async () => {
      mockRedisService.getSsoSession.mockResolvedValue({
        ssoAccessToken: 'sso_tok',
        email: 'stale@b.com',
        firstName: 'Stale',
        lastName: 'Name',
      });
      mockSsoService.getProfile.mockResolvedValue({
        ssoId: 'sso_1',
        email: 'a@b.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        username: 'ada',
        emailVerified: true,
        imageUrl: 'https://img/ada.png',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
      });
      const req = { user: { id: 1, ssoId: 'sso_1' }, sessionId: 'sess_1' } as any;
      await expect(controller.getProfile(req)).resolves.toEqual({
        id: 1,
        ssoId: 'sso_1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'a@b.com',
        username: 'ada',
        emailVerified: true,
        imageUrl: 'https://img/ada.png',
        createdAt: '2026-05-01T00:00:00.000Z',
      });
      expect(mockSsoService.getProfile).toHaveBeenCalledWith('sso_tok');
    });

    it('falls back to the login snapshot when the SSO is unreachable', async () => {
      mockRedisService.getSsoSession.mockResolvedValue({
        ssoAccessToken: 'sso_tok',
        email: 'a@b.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        username: 'ada',
        emailVerified: true,
        imageUrl: '',
        ssoCreatedAt: '2026-05-01T00:00:00.000Z',
      });
      mockSsoService.getProfile.mockResolvedValue(null);
      const req = { user: { id: 1, ssoId: 'sso_1' }, sessionId: 'sess_1' } as any;
      await expect(controller.getProfile(req)).resolves.toEqual({
        id: 1,
        ssoId: 'sso_1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'a@b.com',
        username: 'ada',
        emailVerified: true,
        imageUrl: '',
        createdAt: '2026-05-01T00:00:00.000Z',
      });
    });

    it('falls back to empty fields when the session has expired', async () => {
      mockRedisService.getSsoSession.mockResolvedValue(null);
      const req = { user: { id: 1, ssoId: 'sso_1' }, sessionId: 'sess_1' } as any;
      await expect(controller.getProfile(req)).resolves.toEqual({
        id: 1,
        ssoId: 'sso_1',
        firstName: '',
        lastName: '',
        email: '',
        username: '',
        emailVerified: false,
        imageUrl: '',
        createdAt: null,
      });
      expect(mockSsoService.getProfile).not.toHaveBeenCalled();
    });

    it('throws UnauthorizedException when user is missing', async () => {
      const req = {} as any;
      await expect(controller.getProfile(req)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('generateTestToken', () => {
    it('throws ForbiddenException in production', async () => {
      mockConfigService.get.mockReturnValue('production');
      await expect(controller.generateTestToken()).rejects.toThrow(ForbiddenException);
    });

    it('throws UnauthorizedException when test user not found', async () => {
      mockConfigService.get.mockReturnValue('development');
      mockUserService.findById.mockResolvedValue(null);
      await expect(controller.generateTestToken()).rejects.toThrow(UnauthorizedException);
    });

    it('returns token and user in non-production env', async () => {
      mockConfigService.get.mockReturnValue('development');
      const user = { id: 1, email: 'test@test.com', firstName: 'Test', lastName: 'User' };
      mockUserService.findById.mockResolvedValue(user);

      const result = await controller.generateTestToken();

      expect(result.access_token).toBe('signed_token');
      expect(result.user.id).toBe(1);
      expect(mockJwtService.signAsync).toHaveBeenCalled();
    });
  });
});
