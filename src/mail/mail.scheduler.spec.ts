import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailScheduler } from './mail.scheduler';
import { MailService } from './mail.service';

const mockPrisma = {
  notificationPreference: { findMany: jest.fn() },
  user: { findMany: jest.fn() },
  message: { count: jest.fn() },
  inboundMessage: { count: jest.fn() },
  messageTemplate: { count: jest.fn() },
  userWhatsapp: { findMany: jest.fn() },
  mailLog: { findMany: jest.fn() },
};

const mockMail = {
  enabled: true,
  recipientsByIds: jest.fn(),
  sendTo: jest.fn().mockResolvedValue(true),
  retryFailed: jest.fn().mockResolvedValue({ retried: 0, sent: 0, abandoned: 0 }),
};

const RECIPIENT = { userId: 7, email: 'ada@example.com', firstName: 'Ada' };

/** Counts for one recipient: sent, failed, then inbound. */
function activity(sent: number, failed: number, inbound: number) {
  mockPrisma.message.count
    .mockResolvedValueOnce(sent)
    .mockResolvedValueOnce(failed);
  mockPrisma.userWhatsapp.findMany.mockResolvedValue([{ wabaId: 'w1' }]);
  mockPrisma.inboundMessage.count.mockResolvedValue(inbound);
}

describe('MailScheduler — daily summary', () => {
  let scheduler: MailScheduler;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockMail.enabled = true;
    mockMail.sendTo.mockResolvedValue(true);
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.notificationPreference.findMany.mockResolvedValue([
      { userId: 7 },
    ]);
    mockMail.recipientsByIds.mockResolvedValue([RECIPIENT]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MailScheduler,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MailService, useValue: mockMail },
      ],
    }).compile();
    scheduler = module.get<MailScheduler>(MailScheduler);
  });

  it('reports failures, which nothing else does any more', async () => {
    activity(40, 3, 2);

    await scheduler.sendDailySummary();

    expect(mockMail.sendTo).toHaveBeenCalledTimes(1);
    const options = mockMail.sendTo.mock.calls[0][1] as {
      kind: string;
      subject: string;
      facts: [string, string][];
    };
    expect(options.kind).toBe('emailDailySummary');
    // The count belongs in the subject line: it is the reason to open it.
    expect(options.subject).toContain('3 failed to deliver');
    expect(options.facts).toEqual(
      expect.arrayContaining([['Failed to deliver', '3']]),
    );
  });

  it('includes a user who never opened their notification settings', async () => {
    // The preference row is created on the first change, so the people who
    // never made one are exactly the people on the defaults — and the daily
    // summary is one of them. Missing them would leave them hearing nothing
    // about failures at all.
    mockPrisma.notificationPreference.findMany.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([{ id: 7 }]);
    activity(1, 0, 0);

    await scheduler.sendDailySummary();

    expect(mockMail.recipientsByIds).toHaveBeenCalledWith([7]);
    expect(mockMail.sendTo).toHaveBeenCalledTimes(1);
  });

  it('does not count an opted-in user twice', async () => {
    mockPrisma.notificationPreference.findMany.mockResolvedValue([
      { userId: 7 },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([{ id: 7 }]);
    activity(1, 0, 0);

    await scheduler.sendDailySummary();

    expect(mockMail.recipientsByIds).toHaveBeenCalledWith([7]);
  });

  it('says nothing about a day where nothing happened', async () => {
    activity(0, 0, 0);

    await scheduler.sendDailySummary();

    expect(mockMail.sendTo).not.toHaveBeenCalled();
  });

  it('sends nothing when email is not configured', async () => {
    mockMail.enabled = false;

    await scheduler.sendDailySummary();

    expect(mockPrisma.notificationPreference.findMany).not.toHaveBeenCalled();
  });

  it('swallows a failure rather than letting a timer throw', async () => {
    mockPrisma.notificationPreference.findMany.mockRejectedValue(
      new Error('database down'),
    );

    await expect(scheduler.sendDailySummary()).resolves.toBeUndefined();
  });
});

describe('MailScheduler — retry sweep', () => {
  let scheduler: MailScheduler;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockMail.enabled = true;
    mockMail.retryFailed.mockResolvedValue({ retried: 0, sent: 0, abandoned: 0 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MailScheduler,
        { provide: MailService, useValue: mockMail },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    scheduler = module.get<MailScheduler>(MailScheduler);
  });

  it('sweeps the failed sends', async () => {
    mockMail.retryFailed.mockResolvedValue({ retried: 2, sent: 1, abandoned: 1 });

    await scheduler.retryFailedMail();

    expect(mockMail.retryFailed).toHaveBeenCalled();
  });

  it('does not run when SES is not configured', async () => {
    mockMail.enabled = false;

    await scheduler.retryFailedMail();

    expect(mockMail.retryFailed).not.toHaveBeenCalled();
  });

  it('survives a sweep that throws — the next one still runs', async () => {
    mockMail.retryFailed.mockRejectedValue(new Error('database down'));

    await expect(scheduler.retryFailedMail()).resolves.toBeUndefined();
  });
});
