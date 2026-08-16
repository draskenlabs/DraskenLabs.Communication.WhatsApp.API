import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * What a plan allows.
 *
 * Null means the plan puts no number on it — unlimited on a published plan,
 * negotiated on Agency. The console renders the difference as words; nothing
 * here should be read as zero.
 */
export class PlanLimitsDto {
  @ApiProperty({
    nullable: true,
    description: 'WhatsApp Business Accounts allowed',
  })
  wabas: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Phone numbers per WABA, the first of which is in the price',
  })
  phoneNumbersPerWaba: number | null;

  @ApiProperty({ nullable: true })
  teamMembers: number | null;

  @ApiProperty({ nullable: true })
  webhookEndpoints: number | null;

  @ApiProperty({
    nullable: true,
    description: 'How long message and webhook-event history is kept, in days',
  })
  historyDays: number | null;
}

export class PlanDto {
  @ApiProperty({
    description: 'Stable identifier: starter, growth, business, agency',
  })
  code: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ description: 'Who the plan is for, in one line' })
  audience: string;

  @ApiProperty({
    nullable: true,
    description:
      'Per WABA per month, in the smallest currency unit (paise for INR). ' +
      'Null where pricing is quoted rather than published.',
  })
  price: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Shown instead of an amount when `price` is null, e.g. "Custom"',
  })
  priceLabel: string | null;

  @ApiProperty()
  currency: string;

  @ApiProperty({ description: 'What the price is per, e.g. "/WABA/month"' })
  unit: string;

  @ApiProperty({
    nullable: true,
    description:
      'Monthly charge for each phone number after the first on a WABA, in the ' +
      'smallest currency unit',
  })
  additionalNumberPrice: number | null;

  @ApiProperty({ type: PlanLimitsDto })
  limits: PlanLimitsDto;

  @ApiProperty({
    type: [String],
    description: 'Feature bullets, in published order',
  })
  features: string[];

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Code of the plan this one builds on — "Everything in X, plus:"',
  })
  inherits: string | null;

  @ApiProperty({ description: 'Whether this is the highlighted plan' })
  recommended: boolean;

  @ApiProperty({ description: 'subscribe | contact' })
  ctaKind: string;

  @ApiProperty()
  ctaLabel: string;
}
