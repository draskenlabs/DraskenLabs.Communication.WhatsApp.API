import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { InboxService } from './inbox.service';
import { InboxMediaService } from './inbox-media.service';
import { ConversationDto } from './dto/conversation.dto';
import { ThreadDto } from './dto/thread.dto';
import { SendReplyDto } from './dto/reply.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { SendMessageResponseDto } from 'src/messaging/dto/message-response.dto';
import { PaginationMetaDto } from 'src/common/responses/swagger-response.dto';
import { BaseResponse } from 'src/common/responses/base-response';
import { ApiWrappedOkResponse } from 'src/common/responses/swagger.decorators';

/** The caller, as the auth middleware left it on the request. */
interface AuthedRequest extends Request {
  user?: { id: number };
  orgId?: string;
  apiKeyWabaId?: string;
}

@ApiTags('Inbox')
@ApiSecurity('x-access-key')
@ApiSecurity('x-secret-key')
@Controller('inbox')
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly media: InboxMediaService,
  ) {}

  /** The caller's identity, or a 401. Every route here needs all three. */
  private context(req: AuthedRequest): {
    userId: number;
    orgId: string;
    scopedWabaId?: string;
  } {
    const user = req.user;
    const orgId = req.orgId;
    if (!user || !orgId)
      throw new UnauthorizedException('User not found in context');
    return {
      userId: user.id,
      orgId,
      // Set only on the API-key path. A key issued for one account must not
      // read the organisation's other conversations.
      ...(req.apiKeyWabaId ? { scopedWabaId: req.apiKeyWabaId } : {}),
    };
  }

  @Get()
  @ApiOperation({
    summary: 'List conversations',
    description:
      'Newest activity first. One row per customer per number, with the ' +
      'unread count and whether a free-form reply is currently allowed.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size, 1–100',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['open', 'closed'] })
  @ApiQuery({
    name: 'unread',
    required: false,
    type: Boolean,
    description: 'Unread threads only',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Matches the name or the number',
  })
  @ApiQuery({ name: 'phoneNumberId', required: false })
  @ApiQuery({ name: 'wabaId', required: false })
  @ApiWrappedOkResponse({
    dataDto: ConversationDto,
    isArray: true,
    metaDto: PaginationMetaDto,
    description: 'Conversation list',
  })
  async list(
    @Req() req: AuthedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('unread') unread?: string,
    @Query('search') search?: string,
    @Query('phoneNumberId') phoneNumberId?: string,
    @Query('wabaId') wabaId?: string,
  ): Promise<BaseResponse<ConversationDto[]>> {
    const { orgId, scopedWabaId } = this.context(req);
    return this.inbox.list(
      orgId,
      {
        ...(page ? { page: Number(page) } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
        ...(status ? { status } : {}),
        ...(unread === 'true' ? { unreadOnly: true } : {}),
        ...(search ? { search } : {}),
        ...(phoneNumberId ? { phoneNumberId } : {}),
        ...(wabaId ? { wabaId } : {}),
      },
      scopedWabaId,
    );
  }

  @Get(':id/messages')
  @ApiOperation({
    summary: 'Read one conversation',
    description:
      'Sent and received messages interleaved in time order, oldest first. ' +
      'Page backwards with `before`, which takes the `nextCursor` of the ' +
      'previous response.',
  })
  @ApiParam({ name: 'id', type: Number, description: 'Conversation id' })
  @ApiQuery({
    name: 'before',
    required: false,
    description: 'ISO 8601 timestamp — return messages older than this',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size, 1–100',
  })
  @ApiWrappedOkResponse({
    dataDto: ThreadDto,
    description: 'Conversation thread',
  })
  async thread(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ): Promise<BaseResponse<ThreadDto>> {
    const { orgId, scopedWabaId } = this.context(req);
    const thread = await this.inbox.thread(
      orgId,
      id,
      {
        ...(before ? { before } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      },
      scopedWabaId,
    );
    return BaseResponse.success(thread);
  }

  @Post(':id/read')
  @ApiOperation({
    summary: 'Mark a conversation read',
    description: 'Clears the unread count for the calling organisation only.',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiWrappedOkResponse({
    dataDto: ConversationDto,
    description: 'The updated conversation',
  })
  async markRead(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<BaseResponse<ConversationDto>> {
    const { orgId, scopedWabaId } = this.context(req);
    return BaseResponse.success(
      await this.inbox.markRead(orgId, id, scopedWabaId),
    );
  }

  @Post(':id/messages')
  @ApiOperation({
    summary: 'Reply in a conversation',
    description:
      'The recipient and the sending number come from the thread. Outside the ' +
      '24-hour customer service window only `type: template` is accepted — ' +
      'anything else is refused here rather than failing at Meta.',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiWrappedOkResponse({
    dataDto: SendMessageResponseDto,
    description: 'Reply sent',
  })
  async reply(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SendReplyDto,
  ): Promise<SendMessageResponseDto> {
    const { userId, orgId, scopedWabaId } = this.context(req);
    return this.inbox.reply(userId, orgId, id, dto, scopedWabaId);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Close, reopen or assign a conversation',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiWrappedOkResponse({
    dataDto: ConversationDto,
    description: 'The updated conversation',
  })
  async update(
    @Req() req: AuthedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateConversationDto,
  ): Promise<BaseResponse<ConversationDto>> {
    const { orgId, scopedWabaId } = this.context(req);
    return BaseResponse.success(
      await this.inbox.update(orgId, id, dto, scopedWabaId),
    );
  }

  @Get('media/:messageId')
  @ApiOperation({
    summary: 'Download media from a received message',
    description:
      'Streams the file back from WhatsApp. Meta addresses media by an id ' +
      'that needs the account token to resolve and expires on its own, so a ' +
      'browser cannot fetch it directly. Returns the bytes, not JSON.',
  })
  @ApiParam({
    name: 'messageId',
    type: Number,
    description:
      'The received message’s id — the digits after `in:` in a thread',
  })
  async mediaFor(
    @Req() req: AuthedRequest,
    @Param('messageId', ParseIntPipe) messageId: number,
    @Res() res: Response,
  ): Promise<void> {
    const { orgId, scopedWabaId } = this.context(req);
    const media = await this.media.fetch(orgId, messageId, scopedWabaId);

    res.setHeader('Content-Type', media.contentType);
    if (media.contentLength)
      res.setHeader('Content-Length', media.contentLength);
    if (media.filename) {
      // `inline`, so a photo opens in the thread rather than downloading. The
      // filename is still offered for a viewer that chooses to save it.
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${media.filename.replace(/"/g, '')}"`,
      );
    }
    // Private: this is one organisation's customer's file, and it is served
    // from a URL that any of their colleagues could otherwise have cached for
    // them by a shared proxy.
    res.setHeader('Cache-Control', 'private, max-age=300');

    media.stream.pipe(res);
  }
}
