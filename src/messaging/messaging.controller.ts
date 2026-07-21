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
    return this.messagingService.sendMessage(user.id, orgId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all messages for current organisation' })
  @ApiWrappedOkResponse({ dataDto: MessageListItemDto, isArray: true, description: 'Message list' })
  async findAll(@Req() req: Request): Promise<MessageListItemDto[]> {
    const orgId = (req as any).orgId;
    if (!orgId) throw new UnauthorizedException('Organisation not found in context');
    return this.messagingService.findAll(orgId);
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
    return this.messagingService.analytics(orgId, days);
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
    return this.messagingService.findOne(orgId, id);
  }
}
