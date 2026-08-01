import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { NotificationsService } from './notifications.service';
import {
  DeleteDeviceTokenDto,
  DeviceTokenResultDto,
  NotificationPreferencesDto,
  RegisterDeviceTokenDto,
  SendTestNotificationResultDto,
  UpdateNotificationPreferencesDto,
} from './dto/notification.dto';
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
