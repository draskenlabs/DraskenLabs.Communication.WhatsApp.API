import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RedisService } from 'src/redis/redis.service';

const mockUserService = { findById: jest.fn() };
const mockJwtService = { signAsync: jest.fn().mockResolvedValue('signed_token') };
const mockConfigService = { get: jest.fn() };
const mockRedisService = { getSsoSession: jest.fn() };

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
      ],
    }).compile();
    controller = module.get<UserController>(UserController);
  });

  describe('getProfile', () => {
    it('merges the SSO session name/email onto the slim user record', async () => {
      mockRedisService.getSsoSession.mockResolvedValue({
        email: 'a@b.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
      const req = { user: { id: 1, ssoId: 'sso_1' }, sessionId: 'sess_1' } as any;
      await expect(controller.getProfile(req)).resolves.toEqual({
        id: 1,
        ssoId: 'sso_1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'a@b.com',
      });
    });

    it('falls back to empty name/email when the session has expired', async () => {
      mockRedisService.getSsoSession.mockResolvedValue(null);
      const req = { user: { id: 1, ssoId: 'sso_1' }, sessionId: 'sess_1' } as any;
      await expect(controller.getProfile(req)).resolves.toEqual({
        id: 1,
        ssoId: 'sso_1',
        firstName: '',
        lastName: '',
        email: '',
      });
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
