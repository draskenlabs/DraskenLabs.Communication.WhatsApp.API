import {
  BadRequestException,
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
}
