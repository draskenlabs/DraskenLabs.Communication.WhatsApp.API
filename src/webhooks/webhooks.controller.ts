import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  Body,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { WebhooksService } from './webhooks.service';
import { WebhookConfigDto } from './dto/webhook-config.dto';
import { WebhookEventDto } from './dto/webhook-event.dto';
import { PaginationMetaDto } from 'src/common/responses/swagger-response.dto';
import { BaseResponse } from 'src/common/responses/base-response';
import { ApiWrappedOkResponse } from 'src/common/responses/swagger.decorators';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly config: ConfigService,
  ) {}

  @Get('config')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: 'Webhook configuration for the console',
    description:
      'Returns the callback URL, signature header and subscribed fields for display in the dashboard. The verify token value is never returned — only whether it is configured.',
  })
  @ApiWrappedOkResponse({ dataDto: WebhookConfigDto, description: 'Webhook configuration' })
  getConfig(@Req() req: Request): WebhookConfigDto {
    const host = req.get('host');
    const callbackUrl = `${req.protocol}://${host ?? ''}/webhooks`;
    return this.webhooksService.getConfig(callbackUrl);
  }

  @Get('events')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: 'Webhook events for a WABA (paginated)',
    description: 'Returns stored webhook events for a WABA owned by the caller, newest first, with pagination metadata.',
  })
  @ApiQuery({ name: 'wabaId', required: true, description: 'WABA id to list events for' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '1-based page number (default 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size, 1–100 (default 20)' })
  @ApiWrappedOkResponse({
    dataDto: WebhookEventDto,
    isArray: true,
    metaDto: PaginationMetaDto,
    description: 'Webhook events',
  })
  async getEvents(
    @Req() req: Request,
    @Query('wabaId') wabaId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<BaseResponse<WebhookEventDto[]>> {
    const orgId = (req as any).orgId;
    if (!orgId) throw new UnauthorizedException('Organisation not found in context');
    if (!wabaId) throw new ForbiddenException('wabaId is required');
    return this.webhooksService.getRecentEvents(orgId, wabaId, {
      page: page !== undefined ? Number(page) : undefined,
      limit: limit !== undefined ? Number(limit) : undefined,
    });
  }

  @Get()
  @ApiOperation({
    summary: 'Meta webhook verification',
    description:
      'One-time GET request sent by Meta when a webhook subscription is created. Validates hub.verify_token and echoes hub.challenge as plain text.',
  })
  @ApiQuery({ name: 'hub.mode', required: true, example: 'subscribe' })
  @ApiQuery({ name: 'hub.verify_token', required: true, description: 'Must match WEBHOOK_VERIFY_TOKEN env var' })
  @ApiQuery({ name: 'hub.challenge', required: true, description: 'Random integer echoed back on success' })
  @ApiResponse({ status: 200, description: 'Challenge echoed — subscription confirmed' })
  @ApiResponse({ status: 403, description: 'Token mismatch or mode not subscribe' })
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ): void {
    const verifyToken = this.config.get<string>('WEBHOOK_VERIFY_TOKEN');

    if (mode !== 'subscribe' || token !== verifyToken) {
      throw new ForbiddenException('Webhook verification failed');
    }

    res.status(200).send(challenge);
  }

  @Post()
  @ApiOperation({
    summary: 'Receive Meta webhook events',
    description:
      'Receives all lifecycle events from Meta (inbound messages, delivery/read status, template updates, account events). ' +
      'Requires a valid X-Hub-Signature-256 HMAC header. Always returns 200 immediately; processing is asynchronous.',
  })
  @ApiResponse({ status: 200, description: 'Event accepted for processing' })
  @ApiResponse({ status: 401, description: 'Missing or invalid X-Hub-Signature-256 header' })
  receive(@Body() body: any, @Res() res: Response): void {
    res.status(200).send('EVENT_RECEIVED');

    setImmediate(() => {
      this.webhooksService.processPayload(body).catch(() => {});
    });
  }
}
