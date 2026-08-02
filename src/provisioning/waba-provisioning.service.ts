import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { WabaService } from 'src/waba/waba.service';
import { WabaMembershipService } from 'src/waba/waba-membership.service';
import { WabaPhoneNumberService } from 'src/waba-phone-number/waba-phone-number.service';
import { TemplatesService } from 'src/templates/templates.service';

/** What a provisioning run managed to do, for the log and for the tests. */
export interface ProvisionResult {
  phoneNumbers: number;
  templates: number;
  subscribed: boolean;
  failures: string[];
}

/**
 * Pull an account's data from Meta, once somebody has paid for it.
 *
 * Connecting an account used to sync everything immediately: phone numbers,
 * webhook subscription, templates. That gave away the working product to anyone
 * who completed signup and never subscribed, and it meant the console filled
 * with data the organisation could not act on — every send and every template
 * edit answered 402.
 *
 * So connect now records the account and stops. This runs when a subscription
 * starts paying, and it is the only thing that turns a connected account into a
 * usable one.
 *
 * Every step is best-effort and logged. A Meta outage must not leave a paid
 * subscription looking unpaid, and the hourly reconciliation will come back
 * round; nothing here is the last chance to get the data.
 */
@Injectable()
export class WabaProvisioningService {
  private readonly logger = new Logger(WabaProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly waba: WabaService,
    private readonly membership: WabaMembershipService,
    private readonly phoneNumbers: WabaPhoneNumberService,
    private readonly templates: TemplatesService,
  ) {}

  /**
   * Whether this organisation's copy of the account has been filled in yet.
   *
   * Phone numbers are the marker: nothing can be sent without one, and they are
   * the first thing a run fetches.
   */
  async isProvisioned(wabaId: string): Promise<boolean> {
    const count = await this.prisma.wabaPhoneNumber.count({ where: { wabaId } });
    return count > 0;
  }

  /**
   * The numbers already on record for an account, in the shape connect returns.
   *
   * Empty until somebody subscribes — which is the point — but not empty when
   * another organisation has already paid for the same account, because the
   * numbers belong to the account rather than to the subscription.
   */
  async syncedNumbers(
    ssoOrgId: string,
    wabaId: string,
  ): Promise<
    { phoneNumberId: string; displayPhoneNumber: string; verifiedName: string }[]
  > {
    await this.membership.require(ssoOrgId, wabaId);
    const phones = await this.prisma.wabaPhoneNumber.findMany({
      where: { wabaId },
      select: {
        phoneNumberId: true,
        displayPhoneNumber: true,
        verifiedName: true,
      },
    });
    return phones;
  }

  /**
   * Fill in an account that has just been paid for.
   *
   * Safe to call repeatedly: every step upserts, so a renewal, a second
   * organisation subscribing, or a reconciliation sweep re-running this costs a
   * few Meta calls and changes nothing else.
   */
  async provision(ssoOrgId: string, wabaId: string): Promise<ProvisionResult> {
    const result: ProvisionResult = {
      phoneNumbers: 0,
      templates: 0,
      subscribed: false,
      failures: [],
    };

    let connection;
    try {
      connection = await this.membership.connection(ssoOrgId, wabaId);
    } catch {
      // Paid for, but the connection is gone — disconnected, or the account was
      // never finished. Nothing to sync against, and not an error worth raising
      // into the payment path.
      this.logger.warn(
        `Cannot provision ${wabaId} for ${ssoOrgId}: no Meta connection on record`,
      );
      result.failures.push('connection');
      return result;
    }

    const rawToken = this.encryption.decrypt(connection.accessToken);
    const userId = connection.userId;

    // Webhooks first: it is the cheapest call, and until it succeeds no inbound
    // message or delivery status arrives however much else is synced.
    try {
      result.subscribed = await this.waba.subscribeAppToWaba(wabaId, rawToken);
    } catch (err) {
      result.failures.push('webhooks');
      this.logger.warn(`Provisioning ${wabaId}: webhook subscribe failed — ${reason(err)}`);
    }

    try {
      const phones = await this.phoneNumbers.syncPhoneNumbersWithToken(
        wabaId,
        rawToken,
        connection.accessToken,
      );
      result.phoneNumbers = phones.length;
    } catch (err) {
      result.failures.push('phoneNumbers');
      this.logger.warn(`Provisioning ${wabaId}: phone sync failed — ${reason(err)}`);
    }

    try {
      const templates = await this.templates.syncTemplates(userId, ssoOrgId, wabaId);
      result.templates = templates.synced;
    } catch (err) {
      result.failures.push('templates');
      this.logger.warn(`Provisioning ${wabaId}: template sync failed — ${reason(err)}`);
    }

    this.logger.log(
      `Provisioned ${wabaId} for ${ssoOrgId}: ${result.phoneNumbers} numbers, ` +
        `${result.templates} templates, webhooks ${result.subscribed ? 'on' : 'off'}` +
        (result.failures.length ? ` (failed: ${result.failures.join(', ')})` : ''),
    );

    return result;
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
