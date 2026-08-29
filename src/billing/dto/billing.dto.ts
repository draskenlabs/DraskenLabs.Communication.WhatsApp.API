import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

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
      'The invoice raised for this debit. Null for a payment taken before ' +
      'invoicing shipped, and for one that was never captured.',
    example: 'INV-WAC-2627-0001',
  })
  invoiceNumber: string | null;
}

/** One account the organisation's subscription pays for. */
export class CoveredAccountDto {
  @ApiProperty({ description: 'The WhatsApp Business Account' })
  wabaId: string;

  @ApiProperty({ nullable: true, description: 'Its name, for display' })
  name: string | null;

  @ApiProperty({ description: 'Phone numbers registered on it' })
  phoneNumbers: number;

  @ApiProperty({ description: 'Webhook endpoints configured on it' })
  webhookEndpoints: number;

  @ApiProperty({ description: 'Live API keys issued for it' })
  apiKeys: number;
}

/**
 * What the organisation is using, against what its plan allows.
 *
 * Two kinds of allowance sit here and they read differently, which is why the
 * field names differ.
 *
 * `included*` is **what the price covers**. Nothing is capped — an organisation
 * may connect as many accounts and numbers as it likes — so past the included
 * count the add-on price applies and the console's job is to say what the next
 * one costs, not to refuse it.
 *
 * `max*` is a **ceiling**, and reaching one refuses the next addition. Those
 * are worth seeing before they refuse something, which is the whole reason
 * they are reported here rather than only in the error.
 *
 * A count is `null` when it could not be established (team members live in the
 * SSO, not in this database) or does not apply (clients, for an organisation
 * that is not an agency). A limit is `null` when the plan names no number.
 */
export class SubscriptionUsageDto {
  @ApiProperty({ description: 'WhatsApp Business Accounts connected' })
  wabas: number;

  @ApiProperty({ description: 'Phone numbers across all of them' })
  phoneNumbers: number;

  @ApiProperty({
    nullable: true,
    description: 'Accounts the plan includes, or null when it names no number',
  })
  includedWabas: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Numbers each account includes, or null when it names none',
  })
  includedPhoneNumbersPerWaba: number | null;

  @ApiProperty({
    nullable: true,
    description: 'What each account past the included ones costs, in paise',
  })
  additionalWabaPrice: number | null;

  @ApiProperty({
    nullable: true,
    description: 'What each number past the included ones costs, in paise',
  })
  additionalNumberPrice: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Client organisations under this agency, or null if not one',
  })
  clients: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Clients the plan includes, or null when it names no number',
  })
  includedClients: number | null;

  @ApiProperty({ description: 'Contacts stored by this organisation' })
  contacts: number;

  @ApiProperty({ nullable: true, description: 'Ceiling on contacts' })
  maxContacts: number | null;

  @ApiProperty({ description: 'Webhook endpoints across all accounts' })
  webhookEndpoints: number;

  @ApiProperty({
    nullable: true,
    description: 'Ceiling on webhook endpoints, applied to each account',
  })
  maxWebhookEndpointsPerWaba: number | null;

  @ApiProperty({ description: 'Live API keys across all accounts' })
  apiKeys: number;

  @ApiProperty({
    nullable: true,
    description: 'Ceiling on API keys, applied to each account',
  })
  maxApiKeysPerWaba: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Members and pending invitations, or null when the SSO could not be ' +
      'asked. Absence is not zero.',
  })
  teamMembers: number | null;

  @ApiProperty({ nullable: true, description: 'Ceiling on team members' })
  maxTeamMembers: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Send rate the plan allows. A rate has no stock to count, so it is ' +
      'reported as the allowance alone.',
  })
  maxMessagesPerMinute: number | null;

  @ApiProperty({
    nullable: true,
    description: 'How long message history is kept, in days',
  })
  historyDays: number | null;
}

/** An upgrade waiting for the customer to authorise a new mandate. */
export class PendingAuthorisationDto {
  @ApiProperty({ description: 'Razorpay subscription id, to open Checkout on' })
  subscriptionId: string;

  @ApiProperty({ nullable: true, description: 'Hosted page, as a fallback' })
  authorisationUrl: string | null;

  @ApiProperty({ nullable: true, description: 'The tier being moved onto' })
  planCode: string | null;

  @ApiProperty({ nullable: true })
  planName: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'The one-off difference charged for the rest of the month already paid ' +
      'for, in paise. Null when the new tier starts at the renewal anyway.',
  })
  prorationAmount: number | null;
}

export class SubscriptionStateDto {
  @ApiProperty({
    description:
      'Whether the organisation may call the Messaging API right now. True ' +
      'for a paid month that has not run out, even after cancelling.',
  })
  active: boolean;

  @ApiProperty({
    type: CoveredAccountDto,
    isArray: true,
    description:
      'Every account in the organisation. One subscription pays for all of ' +
      'them, so this is what it covers rather than what it is billed against.',
  })
  covers: CoveredAccountDto[];

  @ApiProperty({ type: SubscriptionUsageDto })
  usage: SubscriptionUsageDto;

  @ApiProperty({
    nullable: true,
    description:
      'The organisation paying for this one, when it is not itself. Set for ' +
      'an agency’s client: the console shows what the plan is and who pays ' +
      'for it, instead of offering a checkout that would be refused.',
  })
  payerOrgId: string | null;

  @ApiProperty({
    nullable: true,
    description: 'What that organisation is called, where we know it',
  })
  payerName: string | null;

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

  @ApiProperty({
    type: PendingAuthorisationDto,
    nullable: true,
    description:
      'An upgrade the customer has been asked to authorise but has not yet. ' +
      'A Razorpay mandate is authorised for a fixed amount, so moving up a ' +
      'tier needs a new one — until they approve it they stay on, and keep ' +
      'paying for, the tier they have.',
  })
  pendingAuthorisation: PendingAuthorisationDto | null;
}

/** Body for `PATCH /billing/subscription/plan`. */
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

/** Body for `POST /billing/subscription`. */
export class RegisterSubscriptionDto {
  @ApiProperty({
    description:
      'Tier from the published price list (`GET /plans`), e.g. growth — or ' +
      'from `GET /plans/mine`, which also carries a tier negotiated for this ' +
      'organisation. Required: there is no deployment-wide default plan, ' +
      'because a price list with four tiers cannot be expressed by one. A ' +
      'tier that is quoted rather than sold, or that has no Razorpay plan ' +
      'behind it, is refused.',
    example: 'growth',
  })
  @IsString()
  @IsNotEmpty()
  planCode: string;
}

export class SubscriptionRegisteredDto {
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

  @ApiProperty({ description: 'The tier it was sold as' })
  planCode: string;

  @ApiProperty({
    nullable: true,
    description:
      'On an upgrade, the one-off difference charged for the rest of the ' +
      'month already paid for, in paise. Null on a first subscription, which ' +
      'has no month behind it to make up.',
  })
  prorationAmount: number | null;
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

/** One thing an invoice charged for. */
export class InvoiceLineDto {
  @ApiProperty({
    nullable: true,
    description:
      'The organisation this line bought for. A client of the agency being ' +
      'charged, on an agency’s invoice.',
  })
  ssoOrgId: string | null;

  @ApiProperty({ example: 'Growth — Kettle Coffee' })
  description: string;

  @ApiProperty({ nullable: true }) detail: string | null;
  @ApiProperty({ nullable: true }) planCode: string | null;
  @ApiProperty({ nullable: true }) planName: string | null;

  @ApiProperty({ example: 1 }) quantity: number;

  @ApiProperty({ description: 'Per unit, smallest currency unit' })
  unitAmount: number;

  @ApiProperty({ description: 'quantity × unitAmount' })
  amount: number;
}

/**
 * A receipt, as the console shows it.
 *
 * Deliberately thinner than an invoice: a receipt acknowledges money and
 * points at the document that explains it, so it carries no lines and no tax
 * split. `invoiceNumber` is how a reader gets from one to the other.
 */
export class ReceiptDto {
  @ApiProperty({ example: 'RCT-WAC-2627-0001' }) number: string;

  @ApiProperty({ example: '2627' }) financialYear: string;

  @ApiProperty() issuedAt: Date;

  @ApiProperty({
    nullable: true,
    description: 'When the money actually arrived',
  })
  receivedAt: Date | null;

  @ApiProperty({
    nullable: true,
    example: 'INV-WAC-2627-0001',
    description: 'The invoice this settles',
  })
  invoiceNumber: string | null;

  @ApiProperty() ssoOrgId: string;

  @ApiProperty({ nullable: true }) organisationName: string | null;

  @ApiProperty({ nullable: true, example: 'Growth' }) summary: string | null;

  @ApiProperty({
    description: 'What was received, in the smallest currency unit',
    example: 117882,
  })
  amount: number;

  @ApiProperty({ example: 'INR' }) currency: string;

  @ApiProperty({ nullable: true, example: 'Visa ···· 4242' })
  paymentMethod: string | null;

  @ApiProperty({ nullable: true }) emailedAt: Date | null;

  @ApiProperty({ example: 'pay_29QQoUBi66xm2f' }) razorpayPaymentId: string;
}

/**
 * An invoice as the console shows it.
 *
 * Everything here is the snapshot taken when the document was raised, not a
 * live read: a plan renamed or a client released next month cannot restate an
 * invoice already sent.
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

  @ApiProperty() issuedAt: Date;
  @ApiProperty({ nullable: true }) paidAt: Date | null;

  @ApiProperty({ description: 'The organisation charged — whose bank moved' })
  ssoOrgId: string;

  @ApiProperty({ nullable: true }) organisationName: string | null;

  @ApiProperty({
    nullable: true,
    description: 'What the money bought, in a few words',
    example: '3 client plans — Growth',
  })
  summary: string | null;

  @ApiProperty({ type: [InvoiceLineDto] })
  lines: InvoiceLineDto[];

  @ApiProperty({
    nullable: true,
    description: 'Start of the cycle charged for',
  })
  periodStart: Date | null;

  @ApiProperty({ nullable: true }) periodEnd: Date | null;

  @ApiProperty({
    description: 'Taxable value in the smallest currency unit',
    example: 42288,
  })
  subtotal: number;

  @ApiProperty({
    description: 'Tax in the smallest currency unit',
    example: 7612,
  })
  taxAmount: number;

  @ApiProperty({ description: 'Basis points, so 18% is 1800', example: 1800 })
  taxRateBps: number;

  @ApiProperty({ nullable: true, example: 'GST' }) taxLabel: string | null;

  @ApiProperty({
    description:
      'Central GST, on a supply inside our own state. Half the rate; the ' +
      'other half is sgstAmount. Zero on an inter-state supply.',
    example: 3806,
  })
  cgstAmount: number;

  @ApiProperty({ description: 'State GST — see cgstAmount', example: 3806 })
  sgstAmount: number;

  @ApiProperty({
    description:
      'Integrated GST, on a supply to another state. The whole rate, and ' +
      'zero whenever cgstAmount and sgstAmount are not.',
    example: 0,
  })
  igstAmount: number;

  @ApiProperty({
    nullable: true,
    description:
      'The state the supply was made to, which is what decided the split ' +
      'above. Absent on an extract — it is the payer’s, not the reader’s.',
    example: 'Karnataka (29)',
  })
  placeOfSupply: string | null;

  @ApiProperty({
    nullable: true,
    description: 'The customer’s registration, as stated on the document',
    example: '29AAPFU0939F1ZR',
  })
  billedToGstin: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Service classification the charge was made under',
    example: '998314',
  })
  sacCode: string | null;

  @ApiProperty({
    description: 'What was actually taken. Not derived — this is what moved.',
    example: 49900,
  })
  total: number;

  @ApiProperty({ example: 'INR' }) currency: string;

  @ApiProperty({ nullable: true, example: 'Visa ···· 4242' })
  paymentMethod: string | null;

  @ApiProperty({
    nullable: true,
    description: 'When the email carrying it went',
  })
  emailedAt: Date | null;

  @ApiProperty({ nullable: true }) emailedTo: string | null;

  @ApiProperty({ example: 'pay_29QQoUBi66xm2f' })
  razorpayPaymentId: string;

  @ApiProperty({
    description:
      'True when this is somebody else’s document seen from a line on it — ' +
      'an agency’s invoice, as one of its clients sees it. The lines and ' +
      'total are then this organisation’s share, not the whole debit, and ' +
      'the tax is absent because it divides the whole.',
  })
  extract: boolean;

  @ApiProperty({
    description:
      'Whether the PDF is on offer. False for an extract: the document is ' +
      'the payer’s entire debit and names its other clients.',
  })
  downloadable: boolean;
}
