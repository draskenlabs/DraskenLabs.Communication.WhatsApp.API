import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';
import { BillingService } from './billing.service';
import { SubscriptionRegisteredDto, SubscriptionStateDto } from './dto/billing.dto';
import { ApiWrappedOkResponse } from 'src/common/responses/swagger.decorators';

@ApiTags('Billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('subscription')
  @ApiBearerAuth()
  @ApiOperation({ summary: "The organisation's subscription state" })
  @ApiWrappedOkResponse({ dataDto: SubscriptionStateDto, description: 'Subscription state' })
  async state(@Req() req: Request): Promise<SubscriptionStateDto> {
    const orgId = (req as any).orgId;
    if (!orgId) throw new UnauthorizedException('Organisation not found in context');
    return this.billing.getState(orgId);
  }

  @Post('subscription')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Register a monthly subscription',
    description:
      'Creates the subscription and returns the Razorpay page where the ' +
      'customer authorises the mandate. Nothing is charged until they do.',
  })
  @ApiWrappedOkResponse({
    dataDto: SubscriptionRegisteredDto,
    description: 'Subscription registered',
  })
  async register(@Req() req: Request): Promise<SubscriptionRegisteredDto> {
    const user = (req as any).user;
    const orgId = (req as any).orgId;
    if (!user || !orgId) throw new UnauthorizedException('User not found in context');

    return this.billing.register(user.id, orgId, {
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined,
      email: user.email,
    });
  }

  @Delete('subscription')
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel the subscription',
    description:
      'Stops the next debit. The month already paid for is kept — access ' +
      'continues until the end of it.',
  })
  @ApiWrappedOkResponse({ dataDto: SubscriptionStateDto, description: 'Subscription state' })
  async cancel(@Req() req: Request): Promise<SubscriptionStateDto> {
    const orgId = (req as any).orgId;
    if (!orgId) throw new UnauthorizedException('Organisation not found in context');
    return this.billing.cancel(orgId);
  }

  /** Razorpay-facing. Signature-checked by middleware; never called by a user. */
  @Post('webhook')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async webhook(@Req() req: Request, @Body() body: unknown): Promise<{ received: true }> {
    const eventId = req.headers['x-razorpay-event-id'] as string | undefined;
    if (!eventId) throw new BadRequestException('Missing X-Razorpay-Event-Id');

    await this.billing.handleWebhook(eventId, body);
    // Razorpay retries anything that is not a 2xx, so acknowledge once the
    // event is recorded.
    return { received: true };
  }
}
