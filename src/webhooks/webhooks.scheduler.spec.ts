import { Test, TestingModule } from '@nestjs/testing';
import { WebhooksScheduler } from './webhooks.scheduler';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

const mockDispatcher = { sweep: jest.fn() };

describe('WebhooksScheduler', () => {
  let scheduler: WebhooksScheduler;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksScheduler,
        { provide: WebhookDispatcherService, useValue: mockDispatcher },
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
});
