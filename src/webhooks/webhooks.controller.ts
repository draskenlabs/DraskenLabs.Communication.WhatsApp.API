import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
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
import { WebhookEndpointsService } from './webhook-endpoints.service';
import { WebhookConfigDto } from './dto/webhook-config.dto';
import { WebhookEventDto } from './dto/webhook-event.dto';
import {
  CreateWebhookEndpointDto,
  UpdateWebhookEndpointDto,
  WebhookDeliveryDto,
  WebhookEndpointDto,
  WebhookTestResultDto,
} from './dto/webhook-endpoint.dto';
import { PaginationMetaDto } from 'src/common/responses/swagger-response.dto';
import { BaseResponse } from 'src/common/responses/base-response';
import {
  ApiStandardErrorResponses,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
} from 'src/common/responses/swagger.decorators';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly endpointsService: WebhookEndpointsService,
    private readonly config: ConfigService,
  ) {}

  /* ---------------------------------------------------------------- *
   * Outbound — the customer's own endpoints                           *
   * ---------------------------------------------------------------- */

  @Post('endpoints')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: 'Register an endpoint to receive events',
    description:
      'Every event for the given WABA is posted to this URL as JSON, retried with ' +
      'backoff until it is accepted. A signing secret is optional: with one, each ' +
      'delivery carries an X-Drasken-Signature-256 HMAC over ' +
      '`{timestamp}.{body}`; without one, the body is posted unsigned. The secret ' +
      'is stored encrypted and never returned.',
  })
  @ApiWrappedCreatedResponse({
    dataDto: WebhookEndpointDto,
    description: 'Endpoint registered',
  })
  @ApiStandardErrorResponses({ notFound: true })
  async createEndpoint(
    @Req() req: Request,
    @Body() dto: CreateWebhookEndpointDto,
  ): Promise<WebhookEndpointDto> {
    const { userId, orgId } = this.caller(req);
    return this.endpointsService.create(userId, orgId, dto);
  }

  @Get('endpoints')
  @ApiBearerAuth('jwt')
  @ApiOperation({ summary: 'List registered endpoints for the organisation' })
  @ApiQuery({ name: 'wabaId', required: false, description: 'Filter to one WABA' })
  @ApiWrappedOkResponse({
    dataDto: WebhookEndpointDto,
    isArray: true,
    description: 'Registered endpoints',
  })
  async listEndpoints(
    @Req() req: Request,
    @Query('wabaId') wabaId?: string,
  ): Promise<WebhookEndpointDto[]> {
    const { orgId } = this.caller(req);
    return this.endpointsService.findAll(orgId, wabaId);
  }

  @Patch('endpoints/:id')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: 'Update an endpoint',
    description:
      'Change the URL, label, subscribed events or enabled state. Sending ' +
      '`secret` rotates the signing secret; sending it as an empty string ' +
      'removes it and goes back to unsigned deliveries.',
  })
  @ApiWrappedOkResponse({ dataDto: WebhookEndpointDto, description: 'Endpoint updated' })
  @ApiStandardErrorResponses({ notFound: true })
  async updateEndpoint(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateWebhookEndpointDto,
  ): Promise<WebhookEndpointDto> {
    const { orgId } = this.caller(req);
    return this.endpointsService.update(orgId, id, dto);
  }

  @Delete('endpoints/:id')
  @ApiBearerAuth('jwt')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Delete an endpoint',
    description: 'Deliveries stop immediately and the delivery log goes with it.',
  })
  @ApiStandardErrorResponses({ notFound: true })
  async deleteEndpoint(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    const { orgId } = this.caller(req);
    await this.endpointsService.remove(orgId, id);
  }

  @Post('endpoints/:id/test')
  @ApiBearerAuth('jwt')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send a test event',
    description:
      'Posts a synthetic `endpoint.test` event and waits for the answer, so the ' +
      'response says whether the endpoint is reachable and what it replied. ' +
      'Signed like a real delivery when a secret is configured. Never retried.',
  })
  @ApiWrappedOkResponse({ dataDto: WebhookTestResultDto, description: 'Test result' })
  @ApiStandardErrorResponses({ notFound: true })
  async testEndpoint(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<WebhookTestResultDto> {
    const { orgId } = this.caller(req);
    return this.endpointsService.test(orgId, id);
  }

  @Get('endpoints/:id/deliveries')
  @ApiBearerAuth('jwt')
  @ApiOperation({
    summary: 'Delivery log for an endpoint (paginated)',
    description:
      'What was posted, what came back and what is still due, newest first.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiWrappedOkResponse({
    dataDto: WebhookDeliveryDto,
    isArray: true,
    metaDto: PaginationMetaDto,
    description: 'Deliveries',
  })
  @ApiStandardErrorResponses({ notFound: true })
  async endpointDeliveries(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<BaseResponse<WebhookDeliveryDto[]>> {
    const { orgId } = this.caller(req);
    return this.endpointsService.deliveries(orgId, id, {
      page: page !== undefined ? Number(page) : undefined,
      limit: limit !== undefined ? Number(limit) : undefined,
    });
  }

  @Post('deliveries/:id/redeliver')
  @ApiBearerAuth('jwt')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Queue a delivery for another attempt',
    description:
      'Posts the stored payload again, unchanged and with the same delivery id, ' +
      'on the next sweep. For the one that failed while the receiver was down.',
  })
  @ApiWrappedOkResponse({ dataDto: WebhookDeliveryDto, description: 'Delivery requeued' })
  @ApiStandardErrorResponses({ notFound: true })
  async redeliver(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<WebhookDeliveryDto> {
    const { orgId } = this.caller(req);
    return this.endpointsService.redeliver(orgId, id);
  }

  /** The authenticated caller, or a 401. */
  private caller(req: Request): { userId: number; orgId: string } {
    const user = (req as any).user;
    const orgId = (req as any).orgId;
    if (!user) throw new UnauthorizedException('User not found in context');
    if (!orgId) throw new UnauthorizedException('Organisation not found in context');
    return { userId: user.id, orgId };
  }

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
