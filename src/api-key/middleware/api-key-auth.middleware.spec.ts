import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyAuthMiddleware } from './api-key-auth.middleware';
import { RedisService } from 'src/redis/redis.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { UserService } from 'src/user/user.service';

const mockRedis = {
  getApiKeyCache: jest.fn(),
  setApiKeyCache: jest.fn(),
  getUserCache: jest.fn(),
  setUserCache: jest.fn(),
};

const mockPrisma = {
  userApiKey: { findUnique: jest.fn() },
};

const mockEncryption = { decrypt: jest.fn() };
const mockUserService = { findById: jest.fn() };

describe('ApiKeyAuthMiddleware', () => {
  let middleware: ApiKeyAuthMiddleware;
  let next: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    next = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyAuthMiddleware,
        { provide: RedisService, useValue: mockRedis },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EncryptionService, useValue: mockEncryption },
        { provide: UserService, useValue: mockUserService },
      ],
    }).compile();
    middleware = module.get<ApiKeyAuthMiddleware>(ApiKeyAuthMiddleware);
  });

  it('throws 401 when headers are missing', async () => {
    const req = { headers: {} } as any;
    await expect(middleware.use(req, {} as any, next)).rejects.toThrow(UnauthorizedException);
  });

  it('throws 401 when key not in Redis and not in DB', async () => {
    const req = { headers: { 'x-access-key': 'ak_1', 'x-secret-key': 'sk_1' } } as any;
    mockRedis.getApiKeyCache.mockResolvedValue(null);
    mockPrisma.userApiKey.findUnique.mockResolvedValue(null);
    await expect(middleware.use(req, {} as any, next)).rejects.toThrow(UnauthorizedException);
  });

  it('throws 401 when DB key is inactive', async () => {
    const req = { headers: { 'x-access-key': 'ak_1', 'x-secret-key': 'sk_1' } } as any;
    mockRedis.getApiKeyCache.mockResolvedValue(null);
    mockPrisma.userApiKey.findUnique.mockResolvedValue({ status: false });
    await expect(middleware.use(req, {} as any, next)).rejects.toThrow(UnauthorizedException);
  });

  it('throws 401 when secret key does not match', async () => {
    const req = { headers: { 'x-access-key': 'ak_1', 'x-secret-key': 'wrong' } } as any;
    mockRedis.getApiKeyCache.mockResolvedValue({ userId: 1, ssoOrgId: 'sso_org_2', wabaId: 'waba_1', secretKey: 'enc' });
    mockEncryption.decrypt.mockReturnValue('correct_secret');
    await expect(middleware.use(req, {} as any, next)).rejects.toThrow(UnauthorizedException);
  });

  it('throws 401 when decryption fails', async () => {
    const req = { headers: { 'x-access-key': 'ak_1', 'x-secret-key': 'sk_1' } } as any;
    mockRedis.getApiKeyCache.mockResolvedValue({ userId: 1, ssoOrgId: 'sso_org_2', wabaId: 'waba_1', secretKey: 'enc' });
    mockEncryption.decrypt.mockImplementation(() => { throw new Error('bad'); });
    await expect(middleware.use(req, {} as any, next)).rejects.toThrow(UnauthorizedException);
  });

  it('attaches user and orgId to request and calls next', async () => {
    const req: any = { headers: { 'x-access-key': 'ak_1', 'x-secret-key': 'correct' } };
    mockRedis.getApiKeyCache.mockResolvedValue({ userId: 1, ssoOrgId: 'sso_org_2', wabaId: 'waba_1', secretKey: 'enc' });
    mockEncryption.decrypt.mockReturnValue('correct');
    const user = { id: 1, ssoId: 'c1' };
    mockRedis.getUserCache.mockResolvedValue(user);

    await middleware.use(req, {} as any, next);

    expect(req.user).toEqual(user);
    expect(req.orgId).toBe('sso_org_2');
    // The account the key may act on, which the send handler checks the
    // request's phone number against.
    expect(req.apiKeyWabaId).toBe('waba_1');
    expect(req.authType).toBe('apiKey');
    expect(next).toHaveBeenCalled();
  });

  it('refuses a key that names no WABA', async () => {
    // Keys issued before scoping, and keys whose account was deleted. Letting
    // them through would give the run of the organisation to a key that is
    // supposed to reach exactly one account.
    const req: any = { headers: { 'x-access-key': 'ak_1', 'x-secret-key': 'correct' } };
    mockRedis.getApiKeyCache.mockResolvedValue({
      userId: 1, ssoOrgId: 'sso_org_2', wabaId: null, secretKey: 'enc',
    });
    mockEncryption.decrypt.mockReturnValue('correct');

    await expect(middleware.use(req, {} as any, next)).rejects.toThrow(
      /not scoped to a WhatsApp Business Account/,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('loads user from DB when not in Redis cache and caches it', async () => {
    const req: any = { headers: { 'x-access-key': 'ak_1', 'x-secret-key': 'correct' } };
    mockRedis.getApiKeyCache.mockResolvedValue({ userId: 1, ssoOrgId: 'sso_org_2', wabaId: 'waba_1', secretKey: 'enc' });
    mockEncryption.decrypt.mockReturnValue('correct');
    mockRedis.getUserCache.mockResolvedValue(null);
    const dbUser = { id: 1, ssoId: 'c1' };
    mockUserService.findById.mockResolvedValue(dbUser);
    mockRedis.setUserCache.mockResolvedValue(undefined);

    await middleware.use(req, {} as any, next);

    expect(mockUserService.findById).toHaveBeenCalledWith(1);
    expect(mockRedis.setUserCache).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('loads key from DB when not in Redis, then caches it', async () => {
    const req: any = { headers: { 'x-access-key': 'ak_1', 'x-secret-key': 'correct' } };
    mockRedis.getApiKeyCache.mockResolvedValue(null);
    mockPrisma.userApiKey.findUnique.mockResolvedValue({
      status: true, userId: 1, ssoOrgId: 'sso_org_2', wabaId: 'waba_1', secretKey: 'enc', accessKey: 'ak_1',
    });
    mockRedis.setApiKeyCache.mockResolvedValue(undefined);
    mockEncryption.decrypt.mockReturnValue('correct');
    const user = { id: 1, ssoId: 'c1' };
    mockRedis.getUserCache.mockResolvedValue(user);

    await middleware.use(req, {} as any, next);

    expect(mockRedis.setApiKeyCache).toHaveBeenCalledWith('ak_1', 1, 'sso_org_2', 'enc', 'waba_1');
    expect(req.apiKeyWabaId).toBe('waba_1');
    expect(next).toHaveBeenCalled();
  });
});
