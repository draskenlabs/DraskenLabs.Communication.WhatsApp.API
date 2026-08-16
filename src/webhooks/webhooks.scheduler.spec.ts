import { Test, TestingModule } from '@nestjs/testing';
import { WebhooksScheduler } from './webhooks.scheduler';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { RetentionService } from './retention.service';

const mockDispatcher = { sweep: jest.fn() };
const mockRetention = { sweep: jest.fn() };

describe('WebhooksScheduler', () => {
  let scheduler: WebhooksScheduler;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksScheduler,
        { provide: WebhookDispatcherService, useValue: mockDispatcher },
        { provide: RetentionService, useValue: mockRetention },
      ],
    }).compile();
    scheduler = module.get(WebhooksScheduler);
  });

  it('runs the sweep', async () => {
    mockDispatcher.sweep.mockResolvedValue({
      attempted: 2,
      sent: 1,
      abandoned: 1,
    });

    await scheduler.deliverDue();

    expect(mockDispatcher.sweep).toHaveBeenCalled();
  });

  it('survives a sweep that throws — the next minute must still run', async () => {
    mockDispatcher.sweep.mockRejectedValue(new Error('db down'));

    await expect(scheduler.deliverDue()).resolves.toBeUndefined();
  });

  it('runs the nightly retention pass', async () => {
    mockRetention.sweep.mockResolvedValue({
      events: 10,
      deliveries: 4,
      messages: 0,
      inbound: 0,
    });

    await scheduler.pruneExpired();

    expect(mockRetention.sweep).toHaveBeenCalled();
  });

  it('survives a retention pass that throws', async () => {
    mockRetention.sweep.mockRejectedValue(new Error('db down'));

    await expect(scheduler.pruneExpired()).resolves.toBeUndefined();
  });
});
