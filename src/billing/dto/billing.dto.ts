import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** What the subscription costs, read from the Razorpay plan. */
export class SubscriptionPlanDto {
  @ApiProperty({ description: 'Razorpay plan id' })
  planId: string;

  @ApiProperty({ nullable: true, description: 'The plan’s name at Razorpay' })
  name: string | null;

  @ApiProperty({
    description:
      'Price in the smallest currency unit — paise for INR. An integer on ' +
      'purpose: the console formats it, nothing rounds it.',
    example: 49900,
  })
  amount: number;

  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({
    description: 'monthly, yearly, weekly, daily',
    example: 'monthly',
  })
  period: string;

  @ApiProperty({ description: 'How many periods per charge', example: 1 })
  interval: number;
}

/** One debit, as it happened. */
export class SubscriptionPaymentDto {
  @ApiProperty({ example: 'pay_29QQoUBi66xm2f' })
  razorpayPaymentId: string;

  @ApiProperty({ nullable: true })
  razorpayInvoiceId: string | null;

  @ApiProperty({ description: 'In the smallest currency unit', example: 49900 })
  amount: number;

  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({
    description: 'Razorpay’s own vocabulary',
    example: 'captured',
  })
  status: string;

  @ApiProperty({ nullable: true, example: 'card' })
  method: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Enough to recognise the instrument, and no more',
    example: 'Visa ···· 4242',
  })
  methodDetail: string | null;

  @ApiProperty({ nullable: true })
  paidAt: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'Our invoice for this debit, in the deployment’s own series. Null for a ' +
      'payment that was never captured, and for debits taken before invoicing ' +
      'existed.',
    example: 'INV-WAC-2627-0001',
  })
  invoiceNumber: string | null;
}

export class SubscriptionStateDto {
  @ApiProperty({ description: 'The WhatsApp Business Account this covers' })
  wabaId: string;

  @ApiProperty({
    nullable: true,
    description: 'That account’s name, for display',
  })
  wabaName: string | null;

  @ApiProperty({
    description:
      'Whether an API key scoped to this account may call the Messaging API ' +
      'right now. True for a paid month that has not run out, even after cancelling.',
  })
  active: boolean;

  @ApiProperty({
    nullable: true,
    description:
      'Razorpay status, or null when this account was never subscribed',
    example: 'active',
  })
  status: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Start of the month currently paid for',
  })
  currentStart: Date | null;

  @ApiProperty({
    nullable: true,
    description: 'End of the month paid for. Access lasts until this moment',
  })
  currentEnd: Date | null;

  @ApiProperty({
    description: 'Cancelled, but still inside the month already paid for',
  })
  cancelAtCycleEnd: boolean;

  @ApiProperty({
    nullable: true,
    description:
      'Razorpay subscription id, for opening Checkout. Present only while the ' +
      'mandate is not yet registered — the customer has to authorise it there ' +
      'before anything is charged.',
  })
  subscriptionId: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Razorpay hosted authorisation page, as a fallback for a browser that ' +
      'cannot open Checkout. Present under the same conditions.',
  })
  authorisationUrl: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Publishable Razorpay key id, which Checkout needs in the browser',
  })
  keyId: string | null;

  @ApiProperty({
    description: 'Whether this deployment can sell subscriptions at all',
  })
  billingEnabled: boolean;

  @ApiProperty({
    nullable: true,
    description:
      'Published tier this was sold as (starter, growth, business). Null for ' +
      'a subscription on the deployment’s configured plan.',
  })
  planCode: string | null;

  @ApiProperty({ nullable: true, description: 'That tier’s name, for display' })
  planName: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'A tier chosen but not yet in force — a downgrade takes effect at the ' +
      'renewal rather than cutting short the month already paid for. Null ' +
      'when nothing is scheduled.',
  })
  pendingPlanCode: string | null;

  @ApiProperty({ nullable: true, description: 'That tier’s name, for display' })
  pendingPlanName: string | null;

  @ApiProperty({
    nullable: true,
    description: 'When the pending tier starts — the end of the paid month.',
  })
  pendingPlanAt: Date | null;

  @ApiProperty({
    type: SubscriptionPlanDto,
    nullable: true,
    description:
      'What this costs. Null only when billing is unconfigured or Razorpay ' +
      'could not be reached — a price the console cannot show is not a reason ' +
      'to fail the page.',
  })
  plan: SubscriptionPlanDto | null;

  @ApiProperty({
    type: SubscriptionPaymentDto,
    nullable: true,
    description: 'The most recent debit, or null before the first one',
  })
  lastPayment: SubscriptionPaymentDto | null;

  @ApiProperty({
    type: [SubscriptionPaymentDto],
    description: 'Recent debits, newest first. Empty until the first charge.',
  })
  payments: SubscriptionPaymentDto[];

  @ApiProperty({
    nullable: true,
    description:
      'When the next automatic debit is due. Null once cancelled, or before ' +
      'the mandate is authorised.',
  })
  nextChargeAt: Date | null;

  @ApiProperty({
    description: 'How many times this subscription has been charged',
    example: 3,
  })
  paidCount: number;
}

/** Body for `PATCH /billing/subscriptions/:wabaId/plan`. */
export class ChangePlanDto {
  @ApiProperty({
    description:
      'The tier to move to, from the published price list (`GET /plans`). ' +
      'Costing more than the current tier takes effect immediately; costing ' +
      'less takes effect at the end of the month already paid for.',
    example: 'business',
  })
  @IsString()
  @IsNotEmpty()
  planCode: string;
}

/** Body for `POST /billing/subscriptions/:wabaId`. */
export class RegisterSubscriptionDto {
  @ApiPropertyOptional({
    description:
      'Tier from the published price list (`GET /plans`), e.g. growth. Omit ' +
      'to use the deployment’s configured plan. A tier that is quoted rather ' +
      'than sold, or that has no Razorpay plan behind it, is refused.',
    example: 'growth',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  planCode?: string;
}

export class SubscriptionRegisteredDto {
  @ApiProperty({ description: 'The account the subscription was started for' })
  wabaId: string;

  @ApiProperty({
    description: 'Open Razorpay Checkout with this subscription id',
  })
  subscriptionId: string;

  @ApiProperty({ description: 'Publishable key id Checkout is opened with' })
  keyId: string;

  @ApiProperty({
    description:
      'Hosted authorisation page, for a browser that cannot open Checkout',
  })
  authorisationUrl: string;

  @ApiProperty()
  status: string;

  @ApiProperty({
    nullable: true,
    description: 'The tier it was sold as, or null on the configured plan',
  })
  planCode: string | null;
}

/** What Razorpay Checkout hands back when the mandate is authorised. */
export class ConfirmSubscriptionDto {
  @ApiProperty({ example: 'pay_29QQoUBi66xm2f' })
  @IsString()
  @IsNotEmpty()
  razorpayPaymentId: string;

  @ApiProperty({ example: 'sub_00000000000001' })
  @IsString()
  @IsNotEmpty()
  razorpaySubscriptionId: string;

  @ApiProperty({ description: 'HMAC over `payment_id|subscription_id`' })
  @IsString()
  @IsNotEmpty()
  razorpaySignature: string;
}

/**
 * One invoice, as the console lists it.
 *
 * Everything here is the snapshot written when the invoice was raised, not a
 * live read: a plan renamed or an organisation renamed since must not change
 * what a document already sent to a customer says.
 */
export class InvoiceDto {
  @ApiProperty({
    description: 'The number as printed, and the id every other route uses',
    example: 'INV-WAC-2627-0001',
  })
  number: string;

  @ApiProperty({
    description: 'The Indian financial year it was raised in',
    example: '2627',
  })
  financialYear: string;

  @ApiProperty()
  issuedAt: Date;

  @ApiProperty({ nullable: true })
  paidAt: Date | null;

  @ApiProperty({ nullable: true })
  organisationName: string | null;

  @ApiProperty({ nullable: true, description: 'The account the charge paid for' })
  accountName: string | null;

  @ApiProperty({ nullable: true })
  planName: string | null;

  @ApiProperty({ example: 'Growth plan — Acme Retail' })
  description: string;

  @ApiProperty({ nullable: true, description: 'Start of the cycle charged for' })
  periodStart: Date | null;

  @ApiProperty({ nullable: true })
  periodEnd: Date | null;

  @ApiProperty({
    description: 'Taxable value in the smallest currency unit',
    example: 42288,
  })
  subtotal: number;

  @ApiProperty({ description: 'Tax in the smallest currency unit', example: 7612 })
  taxAmount: number;

  @ApiProperty({
    description: 'Tax rate in basis points, so 18% is 1800. Zero where no rate is configured',
    example: 1800,
  })
  taxRateBps: number;

  @ApiProperty({ nullable: true, example: 'GST' })
  taxLabel: string | null;

  @ApiProperty({
    description: 'What was actually taken, in the smallest currency unit',
    example: 49900,
  })
  total: number;

  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({
    nullable: true,
    description: 'When the invoice was emailed. Null while it has not gone out',
  })
  emailedAt: Date | null;

  @ApiProperty({
    nullable: true,
    description: 'Where it was emailed, as recorded at the time',
  })
  emailedTo: string | null;

  @ApiProperty({
    description: 'Razorpay’s payment id, for tracing a query to their dashboard',
    example: 'pay_29QQoUBi66xm2f',
  })
  razorpayPaymentId: string;
}
