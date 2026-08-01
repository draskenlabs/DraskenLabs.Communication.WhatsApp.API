import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from 'src/prisma/prisma.service';

const mockPrisma = {
  message: { findMany: jest.fn() },
  inboundMessage: { findMany: jest.fn() },
  messageTemplate: { findMany: jest.fn() },
  contact: { findMany: jest.fn(), count: jest.fn() },
  waba: { findMany: jest.fn() },
  wabaPhoneNumber: { findMany: jest.fn() },
  phoneQualityEvent: { findMany: jest.fn() },
};

/** `daysAgo(0)` is midday today, so a bucket lands on the expected date. */
const daysAgo = (n: number): Date => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
};

const key = (d: Date): string => d.toISOString().slice(0, 10);

const message = (over: Partial<Record<string, unknown>> = {}) => ({
  status: 'delivered',
  type: 'template',
  createdAt: daysAgo(1),
  deliveredAt: null,
  readAt: null,
  failureReason: null,
  templateName: null,
  phoneNumberId: 'p1',
  ...over,
});

describe('AnalyticsService', () => {
  let service: AnalyticsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.inboundMessage.findMany.mockResolvedValue([]);
    mockPrisma.messageTemplate.findMany.mockResolvedValue([]);
    mockPrisma.contact.findMany.mockResolvedValue([]);
    mockPrisma.contact.count.mockResolvedValue(0);
    mockPrisma.waba.findMany.mockResolvedValue([{ wabaId: 'w1' }]);
    mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue([
      { phoneNumberId: 'p1' },
    ]);
    mockPrisma.phoneQualityEvent.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<AnalyticsService>(AnalyticsService);
  });

  describe('range handling', () => {
    it('clamps a nonsense range instead of scanning the whole table', async () => {
      expect((await service.overview('org_1', { days: 5000 })).rangeDays).toBe(
        90,
      );
      expect((await service.overview('org_1', { days: 0 })).rangeDays).toBe(1);
    });

    it('seeds a bucket for every day, so a quiet day is a zero not a gap', async () => {
      const result = await service.overview('org_1', { days: 7 });
      expect(result.series).toHaveLength(7);
      expect(result.series.every((p) => p.sent === 0)).toBe(true);
    });
  });

  describe('overview', () => {
    beforeEach(() => {
      mockPrisma.message.findMany
        // This period.
        .mockResolvedValueOnce([
          message({ status: 'read' }),
          message({ status: 'delivered' }),
          message({ status: 'failed' }),
          message({ status: 'sent' }),
        ])
        // The period before it.
        .mockResolvedValueOnce([message({ status: 'delivered' })]);
    });

    it('counts a read message as delivered too', async () => {
      // Treating them as exclusive would make delivery look like it collapsed
      // whenever the read rate rose.
      const { stats, funnel } = await service.overview('org_1', { days: 7 });

      expect(stats.find((s) => s.key === 'sent')?.value).toBe(4);
      expect(funnel).toEqual([
        { label: 'Sent', value: 4, share: 1 },
        { label: 'Delivered', value: 2, share: 0.5 },
        { label: 'Read', value: 1, share: 0.25 },
      ]);
    });

    it('carries the previous period on every stat, so a number reads as a change', async () => {
      const { stats } = await service.overview('org_1', { days: 7 });

      expect(stats.find((s) => s.key === 'sent')?.previous).toBe(1);
      expect(stats.find((s) => s.key === 'failed')?.previous).toBe(0);
    });

    it('asks for the previous window as its own query, not the same rows twice', async () => {
      await service.overview('org_1', { days: 7 });

      const [current, previous] = mockPrisma.message.findMany.mock.calls as [
        [{ where: { createdAt: { gte: Date; lt?: Date } } }],
        [{ where: { createdAt: { gte: Date; lt?: Date } } }],
      ];
      expect(previous[0].where.createdAt.lt).toEqual(
        current[0].where.createdAt.gte,
      );
    });
  });

  describe('messages', () => {
    it('ranks failure reasons and message types by frequency', async () => {
      mockPrisma.message.findMany.mockResolvedValue([
        message({
          status: 'failed',
          failureReason: 'Outside window',
          type: 'text',
        }),
        message({
          status: 'failed',
          failureReason: 'Outside window',
          type: 'text',
        }),
        message({
          status: 'failed',
          failureReason: 'Not opted in',
          type: 'template',
        }),
      ]);

      const result = await service.messages('org_1', { days: 7 });

      expect(result.failureReasons[0]).toEqual({
        label: 'Outside window',
        value: 2,
      });
      expect(result.byType[0]).toEqual({ label: 'text', value: 2 });
    });

    it('names an unexplained failure rather than dropping it from the chart', async () => {
      mockPrisma.message.findMany.mockResolvedValue([
        message({ status: 'failed', failureReason: null }),
      ]);

      const result = await service.messages('org_1', { days: 7 });

      expect(result.failureReasons).toEqual([
        { label: 'No reason given', value: 1 },
      ]);
    });

    it('reports the median delivery time, not the mean', async () => {
      // One message delivered days late after a phone came back online would
      // drag an average into nonsense.
      const at = (from: Date, secs: number) =>
        new Date(from.getTime() + secs * 1000);
      const base = daysAgo(1);
      mockPrisma.message.findMany.mockResolvedValue([
        message({ createdAt: base, deliveredAt: at(base, 10) }),
        message({ createdAt: base, deliveredAt: at(base, 20) }),
        message({ createdAt: base, deliveredAt: at(base, 200000) }),
      ]);

      expect(
        (await service.messages('org_1', {})).medianSecondsToDelivered,
      ).toBe(20);
    });

    it('returns null for timings nothing has recorded yet', async () => {
      mockPrisma.message.findMany.mockResolvedValue([message()]);

      const result = await service.messages('org_1', {});
      expect(result.medianSecondsToDelivered).toBeNull();
      expect(result.medianSecondsToRead).toBeNull();
    });

    it('buckets by weekday and hour for the send-window heatmap', async () => {
      const when = daysAgo(1);
      mockPrisma.message.findMany.mockResolvedValue([
        message({ createdAt: when }),
        message({ createdAt: when }),
      ]);

      const { hourly } = await service.messages('org_1', {});
      expect(hourly).toEqual([
        { weekday: when.getDay(), hour: when.getHours(), value: 2 },
      ]);
    });
  });

  describe('templates', () => {
    it('rates each template on its own sends, busiest first', async () => {
      mockPrisma.message.findMany.mockResolvedValue([
        message({ templateName: 'order_shipped', status: 'read' }),
        message({ templateName: 'order_shipped', status: 'delivered' }),
        message({ templateName: 'order_shipped', status: 'failed' }),
        message({ templateName: 'otp_login', status: 'delivered' }),
      ]);

      const { performance } = await service.templates('org_1', {});

      expect(performance[0]).toEqual({
        name: 'order_shipped',
        sent: 3,
        delivered: 2,
        read: 1,
        failed: 1,
        deliveryRate: 0.667,
        readRate: 0.5,
      });
      expect(performance[1].name).toBe('otp_login');
    });

    it('leaves out sends from before the template name was recorded', async () => {
      // Their name is inside the payload; guessing would be worse than omitting.
      mockPrisma.message.findMany.mockResolvedValue([
        message({ templateName: null }),
      ]);

      expect((await service.templates('org_1', {})).performance).toEqual([]);
    });

    it('counts every template by status and category, used or not', async () => {
      mockPrisma.messageTemplate.findMany.mockResolvedValue([
        { status: 'APPROVED', category: 'UTILITY', rejectedReason: null },
        { status: 'APPROVED', category: 'MARKETING', rejectedReason: null },
        {
          status: 'REJECTED',
          category: 'MARKETING',
          rejectedReason: 'Abusive content',
        },
      ]);

      const result = await service.templates('org_1', {});

      expect(result.byStatus[0]).toEqual({ label: 'APPROVED', value: 2 });
      expect(result.byCategory[0]).toEqual({ label: 'MARKETING', value: 2 });
      expect(result.rejectionReasons).toEqual([
        { label: 'Abusive content', value: 1 },
      ]);
    });
  });

  describe('contacts', () => {
    it('starts the running total from what existed before the window', async () => {
      // Otherwise the line begins at zero and the growth is a fiction.
      mockPrisma.contact.findMany.mockResolvedValue([
        { createdAt: daysAgo(60), optedOut: false, optedOutAt: null },
        { createdAt: daysAgo(60), optedOut: false, optedOutAt: null },
        { createdAt: daysAgo(1), optedOut: false, optedOutAt: null },
      ]);
      mockPrisma.contact.count.mockResolvedValue(3);

      const { series } = await service.contacts('org_1', { days: 7 });

      expect(series[0].total).toBe(2);
      expect(series.at(-2)?.total).toBe(3);
      expect(series.at(-2)?.added).toBe(1);
    });

    it('keeps undated opt-outs out of the series and reports them separately', async () => {
      // Dating them to today would draw a spike that never happened.
      mockPrisma.contact.findMany.mockResolvedValue([
        { createdAt: daysAgo(60), optedOut: true, optedOutAt: null },
        { createdAt: daysAgo(60), optedOut: true, optedOutAt: daysAgo(2) },
      ]);
      mockPrisma.contact.count.mockResolvedValue(2);

      const result = await service.contacts('org_1', { days: 7 });

      expect(result.optedOutUndated).toBe(1);
      const day = result.series.find((p) => p.date === key(daysAgo(2)));
      expect(day?.optedOut).toBe(1);
      expect(result.series.reduce((n, p) => n + p.optedOut, 0)).toBe(1);
    });
  });

  describe('phone numbers', () => {
    it('reports a number with no traffic rather than omitting it', async () => {
      mockPrisma.wabaPhoneNumber.findMany.mockResolvedValue([
        {
          phoneNumberId: 'p1',
          displayPhoneNumber: '+1 555',
          verifiedName: 'Retail',
          qualityRating: 'GREEN',
          throughputLevel: 'STANDARD',
        },
        {
          phoneNumberId: 'p2',
          displayPhoneNumber: '+1 666',
          verifiedName: 'Support',
          qualityRating: 'GREEN',
          throughputLevel: 'STANDARD',
        },
      ]);
      mockPrisma.message.findMany.mockResolvedValue([
        message({ phoneNumberId: 'p1', status: 'failed' }),
        message({ phoneNumberId: 'p1', status: 'delivered' }),
      ]);

      const { numbers } = await service.phoneNumbers('org_1', {});

      expect(numbers[0]).toMatchObject({
        phoneNumberId: 'p1',
        sent: 2,
        failed: 1,
        failureRate: 0.5,
      });
      // A silent number is a fact about the account, not a missing row.
      expect(numbers[1]).toMatchObject({ phoneNumberId: 'p2', sent: 0 });
    });
  });

  describe('scoping', () => {
    it('resolves a WABA filter into its phone numbers', async () => {
      // Messages carry a phone number and not a WABA, so the filter cannot be
      // applied directly.
      await service.messages('org_1', { wabaId: 'w1' });

      expect(mockPrisma.wabaPhoneNumber.findMany).toHaveBeenCalledWith({
        where: { wabaId: { in: ['w1'] } },
        select: { phoneNumberId: true },
      });
      const [call] = mockPrisma.message.findMany.mock.calls as [
        [{ where: { phoneNumberId?: { in: string[] } } }],
      ];
      expect(call[0].where.phoneNumberId).toEqual({ in: ['p1'] });
    });

    it('never reads another organisation, whatever is filtered', async () => {
      await service.messages('org_1', { phoneNumberId: 'p9' });

      const [call] = mockPrisma.message.findMany.mock.calls as [
        [{ where: { ssoOrgId: string } }],
      ];
      expect(call[0].where.ssoOrgId).toBe('org_1');
    });
  });

  describe('export', () => {
    it('quotes a value a spreadsheet would otherwise split', async () => {
      mockPrisma.message.findMany.mockResolvedValue([
        message({ templateName: 'promo, summer', status: 'delivered' }),
      ]);

      const { csv, filename } = await service.exportCsv(
        'org_1',
        'templates',
        {},
      );

      expect(csv.split('\n')[1]).toContain('"promo, summer"');
      expect(filename).toMatch(/^templates-\d{4}-\d{2}-\d{2}\.csv$/);
    });

    it('falls back to the overview for an unknown dataset', async () => {
      const { csv } = await service.exportCsv('org_1', 'nonsense', {});
      expect(csv.split('\n')[0]).toBe('metric,value,previous');
    });
  });
});
