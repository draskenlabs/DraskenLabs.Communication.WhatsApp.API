import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import { SesService } from './ses.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';

const mockPrisma = {
  user: { findMany: jest.fn(), findUnique: jest.fn() },
  userWhatsapp: { findMany: jest.fn() },
  notificationPreference: { findUnique: jest.fn(), upsert: jest.fn() },
  mailSuppression: { findUnique: jest.fn(), upsert: jest.fn() },
  mailLog: { create: jest.fn() },
};

const mockRedis = {
  queueDigestItem: jest.fn(),
  listDigestQueues: jest.fn().mockResolvedValue([]),
  drainDigest: jest.fn().mockResolvedValue([]),
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MailService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
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
    it('mails template decisions and failures when no row exists', async () => {
      await expect(service.sendTo(RECIPIENT, OPTIONS)).resolves.toBe(true);
      await expect(
        service.sendTo(RECIPIENT, { ...OPTIONS, kind: 'emailMessageFailed' }),
      ).resolves.toBe(true);
    });

    it('stays quiet about inbound messages and marketing by default', async () => {
      await expect(
        service.sendTo(RECIPIENT, { ...OPTIONS, kind: 'emailInboundMessage' }),
      ).resolves.toBe(false);
      await expect(
        service.sendTo(RECIPIENT, { ...OPTIONS, kind: 'emailProductNews' }),
      ).resolves.toBe(false);
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

  describe('digests', () => {
    it('drains a queue and sends one email for many failures', async () => {
      mockRedis.listDigestQueues.mockImplementation((kind: string) =>
        Promise.resolve(kind === 'failed-sends' ? [7] : []),
      );
      mockRedis.drainDigest.mockResolvedValue([
        { to: '447911111111', reason: 'Undeliverable' },
        { to: '447922222222', reason: null },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 7, email: 'ada@example.com', firstName: 'Ada' },
      ]);

      const result = await service.flushDigests();

      expect(result.failed).toBe(1);
      expect(mockSes.send).toHaveBeenCalledTimes(1);
      expect(mockSes.send.mock.calls[0][0].subject).toContain('2 messages');
    });

    it('sends nothing when the queues are empty', async () => {
      mockRedis.listDigestQueues.mockResolvedValue([]);
      await expect(service.flushDigests()).resolves.toEqual({
        failed: 0,
        inbound: 0,
      });
      expect(mockSes.send).not.toHaveBeenCalled();
    });
  });
});
