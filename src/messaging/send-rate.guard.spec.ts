import { HttpException } from '@nestjs/common';
import { SendRateGuard } from './send-rate.guard';
import { RedisService } from 'src/redis/redis.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';

const mockRedis = {
  countInWindow: jest.fn(),
  secondsUntilWindowEnds: jest.fn().mockReturnValue(37),
};
const mockLimits = { forWaba: jest.fn() };

const setHeader = jest.fn();

/** A request as the API-key middleware leaves it, unless a test says otherwise. */
const ctx = (over: Record<string, unknown> = {}) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { 'x-access-key': 'ak_1' },
        authType: 'apiKey',
        orgId: 'org_1',
        apiKeyWabaId: 'waba_1',
        ...over,
      }),
      getResponse: () => ({ setHeader }),
    }),
  }) as never;

describe('SendRateGuard', () => {
  let guard: SendRateGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.secondsUntilWindowEnds.mockReturnValue(37);
    mockLimits.forWaba.mockResolvedValue({
      planName: 'Growth',
      messagesPerMinute: 500,
    });
    guard = new SendRateGuard(
      mockRedis as unknown as RedisService,
      mockLimits as unknown as PlanLimitsService,
    );
  });

  it('lets a send through while the key is under its rate', async () => {
    mockRedis.countInWindow.mockResolvedValue(500);

    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it('refuses the send that goes past it, with a Retry-After', async () => {
    mockRedis.countInWindow.mockResolvedValue(501);

    await expect(guard.canActivate(ctx())).rejects.toThrow(HttpException);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '37');
  });

  it('names the plan and the number, so the message says what to do', async () => {
    mockRedis.countInWindow.mockResolvedValue(501);

    await expect(guard.canActivate(ctx())).rejects.toThrow(
      /Growth plan allows 500 messages a minute/,
    );
  });

  it('counts the key, not the caller’s address', async () => {
    // A customer's whole fleet sends from one address, and two customers can
    // share one. The key is the thing the plan is sold against.
    mockRedis.countInWindow.mockResolvedValue(1);

    await guard.canActivate(ctx());

    expect(mockRedis.countInWindow).toHaveBeenCalledWith('ak_1', 60);
  });

  it('leaves the console alone', async () => {
    // Someone clicking send is bounded by how fast they can click, and the
    // number on the price list is sold as an API rate.
    await expect(
      guard.canActivate(ctx({ authType: 'jwt', headers: {} })),
    ).resolves.toBe(true);
    expect(mockRedis.countInWindow).not.toHaveBeenCalled();
  });

  it('allows anything on a plan that names no rate', async () => {
    mockLimits.forWaba.mockResolvedValue({
      planName: 'Agency',
      messagesPerMinute: null,
    });

    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(mockRedis.countInWindow).not.toHaveBeenCalled();
  });

  it('allows the send when the counter itself is down', async () => {
    // Refusing every send because Redis is unreachable would turn a cache
    // outage into an outage of the product. The limit protects the send path;
    // it is not the send path.
    mockRedis.countInWindow.mockRejectedValue(new Error('redis down'));

    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });
});
