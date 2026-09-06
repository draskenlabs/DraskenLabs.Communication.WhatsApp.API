import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InvoiceDto } from 'src/billing/dto/billing.dto';
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

/** One day's figure in a series. */
export class AdminSeriesPointDto {
  @ApiProperty({ description: 'The day, as YYYY-MM-DD in the billing zone' })
  date: string;

  @ApiProperty() value: number;
}

/** Revenue over the three windows an operator actually asks about. */
export class AdminRevenueDto {
  @ApiProperty({ description: 'Captured today, in the smallest unit' })
  today: number;

  @ApiProperty({ description: 'Captured since the 1st of this month' })
  month: number;

  @ApiProperty({ description: 'Captured since 1 April — the financial year' })
  year: number;

  @ApiProperty({ description: 'The same window a year’s worth of days covers' })
  currency: string;
}

/**
 * The overview's time series.
 *
 * Days are bucketed in the billing time zone rather than UTC: a sign-up at
 * 03:00 IST belongs to that day, and bucketing from UTC would file it under
 * the one before and make every daily figure quietly wrong.
 */
export class AdminAnalyticsDto {
  @ApiProperty({ description: 'Days covered' }) days: number;

  @ApiProperty({ type: [AdminSeriesPointDto] })
  registrations: AdminSeriesPointDto[];

  @ApiProperty({ type: [AdminSeriesPointDto] })
  subscriptions: AdminSeriesPointDto[];

  @ApiProperty({
    type: [AdminSeriesPointDto],
    description: 'Captured payments each day, in the smallest currency unit',
  })
  revenue: AdminSeriesPointDto[];

  @ApiProperty() currency: string;
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

  @ApiProperty({ description: 'People with an account on this deployment' })
  users: number;

  @ApiProperty({ description: 'Organisations marked as agencies' })
  agencies: number;

  @ApiProperty({
    description:
      'Money actually captured, as opposed to the MRR above — which is what ' +
      'the live subscriptions are worth if every one of them pays.',
  })
  revenue: AdminRevenueDto;
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
    description:
      'The organisation charged for this one, when it is not itself — an ' +
      'agency paying for a client.',
  })
  payerOrgId: string | null;

  @ApiProperty({ nullable: true, description: 'That organisation’s name' })
  payerName: string | null;

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
/**
 * One of a plan's numbers, with what the organisation is actually doing
 * against it.
 *
 * `kind` is the load-bearing field and the reason this is not a flat table of
 * numbers. An **inclusion** is what the price covers; going past it bills the
 * customer and refuses nobody. A **ceiling** refuses. Showing both as "8 / 5"
 * in the same red would have an operator chasing a customer who is simply
 * paying for what they use.
 */
export class AdminAllowanceDto {
  @ApiProperty({ example: 'contacts' }) key: string;

  @ApiProperty({ example: 'Contacts' }) label: string;

  @ApiProperty({
    description: 'What the plan gives. Null means the plan sets no number.',
    nullable: true,
    example: 10000,
  })
  allowed: number | null;

  @ApiProperty({
    description:
      'What is in use. Null where usage is not a count this deployment ' +
      'holds — a send rate is a ceiling on a moment, not a total.',
    nullable: true,
    example: 812,
  })
  used: number | null;

  @ApiProperty({
    enum: ['inclusion', 'ceiling', 'retention'],
    description:
      'inclusion — past it the customer is billed, not refused. ' +
      'ceiling — past it the request is refused. ' +
      'retention — a window, not a quantity.',
  })
  kind: 'inclusion' | 'ceiling' | 'retention';

  @ApiProperty({
    nullable: true,
    description: 'What each one past the inclusion costs, where it is sold',
    example: 29900,
  })
  overagePrice: number | null;

  @ApiProperty({
    description:
      'Whether usage has reached what the plan allows. On a ceiling that ' +
      'means the next request is refused; on an inclusion it means the next ' +
      'one bills.',
  })
  atLimit: boolean;
}

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

  @ApiProperty({
    type: [AdminAllowanceDto],
    description:
      'Every number the plan sets, paired with what is being used against ' +
      'it. The pairing is the point: `limits` alone says what is allowed and ' +
      'says nothing about whether it is close.',
  })
  allowances: AdminAllowanceDto[];

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
    nullable: true,
    description: 'The provider plan the next subscriber would be charged on',
  })
  razorpayPlanId: string | null;

  @ApiProperty({
    description: 'Whether a subscription can be sold on it',
  })
  sellable: boolean;

  @ApiProperty({
    description:
      'Whether this deployment has payment credentials at all. A property of ' +
      'the deployment, not of the tier — repeated on every row so the console ' +
      'can tell an unwired tier from an unwired deployment.',
  })
  billingEnabled: boolean;

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

  /**
   * Point the tier at a different provider plan.
   *
   * The one field here that moves money, so it is checked rather than trusted:
   * the plan has to exist at the provider and its amount has to match this
   * tier's price. Pointing a ₹499 tier at a ₹9,999 plan is one typo, and the
   * first anybody would know is a customer's bank statement.
   *
   * Existing subscribers are unaffected — each records the plan it was created
   * against — so this only ever changes what the *next* customer is charged.
   */
  @ApiPropertyOptional({ description: 'Provider plan id, e.g. plan_XXXXXXXX' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  razorpayPlanId?: string;
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

/**
 * One organisation a user has been seen acting in.
 *
 * Memberships live in the SSO, so this is what *we* have recorded rather than
 * an authoritative roster: an organisation appears here because this person
 * connected an account for it. Somebody invited to an organisation who has
 * connected nothing will not show up, which is why the screen says so rather
 * than presenting this as the whole truth.
 */
export class AdminUserOrgDto {
  @ApiProperty() ssoOrgId: string;
  @ApiProperty({ nullable: true }) name: string | null;
  @ApiProperty({ description: 'Accounts this person connected for it' })
  wabas: number;
  @ApiProperty({ description: 'Whether that organisation manages clients' })
  isAgency: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The tier it is on. Only on the detail view.',
  })
  planName?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Its subscription status, or null where it has none',
  })
  status?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Who pays for it, where that is somebody else',
  })
  payerName?: string | null;

  @ApiPropertyOptional({ description: 'When this person first connected one' })
  since?: Date;
}

/** A user, with the organisations we have seen them in. */
export class AdminUserRowDto {
  @ApiProperty() id: number;
  @ApiProperty({ nullable: true }) email: string | null;
  @ApiProperty({ nullable: true }) name: string | null;
  @ApiProperty() isAdmin: boolean;
  @ApiProperty() createdAt: Date;

  @ApiProperty({ type: [AdminUserOrgDto] })
  organisations: AdminUserOrgDto[];
}

/**
 * One user, in full: who they are and every organisation we have seen them in.
 *
 * The organisations carry enough to be worth landing on — what each is paying
 * and how big it is — so an operator following somebody from a support ticket
 * does not have to open three of them to find the one that matters.
 */
export class AdminUserDetailDto {
  @ApiProperty() id: number;
  @ApiProperty({ nullable: true }) email: string | null;
  @ApiProperty({ nullable: true }) name: string | null;
  @ApiProperty() isAdmin: boolean;
  @ApiProperty() createdAt: Date;

  @ApiProperty({
    nullable: true,
    description: 'The SSO identity behind the account',
  })
  ssoId: string | null;

  @ApiProperty({
    type: [AdminUserOrgDto],
    description:
      'Organisations this person connected an account for. Membership lives ' +
      'in the SSO, so somebody invited who has connected nothing has none.',
  })
  organisations: AdminUserOrgDto[];
}

export class AdminUserPageDto {
  @ApiProperty({ type: [AdminUserRowDto] }) users: AdminUserRowDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() totalPages: number;
}

/** One client an agency manages. */
export class AdminAgencyClientDto {
  @ApiProperty() ssoOrgId: string;
  @ApiProperty({
    nullable: true,
    description: 'What the agency calls it, falling back to its own name',
  })
  name: string | null;

  @ApiProperty({ nullable: true, description: 'The tier it is on' })
  planName: string | null;

  @ApiProperty({ nullable: true }) planCode: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Its subscription status, or null where it has none',
  })
  status: string | null;

  @ApiProperty({
    nullable: true,
    description: 'What the agency pays for it a month, in the smallest unit',
  })
  price: number | null;

  @ApiProperty({ description: 'When the agency took it on' })
  since: Date;
}

/** An agency, and the clients under it. */
export class AdminAgencyRowDto {
  @ApiProperty() ssoOrgId: string;
  @ApiProperty({ nullable: true }) name: string | null;

  @ApiProperty({ nullable: true, description: 'Who marked it an agency' })
  convertedBy: string | null;

  @ApiProperty({ nullable: true }) convertedAt: Date | null;

  @ApiProperty({ description: 'How many clients it manages' })
  clientCount: number;

  @ApiProperty({
    description:
      'What it pays a month across every client, in the smallest currency ' +
      'unit. Clients on a quoted tier carry no price and count for nothing.',
  })
  monthly: number;

  @ApiProperty() currency: string;

  @ApiProperty({ type: [AdminAgencyClientDto] })
  clients: AdminAgencyClientDto[];
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
/** A page of invoices, with the one figure on the screen that is a job. */
export class AdminInvoicePageDto {
  @ApiProperty({ type: [InvoiceDto] }) invoices: InvoiceDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() totalPages: number;

  @ApiProperty({
    description:
      'Invoices raised and never emailed — a mail outage at the moment of ' +
      'the charge. Not page-scoped: it is the whole backlog.',
  })
  undelivered: number;
}

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
