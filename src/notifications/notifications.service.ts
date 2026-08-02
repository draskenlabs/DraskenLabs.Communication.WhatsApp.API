import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { FirebaseService, PushMessage } from './firebase.service';
import { BaseResponse } from 'src/common/responses/base-response';
import {
  NotificationDto,
  NotificationPreferencesDto,
  RegisterDeviceTokenDto,
  UpdateNotificationPreferencesDto,
} from './dto/notification.dto';

/** The notifications a user can switch off, matching the preference columns. */
export type NotificationKind = 'inboundMessage' | 'templateStatus';

const DEFAULT_PREFERENCES = {
  inboundMessage: true,
  templateStatus: true,
  // Email defaults match the schema: the daily summary on, because it is how a
  // failed send reaches anyone, and no marketing until it is asked for.
  emailTemplateStatus: true,
  emailDailySummary: true,
  emailWeeklySummary: false,
  emailProductNews: false,
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
      emailTemplateStatus:
        row?.emailTemplateStatus ?? DEFAULT_PREFERENCES.emailTemplateStatus,
      emailDailySummary:
        row?.emailDailySummary ?? DEFAULT_PREFERENCES.emailDailySummary,
      emailWeeklySummary:
        row?.emailWeeklySummary ?? DEFAULT_PREFERENCES.emailWeeklySummary,
      emailProductNews:
        row?.emailProductNews ?? DEFAULT_PREFERENCES.emailProductNews,
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
      const [connections, memberships] = await Promise.all([
        this.prisma.userWhatsapp.findMany({
          where: { wabaId },
          select: { userId: true },
        }),
        // Every organisation holding the account, not `Waba.ssoOrgId` — that is
        // whichever one connected it first. The feed is filtered by the
        // organisation being viewed, so stamping one organisation's id on
        // activity for an account two of them hold left the second looking at
        // an empty bell for its own messages.
        this.prisma.wabaOrganisation.findMany({
          where: { wabaId },
          select: { ssoOrgId: true },
        }),
      ]);
      const userIds = [...new Set(connections.map((c) => c.userId))];
      if (userIds.length === 0) return;

      // One entry per organisation. A user who is in only one of them can only
      // ever view that one, so the rows they cannot see stay invisible.
      const orgIds = memberships.length
        ? memberships.map((m) => m.ssoOrgId)
        : [null];

      for (const ssoOrgId of orgIds) {
        await this.record(userIds, kind, message, ssoOrgId);
      }

      // Once, however many organisations hold the account: the feed is a
      // per-organisation record, the push is an interruption of a person.
      await this.push(userIds, kind, message);
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
    ssoOrgId?: string | null,
  ): Promise<void> {
    if (userIds.length === 0) return;

    // The feed is written first and for everyone: it is the record of what
    // happened, so it must survive a server with no Firebase credentials, a
    // browser that never registered, and a person who switched the push off.
    // The preference below governs the interruption, not the record.
    await this.record(userIds, kind, message, ssoOrgId);
    await this.push(userIds, kind, message);
  }

  /**
   * The interruption, as opposed to the record.
   *
   * Separate so an event that belongs to more than one organisation can write a
   * feed entry for each and still buzz a phone once.
   */
  private async push(
    userIds: number[],
    kind: NotificationKind,
    message: PushMessage,
  ): Promise<void> {
    if (userIds.length === 0) return;
    if (!this.firebase.enabled) return;

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

  // --- The feed behind the bell -------------------------------------------

  /**
   * Write one entry per recipient. Never throws: a webhook must still be
   * acknowledged even if the feed cannot be written.
   */
  private async record(
    userIds: number[],
    kind: string,
    message: PushMessage,
    ssoOrgId?: string | null,
  ): Promise<void> {
    try {
      await this.prisma.notification.createMany({
        data: userIds.map((userId) => ({
          userId,
          ssoOrgId: ssoOrgId ?? null,
          kind,
          title: message.title,
          body: message.body,
          link: message.link ?? null,
        })),
      });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Could not record ${kind} notification: ${detail}`);
    }
  }

  /**
   * A page of someone's feed, newest first.
   *
   * Scoped to the organisation being viewed, plus entries belonging to no
   * organisation — an account-level notice should not disappear because of
   * which organisation happens to be selected.
   */
  async list(
    userId: number,
    ssoOrgId: string,
    opts: { page?: number; limit?: number } = {},
  ): Promise<BaseResponse<NotificationDto[]>> {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 20)));
    const where = this.scope(userId, ssoOrgId);

    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return BaseResponse.paginate(
      rows.map((row) => this.toDto(row)),
      total,
      Math.max(1, Math.ceil(total / limit)),
      page,
      limit,
    );
  }

  /** What the bell's badge shows. */
  async unreadCount(userId: number, ssoOrgId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { ...this.scope(userId, ssoOrgId), readAt: null },
    });
  }

  /**
   * Mark specific notifications read, or the whole organisation's feed when no
   * ids are given. Already-read rows are left alone so `updated` reports what
   * actually changed.
   */
  async markRead(
    userId: number,
    ssoOrgId: string,
    ids?: number[],
  ): Promise<{ updated: number; unread: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: {
        ...this.scope(userId, ssoOrgId),
        readAt: null,
        ...(ids && ids.length > 0 && { id: { in: ids } }),
      },
      data: { readAt: new Date() },
    });

    return { updated: count, unread: await this.unreadCount(userId, ssoOrgId) };
  }

  /** One person's feed for one organisation, plus their org-less entries. */
  private scope(userId: number, ssoOrgId: string) {
    return { userId, OR: [{ ssoOrgId }, { ssoOrgId: null }] };
  }

  private toDto(row: {
    id: number;
    kind: string;
    title: string;
    body: string;
    link: string | null;
    readAt: Date | null;
    createdAt: Date;
  }): NotificationDto {
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      link: row.link,
      readAt: row.readAt,
      createdAt: row.createdAt,
    };
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
