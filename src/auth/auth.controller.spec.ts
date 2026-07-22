import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

const mockAuthService = { handleCallback: jest.fn() };

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

  describe('callback', () => {
    it('delegates to AuthService.handleCallback', async () => {
      const dto = { code: 'c1', codeVerifier: 'v1' };
      const response = { access_token: 'tok', user: { id: 1 } };
      mockAuthService.handleCallback.mockResolvedValue(response);

      await expect(controller.callback(dto as any)).resolves.toEqual(response);
      expect(mockAuthService.handleCallback).toHaveBeenCalledWith(dto);
    });
  });
});
