jest.mock('uuid', () => ({ v7: jest.fn().mockReturnValue('mock-uuid-v7') }));

const mockClient = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  hset: jest.fn(),
  hgetall: jest.fn(),
  on: jest.fn(),
  disconnect: jest.fn(),
};

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => mockClient),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

const mockConfigService = {
  getOrThrow: (key: string) => (key === 'REDIS_URL' ? 'redis://localhost:6379' : undefined),
};

describe('RedisService', () => {
  let service: RedisService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockClient.on.mockReturnValue(mockClient);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<RedisService>(RedisService);
    service.onModuleInit();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleDestroy', () => {
    it('disconnects the redis client', () => {
      service.onModuleDestroy();
      expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('getState', () => {
    it('returns null when key does not exist', async () => {
      mockClient.get.mockResolvedValue(null);
      const result = await service.getState('missing-id');
      expect(result).toBeNull();
      expect(mockClient.get).toHaveBeenCalledWith('state:missing-id');
    });

    it('returns parsed object when key exists', async () => {
      const state = { userId: 1, wabaId: 'waba_1' };
      mockClient.get.mockResolvedValue(JSON.stringify(state));
      const result = await service.getState('abc');
      expect(result).toEqual(state);
    });
  });

  describe('createState', () => {
    it('returns a stateId string and sets key with 300s TTL', async () => {
      mockClient.set.mockResolvedValue('OK');
      const stateId = await service.createState();
      expect(typeof stateId).toBe('string');
      expect(stateId.length).toBeGreaterThan(0);
      expect(mockClient.set).toHaveBeenCalledWith(
        expect.stringMatching(/^state:/),
        JSON.stringify({}),
        'EX',
        300,
      );
    });
  });

  describe('updateState', () => {
    it('updates the key and returns the stateId', async () => {
      mockClient.set.mockResolvedValue('OK');
      const data = { accessToken: 'tok_abc', businesses: [{ id: 1, name: 'Biz' }] };
      const result = await service.updateState('my-state', data);
      expect(result).toBe('my-state');
      expect(mockClient.set).toHaveBeenCalledWith(
        'state:my-state',
        JSON.stringify(data),
        'EX',
        300,
      );
    });
  });

  describe('getUserCache', () => {
    it('returns null when key does not exist', async () => {
      mockClient.get.mockResolvedValue(null);
      const result = await service.getUserCache(42);
      expect(result).toBeNull();
      expect(mockClient.get).toHaveBeenCalledWith('user:42');
    });

    it('returns parsed user when key exists', async () => {
      const user = { id: 42, ssoId: 'sso_1' };
      mockClient.get.mockResolvedValue(JSON.stringify(user));
      const result = await service.getUserCache(42);
      expect(result).toEqual(user);
    });
  });

  describe('setUserCache', () => {
    it('sets key with 900s TTL', async () => {
      mockClient.set.mockResolvedValue('OK');
      const user = { id: 1, ssoId: 'sso_c' };
      await service.setUserCache(1, user);
      expect(mockClient.set).toHaveBeenCalledWith(
        'user:1',
        JSON.stringify(user),
        'EX',
        900,
      );
    });
  });

  describe('invalidateUserCache', () => {
    it('deletes the user key', async () => {
      mockClient.del.mockResolvedValue(1);
      await service.invalidateUserCache(7);
      expect(mockClient.del).toHaveBeenCalledWith('user:7');
    });
  });

});
