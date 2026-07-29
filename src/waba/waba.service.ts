import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { RedisService } from 'src/redis/redis.service';
import axios from 'axios';
import { Waba } from '@prisma/client';

@Injectable()
export class WabaService {
  private readonly logger = new Logger(WabaService.name);
  private readonly metaApiVersion = 'v25.0';

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly redisService: RedisService,
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

  async findAllByOrgId(ssoOrgId: string): Promise<Waba[]> {
    return this.prisma.waba.findMany({ where: { ssoOrgId } });
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

    const response = await axios.get(
      `https://graph.facebook.com/v25.0/${wabaId}`,
      {
        params: {
          fields: 'id,name,currency,timezone_id,message_template_namespace,tasks',
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    return response.data;
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

    // Remove the connection (access token) — Waba and WabaPhoneNumber records are preserved for audit
    await this.prisma.userWhatsapp.delete({
      where: { userId_wabaId: { userId, wabaId } },
    });
  }
}
