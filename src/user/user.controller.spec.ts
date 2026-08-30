import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { RedisService } from 'src/redis/redis.service';
import { SsoService } from 'src/auth/sso.service';

const mockUserService = { findById: jest.fn(), deleteAccount: jest.fn() };
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
        { provide: RedisService, useValue: mockRedisService },
        { provide: SsoService, useValue: mockSsoService },
      ],
    }).compile();
    controller = module.get<UserController>(UserController);
  });

  describe('getProfile', () => {
    it("reads the live SSO profile with the request's own token", async () => {
      mockRedisService.getSsoSession.mockResolvedValue({
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
      const req = {
        user: { id: 1, ssoId: 'sso_1' },
        sessionId: 'sess_1',
        ssoAccessToken: 'sso_tok',
      } as any;
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
        email: 'a@b.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        username: 'ada',
        emailVerified: true,
        imageUrl: '',
        ssoCreatedAt: '2026-05-01T00:00:00.000Z',
      });
      mockSsoService.getProfile.mockResolvedValue(null);
      const req = {
        user: { id: 1, ssoId: 'sso_1' },
        sessionId: 'sess_1',
        ssoAccessToken: 'sso_tok',
      } as any;
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

    it('falls back to empty fields when nothing is known about the session', async () => {
      mockRedisService.getSsoSession.mockResolvedValue(null);
      mockSsoService.getProfile.mockResolvedValue(null);
      const req = {
        user: { id: 1, ssoId: 'sso_1' },
        sessionId: 'sess_1',
      } as any;
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
      await expect(controller.getProfile(req)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
