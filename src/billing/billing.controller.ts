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
  Res,
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
import { Request, Response } from 'express';
import { BillingService } from './billing.service';
import { InvoiceService } from './invoice.service';
import { isInvoiceNumber } from './invoice.number';
import {
  ChangePlanDto,
  ConfirmSubscriptionDto,
  InvoiceDto,
  RegisterSubscriptionDto,
  SubscriptionRegisteredDto,
  SubscriptionStateDto,
} from './dto/billing.dto';
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

  @Get('subscription')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The organisation’s subscription, and what it covers',
    description:
      'One subscription pays for every account the organisation has ' +
      'connected. Answers even when there is none — the console’s job is to ' +
      'say whether the organisation is paid up and offer a tier if it is ' +
      'not. `usage` says what is connected against what the tier includes, ' +
      'and what the next account or number will cost: nothing here is a cap.',
  })
  @ApiWrappedOkResponse({
    dataDto: SubscriptionStateDto,
    description: 'Subscription state',
  })
  async state(@Req() req: Request): Promise<SubscriptionStateDto> {
    const orgId = this.orgOf(req);
    // The team-member count lives in the SSO, which needs the caller's own
    // token. Everything else on this page comes from our database.
    return this.billing.state(orgId, req.headers.authorization);
  }

  @Post('subscription')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Subscribe the organisation',
    description:
      'Creates the subscription on the chosen tier and returns the id to open ' +
      'Razorpay Checkout with, plus the hosted page as a fallback. Nothing is ' +
      'charged until the customer authorises the mandate. One subscription ' +
      'covers every account the organisation has, so this is done once — ' +
      'before or after connecting anything.',
  })
  @ApiWrappedOkResponse({
    dataDto: SubscriptionRegisteredDto,
    description: 'Subscription registered',
  })
  async register(
    @Req() req: Request,
    @Body() dto: RegisterSubscriptionDto,
  ): Promise<SubscriptionRegisteredDto> {
    const { user } = req as unknown as { user?: { id: number } };
    const orgId = this.orgOf(req);
    if (!user) throw new UnauthorizedException('User not found in context');

    // The name and email come from the user row, not from the request: this
    // context holds only an id and an SSO id.
    return this.billing.register(user.id, orgId, dto.planCode);
  }

  @Post('subscription/confirm')
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
    @Body() dto: ConfirmSubscriptionDto,
  ): Promise<SubscriptionStateDto> {
    const orgId = this.orgOf(req);
    return this.billing.confirm(orgId, dto);
  }

  @Patch('subscription/plan')
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({
    summary: "Move the organisation's subscription onto another tier",
    description:
      'A tier that costs more needs a new mandate — a Razorpay mandate is ' +
      'authorised for a fixed amount — so the response carries a ' +
      '`pendingAuthorisation` to open Checkout on. It starts charging where ' +
      'the month already paid for ends, with the difference for the rest of ' +
      'that month added as a one-off, and the old subscription is cancelled ' +
      'only once the new one is authorised. A tier that costs the same or ' +
      'less takes effect at the renewal, with no new mandate and no credit.',
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
    @Body() dto: ChangePlanDto,
  ): Promise<SubscriptionStateDto> {
    const orgId = this.orgOf(req);
    return this.billing.changePlan(orgId, dto.planCode);
  }

  @Delete('subscription')
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({
    summary: "Cancel the organisation's subscription",
    description:
      'Stops the next debit. The month already paid for is kept — access ' +
      'continues until the end of it. An upgrade the customer never got round ' +
      'to authorising is abandoned with it.',
  })
  @ApiWrappedOkResponse({
    dataDto: SubscriptionStateDto,
    description: 'Subscription state',
  })
  async cancel(@Req() req: Request): Promise<SubscriptionStateDto> {
    const orgId = this.orgOf(req);
    return this.billing.cancel(orgId);
  }

  /* ------------------------------------------------------------------ *
   * Invoices                                                            *
   * ------------------------------------------------------------------ */

  @Get('invoices')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Every invoice that bought this organisation a month',
    description:
      'Both the invoices charged to it and, for a client an agency pays ' +
      'for, the agency’s invoices carrying the line that bought its month. ' +
      'A client holds no mandate of its own, so without the second half its ' +
      'billing history would be empty while it was being paid for.',
  })
  @ApiWrappedOkResponse({
    dataDto: InvoiceDto,
    isArray: true,
    description: 'Invoices, newest first',
  })
  async invoiceList(@Req() req: Request): Promise<InvoiceDto[]> {
    const orgId = this.orgOf(req);
    const invoices = await this.invoices.listCoveringOrg(orgId);
    // Scoped per invoice, not per request: its own come back whole, and an
    // agency's come back as an extract of the lines that bought its month.
    return invoices.map((invoice) => this.invoices.toDtoFor(invoice, orgId));
  }

  @Get('invoices/:number')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'One invoice, by its number',
    description:
      'Scoped to the caller’s organisation. The numbers are sequential, so ' +
      'an unscoped lookup would let anyone with a session walk the series — ' +
      'somebody else’s number answers 404 rather than 403, which is the same ' +
      'answer a number that does not exist gets.',
  })
  @ApiWrappedOkResponse({ dataDto: InvoiceDto, description: 'The invoice' })
  @ApiStandardErrorResponses()
  async invoice(
    @Req() req: Request,
    @Param('number') number: string,
  ): Promise<InvoiceDto> {
    const orgId = this.orgOf(req);
    return this.invoices.toDtoFor(await this.readable(req, number), orgId);
  }

  @Get('invoices/:number/pdf')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The invoice as a PDF',
    description:
      'The same document that was emailed when the payment was taken. ' +
      'Rendered on demand from the snapshot rather than stored, so it cannot ' +
      'drift from the row it was raised against. Only for an invoice ' +
      'addressed to the caller: an agency’s client sees its own line through ' +
      'the list, not the agency’s whole debit.',
  })
  @ApiStandardErrorResponses()
  async invoicePdf(
    @Req() req: Request,
    @Param('number') number: string,
    @Res() res: Response,
  ): Promise<void> {
    // Stricter than the list: the document is the payer's whole debit, so an
    // agency's client downloading it would be downloading its rivals' names
    // and prices. It sees its own line as an extract instead.
    const invoice = await this.invoices.findAddressedTo(
      [this.orgOf(req)],
      number,
    );
    if (!invoice) throw new NotFoundException(`No invoice ${number}`);
    const pdf = this.invoices.pdf(invoice);

    res.setHeader('Content-Type', 'application/pdf');
    // `inline`, so a browser opens it rather than dropping it in Downloads. A
    // customer checking a figure usually wants to look, not to keep.
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${this.invoices.filename(invoice)}"`,
    );
    res.setHeader('Content-Length', String(pdf.length));
    res.end(pdf);
  }

  /**
   * One invoice this caller is allowed to read, or a 404.
   *
   * The number is checked against the series before the database is asked, so
   * a lookup by number cannot be turned into a search.
   */
  private async readable(req: Request, number: string) {
    const orgId = this.orgOf(req);
    if (!isInvoiceNumber(number)) {
      throw new NotFoundException(`No invoice ${number}`);
    }
    const invoice = await this.invoices.findForOrgs([orgId], number);
    if (!invoice) throw new NotFoundException(`No invoice ${number}`);
    return invoice;
  }

  /**
   * The organisation on the request, or a refusal.
   *
   * Typed rather than cast to `any`: `orgId` is put there by `AuthMiddleware`
   * and read by every route on this controller, so it is worth naming once.
   */
  private orgOf(req: Request): string {
    const { orgId } = req as unknown as { orgId?: string };
    if (!orgId)
      throw new UnauthorizedException('Organisation not found in context');
    return orgId;
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
