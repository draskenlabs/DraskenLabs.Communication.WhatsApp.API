import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyService } from './api-key.service';

const mockApiKeyService = {
  createApiKey: jest.fn(),
  findAllByOrgId: jest.fn(),
  revokeApiKey: jest.fn(),
};

describe('ApiKeyController', () => {
  let controller: ApiKeyController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApiKeyController],
      providers: [{ provide: ApiKeyService, useValue: mockApiKeyService }],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<ApiKeyController>(ApiKeyController);
  });

  describe('create', () => {
    it('creates API key for authenticated user', async () => {
      const req = { user: { id: 1 }, orgId: 2 } as any;
      const dto = { name: 'My Key' } as any;
      const response = { accessKey: 'ak_1', secretKey: 'sk_1' };
      mockApiKeyService.createApiKey.mockResolvedValue(response);

      await expect(controller.create(req, dto)).resolves.toEqual(response);
      expect(mockApiKeyService.createApiKey).toHaveBeenCalledWith(1, 2, dto);
    });

    it('throws UnauthorizedException when user or org missing', async () => {
      const req = {} as any;
      await expect(controller.create(req, {} as any)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('findAll', () => {
    it('returns keys for authenticated org', async () => {
      const req = { orgId: 2 } as any;
      const keys = [{ id: 1, name: 'Key' }];
      mockApiKeyService.findAllByOrgId.mockResolvedValue(keys);

      await expect(controller.findAll(req)).resolves.toEqual(keys);
      expect(mockApiKeyService.findAllByOrgId).toHaveBeenCalledWith(2);
    });

    it('throws UnauthorizedException when org missing', async () => {
      const req = {} as any;
      await expect(controller.findAll(req)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('revoke', () => {
    it('revokes an API key', async () => {
      const req = { user: { id: 1 }, orgId: 'sso_org_1' } as any;
      mockApiKeyService.revokeApiKey.mockResolvedValue(undefined);

      await expect(controller.revoke(req, 5)).resolves.toBeUndefined();
      expect(mockApiKeyService.revokeApiKey).toHaveBeenCalledWith(1, 'sso_org_1', 5);
    });

    it('throws UnauthorizedException when user missing', async () => {
      const req = {} as any;
      await expect(controller.revoke(req, 5)).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when the organisation is missing', async () => {
      const req = { user: { id: 1 } } as any;
      await expect(controller.revoke(req, 5)).rejects.toThrow(UnauthorizedException);
    });
  });
});
