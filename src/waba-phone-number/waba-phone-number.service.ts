import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { SubscriptionAccessService } from 'src/billing/subscription-access.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { WabaMembershipService } from 'src/waba/waba-membership.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { RedisService } from 'src/redis/redis.service';
import axios from 'axios';
import { WabaPhoneNumber } from '@prisma/client';
import { MailNotifications } from 'src/mail/mail.notifications';
import {
  isMetaAuthFailure,
  metaErrorMessage,
  metaFailureMessage,
} from 'src/common/utils/meta-error';

/**
 * Meta's `platform_type` for a number that has been registered on the Cloud
 * API — the only ones that can send, and so the only ones worth counting
 * against a plan or charging for.
 */
export const CLOUD_API_PLATFORM = 'CLOUD_API';

/** How many of an account's numbers are live on the Cloud API. */
export function registeredNumbersWhere(wabaId: string) {
  return { wabaId, platformType: CLOUD_API_PLATFORM };
}

@Injectable()
export class WabaPhoneNumberService {
  private readonly logger = new Logger(WabaPhoneNumberService.name);
  private readonly metaApiVersion = 'v25.0';

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
    private readonly redisService: RedisService,
    private readonly mail: MailNotifications,
    private readonly billing: SubscriptionAccessService,
    private readonly planLimits: PlanLimitsService,
    private readonly membership: WabaMembershipService,
  ) {}

  /**
   * Register a phone number on the WhatsApp Cloud API. Until this runs Meta
   * reports the number with platform_type = NOT_APPLICABLE and rejects sends
   * with "(#133010) Account not registered". On success we re-sync so the
   * stored platform/throughput reflect the new registration.
   */
  async registerPhoneNumber(
    userId: number,
    ssoOrgId: string,
    wabaId: string,
    phoneNumberId: string,
    pin: string,
  ): Promise<WabaPhoneNumber> {
    await this.membership.require(ssoOrgId, wabaId);

    // Registering a number puts the account on the Cloud API — the thing the
    // subscription pays for, so it is gated like sending.
    await this.billing.requireAccess(ssoOrgId, wabaId);

    const phone = await this.prisma.wabaPhoneNumber.findFirst({
      where: { phoneNumberId, wabaId },
    });
    if (!phone)
      throw new NotFoundException('Phone number not found for this WABA');

    // How many numbers this account may run is what its plan says. Counted
    // against numbers already registered on the Cloud API, not every number
    // Meta lists on the account: the ones sitting unregistered cost nothing
    // and send nothing.
    const registered = await this.registeredCount(wabaId);
    if (!this.isRegistered(phone)) {
      const limits = await this.planLimits.forWaba(ssoOrgId, wabaId);
      this.planLimits.assertWithin(
        limits,
        limits.phoneNumbersPerWaba,
        registered,
        'phone number',
      );
    }

    const userWhatsapp = await this.membership.connection(
      ssoOrgId,
      wabaId,
      userId,
    );

    const rawAccessToken = this.encryptionService.decrypt(
      userWhatsapp.accessToken,
    );

    try {
      await axios.post(
        `https://graph.facebook.com/${this.metaApiVersion}/${phoneNumberId}/register`,
        { messaging_product: 'whatsapp', pin },
        {
          headers: {
            Authorization: `Bearer ${rawAccessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );
    } catch (err: any) {
      const metaMessage = this.logMetaError(
        `Meta register failed for phone ${phoneNumberId} on WABA ${wabaId}`,
        err,
      );
      throw new BadRequestException(
        metaMessage || 'Failed to register phone number',
      );
    }

    const phones = await this.fetchAndUpsert(wabaId, rawAccessToken);
    await this.populatePhoneCache(phones, wabaId, userWhatsapp.accessToken);
    return phones.find((p) => p.phoneNumberId === phoneNumberId) ?? phone;
  }

  /** Whether this number is already live on the Cloud API. */
  private isRegistered(phone: { platformType: string | null }): boolean {
    return phone.platformType?.toUpperCase() === CLOUD_API_PLATFORM;
  }

  /** How many of this account's numbers are registered on the Cloud API. */
  private registeredCount(wabaId: string): Promise<number> {
    return this.prisma.wabaPhoneNumber.count({
      where: registeredNumbersWhere(wabaId),
    });
  }

  /**
   * Log the full Meta Graph API error and return the human-facing message,
   * keeping diagnostic detail (code/subcode/fbtrace_id) server-side.
   */
  private logMetaError(context: string, err: any): string {
    const metaError = err?.response?.data?.error;
    const userMessage =
      metaError?.error_user_msg ?? metaError?.message ?? err?.message;
    if (metaError) {
      this.logger.warn(
        `${context}: ${userMessage} ` +
          `[code=${metaError.code} subcode=${metaError.error_subcode} ` +
          `type=${metaError.type} fbtrace_id=${metaError.fbtrace_id}]`,
      );
    } else {
      this.logger.warn(`${context}: ${userMessage}`);
    }
    return userMessage;
  }

  /**
   * The account's numbers, for any organisation that holds it.
   *
   * Scoped by membership, not by `Waba.userId`. That column is the original
   * connector, so listing numbers used to 404 for a second organisation — and
   * for every colleague of the person who first connected the account.
   */
  async findAllByWabaId(
    ssoOrgId: string,
    wabaId: string,
  ): Promise<WabaPhoneNumber[]> {
    await this.membership.require(ssoOrgId, wabaId);
    return this.prisma.wabaPhoneNumber.findMany({ where: { wabaId } });
  }

  // Fetches phone numbers from Meta and upserts them into the DB.
  private async fetchAndUpsert(
    wabaId: string,
    rawAccessToken: string,
  ): Promise<WabaPhoneNumber[]> {
    let response: { data?: { data?: any[] } };
    try {
      response = await axios.get(
        `https://graph.facebook.com/v25.0/${wabaId}/phone_numbers`,
        {
          params: {
            fields:
              'id,verified_name,code_verification_status,display_phone_number,quality_rating,platform_type,throughput,last_onboarded_time',
          },
          headers: { Authorization: `Bearer ${rawAccessToken}` },
        },
      );
    } catch (err: unknown) {
      // A revoked token or a WABA Meta no longer recognises would otherwise
      // reach the console as a bare 500 with nothing to act on.
      const message = metaFailureMessage(
        err,
        'Could not read phone numbers from Meta.',
      );
      this.logger.warn(
        `Meta phone-number sync failed for ${wabaId}: ${message}`,
      );
      if (isMetaAuthFailure(err)) {
        void this.mail.metaTokenRejected(wabaId, metaErrorMessage(err));
      }
      throw new BadRequestException(message);
    }

    const synced: WabaPhoneNumber[] = [];
    const keepIds: string[] = [];
    for (const meta of response.data?.data ?? []) {
      // A number that hasn't finished onboarding yet ("Pending sync") comes back
      // from Meta with several of these fields absent. The columns are required,
      // so fall back to sensible defaults rather than writing null/Invalid Date
      // (which Prisma rejects and would fail the whole connect flow).
      const fields = {
        verifiedName: meta.verified_name ?? '',
        codeVerificationStatus: meta.code_verification_status ?? 'NOT_VERIFIED',
        displayPhoneNumber: meta.display_phone_number ?? '',
        qualityRating: meta.quality_rating ?? 'UNKNOWN',
        platformType: meta.platform_type ?? 'NOT_APPLICABLE',
        throughputLevel: meta.throughput?.level ?? 'NOT_APPLICABLE',
        lastOnboardedTime: this.parseOnboardedTime(meta.last_onboarded_time),
      };

      const record = await this.prisma.wabaPhoneNumber.upsert({
        where: { phoneNumberId: meta.id },
        update: fields,
        create: {
          phoneNumberId: meta.id,
          wabaId,
          ...fields,
        },
      });
      synced.push(record);
      keepIds.push(meta.id);
    }

    // Prune numbers that were removed on Meta's side — otherwise a deleted
    // number lingers in the DB and reappears on the next list fetch. (An empty
    // Meta list legitimately means the WABA has no numbers; axios throws on a
    // failed request, so we never reach here with a partial result.)
    const stale = await this.prisma.wabaPhoneNumber.findMany({
      where: { wabaId, phoneNumberId: { notIn: keepIds } },
      select: { phoneNumberId: true },
    });
    if (stale.length > 0) {
      await this.prisma.wabaPhoneNumber.deleteMany({
        where: { wabaId, phoneNumberId: { notIn: keepIds } },
      });
      await Promise.all(
        stale.map((p) =>
          this.redisService.invalidatePhoneCache(p.phoneNumberId),
        ),
      );
    }

    return synced;
  }

  // Meta omits last_onboarded_time for numbers that haven't been onboarded yet,
  // and may return an unparseable value. Return null instead of an Invalid Date.
  private parseOnboardedTime(value: unknown): Date | null {
    if (value === undefined || value === null || value === '') return null;
    const parsed = new Date(value as string | number);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // Populates Redis phone cache for each synced phone number.
  private async populatePhoneCache(
    phones: WabaPhoneNumber[],
    wabaId: string,
    encryptedToken: string,
  ): Promise<void> {
    for (const phone of phones) {
      await this.redisService.setPhoneCache(
        phone.phoneNumberId,
        wabaId,
        encryptedToken,
      );
    }
  }

  // Called by the manual sync endpoint — looks up the stored token then syncs.
  async syncPhoneNumbers(
    userId: number,
    ssoOrgId: string,
    wabaId: string,
  ): Promise<WabaPhoneNumber[]> {
    const userWhatsapp = await this.membership.connection(
      ssoOrgId,
      wabaId,
      userId,
    );

    const rawAccessToken = this.encryptionService.decrypt(
      userWhatsapp.accessToken,
    );
    const phones = await this.fetchAndUpsert(wabaId, rawAccessToken);
    await this.populatePhoneCache(phones, wabaId, userWhatsapp.accessToken);
    return phones;
  }

  // Called by the connect flow — caller already has both raw and encrypted token.
  async syncPhoneNumbersWithToken(
    wabaId: string,
    rawAccessToken: string,
    encryptedToken: string,
  ): Promise<WabaPhoneNumber[]> {
    const phones = await this.fetchAndUpsert(wabaId, rawAccessToken);
    await this.populatePhoneCache(phones, wabaId, encryptedToken);
    return phones;
  }
}
