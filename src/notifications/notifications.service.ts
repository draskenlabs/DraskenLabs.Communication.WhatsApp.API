import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { FirebaseService, PushMessage } from './firebase.service';
import {
  NotificationPreferencesDto,
  RegisterDeviceTokenDto,
  UpdateNotificationPreferencesDto,
} from './dto/notification.dto';

/** The notifications a user can switch off, matching the preference columns. */
export type NotificationKind =
  | 'inboundMessage'
  | 'templateStatus'
  | 'messageFailed';

const DEFAULT_PREFERENCES = {
  inboundMessage: true,
  templateStatus: true,
  messageFailed: true,
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly firebase: FirebaseService,
  ) {}

  /**
   * Remember a device. Firebase hands the same browser the same token, so this
   * upserts: re-registering on every sign-in refreshes `lastSeenAt` and moves
   * the device to the organisation the user is now in, rather than duplicating.
   */
  async registerToken(
    userId: number,
    ssoOrgId: string,
    dto: RegisterDeviceTokenDto,
  ): Promise<number> {
    await this.prisma.deviceToken.upsert({
      where: { token: dto.token },
      create: {
        userId,
        ssoOrgId,
        token: dto.token,
        platform: dto.platform ?? 'web',
        userAgent: dto.userAgent ?? null,
      },
      update: {
        userId,
        ssoOrgId,
        platform: dto.platform ?? 'web',
        userAgent: dto.userAgent ?? null,
        lastSeenAt: new Date(),
      },
    });

    return this.prisma.deviceToken.count({ where: { userId } });
  }

  /** Forget one device — switching push off, or signing out. */
  async removeToken(userId: number, token: string): Promise<number> {
    // Scoped to the caller so one user cannot unregister another's device.
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
    return this.prisma.deviceToken.count({ where: { userId } });
  }

  async getPreferences(userId: number): Promise<NotificationPreferencesDto> {
    const [row, deviceCount] = await Promise.all([
      this.prisma.notificationPreference.findUnique({ where: { userId } }),
      this.prisma.deviceToken.count({ where: { userId } }),
    ]);

    return {
      inboundMessage: row?.inboundMessage ?? DEFAULT_PREFERENCES.inboundMessage,
      templateStatus: row?.templateStatus ?? DEFAULT_PREFERENCES.templateStatus,
      messageFailed: row?.messageFailed ?? DEFAULT_PREFERENCES.messageFailed,
      deviceCount,
      pushEnabled: this.firebase.enabled,
    };
  }

  async updatePreferences(
    userId: number,
    dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferencesDto> {
    await this.prisma.notificationPreference.upsert({
      where: { userId },
      // A user with no row has every notification on, so the row is created
      // from the defaults with the change applied on top.
      create: { userId, ...DEFAULT_PREFERENCES, ...dto },
      update: dto,
    });
    return this.getPreferences(userId);
  }

  /** Push a message to one user's devices, ignoring their preferences. */
  async sendToUser(
    userId: number,
    message: PushMessage,
  ): Promise<PushResultish> {
    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true },
    });
    return this.deliver(
      tokens.map((t) => t.token),
      message,
    );
  }

  /**
   * Notify everyone connected to a WABA, minus those who switched this kind of
   * notification off.
   *
   * Recipients are the users who connected the WABA, not the whole
   * organisation: they are the ones holding the Meta credentials and acting on
   * its messages.
   */
  async notifyWaba(
    wabaId: string,
    kind: NotificationKind,
    message: PushMessage,
  ): Promise<void> {
    try {
      const connections = await this.prisma.userWhatsapp.findMany({
        where: { wabaId },
        select: { userId: true },
      });
      const userIds = [...new Set(connections.map((c) => c.userId))];
      if (userIds.length === 0) return;

      await this.notifyUsers(userIds, kind, message);
    } catch (err: unknown) {
      // A webhook must still be acknowledged even if we cannot notify anyone.
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Could not notify WABA ${wabaId}: ${detail}`);
    }
  }

  /** Notify specific users, minus those who switched this kind off. */
  async notifyUsers(
    userIds: number[],
    kind: NotificationKind,
    message: PushMessage,
  ): Promise<void> {
    if (!this.firebase.enabled || userIds.length === 0) return;

    try {
      // Only users who explicitly opted out have a row saying so.
      const optedOut = await this.prisma.notificationPreference.findMany({
        where: { userId: { in: userIds }, [kind]: false },
        select: { userId: true },
      });
      const excluded = new Set(optedOut.map((p) => p.userId));
      const wanted = userIds.filter((id) => !excluded.has(id));
      if (wanted.length === 0) return;

      const tokens = await this.prisma.deviceToken.findMany({
        where: { userId: { in: wanted } },
        select: { token: true },
      });
      if (tokens.length === 0) return;

      await this.deliver(
        tokens.map((t) => t.token),
        message,
      );
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Could not send ${kind} notification: ${detail}`);
    }
  }

  /** Send, then drop the tokens Firebase reported as dead. */
  private async deliver(
    tokens: string[],
    message: PushMessage,
  ): Promise<PushResultish> {
    const result = await this.firebase.sendToTokens(tokens, message);

    if (result.staleTokens.length > 0) {
      try {
        await this.prisma.deviceToken.deleteMany({
          where: { token: { in: result.staleTokens } },
        });
        this.logger.log(
          `Pruned ${result.staleTokens.length} device token(s) Firebase no longer recognises`,
        );
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Could not prune stale device tokens: ${detail}`);
      }
    }

    return { sent: result.sent, failed: result.failed };
  }
}

/** What callers get back from a send — the stale-token cleanup is internal. */
export interface PushResultish {
  sent: number;
  failed: number;
}
