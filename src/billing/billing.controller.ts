import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  StreamableFile,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';
import { BillingService } from './billing.service';
import { InvoiceService } from './invoice.service';
import {
  ChangePlanDto,
  ConfirmSubscriptionDto,
  InvoiceDto,
  RegisterSubscriptionDto,
  SubscriptionRegisteredDto,
  SubscriptionStateDto,
} from './dto/billing.dto';
import { isInvoiceNumber } from './invoice.number';
import {
  ApiStandardErrorResponses,
  ApiWrappedOkResponse,
} from 'src/common/responses/swagger.decorators';

@ApiTags('Billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly invoices: InvoiceService,
  ) {}

  @Get('subscriptions')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Subscription state for every connected account',
    description:
      'One row per WhatsApp Business Account in the organisation, subscribed ' +
      'or not — an account missing from the list would read as disconnected ' +
      'rather than unpaid.',
  })
  @ApiWrappedOkResponse({
    dataDto: SubscriptionStateDto,
    isArray: true,
    description: 'Subscription state per account',
  })
  async list(@Req() req: Request): Promise<SubscriptionStateDto[]> {
    const orgId = (req as any).orgId;
    if (!orgId)
      throw new UnauthorizedException('Organisation not found in context');
    return this.billing.listStates(orgId);
  }

  @Post('subscriptions/:wabaId')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Subscribe one account',
    description:
      'Creates the subscription on the chosen tier and returns the id to open ' +
      'Razorpay Checkout with, plus the hosted page as a fallback. Nothing is ' +
      'charged until the customer authorises the mandate. Omit `planCode` to ' +
      'use the deployment’s configured plan.',
  })
  @ApiWrappedOkResponse({
    dataDto: SubscriptionRegisteredDto,
    description: 'Subscription registered',
  })
  async register(
    @Req() req: Request,
    @Param('wabaId') wabaId: string,
    @Body() dto: RegisterSubscriptionDto,
  ): Promise<SubscriptionRegisteredDto> {
    const user = (req as any).user;
    const orgId = (req as any).orgId;
    if (!user || !orgId)
      throw new UnauthorizedException('User not found in context');

    // The name and email come from the user row, not from the request: this
    // context holds only an id and an SSO id.
    return this.billing.register(user.id, orgId, wabaId, dto?.planCode);
  }

  @Post('subscriptions/:wabaId/confirm')
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Record a mandate authorised in Checkout',
    description:
      "Verifies Checkout's signature and re-reads the subscription from " +
      'Razorpay, so the console reflects the payment without waiting for the ' +
      'webhook that says the same thing.',
  })
  @ApiWrappedOkResponse({
    dataDto: SubscriptionStateDto,
    description: 'Subscription state',
  })
  async confirm(
    @Req() req: Request,
    @Param('wabaId') wabaId: string,
    @Body() dto: ConfirmSubscriptionDto,
  ): Promise<SubscriptionStateDto> {
    const orgId = (req as any).orgId;
    if (!orgId)
      throw new UnauthorizedException('Organisation not found in context');
    return this.billing.confirm(orgId, wabaId, dto);
  }

  @Patch('subscriptions/:wabaId/plan')
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({
    summary: "Move one account's subscription onto another tier",
    description:
      'A tier that costs more takes effect immediately — Razorpay closes the ' +
      'current cycle and starts one on the new plan. A tier that costs the ' +
      'same or less takes effect at the renewal, so the month already paid ' +
      'for keeps what it bought. Nothing is prorated either way. Refused ' +
      'where the mandate the customer authorised will not cover the higher ' +
      'amount: that needs a new subscription, which only they can authorise.',
  })
  @ApiWrappedOkResponse({
    dataDto: SubscriptionStateDto,
    description: 'Subscription state, with the pending tier where there is one',
  })
  @ApiStandardErrorResponses({
    badRequest: true,
    notFound: true,
    validation: true,
  })
  async changePlan(
    @Req() req: Request,
    @Param('wabaId') wabaId: string,
    @Body() dto: ChangePlanDto,
  ): Promise<SubscriptionStateDto> {
    const orgId = (req as any).orgId;
    if (!orgId)
      throw new UnauthorizedException('Organisation not found in context');
    return this.billing.changePlan(orgId, wabaId, dto.planCode);
  }

  @Delete('subscriptions/:wabaId')
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({
    summary: "Cancel one account's subscription",
    description:
      'Stops the next debit. The month already paid for is kept — access ' +
      'continues until the end of it.',
  })
  @ApiWrappedOkResponse({
    dataDto: SubscriptionStateDto,
    description: 'Subscription state',
  })
  async cancel(
    @Req() req: Request,
    @Param('wabaId') wabaId: string,
  ): Promise<SubscriptionStateDto> {
    const orgId = (req as any).orgId;
    if (!orgId)
      throw new UnauthorizedException('Organisation not found in context');
    return this.billing.cancel(orgId, wabaId);
  }

  @Get('invoices')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Invoices raised for this organisation',
    description:
      'One per captured payment, newest first, in the deployment’s own series ' +
      '(`INV-WAC-2627-0001` — the third part is the Indian financial year). ' +
      'Each was emailed to the person who took the subscription out when it ' +
      'was raised; this is where to find one again.',
  })
  @ApiWrappedOkResponse({
    dataDto: InvoiceDto,
    isArray: true,
    description: 'Invoices, newest first',
  })
  async listInvoices(@Req() req: Request): Promise<InvoiceDto[]> {
    const orgId = (req as any).orgId;
    if (!orgId)
      throw new UnauthorizedException('Organisation not found in context');
    const invoices = await this.invoices.listForOrg(orgId);
    return invoices.map((invoice) => this.invoices.toDto(invoice));
  }

  @Get('invoices/:number')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'One invoice' })
  @ApiWrappedOkResponse({ dataDto: InvoiceDto, description: 'The invoice' })
  @ApiStandardErrorResponses({ notFound: true })
  async invoice(
    @Req() req: Request,
    @Param('number') number: string,
  ): Promise<InvoiceDto> {
    return this.invoices.toDto(await this.ownedInvoice(req, number));
  }

  @Get('invoices/:number/pdf')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The invoice as a PDF',
    description:
      'The same document that was emailed. Served inline so a browser can ' +
      'show it, with the invoice number as the filename when it is saved.',
  })
  @ApiStandardErrorResponses({ notFound: true })
  async invoicePdf(
    @Req() req: Request,
    @Param('number') number: string,
  ): Promise<StreamableFile> {
    const invoice = await this.ownedInvoice(req, number);
    // A file rather than the response envelope every other route returns: a
    // PDF wrapped in JSON is not a PDF. The interceptor lets a StreamableFile
    // through untouched, which is what makes that possible.
    return new StreamableFile(this.invoices.pdf(invoice), {
      type: 'application/pdf',
      disposition: `inline; filename="${this.invoices.filename(invoice)}"`,
    });
  }

  /**
   * One invoice, or a 404 — including when it exists and belongs to somebody
   * else. The numbers are sequential, so "yours" and "not found" have to be
   * the same answer or the series is enumerable.
   */
  private async ownedInvoice(req: Request, number: string) {
    const orgId = (req as any).orgId;
    if (!orgId)
      throw new UnauthorizedException('Organisation not found in context');
    if (!isInvoiceNumber(number)) throw new NotFoundException('No such invoice');

    const invoice = await this.invoices.findForOrg(orgId, number);
    if (!invoice) throw new NotFoundException('No such invoice');
    return invoice;
  }

  /** Razorpay-facing. Signature-checked by middleware; never called by a user. */
  @Post('webhook')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async webhook(
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<{ received: true }> {
    const eventId = req.headers['x-razorpay-event-id'] as string | undefined;
    if (!eventId) throw new BadRequestException('Missing X-Razorpay-Event-Id');

    await this.billing.handleWebhook(eventId, body);
    // Razorpay retries anything that is not a 2xx, so acknowledge once the
    // event is recorded.
    return { received: true };
  }
}
