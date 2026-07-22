import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

const mockAuthService = { handleCallback: jest.fn(), authorize: jest.fn() };

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: mockAuthService }],
    }).compile();
    controller = module.get<AuthController>(AuthController);
  });

  describe('authorize', () => {
    const query = { redirectUri: 'https://app.com/cb', codeChallenge: 'challenge_abc' };

    it('extracts the bearer token and delegates to AuthService.authorize', async () => {
      const response = { code: 'c1', state: 's1', redirectUri: 'https://app.com/cb' };
      mockAuthService.authorize.mockResolvedValue(response);

      await expect(controller.authorize(query as any, 'Bearer user_tok')).resolves.toEqual(response);
      expect(mockAuthService.authorize).toHaveBeenCalledWith('user_tok', 'https://app.com/cb', 'challenge_abc');
    });

    it('throws UnauthorizedException when the bearer token is missing', async () => {
      await expect(controller.authorize(query as any, undefined)).rejects.toThrow(UnauthorizedException);
      expect(mockAuthService.authorize).not.toHaveBeenCalled();
    });
  });

  describe('callback', () => {
    it('delegates to AuthService.handleCallback', async () => {
      const dto = { code: 'c1', codeVerifier: 'v1', redirectUri: 'https://app.com/cb' };
      const response = { access_token: 'tok', user: { id: 1 } };
      mockAuthService.handleCallback.mockResolvedValue(response);

      await expect(controller.callback(dto as any)).resolves.toEqual(response);
      expect(mockAuthService.handleCallback).toHaveBeenCalledWith(dto);
    });
  });
});
