import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class SubscriptionStateDto {
  @ApiProperty({ description: 'The WhatsApp Business Account this covers' })
  wabaId: string;

  @ApiProperty({ nullable: true, description: 'That account’s name, for display' })
  wabaName: string | null;

  @ApiProperty({
    description:
      'Whether an API key scoped to this account may call the Messaging API ' +
      'right now. True for a paid month that has not run out, even after cancelling.',
  })
  active: boolean;

  @ApiProperty({
    nullable: true,
    description: 'Razorpay status, or null when this account was never subscribed',
    example: 'active',
  })
  status: string | null;

  @ApiProperty({ nullable: true, description: 'Start of the month currently paid for' })
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
    description: 'Publishable Razorpay key id, which Checkout needs in the browser',
  })
  keyId: string | null;

  @ApiProperty({ description: 'Whether this deployment can sell subscriptions at all' })
  billingEnabled: boolean;
}

export class SubscriptionRegisteredDto {
  @ApiProperty({ description: 'The account the subscription was started for' })
  wabaId: string;

  @ApiProperty({ description: 'Open Razorpay Checkout with this subscription id' })
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
