import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  AnalyticsOverviewDto,
  ContactAnalyticsDto,
  ContactPointDto,
  DailyPointDto,
  LabelledCountDto,
  MessageAnalyticsDetailDto,
  PhoneNumberAnalyticsDto,
  StatDto,
  TemplateAnalyticsDto,
  TemplatePerformanceDto,
} from './dto/analytics.dto';

/** The filters every endpoint accepts. */
export interface AnalyticsQuery {
  days?: number;
  wabaId?: string;
  phoneNumberId?: string;
}

/** A resolved window plus the equally long window before it, for deltas. */
interface Range {
  days: number;
  from: Date;
  previousFrom: Date;
}

const MAX_DAYS = 90;
const DEFAULT_DAYS = 14;

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
const round = (n: number): number => Math.round(n * 1000) / 1000;
const rate = (part: number, whole: number): number =>
  whole ? round(part / whole) : 0;

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /* ---------------------------------------------------------------- *
   * Overview                                                          *
   * ---------------------------------------------------------------- */

  /**
   * Everything the dashboard shows, in one call: the headline stats with a
   * previous-period comparison, a daily series, and the delivery funnel.
   *
   * The console used to assemble this from four list endpoints and count in
   * the browser, which meant no comparison was possible and the contact tile
   * was the length of a fetched array.
   */
  async overview(
    ssoOrgId: string,
    query: AnalyticsQuery = {},
  ): Promise<AnalyticsOverviewDto> {
    const range = this.resolveRange(query.days);
    const numbers = await this.scopeNumbers(ssoOrgId, query);

    const [messages, previousMessages, inbound, templates, contacts] =
      await Promise.all([
        this.messagesIn(ssoOrgId, range.from, numbers),
        this.messagesIn(ssoOrgId, range.previousFrom, numbers, range.from),
        this.inboundIn(ssoOrgId, range.from, query),
        this.prisma.messageTemplate.findMany({
          where: await this.templateScope(ssoOrgId, query),
          select: { status: true },
        }),
        this.prisma.contact.count({ where: { ssoOrgId } }),
      ]);

    const totals = this.countStatuses(messages);
    const previous = this.countStatuses(previousMessages);
    const approved = templates.filter((t) => t.status === 'APPROVED').length;

    const stats: StatDto[] = [
      stat('sent', 'Messages sent', totals.total, previous.total),
      stat(
        'delivery',
        'Delivery rate',
        rate(totals.deliveredOrRead, totals.total),
        rate(previous.deliveredOrRead, previous.total),
        'rate',
      ),
      stat(
        'read',
        'Read rate',
        rate(totals.read, totals.deliveredOrRead),
        rate(previous.read, previous.deliveredOrRead),
        'rate',
      ),
      stat('failed', 'Failed', totals.failed, previous.failed),
      stat('inbound', 'Replies received', inbound.length, 0),
      // Templates and contacts are current counts, not period totals, so there
      // is nothing honest to compare them with.
      stat('templates', 'Active templates', approved, approved),
      stat('contacts', 'Contacts', contacts, contacts),
    ];

    return {
      rangeDays: range.days,
      stats,
      series: this.dailySeries(range, messages, inbound),
      funnel: [
        { label: 'Sent', value: totals.total, share: 1 },
        {
          label: 'Delivered',
          value: totals.deliveredOrRead,
          share: rate(totals.deliveredOrRead, totals.total),
        },
        {
          label: 'Read',
          value: totals.read,
          share: rate(totals.read, totals.total),
        },
      ],
    };
  }

  /* ---------------------------------------------------------------- *
   * Messages                                                          *
   * ---------------------------------------------------------------- */

  async messages(
    ssoOrgId: string,
    query: AnalyticsQuery = {},
  ): Promise<MessageAnalyticsDetailDto> {
    const range = this.resolveRange(query.days);
    const numbers = await this.scopeNumbers(ssoOrgId, query);
    const [messages, inbound] = await Promise.all([
      this.messagesIn(ssoOrgId, range.from, numbers),
      this.inboundIn(ssoOrgId, range.from, query),
    ]);

    const byType = tally(messages.map((m) => m.type));
    const failureReasons = tally(
      messages
        .filter((m) => m.status === 'failed')
        .map((m) => m.failureReason ?? 'No reason given'),
    );

    // Weekday × hour, so the empty cells are as informative as the busy ones.
    const cells = new Map<string, number>();
    for (const m of messages) {
      const key = `${m.createdAt.getDay()}:${m.createdAt.getHours()}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }

    return {
      rangeDays: range.days,
      series: this.dailySeries(range, messages, inbound),
      byType,
      failureReasons,
      hourly: [...cells.entries()].map(([key, value]) => {
        const [weekday, hour] = key.split(':').map(Number);
        return { weekday, hour, value };
      }),
      medianSecondsToDelivered: median(
        messages
          .filter((m) => m.deliveredAt)
          .map((m) => seconds(m.createdAt, m.deliveredAt as Date)),
      ),
      medianSecondsToRead: median(
        messages
          .filter((m) => m.readAt && m.deliveredAt)
          .map((m) => seconds(m.deliveredAt as Date, m.readAt as Date)),
      ),
    };
  }

  /* ---------------------------------------------------------------- *
   * Templates                                                         *
   * ---------------------------------------------------------------- */

  async templates(
    ssoOrgId: string,
    query: AnalyticsQuery = {},
  ): Promise<TemplateAnalyticsDto> {
    const range = this.resolveRange(query.days);
    const numbers = await this.scopeNumbers(ssoOrgId, query);

    const [sends, templates] = await Promise.all([
      this.messagesIn(ssoOrgId, range.from, numbers),
      this.prisma.messageTemplate.findMany({
        where: await this.templateScope(ssoOrgId, query),
        select: { status: true, category: true, rejectedReason: true },
      }),
    ]);

    // Only messages that named a template. Anything sent before the name was
    // captured has none, and guessing from the payload would be worse than
    // leaving it out.
    const byTemplate = new Map<string, TemplatePerformanceDto>();
    for (const m of sends) {
      if (!m.templateName) continue;
      const row =
        byTemplate.get(m.templateName) ?? blankTemplate(m.templateName);
      row.sent++;
      if (m.status === 'delivered' || m.status === 'read') row.delivered++;
      if (m.status === 'read') row.read++;
      if (m.status === 'failed') row.failed++;
      byTemplate.set(m.templateName, row);
    }

    const performance = [...byTemplate.values()]
      .map((row) => ({
        ...row,
        deliveryRate: rate(row.delivered, row.sent),
        readRate: rate(row.read, row.delivered),
      }))
      .sort((a, b) => b.sent - a.sent);

    return {
      rangeDays: range.days,
      performance,
      byStatus: tally(templates.map((t) => t.status)),
      byCategory: tally(templates.map((t) => t.category)),
      rejectionReasons: tally(
        templates
          .filter((t) => t.status === 'REJECTED' && t.rejectedReason)
          .map((t) => t.rejectedReason as string),
      ),
    };
  }

  /* ---------------------------------------------------------------- *
   * Contacts                                                          *
   * ---------------------------------------------------------------- */

  async contacts(
    ssoOrgId: string,
    query: AnalyticsQuery = {},
  ): Promise<ContactAnalyticsDto> {
    const range = this.resolveRange(query.days);

    const [all, total, optedOut] = await Promise.all([
      this.prisma.contact.findMany({
        where: { ssoOrgId },
        select: { createdAt: true, optedOut: true, optedOutAt: true },
      }),
      this.prisma.contact.count({ where: { ssoOrgId } }),
      this.prisma.contact.count({ where: { ssoOrgId, optedOut: true } }),
    ]);

    // The running total has to start from everything that existed before the
    // window, or the line begins at zero and the growth is a fiction.
    let running = all.filter((c) => c.createdAt < range.from).length;

    const added = new Map<string, number>();
    const outs = new Map<string, number>();
    for (const c of all) {
      if (c.createdAt >= range.from) {
        const key = dayKey(c.createdAt);
        added.set(key, (added.get(key) ?? 0) + 1);
      }
      if (c.optedOut && c.optedOutAt && c.optedOutAt >= range.from) {
        const key = dayKey(c.optedOutAt);
        outs.set(key, (outs.get(key) ?? 0) + 1);
      }
    }

    const series: ContactPointDto[] = this.eachDay(range).map((date) => {
      running += added.get(date) ?? 0;
      return {
        date,
        added: added.get(date) ?? 0,
        total: running,
        optedOut: outs.get(date) ?? 0,
      };
    });

    return {
      rangeDays: range.days,
      total,
      optedOut,
      optOutRate: rate(optedOut, total),
      series,
      // Opt-outs from before the date was captured. Reported separately rather
      // than dropped silently or dated to today, either of which would put a
      // spike in the chart that never happened.
      optedOutUndated: all.filter((c) => c.optedOut && !c.optedOutAt).length,
    };
  }

  /* ---------------------------------------------------------------- *
   * Phone numbers                                                     *
   * ---------------------------------------------------------------- */

  async phoneNumbers(
    ssoOrgId: string,
    query: AnalyticsQuery = {},
  ): Promise<PhoneNumberAnalyticsDto> {
    const range = this.resolveRange(query.days);
    const wabaIds = await this.orgWabaIds(ssoOrgId, query.wabaId);

    const numbers = await this.prisma.wabaPhoneNumber.findMany({
      where: {
        wabaId: { in: wabaIds },
        ...(query.phoneNumberId && { phoneNumberId: query.phoneNumberId }),
      },
      select: {
        phoneNumberId: true,
        displayPhoneNumber: true,
        verifiedName: true,
        qualityRating: true,
        throughputLevel: true,
      },
    });
    const ids = numbers.map((n) => n.phoneNumberId);

    const [messages, history] = await Promise.all([
      this.messagesIn(ssoOrgId, range.from, ids),
      this.prisma.phoneQualityEvent.findMany({
        where: {
          phoneNumberId: { in: ids },
          createdAt: { gte: range.from },
        },
        orderBy: { createdAt: 'asc' },
        select: {
          createdAt: true,
          phoneNumberId: true,
          qualityRating: true,
        },
      }),
    ]);

    const perNumber = new Map(
      ids.map((id) => [id, { sent: 0, delivered: 0, failed: 0 }]),
    );
    for (const m of messages) {
      const row = perNumber.get(m.phoneNumberId);
      if (!row) continue;
      row.sent++;
      if (m.status === 'delivered' || m.status === 'read') row.delivered++;
      if (m.status === 'failed') row.failed++;
    }

    return {
      rangeDays: range.days,
      numbers: numbers
        .map((n) => {
          const row = perNumber.get(n.phoneNumberId) ?? {
            sent: 0,
            delivered: 0,
            failed: 0,
          };
          return {
            ...n,
            ...row,
            failureRate: rate(row.failed, row.sent),
          };
        })
        .sort((a, b) => b.sent - a.sent),
      qualityHistory: history.map((h) => ({
        date: dayKey(h.createdAt),
        phoneNumberId: h.phoneNumberId,
        qualityRating: h.qualityRating,
      })),
    };
  }

  /* ---------------------------------------------------------------- *
   * Export                                                            *
   * ---------------------------------------------------------------- */

  /**
   * The same numbers as a downloadable table. CSV is generated here rather
   * than in the browser so a scheduled job or a spreadsheet can fetch it
   * directly.
   */
  async exportCsv(
    ssoOrgId: string,
    dataset: string,
    query: AnalyticsQuery = {},
  ): Promise<{ filename: string; csv: string }> {
    const stamp = dayKey(new Date());

    switch (dataset) {
      case 'messages': {
        const { series } = await this.messages(ssoOrgId, query);
        return {
          filename: `messages-${stamp}.csv`,
          csv: toCsv(
            ['date', 'sent', 'delivered', 'read', 'failed', 'inbound'],
            series.map((p) => [
              p.date,
              p.sent,
              p.delivered,
              p.read,
              p.failed,
              p.inbound,
            ]),
          ),
        };
      }
      case 'templates': {
        const { performance } = await this.templates(ssoOrgId, query);
        return {
          filename: `templates-${stamp}.csv`,
          csv: toCsv(
            [
              'name',
              'sent',
              'delivered',
              'read',
              'failed',
              'deliveryRate',
              'readRate',
            ],
            performance.map((t) => [
              t.name,
              t.sent,
              t.delivered,
              t.read,
              t.failed,
              t.deliveryRate,
              t.readRate,
            ]),
          ),
        };
      }
      case 'contacts': {
        const { series } = await this.contacts(ssoOrgId, query);
        return {
          filename: `contacts-${stamp}.csv`,
          csv: toCsv(
            ['date', 'added', 'total', 'optedOut'],
            series.map((p) => [p.date, p.added, p.total, p.optedOut]),
          ),
        };
      }
      case 'phone-numbers': {
        const { numbers } = await this.phoneNumbers(ssoOrgId, query);
        return {
          filename: `phone-numbers-${stamp}.csv`,
          csv: toCsv(
            [
              'phoneNumberId',
              'displayPhoneNumber',
              'verifiedName',
              'qualityRating',
              'sent',
              'delivered',
              'failed',
              'failureRate',
            ],
            numbers.map((n) => [
              n.phoneNumberId,
              n.displayPhoneNumber,
              n.verifiedName,
              n.qualityRating,
              n.sent,
              n.delivered,
              n.failed,
              n.failureRate,
            ]),
          ),
        };
      }
      default: {
        const { stats } = await this.overview(ssoOrgId, query);
        return {
          filename: `overview-${stamp}.csv`,
          csv: toCsv(
            ['metric', 'value', 'previous'],
            stats.map((s) => [s.label, s.value, s.previous]),
          ),
        };
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Shared query plumbing                                             *
   * ---------------------------------------------------------------- */

  private resolveRange(days?: number): Range {
    const span = Math.min(
      Math.max(Math.floor(days ?? DEFAULT_DAYS), 1),
      MAX_DAYS,
    );
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - (span - 1));

    const previousFrom = new Date(from);
    previousFrom.setDate(previousFrom.getDate() - span);

    return { days: span, from, previousFrom };
  }

  private eachDay(range: Range): string[] {
    return Array.from({ length: range.days }, (_, i) => {
      const d = new Date(range.from);
      d.setDate(range.from.getDate() + i);
      return dayKey(d);
    });
  }

  /** WABAs in the organisation, narrowed to one when asked for. */
  private async orgWabaIds(
    ssoOrgId: string,
    wabaId?: string,
  ): Promise<string[]> {
    const wabas = await this.prisma.waba.findMany({
      where: {
        WabaOrganisation: { some: { ssoOrgId } },
        ...(wabaId && { wabaId }),
      },
      select: { wabaId: true },
    });
    return wabas.map((w) => w.wabaId);
  }

  /**
   * The phone numbers a query covers, or null for "no restriction".
   *
   * Messages carry a phone number and not a WABA, so a WABA filter has to be
   * resolved into numbers before it can be applied.
   */
  private async scopeNumbers(
    ssoOrgId: string,
    query: AnalyticsQuery,
  ): Promise<string[] | null> {
    if (query.phoneNumberId) return [query.phoneNumberId];
    if (!query.wabaId) return null;

    const wabaIds = await this.orgWabaIds(ssoOrgId, query.wabaId);
    if (wabaIds.length === 0) return [];

    const numbers = await this.prisma.wabaPhoneNumber.findMany({
      where: { wabaId: { in: wabaIds } },
      select: { phoneNumberId: true },
    });
    return numbers.map((n) => n.phoneNumberId);
  }

  private async templateScope(ssoOrgId: string, query: AnalyticsQuery) {
    return { wabaId: { in: await this.orgWabaIds(ssoOrgId, query.wabaId) } };
  }

  private messagesIn(
    ssoOrgId: string,
    from: Date,
    numbers: string[] | null,
    to?: Date,
  ) {
    return this.prisma.message.findMany({
      where: {
        ssoOrgId,
        createdAt: { gte: from, ...(to && { lt: to }) },
        ...(numbers && { phoneNumberId: { in: numbers } }),
      },
      select: {
        status: true,
        type: true,
        createdAt: true,
        deliveredAt: true,
        readAt: true,
        failureReason: true,
        templateName: true,
        phoneNumberId: true,
      },
    });
  }

  private async inboundIn(
    ssoOrgId: string,
    from: Date,
    query: AnalyticsQuery,
  ): Promise<{ createdAt: Date }[]> {
    const wabaIds = await this.orgWabaIds(ssoOrgId, query.wabaId);
    if (wabaIds.length === 0) return [];

    return this.prisma.inboundMessage.findMany({
      where: {
        wabaId: { in: wabaIds },
        createdAt: { gte: from },
        ...(query.phoneNumberId && { phoneNumberId: query.phoneNumberId }),
      },
      select: { createdAt: true },
    });
  }

  private countStatuses(messages: { status: string }[]) {
    const totals = { sent: 0, delivered: 0, read: 0, failed: 0 };
    for (const m of messages) {
      if (m.status in totals) totals[m.status as keyof typeof totals]++;
    }
    const deliveredOrRead = totals.delivered + totals.read;
    return {
      ...totals,
      deliveredOrRead,
      total: totals.sent + deliveredOrRead + totals.failed,
    };
  }

  /** One bucket per day, pre-seeded, so a quiet day is a zero and not a gap. */
  private dailySeries(
    range: Range,
    messages: { status: string; createdAt: Date }[],
    inbound: { createdAt: Date }[],
  ): DailyPointDto[] {
    const buckets = new Map<string, DailyPointDto>(
      this.eachDay(range).map((date) => [
        date,
        { date, sent: 0, delivered: 0, read: 0, failed: 0, inbound: 0 },
      ]),
    );

    for (const m of messages) {
      const bucket = buckets.get(dayKey(m.createdAt));
      if (!bucket) continue;
      bucket.sent++;
      // A read message was also delivered — charting them as exclusive would
      // make delivery look like it collapsed as read rates rose.
      if (m.status === 'delivered' || m.status === 'read') bucket.delivered++;
      if (m.status === 'read') bucket.read++;
      if (m.status === 'failed') bucket.failed++;
    }

    for (const i of inbound) {
      const bucket = buckets.get(dayKey(i.createdAt));
      if (bucket) bucket.inbound++;
    }

    return [...buckets.values()];
  }
}

/* ------------------------------------------------------------------ *
 * Small pure helpers                                                  *
 * ------------------------------------------------------------------ */

function stat(
  key: string,
  label: string,
  value: number,
  previous: number,
  format: 'count' | 'rate' | 'duration' = 'count',
): StatDto {
  return { key, label, value, previous, format };
}

function blankTemplate(name: string): TemplatePerformanceDto {
  return {
    name,
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
    deliveryRate: 0,
    readRate: 0,
  };
}

/** Count occurrences, biggest first. */
function tally(values: string[]): LabelledCountDto[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

const seconds = (from: Date, to: Date): number =>
  Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));

/**
 * The median, not the mean: one message delivered three days late after a
 * phone came back online would drag an average into nonsense.
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function toCsv(headers: string[], rows: (string | number)[][]): string {
  const escape = (v: string | number): string => {
    const s = String(v);
    // Quote anything a spreadsheet would otherwise split or mangle.
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(escape).join(',')).join('\n');
}
