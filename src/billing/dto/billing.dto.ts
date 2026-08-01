import { ApiProperty } from '@nestjs/swagger';

export class SubscriptionStateDto {
  @ApiProperty({
    description:
      'Whether the Messaging API may be called with an API key right now. ' +
      'True for a paid month that has not run out, even after cancelling.',
  })
  active: boolean;

  @ApiProperty({
    nullable: true,
    description: 'Razorpay status, or null when the organisation never subscribed',
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
      'Razorpay authorisation page. Present only while the mandate is not yet ' +
      'registered — the customer has to complete it before anything is charged.',
  })
  authorisationUrl: string | null;

  @ApiProperty({ description: 'Whether this deployment can sell subscriptions at all' })
  billingEnabled: boolean;
}

export class SubscriptionRegisteredDto {
  @ApiProperty({ description: 'Where to send the customer to authorise the mandate' })
  authorisationUrl: string;

  @ApiProperty()
  status: string;
}
