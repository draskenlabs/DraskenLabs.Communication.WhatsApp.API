import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { NotificationsService } from './notifications.service';
import {
  DeleteDeviceTokenDto,
  DeviceTokenResultDto,
  MarkNotificationsReadDto,
  MarkNotificationsReadResultDto,
  NotificationDto,
  NotificationPreferencesDto,
  RegisterDeviceTokenDto,
  SendTestNotificationResultDto,
  UnreadCountDto,
  UpdateNotificationPreferencesDto,
} from './dto/notification.dto';
import { BaseResponse } from 'src/common/responses/base-response';
import { PaginationMetaDto } from 'src/common/responses/swagger-response.dto';
import {
  ApiStandardErrorResponses,
  ApiWrappedOkResponse,
} from 'src/common/responses/swagger.decorators';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('tokens')
  @ApiOperation({
    summary: 'Register this device for push notifications',
    description:
      'Idempotent: Firebase issues the same token to the same browser, so ' +
      'calling this on every sign-in refreshes the registration rather than ' +
      'creating another one.',
  })
  @ApiWrappedOkResponse({
    dataDto: DeviceTokenResultDto,
    description: 'Devices registered after the call',
  })
  @ApiStandardErrorResponses({
    unauthorized: true,
    badRequest: true,
    validation: true,
  })
  async registerToken(
    @Req() req: Request,
    @Body() dto: RegisterDeviceTokenDto,
  ): Promise<DeviceTokenResultDto> {
    const { userId, orgId } = this.identify(req);
    const deviceCount = await this.notificationsService.registerToken(
      userId,
      orgId,
      dto,
    );
    return { deviceCount };
  }

  @Delete('tokens')
  @ApiOperation({
    summary: 'Forget a device',
    description:
      'Called when push is switched off or the user signs out, so the device ' +
      'stops receiving notifications for an account it is no longer using.',
  })
  @ApiWrappedOkResponse({
    dataDto: DeviceTokenResultDto,
    description: 'Devices still registered',
  })
  @ApiStandardErrorResponses({ unauthorized: true, validation: true })
  async removeToken(
    @Req() req: Request,
    @Body() dto: DeleteDeviceTokenDto,
  ): Promise<DeviceTokenResultDto> {
    const { userId } = this.identify(req);
    const deviceCount = await this.notificationsService.removeToken(
      userId,
      dto.token,
    );
    return { deviceCount };
  }

  @Get()
  @ApiOperation({
    summary: 'The notification feed for the current organisation',
    description:
      'Everything we would have pushed, whether or not a device took it — a ' +
      'notification missed while the browser was closed is still here. Newest ' +
      'first. The console shows the first few under the bell and the rest on ' +
      'its notifications page.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: '1-based page number (default 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size, 1–100 (default 20)',
  })
  @ApiWrappedOkResponse({
    dataDto: NotificationDto,
    isArray: true,
    metaDto: PaginationMetaDto,
    description: 'A page of the feed',
  })
  @ApiStandardErrorResponses({ unauthorized: true })
  list(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<BaseResponse<NotificationDto[]>> {
    const { userId, orgId } = this.identify(req);
    return this.notificationsService.list(userId, orgId, {
      page: page !== undefined ? Number(page) : undefined,
      limit: limit !== undefined ? Number(limit) : undefined,
    });
  }

  @Get('unread-count')
  @ApiOperation({
    summary: 'How many notifications are unread',
    description:
      'Just the number behind the bell, so the console can poll it without ' +
      'pulling the whole feed.',
  })
  @ApiWrappedOkResponse({
    dataDto: UnreadCountDto,
    description: 'Unread notifications for this organisation',
  })
  @ApiStandardErrorResponses({ unauthorized: true })
  async unreadCount(@Req() req: Request): Promise<UnreadCountDto> {
    const { userId, orgId } = this.identify(req);
    return {
      unread: await this.notificationsService.unreadCount(userId, orgId),
    };
  }

  @Post('read')
  @ApiOperation({
    summary: 'Mark notifications as read',
    description:
      'Pass `ids` to mark specific entries, or omit it to clear the whole ' +
      'feed for this organisation.',
  })
  @ApiWrappedOkResponse({
    dataDto: MarkNotificationsReadResultDto,
    description: 'What changed, and what is left unread',
  })
  @ApiStandardErrorResponses({
    unauthorized: true,
    badRequest: true,
    validation: true,
  })
  markRead(
    @Req() req: Request,
    @Body() dto: MarkNotificationsReadDto,
  ): Promise<MarkNotificationsReadResultDto> {
    const { userId, orgId } = this.identify(req);
    return this.notificationsService.markRead(userId, orgId, dto.ids);
  }

  @Get('preferences')
  @ApiOperation({
    summary: 'Which notifications this user receives',
    description:
      'Also reports whether the server can send push at all, so the console ' +
      'can explain an unavailable feature instead of offering a dead switch.',
  })
  @ApiWrappedOkResponse({
    dataDto: NotificationPreferencesDto,
    description: 'Current preferences',
  })
  @ApiStandardErrorResponses({ unauthorized: true })
  getPreferences(@Req() req: Request): Promise<NotificationPreferencesDto> {
    const { userId } = this.identify(req);
    return this.notificationsService.getPreferences(userId);
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Turn a kind of notification on or off' })
  @ApiWrappedOkResponse({
    dataDto: NotificationPreferencesDto,
    description: 'Preferences after the change',
  })
  @ApiStandardErrorResponses({
    unauthorized: true,
    badRequest: true,
    validation: true,
  })
  updatePreferences(
    @Req() req: Request,
    @Body() dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferencesDto> {
    const { userId } = this.identify(req);
    return this.notificationsService.updatePreferences(userId, dto);
  }

  @Post('test')
  @ApiOperation({
    summary: 'Send a test notification to this user’s devices',
    description:
      'Proves the whole path — browser permission, service worker, Firebase ' +
      'credentials — without waiting for a customer to message you.',
  })
  @ApiWrappedOkResponse({
    dataDto: SendTestNotificationResultDto,
    description: 'How many devices it reached',
  })
  @ApiStandardErrorResponses({ unauthorized: true, badRequest: true })
  async sendTest(@Req() req: Request): Promise<SendTestNotificationResultDto> {
    const { userId } = this.identify(req);
    const { deviceCount, pushEnabled } =
      await this.notificationsService.getPreferences(userId);

    if (!pushEnabled) {
      throw new BadRequestException(
        'Push notifications are not configured on this server.',
      );
    }
    if (deviceCount === 0) {
      throw new BadRequestException(
        'No device is registered. Allow notifications in your browser first.',
      );
    }

    return this.notificationsService.sendToUser(userId, {
      title: 'WhatsApp Console',
      body: 'Test notification — push is working on this device.',
      link: '/settings',
    });
  }

  /** The caller, as the auth middleware left it on the request. */
  private identify(req: Request): { userId: number; orgId: string } {
    const { user, orgId } = req as Request & {
      user?: { id: number };
      orgId?: string;
    };
    if (!user || !orgId) throw new UnauthorizedException();
    return { userId: user.id, orgId };
  }
}
