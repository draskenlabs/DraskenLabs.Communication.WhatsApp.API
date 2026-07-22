import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

const mockAuthService = {
  handleCallback: jest.fn(),
  listOrganisations: jest.fn(),
  createOrganisation: jest.fn(),
  selectOrg: jest.fn(),
};

const mockJwtService = { verifyAsync: jest.fn() };

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile();
    controller = module.get<AuthController>(AuthController);
  });

  describe('callback', () => {
    it('delegates to AuthService.handleCallback', async () => {
      const dto = { code: 'c1', codeVerifier: 'v1' };
      const response = { access_token: 'tok', user: { id: 1 }, organisations: [] };
      mockAuthService.handleCallback.mockResolvedValue(response);

      await expect(controller.callback(dto as any)).resolves.toEqual(response);
      expect(mockAuthService.handleCallback).toHaveBeenCalledWith(dto);
    });
  });

  describe('org endpoints (session-authenticated)', () => {
    beforeEach(() => {
      mockJwtService.verifyAsync.mockResolvedValue({ sub: 7, sessionId: 'session-1' });
    });

    it('listOrganisations passes the session id', async () => {
      mockAuthService.listOrganisations.mockResolvedValue([{ id: 'org_1', name: 'Acme' }]);
      await controller.listOrganisations('Bearer app_tok');
      expect(mockAuthService.listOrganisations).toHaveBeenCalledWith('session-1');
    });

    it('createOrganisation passes user id, session id and name', async () => {
      mockAuthService.createOrganisation.mockResolvedValue({ access_token: 't', orgId: 'org_new', organisation: {} });
      await controller.createOrganisation({ name: 'Gamma' } as any, 'Bearer app_tok');
      expect(mockAuthService.createOrganisation).toHaveBeenCalledWith(7, 'session-1', 'Gamma');
    });

    it('selectOrg passes user id, session id and orgId', async () => {
      mockAuthService.selectOrg.mockResolvedValue({ access_token: 't', orgId: 'org_1', organisation: {} });
      await controller.selectOrg({ orgId: 'org_1' } as any, 'Bearer app_tok');
      expect(mockAuthService.selectOrg).toHaveBeenCalledWith(7, 'session-1', 'org_1');
    });

    it('throws UnauthorizedException when no token is provided', async () => {
      await expect(controller.listOrganisations(undefined)).rejects.toThrow(UnauthorizedException);
      expect(mockAuthService.listOrganisations).not.toHaveBeenCalled();
    });

    it('throws UnauthorizedException when the token has no session id', async () => {
      mockJwtService.verifyAsync.mockResolvedValue({ sub: 7 });
      await expect(controller.listOrganisations('Bearer app_tok')).rejects.toThrow(UnauthorizedException);
    });
  });
});
