import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { MessagingService } from './messaging.service';
import { SendMessageDto } from './dto/send-message.dto';
import { SendMessageResponseDto, MessageListItemDto } from './dto/message-response.dto';
import { MessageAnalyticsDto } from './dto/message-analytics.dto';
import { PaginationMetaDto } from 'src/common/responses/swagger-response.dto';
import { BaseResponse } from 'src/common/responses/base-response';
import { ApiWrappedOkResponse } from 'src/common/responses/swagger.decorators';

@ApiTags('Messaging')
@ApiSecurity('x-access-key')
@ApiSecurity('x-secret-key')
@Controller('messages')
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) {}

  @Post()
  @ApiOperation({ summary: 'Send a WhatsApp message' })
  @ApiWrappedOkResponse({ dataDto: SendMessageResponseDto, description: 'Message sent' })
  async send(@Req() req: Request, @Body() dto: SendMessageDto): Promise<SendMessageResponseDto> {
    const user = (req as any).user;
    const orgId = (req as any).orgId;
    if (!user || !orgId) throw new UnauthorizedException('User not found in context');
    // Set only on the API-key path; the console picks its own account.
    const scopedWabaId = (req as any).apiKeyWabaId as string | undefined;
    return this.messagingService.sendMessage(user.id, orgId, dto, scopedWabaId);
  }

  @Get()
  @ApiOperation({
    summary: 'List messages for current organisation',
    description:
      'Returns all messages by default. Supply `page`/`limit` to paginate ' +
      '(response then includes a `meta` block).',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '1-based page number (enables pagination)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size, 1–100 (enables pagination)' })
  @ApiWrappedOkResponse({
    dataDto: MessageListItemDto,
    isArray: true,
    metaDto: PaginationMetaDto,
    description: 'Message list',
  })
  async findAll(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<BaseResponse<MessageListItemDto[]>> {
    const orgId = (req as any).orgId;
    if (!orgId) throw new UnauthorizedException('Organisation not found in context');
    return this.messagingService.findAll(
      orgId,
      {
        page: page !== undefined ? Number(page) : undefined,
        limit: limit !== undefined ? Number(limit) : undefined,
      },
      (req as any).apiKeyWabaId as string | undefined,
    );
  }

  @Get('analytics')
  @ApiOperation({
    summary: 'Message analytics for the current organisation',
    description: 'Status totals, delivery/read rates and a daily delivered-vs-failed series.',
  })
  @ApiQuery({ name: 'days', required: false, description: 'Range in days (1–90, default 14)' })
  @ApiWrappedOkResponse({ dataDto: MessageAnalyticsDto, description: 'Message analytics' })
  async analytics(
    @Req() req: Request,
    @Query('days', new DefaultValuePipe(14), ParseIntPipe) days: number,
  ): Promise<MessageAnalyticsDto> {
    const orgId = (req as any).orgId;
    if (!orgId) throw new UnauthorizedException('Organisation not found in context');
    return this.messagingService.analytics(
      orgId,
      days,
      (req as any).apiKeyWabaId as string | undefined,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single message by ID' })
  @ApiWrappedOkResponse({ dataDto: MessageListItemDto, description: 'Message detail' })
  async findOne(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<MessageListItemDto> {
    const orgId = (req as any).orgId;
    if (!orgId) throw new UnauthorizedException('Organisation not found in context');
    return this.messagingService.findOne(
      orgId,
      id,
      (req as any).apiKeyWabaId as string | undefined,
    );
  }
}
