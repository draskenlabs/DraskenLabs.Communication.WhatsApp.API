import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { RedisService } from 'src/redis/redis.service';
import axios from 'axios';
import { Waba } from '@prisma/client';
import { WabaResponseDto } from './dto/waba-response.dto';
import { MailNotifications } from 'src/mail/mail.notifications';
import {
  isMetaAuthFailure,
  metaErrorMessage,
  metaFailureMessage,
} from 'src/common/utils/meta-error';

@Injectable()
export class WabaService {
  private readonly logger = new Logger(WabaService.name);
  private readonly metaApiVersion = 'v25.0';

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly redisService: RedisService,
    private readonly mail: MailNotifications,
  ) {}

  /**
   * Subscribe our app to the WABA's webhooks (`POST /{waba-id}/subscribed_apps`).
   * Embedded Signup connects the account but does NOT auto-subscribe the app —
   * without this Meta sends no webhooks (inbound messages OR delivery/read
   * statuses) for the WABA, so messages stay stuck at "sent".
   *
   * Non-fatal: a failure here (e.g. missing `whatsapp_business_management`
   * permission) is logged but must not break connecting/syncing.
   */
  async subscribeAppToWaba(wabaId: string, rawAccessToken: string): Promise<boolean> {
    try {
      await axios.post(
        `https://graph.facebook.com/${this.metaApiVersion}/${wabaId}/subscribed_apps`,
        {},
        { headers: { Authorization: `Bearer ${rawAccessToken}` } },
      );
      this.logger.log(`Subscribed app to WABA ${wabaId} webhooks`);
      return true;
    } catch (err: any) {
      const metaError = err?.response?.data?.error;
      this.logger.warn(
        `Failed to subscribe app to WABA ${wabaId} webhooks: ` +
          `${metaError?.message ?? err?.message} ` +
          `[code=${metaError?.code} fbtrace_id=${metaError?.fbtrace_id}]`,
      );
      return false;
    }
  }

  /** Subscribe an already-connected WABA using its stored token. */
  async subscribeExistingWaba(userId: number, wabaId: string): Promise<boolean> {
    const userWhatsapp = await this.prisma.userWhatsapp.findFirst({
      where: { userId, wabaId },
    });
    if (!userWhatsapp) throw new NotFoundException('No connection found for this WABA');
    const rawAccessToken = this.encryptionService.decrypt(userWhatsapp.accessToken);
    return this.subscribeAppToWaba(wabaId, rawAccessToken);
  }

  /**
   * Every WABA in the organisation, each flagged with whether this user still
   * has a connection to it. Disconnecting keeps the record for audit, so
   * without the flag the console offers Sync on an account it cannot reach —
   * which is exactly how a disconnected WABA produced a server error.
   */
  async findAllByOrgId(
    ssoOrgId: string,
    userId?: number,
  ): Promise<WabaResponseDto[]> {
    const wabas = await this.prisma.waba.findMany({ where: { ssoOrgId } });
    if (wabas.length === 0) return [];

    const connections = await this.prisma.userWhatsapp.findMany({
      where: {
        wabaId: { in: wabas.map((w) => w.wabaId) },
        ...(userId ? { userId } : {}),
      },
      select: { wabaId: true },
    });
    const connected = new Set(connections.map((c) => c.wabaId));

    return wabas.map((waba) => ({ ...waba, connected: connected.has(waba.wabaId) }));
  }

  async findByWabaId(ssoOrgId: string, wabaId: string): Promise<Waba> {
    const waba = await this.prisma.waba.findFirst({ where: { ssoOrgId, wabaId } });
    if (!waba) throw new NotFoundException('WABA not found');
    return waba;
  }

  async getWabaDetailsFromMeta(userId: number, wabaId: string): Promise<any> {
    const userWhatsapp = await this.prisma.userWhatsapp.findFirst({
      where: { userId, wabaId },
    });

    if (!userWhatsapp) {
      throw new NotFoundException('No connection found for this WABA');
    }

    const accessToken = this.encryptionService.decrypt(
      userWhatsapp.accessToken,
    );

    try {
      const response = await axios.get(
        `https://graph.facebook.com/v25.0/${wabaId}`,
        {
          params: {
            fields:
              'id,name,currency,timezone_id,message_template_namespace,tasks',
          },
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      return response.data;
    } catch (err: unknown) {
      // Without this, a revoked token or a WABA Meta no longer recognises
      // reaches the client as a bare 500 with nothing to act on.
      throw this.metaFailure(
        err,
        wabaId,
        `Meta lookup failed for WABA ${wabaId}`,
        'Could not read this account from Meta.',
      );
    }
  }

  /**
   * Turn a Graph failure into something the console can show, and tell the
   * account owner when it was our credentials Meta rejected — sending stays
   * broken until they reconnect, and a log line does not reach them.
   */
  private metaFailure(
    err: unknown,
    wabaId: string,
    context: string,
    fallback: string,
  ): BadRequestException {
    const message = metaFailureMessage(err, fallback);
    this.logger.warn(`${context}: ${message}`);
    if (isMetaAuthFailure(err)) {
      void this.mail.metaTokenRejected(wabaId, metaErrorMessage(err));
    }
    return new BadRequestException(message);
  }

  async createOrUpdateWaba(data: {
    wabaId: string;
    userId: number;
    ssoOrgId: string;
    name?: string;
    currency?: string;
    timezoneId?: string;
    messageTemplateNamespace?: string;
  }): Promise<Waba> {
    const existing = await this.prisma.waba.findUnique({ where: { wabaId: data.wabaId } });
    if (existing && existing.userId !== data.userId) {
      throw new ForbiddenException('WABA belongs to another account');
    }

    // A WABA row is unique on `wabaId` alone, so connecting one that is
    // already connected in another organisation would update that row rather
    // than create one here — the account would appear to reconnect over there
    // and never arrive here. Refused explicitly until the row can be held per
    // organisation; silently doing nothing visible is worse than saying so.
    if (existing && existing.ssoOrgId !== data.ssoOrgId) {
      throw new ConflictException(
        'This WhatsApp Business Account is already connected in another of your organisations. ' +
          'Disconnect it there first, or use that organisation to manage it.',
      );
    }

    return this.prisma.waba.upsert({
      where: { wabaId: data.wabaId },
      update: {
        name: data.name,
        currency: data.currency,
        timezoneId: data.timezoneId,
        messageTemplateNamespace: data.messageTemplateNamespace,
      },
      create: {
        wabaId: data.wabaId,
        userId: data.userId,
        ssoOrgId: data.ssoOrgId,
        name: data.name,
        currency: data.currency,
        timezoneId: data.timezoneId,
        messageTemplateNamespace: data.messageTemplateNamespace,
      },
    });
  }

  async disconnectWaba(userId: number, ssoOrgId: string, wabaId: string): Promise<void> {
    const waba = await this.prisma.waba.findFirst({ where: { wabaId, ssoOrgId } });
    if (!waba) throw new NotFoundException('WABA not found in your organisation');

    const userWhatsapp = await this.prisma.userWhatsapp.findUnique({
      where: { userId_wabaId: { userId, wabaId } },
    });
    if (!userWhatsapp) throw new ForbiddenException('You are not the owner of this WABA connection');

    // Invalidate Redis phone cache for all phone numbers on this WABA
    const phoneNumbers = await this.prisma.wabaPhoneNumber.findMany({
      where: { wabaId },
      select: { phoneNumberId: true },
    });
    await Promise.all(phoneNumbers.map((p) => this.redisService.invalidatePhoneCache(p.phoneNumberId)));

    // Everyone who used this WABA is told, before the connection goes — after
    // the delete there is nobody left to look up.
    void this.mail.wabaDisconnected(wabaId, waba.name);

    // Remove the connection (access token) — Waba and WabaPhoneNumber records are preserved for audit
    await this.prisma.userWhatsapp.delete({
      where: { userId_wabaId: { userId, wabaId } },
    });
  }

  /**
   * Erase one WhatsApp Business Account and everything the console holds about
   * it. Irreversible, and the point: disconnecting deliberately keeps the
   * record for audit, so this is how that record is finally discarded.
   *
   * Only the person who onboarded the account may do it — ownership is read
   * from the Waba row rather than from a connection, because a disconnected
   * account has no connection left to check.
   *
   * Never touches Meta's copy: the WhatsApp Business Account, its phone
   * numbers and its approved templates all survive at Meta, and can be
   * reconnected afterwards as if for the first time.
   */
  async deleteWaba(
    userId: number,
    ssoOrgId: string,
    wabaId: string,
  ): Promise<WabaDeletionCounts> {
    const waba = await this.prisma.waba.findFirst({
      where: { wabaId, ssoOrgId },
    });
    if (!waba) {
      throw new NotFoundException('WABA not found in your organisation');
    }
    if (waba.userId !== userId) {
      throw new ForbiddenException(
        'Only the person who connected this account can delete it',
      );
    }

    // Read before the rows go: afterwards there is nobody to write to, and no
    // phone numbers left to name the cache entries.
    const connections = await this.prisma.userWhatsapp.findMany({
      where: { wabaId },
      select: { userId: true },
    });
    const phoneNumbers = await this.prisma.wabaPhoneNumber.findMany({
      where: { wabaId },
      select: { phoneNumberId: true },
    });
    const recipientIds = [
      ...new Set([waba.userId, ...connections.map((c) => c.userId)]),
    ];

    // Tell Meta to stop sending webhooks while a token still exists. A
    // disconnected account has none, so Meta keeps the subscription until the
    // app is removed in Business Manager — nothing we can do from here, and
    // not a reason to refuse the delete.
    if (connections.some((c) => c.userId === userId)) {
      try {
        await this.unsubscribeAppFromWaba(userId, wabaId);
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Could not unsubscribe from WABA ${wabaId}: ${detail}`,
        );
      }
    }

    const counts = await this.prisma.$transaction(async (tx) => {
      const byWaba = { wabaId };

      const templates = await tx.messageTemplate.deleteMany({ where: byWaba });
      const inbound = await tx.inboundMessage.deleteMany({ where: byWaba });
      const events = await tx.webhookEvent.deleteMany({ where: byWaba });

      // Outbound messages carry a phone number, not a WABA, so they are found
      // through the numbers this account owns.
      const messages = phoneNumbers.length
        ? await tx.message.deleteMany({
            where: {
              phoneNumberId: { in: phoneNumbers.map((p) => p.phoneNumberId) },
            },
          })
        : { count: 0 };

      const numbers = await tx.wabaPhoneNumber.deleteMany({ where: byWaba });
      // Every member's connection, not just the caller's — theirs would
      // otherwise hold the WABA in place by its foreign key.
      const removedConnections = await tx.userWhatsapp.deleteMany({
        where: byWaba,
      });

      await tx.waba.delete({ where: { wabaId } });

      return {
        phoneNumbers: numbers.count,
        templates: templates.count,
        messages: messages.count,
        inboundMessages: inbound.count,
        metaConnections: removedConnections.count,
        webhookEvents: events.count,
      };
    });

    // Caches outlive the rows, so a missed purge would keep routing messages
    // for a number that no longer exists here. Best-effort: the data is gone
    // either way.
    try {
      await Promise.all(
        phoneNumbers.map((p) =>
          this.redisService.invalidatePhoneCache(p.phoneNumberId),
        ),
      );
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Deleted WABA ${wabaId} but failed to purge phone caches: ${detail}`,
      );
    }

    void this.mail.wabaDeleted(
      recipientIds,
      waba.name ?? wabaId,
      wabaId,
      counts,
    );

    this.logger.log(
      `Deleted WABA ${wabaId} for user ${userId}: ${JSON.stringify(counts)}`,
    );
    return counts;
  }

  /**
   * Ask Meta to stop sending webhooks for this WABA
   * (`DELETE /{waba-id}/subscribed_apps`). Only possible while we still hold a
   * token for it.
   */
  private async unsubscribeAppFromWaba(
    userId: number,
    wabaId: string,
  ): Promise<void> {
    const userWhatsapp = await this.prisma.userWhatsapp.findUnique({
      where: { userId_wabaId: { userId, wabaId } },
    });
    if (!userWhatsapp) return;

    const rawAccessToken = this.encryptionService.decrypt(
      userWhatsapp.accessToken,
    );
    await axios.delete(
      `https://graph.facebook.com/${this.metaApiVersion}/${wabaId}/subscribed_apps`,
      { headers: { Authorization: `Bearer ${rawAccessToken}` } },
    );
    this.logger.log(`Unsubscribed app from WABA ${wabaId} webhooks`);
  }
}

/** What a WABA deletion removed, for the response and the emailed receipt. */
export interface WabaDeletionCounts {
  phoneNumbers: number;
  templates: number;
  messages: number;
  inboundMessages: number;
  metaConnections: number;
  webhookEvents: number;
}
