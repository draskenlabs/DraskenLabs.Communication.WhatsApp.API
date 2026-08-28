import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
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
import {
  ChangePlanDto,
  ConfirmSubscriptionDto,
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
  constructor(private readonly billing: BillingService) {}

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
    const orgId = (req as any).orgId;
    if (!orgId)
      throw new UnauthorizedException('Organisation not found in context');
    return this.billing.state(orgId);
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
    const user = (req as any).user;
    const orgId = (req as any).orgId;
    if (!user || !orgId)
      throw new UnauthorizedException('User not found in context');

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
    const orgId = (req as any).orgId;
    if (!orgId)
      throw new UnauthorizedException('Organisation not found in context');
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
    const orgId = (req as any).orgId;
    if (!orgId)
      throw new UnauthorizedException('Organisation not found in context');
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
    const orgId = (req as any).orgId;
    if (!orgId)
      throw new UnauthorizedException('Organisation not found in context');
    return this.billing.cancel(orgId);
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
