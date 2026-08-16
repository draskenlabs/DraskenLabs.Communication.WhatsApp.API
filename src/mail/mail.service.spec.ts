import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import { SesService } from './ses.service';
import { PrismaService } from 'src/prisma/prisma.service';

const mockPrisma = {
  user: { findMany: jest.fn(), findUnique: jest.fn() },
  userWhatsapp: { findMany: jest.fn() },
  notificationPreference: { findUnique: jest.fn(), upsert: jest.fn() },
  mailSuppression: { findUnique: jest.fn(), upsert: jest.fn() },
  mailLog: {
    create: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
};

const mockSes = { enabled: true, send: jest.fn() };

const config = new Map<string, string>([
  ['JWT_SECRET', 'test-secret'],
  ['APP_BASE_URL', 'https://wa.example.com'],
]);

const mockConfig = {
  get: (key: string) => config.get(key),
  getOrThrow: (key: string) => {
    const value = config.get(key);
    if (!value) throw new Error(`missing ${key}`);
    return value;
  },
};

const RECIPIENT = { userId: 7, email: 'ada@example.com', firstName: 'Ada' };

const OPTIONS = {
  kind: 'emailTemplateStatus' as const,
  template: 'template.status',
  subject: 'Template approved',
  heading: 'Template approved',
  intro: 'Meta approved your template.',
};

describe('MailService', () => {
  let service: MailService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSes.enabled = true;
    mockSes.send.mockResolvedValue({ ok: true, messageId: 'ses-1' });
    mockPrisma.mailSuppression.findUnique.mockResolvedValue(null);
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);
    mockPrisma.mailLog.create.mockResolvedValue({});
    mockPrisma.mailLog.findMany.mockResolvedValue([]);
    mockPrisma.mailLog.update.mockResolvedValue({});
    mockPrisma.mailLog.updateMany.mockResolvedValue({ count: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MailService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SesService, useValue: mockSes },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get<MailService>(MailService);
  });

  describe('sendTo', () => {
    it('sends, and records the outcome with the SES message id', async () => {
      await expect(service.sendTo(RECIPIENT, OPTIONS)).resolves.toBe(true);

      expect(mockSes.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'ada@example.com' }),
      );
      expect(mockPrisma.mailLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'sent', messageId: 'ses-1' }),
      });
    });

    it('refuses to mail a suppressed address, and says why in the log', async () => {
      mockPrisma.mailSuppression.findUnique.mockResolvedValue({
        email: 'ada@example.com',
      });

      await expect(service.sendTo(RECIPIENT, OPTIONS)).resolves.toBe(false);

      expect(mockSes.send).not.toHaveBeenCalled();
      expect(mockPrisma.mailLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'suppressed' }),
      });
    });

    it('honours a preference that is switched off', async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({
        emailTemplateStatus: false,
      });

      await expect(service.sendTo(RECIPIENT, OPTIONS)).resolves.toBe(false);
      expect(mockSes.send).not.toHaveBeenCalled();
    });

    it('sends transactional mail even when every preference is off', async () => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({
        emailTemplateStatus: false,
        emailMessageFailed: false,
      });

      await expect(
        service.sendTo(RECIPIENT, { ...OPTIONS, kind: 'transactional' }),
      ).resolves.toBe(true);
      expect(mockSes.send).toHaveBeenCalled();
    });

    it('adds an unsubscribe link to notifications but never to transactional mail', async () => {
      await service.sendTo(RECIPIENT, OPTIONS);
      expect(mockSes.send.mock.calls[0][0].unsubscribeUrl).toContain(
        '/unsubscribe?',
      );

      mockSes.send.mockClear();
      await service.sendTo(RECIPIENT, { ...OPTIONS, kind: 'transactional' });
      expect(mockSes.send.mock.calls[0][0].unsubscribeUrl).toBeUndefined();
    });

    it('does nothing at all when SES is not configured', async () => {
      mockSes.enabled = false;
      await expect(service.sendTo(RECIPIENT, OPTIONS)).resolves.toBe(false);
      expect(mockPrisma.mailLog.create).not.toHaveBeenCalled();
    });

    it('never throws — a mail failure must not fail the caller', async () => {
      mockPrisma.mailSuppression.findUnique.mockRejectedValue(new Error('db'));
      await expect(service.sendTo(RECIPIENT, OPTIONS)).resolves.toBe(false);
    });

    it('records a rejected send as failed rather than reporting success', async () => {
      mockSes.send.mockResolvedValue({ ok: false, error: 'Throttled' });

      await expect(service.sendTo(RECIPIENT, OPTIONS)).resolves.toBe(false);
      expect(mockPrisma.mailLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'failed', error: 'Throttled' }),
      });
    });
  });

  describe('preference defaults', () => {
    it('mails template decisions and the daily summary when no row exists', async () => {
      // Someone who never opened their settings must still be told about a
      // failed send, and the daily summary is the only thing that tells them.
      await expect(service.sendTo(RECIPIENT, OPTIONS)).resolves.toBe(true);
      await expect(
        service.sendTo(RECIPIENT, { ...OPTIONS, kind: 'emailDailySummary' }),
      ).resolves.toBe(true);
    });

    it('stays quiet about the weekly summary and marketing by default', async () => {
      await expect(
        service.sendTo(RECIPIENT, { ...OPTIONS, kind: 'emailWeeklySummary' }),
      ).resolves.toBe(false);
      await expect(
        service.sendTo(RECIPIENT, { ...OPTIONS, kind: 'emailProductNews' }),
      ).resolves.toBe(false);
    });
  });

  describe('applying an unsubscribe', () => {
    it('switches off the kind that was asked for', async () => {
      await service.applyUnsubscribe(7, 'emailWeeklySummary');

      expect(mockPrisma.notificationPreference.upsert).toHaveBeenCalledWith({
        where: { userId: 7 },
        create: { userId: 7, emailWeeklySummary: false },
        update: { emailWeeklySummary: false },
      });
    });

    it('accepts a link for a kind we no longer send', async () => {
      // Signed links for retired kinds are already in people's inboxes. The
      // column is gone, so writing it would fail — and they are unsubscribed
      // from it either way.
      await expect(
        service.applyUnsubscribe(7, 'emailMessageFailed'),
      ).resolves.toBeUndefined();

      expect(mockPrisma.notificationPreference.upsert).not.toHaveBeenCalled();
    });
  });

  describe('unsubscribe links', () => {
    it('accepts its own signature and rejects a tampered one', () => {
      const url = service.unsubscribeUrl(7, 'emailTemplateStatus');
      const token = new URL(url).searchParams.get('t') as string;

      expect(service.verifyUnsubscribe(7, 'emailTemplateStatus', token)).toBe(
        true,
      );
      // Another user's id must not validate against this token.
      expect(service.verifyUnsubscribe(8, 'emailTemplateStatus', token)).toBe(
        false,
      );
      expect(service.verifyUnsubscribe(7, 'emailProductNews', token)).toBe(
        false,
      );
      expect(
        service.verifyUnsubscribe(7, 'emailTemplateStatus', 'deadbeef'),
      ).toBe(false);
    });

    it('switches one kind off, leaving the rest alone', async () => {
      await service.applyUnsubscribe(7, 'emailProductNews');

      expect(mockPrisma.notificationPreference.upsert).toHaveBeenCalledWith({
        where: { userId: 7 },
        create: { userId: 7, emailProductNews: false },
        update: { emailProductNews: false },
      });
    });

    it('suppresses the address entirely for "all"', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        email: 'ada@example.com',
      });

      await service.applyUnsubscribe(7, 'all');

      expect(mockPrisma.mailSuppression.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'ada@example.com' } }),
      );
    });
  });

  describe('recipients', () => {
    it('deduplicates users connected to a WABA and skips those with no email', async () => {
      mockPrisma.userWhatsapp.findMany.mockResolvedValue([
        { userId: 1 },
        { userId: 2 },
        { userId: 1 },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 1, email: 'a@example.com', firstName: 'A' },
      ]);

      const recipients = await service.recipientsForWaba('w1');

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: [1, 2] }, email: { not: null } },
        select: { id: true, email: true, firstName: true },
      });
      expect(recipients).toHaveLength(1);
    });
  });

  describe('retryFailed', () => {
    const failedRow = (over = {}) => ({
      id: 1,
      kind: 'template.status',
      email: 'ada@example.com',
      attempts: 1,
      payload: { recipient: RECIPIENT, options: OPTIONS },
      ...over,
    });

    it('sends again, and settles the row it delivered', async () => {
      mockPrisma.mailLog.findMany.mockResolvedValue([failedRow()]);

      await expect(service.retryFailed()).resolves.toEqual({
        retried: 1,
        sent: 1,
        abandoned: 0,
      });

      expect(mockSes.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'ada@example.com' }),
      );
      expect(mockPrisma.mailLog.update).toHaveBeenCalledWith({
        where: { id: 1 },
        // The content is dropped once it is delivered: a support message is
        // the sender's, not ours to keep.
        data: expect.objectContaining({
          status: 'sent',
          attempts: 2,
          retryAt: null,
          payload: expect.anything(),
        }),
      });
    });

    it('backs off and keeps the row when it fails again', async () => {
      mockPrisma.mailLog.findMany.mockResolvedValue([failedRow()]);
      mockSes.send.mockResolvedValue({ ok: false, error: 'throttled' });

      await expect(service.retryFailed()).resolves.toEqual({
        retried: 1,
        sent: 0,
        abandoned: 0,
      });

      expect(mockPrisma.mailLog.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          attempts: 2,
          retryAt: expect.any(Date),
          error: 'throttled',
        }),
      });
    });

    it('gives up after three retries rather than mailing forever', async () => {
      // Attempt 4 — the first send plus three retries.
      mockPrisma.mailLog.findMany.mockResolvedValue([
        failedRow({ attempts: 3 }),
      ]);
      mockSes.send.mockResolvedValue({ ok: false, error: 'still down' });

      await expect(service.retryFailed()).resolves.toEqual({
        retried: 1,
        sent: 0,
        abandoned: 1,
      });

      expect(mockPrisma.mailLog.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          status: 'abandoned',
          attempts: 4,
          retryAt: null,
        }),
      });
    });

    it('honours a suppression that landed after the failure', async () => {
      // A bounce between the first attempt and this one: a queue that ignored
      // that would keep mailing an address SES told us to stop mailing.
      mockPrisma.mailLog.findMany.mockResolvedValue([failedRow()]);
      mockPrisma.mailSuppression.findUnique.mockResolvedValue({
        email: 'ada@example.com',
      });

      await expect(service.retryFailed()).resolves.toEqual({
        retried: 1,
        sent: 0,
        abandoned: 1,
      });

      expect(mockSes.send).not.toHaveBeenCalled();
      expect(mockPrisma.mailLog.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({ status: 'suppressed', retryAt: null }),
      });
    });

    it('settles a row it cannot rebuild instead of asking forever', async () => {
      mockPrisma.mailLog.findMany.mockResolvedValue([
        failedRow({ payload: null }),
      ]);

      await expect(service.retryFailed()).resolves.toEqual({
        retried: 0,
        sent: 0,
        abandoned: 1,
      });

      expect(mockSes.send).not.toHaveBeenCalled();
      expect(mockPrisma.mailLog.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          status: 'abandoned',
          error: 'no payload',
        }),
      });
    });

    it('carries on when one row throws', async () => {
      mockPrisma.mailLog.findMany.mockResolvedValue([
        failedRow({ id: 1 }),
        failedRow({ id: 2 }),
      ]);
      mockPrisma.mailLog.update
        .mockRejectedValueOnce(new Error('row gone'))
        .mockResolvedValue({});

      // The second row is still attempted and still delivered; only the row
      // whose write blew up is left for the next sweep.
      await expect(service.retryFailed()).resolves.toEqual({
        retried: 2,
        sent: 1,
        abandoned: 0,
      });
      expect(mockSes.send).toHaveBeenCalledTimes(2);
    });

    it('asks only for rows whose retry is due', async () => {
      await service.retryFailed();

      expect(mockPrisma.mailLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'failed',
            retryAt: { not: null, lte: expect.any(Date) },
          },
        }),
      );
    });

    it('leaves a row another replica already claimed alone', async () => {
      // Both pods run this timer. Without the claim the recipient gets the
      // same message twice.
      mockPrisma.mailLog.findMany.mockResolvedValue([failedRow()]);
      mockPrisma.mailLog.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.retryFailed()).resolves.toEqual({
        retried: 0,
        sent: 0,
        abandoned: 0,
      });
      expect(mockSes.send).not.toHaveBeenCalled();
    });

    it('does nothing when SES is not configured', async () => {
      mockSes.enabled = false;

      await expect(service.retryFailed()).resolves.toEqual({
        retried: 0,
        sent: 0,
        abandoned: 0,
      });
      expect(mockPrisma.mailLog.findMany).not.toHaveBeenCalled();
    });
  });
});
