import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
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
  ConfirmSubscriptionDto,
  RegisterSubscriptionDto,
  SubscriptionRegisteredDto,
  SubscriptionStateDto,
} from './dto/billing.dto';
import { ApiWrappedOkResponse } from 'src/common/responses/swagger.decorators';

@ApiTags('Billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

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
