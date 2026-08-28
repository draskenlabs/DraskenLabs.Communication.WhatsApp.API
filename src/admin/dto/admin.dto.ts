import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/** The operator behind the current request. */
export class AdminMeDto {
  @ApiProperty() id: number;
  @ApiProperty({ nullable: true }) email: string | null;
  @ApiProperty({ nullable: true }) name: string | null;
}

/**
 * Money that should be arriving and is not.
 *
 * Declared above `AdminOverviewDto` rather than beside it: the decorator
 * metadata emitted for `atRisk` names this class when the module is evaluated,
 * and a class declaration is not hoisted.
 */
export class AdminAtRiskDto {
  @ApiProperty({ description: 'Payment failed, being retried' })
  pending: number;

  @ApiProperty({ description: 'Retries exhausted, mandate stopped' })
  halted: number;

  @ApiProperty({
    description: 'A tier was chosen and the mandate never authorised',
  })
  neverAuthorised: number;
}

/** One line of the estate, for the overview. */
export class AdminOverviewDto {
  @ApiProperty({ description: 'Organisations we have ever seen' })
  organisations: number;

  @ApiProperty({ description: 'Subscriptions granting access right now' })
  activeSubscriptions: number;

  @ApiProperty({
    description:
      'Recurring revenue from live subscriptions, in paise. Quoted plans ' +
      'carry no price and count for nothing here.',
  })
  mrr: number;

  @ApiProperty({ description: 'Currency the MRR is in' })
  currency: string;

  @ApiProperty({ description: 'Accounts connected across every organisation' })
  wabas: number;

  @ApiProperty({ description: 'Phone numbers across them' })
  phoneNumbers: number;

  @ApiProperty({ description: 'Contacts stored across every organisation' })
  contacts: number;

  @ApiProperty({
    description: 'Subscriptions in each state, keyed by status',
    type: Object,
  })
  byStatus: Record<string, number>;

  @ApiProperty({
    description:
      'Money that should be arriving and is not: payments being retried, ' +
      'mandates that stopped, and tiers chosen but never authorised.',
  })
  atRisk: AdminAtRiskDto;
}

/** One organisation, as the index lists it. */
export class AdminOrganisationRowDto {
  @ApiProperty() ssoOrgId: string;

  @ApiProperty({
    nullable: true,
    description:
      'Copied from the SSO when an account was connected. Null for an ' +
      'organisation that has never connected one.',
  })
  name: string | null;

  @ApiProperty({ nullable: true }) planCode: string | null;
  @ApiProperty({ nullable: true }) planName: string | null;
  @ApiProperty({ nullable: true }) status: string | null;

  @ApiProperty({ description: 'Whether its API keys work right now' })
  active: boolean;

  @ApiProperty({ nullable: true }) currentEnd: Date | null;

  @ApiProperty() wabas: number;
  @ApiProperty() phoneNumbers: number;
  @ApiProperty() contacts: number;

  @ApiProperty({ description: 'Manages clients of its own' })
  isAgency: boolean;

  @ApiProperty({
    nullable: true,
    description: 'The agency that pays for it, when it is somebody’s client',
  })
  agencyOrgId: string | null;

  @ApiProperty({
    nullable: true,
    description: 'The earliest thing we recorded for this organisation',
  })
  firstSeen: Date | null;
}

export class AdminOrganisationPageDto {
  @ApiProperty({ type: [AdminOrganisationRowDto] })
  organisations: AdminOrganisationRowDto[];

  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() totalPages: number;
}

/** One account inside an organisation. */
export class AdminWabaDto {
  @ApiProperty() wabaId: string;
  @ApiProperty({ nullable: true }) name: string | null;
  @ApiProperty() phoneNumbers: number;
  @ApiProperty() webhookEndpoints: number;
  @ApiProperty({ description: 'Live keys only' }) apiKeys: number;
  @ApiProperty() connectedAt: Date;
}

export class AdminPaymentDto {
  @ApiProperty() id: string;
  @ApiProperty() status: string;
  @ApiProperty({ nullable: true }) amount: number | null;
  @ApiProperty({ nullable: true }) method: string | null;
  @ApiProperty({ nullable: true }) paidAt: Date | null;
}

export class AdminClientDto {
  @ApiProperty() ssoOrgId: string;
  @ApiProperty({ nullable: true }) name: string | null;
}

/** Everything we hold about one organisation. */
export class AdminOrganisationDetailDto extends AdminOrganisationRowDto {
  @ApiProperty({
    nullable: true,
    description: 'The Razorpay subscription, for looking it up over there',
  })
  razorpaySubscriptionId: string | null;

  @ApiProperty({ nullable: true }) currentStart: Date | null;
  @ApiProperty() cancelAtCycleEnd: boolean;
  @ApiProperty({ nullable: true }) pendingPlanCode: string | null;
  @ApiProperty({ nullable: true }) pendingPlanAt: Date | null;

  @ApiProperty({ type: [AdminWabaDto] }) accounts: AdminWabaDto[];
  @ApiProperty({ type: [AdminPaymentDto] }) payments: AdminPaymentDto[];

  @ApiProperty({
    type: [AdminClientDto],
    description: 'Its clients, when it is an agency',
  })
  clients: AdminClientDto[];

  @ApiProperty({ description: 'What its plan allows', type: Object })
  limits: Record<string, number | string | null>;

  @ApiProperty({ description: 'Team seats, or null when the SSO has none' })
  apiKeys: number;

  @ApiProperty() webhookEndpoints: number;
  @ApiProperty() messagesLast30Days: number;
}

/** One subscription, for the money screen. */
export class AdminSubscriptionRowDto {
  @ApiProperty() ssoOrgId: string;
  @ApiProperty({ nullable: true }) organisationName: string | null;
  @ApiProperty() status: string;
  @ApiProperty({ nullable: true }) planCode: string | null;
  @ApiProperty({ nullable: true }) planName: string | null;
  @ApiProperty({ nullable: true }) price: number | null;
  @ApiProperty() currency: string;
  @ApiProperty({ nullable: true }) currentEnd: Date | null;
  @ApiProperty() cancelAtCycleEnd: boolean;
  @ApiProperty({
    nullable: true,
    description:
      'Null for a client an agency pays for — it is a quantity on the ' +
      'agency’s subscription rather than one of its own.',
  })
  razorpaySubscriptionId: string | null;

  @ApiProperty({ nullable: true }) lastPaymentAt: Date | null;
  @ApiProperty() createdAt: Date;
}

/** A plan as the editor sees it — including the ones the price list hides. */
export class AdminPlanDto {
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty() audience: string;
  @ApiProperty({ nullable: true }) price: number | null;
  @ApiProperty({ nullable: true }) priceLabel: string | null;
  @ApiProperty() currency: string;
  @ApiProperty() unit: string;
  @ApiProperty({ nullable: true }) additionalWabaPrice: number | null;
  @ApiProperty({ nullable: true }) additionalNumberPrice: number | null;
  @ApiProperty({ nullable: true }) includedWabas: number | null;
  @ApiProperty({ nullable: true }) includedPhoneNumbersPerWaba: number | null;
  @ApiProperty({ nullable: true }) includedClients: number | null;
  @ApiProperty({ nullable: true }) maxTeamMembers: number | null;
  @ApiProperty({ nullable: true }) maxWebhookEndpoints: number | null;
  @ApiProperty({ nullable: true }) maxApiKeysPerWaba: number | null;
  @ApiProperty({ nullable: true }) maxContacts: number | null;
  @ApiProperty({ nullable: true }) maxMessagesPerMinute: number | null;
  @ApiProperty({ nullable: true }) historyDays: number | null;
  @ApiProperty() rank: number;
  @ApiProperty() sortOrder: number;
  @ApiProperty() recommended: boolean;
  @ApiProperty() active: boolean;
  @ApiProperty() ctaKind: string;
  @ApiProperty() ctaLabel: string;

  @ApiProperty({
    nullable: true,
    description: 'The organisation this was negotiated for, or null if public',
  })
  ssoOrgId: string | null;

  @ApiProperty({
    description: 'Whether a subscription can be sold on it',
  })
  sellable: boolean;

  @ApiProperty({ description: 'Subscriptions currently on this plan' })
  subscribers: number;
}

/**
 * A change to a plan.
 *
 * `price`, `currency` and the Razorpay plan id are deliberately absent. A
 * Razorpay plan is immutable and a subscription is charged against the one it
 * was created on, so editing the amount here would change what the price list
 * says without changing what anybody is billed — the worst of both. Repricing
 * means a new plan.
 */
export class UpdatePlanDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(240)
  audience?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) unit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  priceLabel?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) additionalWabaPrice?:
    | number
    | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) additionalNumberPrice?:
    | number
    | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) includedWabas?:
    | number
    | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  includedPhoneNumbersPerWaba?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) includedClients?:
    | number
    | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) maxTeamMembers?:
    | number
    | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) maxWebhookEndpoints?:
    | number
    | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) maxApiKeysPerWaba?:
    | number
    | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) maxContacts?:
    | number
    | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) maxMessagesPerMinute?:
    | number
    | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) historyDays?:
    | number
    | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() rank?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() recommended?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;

  @ApiPropertyOptional({ enum: ['subscribe', 'contact'] })
  @IsOptional()
  @IsIn(['subscribe', 'contact'])
  ctaKind?: 'subscribe' | 'contact';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  ctaLabel?: string;
}

/**
 * A new plan.
 *
 * The one place an amount ever enters the system. A provider plan is immutable,
 * so the price is set here, at creation, and never again — repricing is a new
 * plan, which is exactly what this endpoint is for.
 */
export class CreatePlanDto {
  @ApiProperty({
    description:
      'Stable identifier used in seeds, analytics and URLs. Lower case, ' +
      'letters, numbers and hyphens.',
  })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,48}$/, {
    message:
      'code must be lower case letters, numbers and hyphens, 2–49 characters',
  })
  code: string;

  @ApiProperty() @IsString() @MaxLength(120) name: string;

  @ApiProperty({ description: 'Who the plan is for, in one line' })
  @IsString()
  @MaxLength(240)
  audience: string;

  @ApiPropertyOptional({
    description:
      'In paise. Omit for a quoted plan, which carries a label instead and ' +
      'cannot be checked out.',
  })
  @IsOptional()
  @IsInt()
  @Min(100)
  price?: number;

  @ApiPropertyOptional({
    description: 'Shown instead of an amount, e.g. "Custom"',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  priceLabel?: string;

  @ApiPropertyOptional({ default: 'INR' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiPropertyOptional({ description: 'What the price is per, e.g. "/month"' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  unit?: string;

  @ApiPropertyOptional({
    description:
      'The organisation this is negotiated for. Set it and the plan never ' +
      'appears on the public price list, and only that organisation can buy it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  ssoOrgId?: string;

  @ApiPropertyOptional({ enum: ['subscribe', 'contact'], default: 'subscribe' })
  @IsOptional()
  @IsIn(['subscribe', 'contact'])
  ctaKind?: 'subscribe' | 'contact';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  ctaLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  additionalWabaPrice?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  additionalNumberPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) includedWabas?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  includedPhoneNumbersPerWaba?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  includedClients?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) maxTeamMembers?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  maxWebhookEndpoints?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  maxApiKeysPerWaba?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) maxContacts?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxMessagesPerMinute?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) historyDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() rank?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() sortOrder?: number;
}

/** A person who can, or is about to be able to, use this console. */
export class AdminUserDto {
  @ApiProperty() id: number;
  @ApiProperty({ nullable: true }) email: string | null;
  @ApiProperty({ nullable: true }) name: string | null;
  @ApiProperty() isAdmin: boolean;
  @ApiProperty() createdAt: Date;
}

export class SetAdminDto {
  @ApiProperty({ description: 'Whether this person may use the console' })
  @IsBoolean()
  isAdmin: boolean;
}

export class ConvertOrgDto {
  @ApiProperty({ description: 'Whether this organisation manages clients' })
  @IsBoolean()
  isAgency: boolean;
}

export class AttachClientDto {
  @ApiProperty({ description: 'The organisation to place under the agency' })
  @IsString()
  ssoOrgId: string;

  @ApiPropertyOptional({ description: 'What the agency calls it' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  clientName?: string;
}

/** One recorded action. */
export class AdminAuditRowDto {
  @ApiProperty() id: number;
  @ApiProperty({ nullable: true }) actorEmail: string | null;
  @ApiProperty() actorUserId: number;
  @ApiProperty() action: string;
  @ApiProperty() targetType: string;
  @ApiProperty() targetId: string;
  @ApiProperty() summary: string;
  @ApiProperty() createdAt: Date;
}

export class AdminAuditPageDto {
  @ApiProperty({ type: [AdminAuditRowDto] }) entries: AdminAuditRowDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() totalPages: number;
}
