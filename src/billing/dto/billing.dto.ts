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
