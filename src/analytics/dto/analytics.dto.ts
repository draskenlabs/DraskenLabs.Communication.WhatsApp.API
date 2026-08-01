import { ApiProperty } from '@nestjs/swagger';

/* ------------------------------------------------------------------ *
 * Shared shapes                                                       *
 * ------------------------------------------------------------------ */

/**
 * One headline number, with the same number from the period immediately
 * before it. A figure with nothing to compare against says very little —
 * "48,290 sent" is only news next to last week's.
 */
export class StatDto {
  @ApiProperty({ example: 'sent' })
  key: string;

  @ApiProperty({ example: 'Messages sent' })
  label: string;

  @ApiProperty({ example: 48290, description: 'This period' })
  value: number;

  @ApiProperty({ example: 42960, description: 'The period immediately before' })
  previous: number;

  @ApiProperty({
    enum: ['count', 'rate', 'duration'],
    example: 'count',
    description:
      'How to render it: a plain count, a 0–1 rate shown as a percentage, ' +
      'or a duration in seconds',
  })
  format: string;
}

export class DailyPointDto {
  @ApiProperty({ example: '2026-07-20' })
  date: string;

  @ApiProperty({ example: 4310 })
  sent: number;

  @ApiProperty({ example: 4180 })
  delivered: number;

  @ApiProperty({ example: 3120 })
  read: number;

  @ApiProperty({ example: 61 })
  failed: number;

  @ApiProperty({ example: 240, description: 'Replies received that day' })
  inbound: number;
}

export class LabelledCountDto {
  @ApiProperty({ example: 'template' })
  label: string;

  @ApiProperty({ example: 1820 })
  value: number;
}

/* ------------------------------------------------------------------ *
 * Overview                                                            *
 * ------------------------------------------------------------------ */

export class FunnelStageDto {
  @ApiProperty({ example: 'Delivered' })
  label: string;

  @ApiProperty({ example: 4180 })
  value: number;

  @ApiProperty({
    example: 0.973,
    description: 'Share of the first stage, 0–1',
  })
  share: number;
}

export class AnalyticsOverviewDto {
  @ApiProperty({ example: 14 })
  rangeDays: number;

  @ApiProperty({ type: [StatDto] })
  stats: StatDto[];

  @ApiProperty({ type: [DailyPointDto] })
  series: DailyPointDto[];

  @ApiProperty({
    type: [FunnelStageDto],
    description: 'Sent → delivered → read, each as a share of sent',
  })
  funnel: FunnelStageDto[];
}

/* ------------------------------------------------------------------ *
 * Messages                                                            *
 * ------------------------------------------------------------------ */

export class HourlyCellDto {
  @ApiProperty({ example: 2, description: '0 = Sunday' })
  weekday: number;

  @ApiProperty({ example: 14, description: 'Hour of the day, 0–23' })
  hour: number;

  @ApiProperty({ example: 88 })
  value: number;
}

export class MessageAnalyticsDetailDto {
  @ApiProperty({ example: 14 })
  rangeDays: number;

  @ApiProperty({ type: [DailyPointDto] })
  series: DailyPointDto[];

  @ApiProperty({
    type: [LabelledCountDto],
    description: 'Volume by message type',
  })
  byType: LabelledCountDto[];

  @ApiProperty({
    type: [LabelledCountDto],
    description: 'Failure reasons, most common first',
  })
  failureReasons: LabelledCountDto[];

  @ApiProperty({
    type: [HourlyCellDto],
    description: 'Volume by weekday and hour, for a send-window heatmap',
  })
  hourly: HourlyCellDto[];

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 42,
    description:
      'Median seconds from send to delivery. Null until enough messages ' +
      'carry a delivery timestamp — it is not backfillable.',
  })
  medianSecondsToDelivered: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 900,
    description: 'Median seconds from delivery to read',
  })
  medianSecondsToRead: number | null;
}

/* ------------------------------------------------------------------ *
 * Templates                                                           *
 * ------------------------------------------------------------------ */

export class TemplatePerformanceDto {
  @ApiProperty({ example: 'order_shipped' })
  name: string;

  @ApiProperty({ example: 1820 })
  sent: number;

  @ApiProperty({ example: 1795 })
  delivered: number;

  @ApiProperty({ example: 1402 })
  read: number;

  @ApiProperty({ example: 25 })
  failed: number;

  @ApiProperty({ example: 0.986, description: 'delivered ÷ sent, 0–1' })
  deliveryRate: number;

  @ApiProperty({ example: 0.781, description: 'read ÷ delivered, 0–1' })
  readRate: number;
}

export class TemplateAnalyticsDto {
  @ApiProperty({ example: 14 })
  rangeDays: number;

  @ApiProperty({
    type: [TemplatePerformanceDto],
    description: 'Templates actually used in the range, busiest first',
  })
  performance: TemplatePerformanceDto[];

  @ApiProperty({
    type: [LabelledCountDto],
    description: 'Every template by approval status',
  })
  byStatus: LabelledCountDto[];

  @ApiProperty({
    type: [LabelledCountDto],
    description: 'Every template by Meta category',
  })
  byCategory: LabelledCountDto[];

  @ApiProperty({
    type: [LabelledCountDto],
    description: 'Why Meta rejected templates, most common first',
  })
  rejectionReasons: LabelledCountDto[];
}

/* ------------------------------------------------------------------ *
 * Contacts                                                            *
 * ------------------------------------------------------------------ */

export class ContactPointDto {
  @ApiProperty({ example: '2026-07-20' })
  date: string;

  @ApiProperty({ example: 24, description: 'Contacts added that day' })
  added: number;

  @ApiProperty({ example: 1284, description: 'Running total at end of day' })
  total: number;

  @ApiProperty({ example: 3, description: 'Opt-outs recorded that day' })
  optedOut: number;
}

export class ContactAnalyticsDto {
  @ApiProperty({ example: 14 })
  rangeDays: number;

  @ApiProperty({ example: 12845 })
  total: number;

  @ApiProperty({ example: 318 })
  optedOut: number;

  @ApiProperty({ example: 0.025, description: 'opted out ÷ total, 0–1' })
  optOutRate: number;

  @ApiProperty({ type: [ContactPointDto] })
  series: ContactPointDto[];

  @ApiProperty({
    example: 214,
    description:
      'Opt-outs with no recorded date — they happened before the date was ' +
      'captured, so they sit outside the series rather than being invented ' +
      'into it',
  })
  optedOutUndated: number;
}

/* ------------------------------------------------------------------ *
 * Phone numbers                                                       *
 * ------------------------------------------------------------------ */

export class PhoneNumberStatsDto {
  @ApiProperty({ example: '15550001111' })
  phoneNumberId: string;

  @ApiProperty({ example: '+1 555 000 1111' })
  displayPhoneNumber: string;

  @ApiProperty({ example: 'Drasken Retail' })
  verifiedName: string;

  @ApiProperty({ example: 'GREEN' })
  qualityRating: string;

  @ApiProperty({ example: 'STANDARD' })
  throughputLevel: string;

  @ApiProperty({ example: 4310 })
  sent: number;

  @ApiProperty({ example: 4180 })
  delivered: number;

  @ApiProperty({ example: 61 })
  failed: number;

  @ApiProperty({ example: 0.014, description: 'failed ÷ sent, 0–1' })
  failureRate: number;
}

export class QualityPointDto {
  @ApiProperty({ example: '2026-07-20' })
  date: string;

  @ApiProperty({ example: '15550001111' })
  phoneNumberId: string;

  @ApiProperty({ example: 'GREEN' })
  qualityRating: string;
}

export class PhoneNumberAnalyticsDto {
  @ApiProperty({ example: 14 })
  rangeDays: number;

  @ApiProperty({ type: [PhoneNumberStatsDto] })
  numbers: PhoneNumberStatsDto[];

  @ApiProperty({
    type: [QualityPointDto],
    description:
      'Quality changes Meta reported in the range. Empty until a change ' +
      'happens — the rating is only recorded when it moves.',
  })
  qualityHistory: QualityPointDto[];
}
