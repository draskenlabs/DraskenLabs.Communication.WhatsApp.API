import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailNotifications } from 'src/mail/mail.notifications';

@Injectable()
export class AccountHandler {
  private readonly logger = new Logger(AccountHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailNotifications,
  ) {}

  /**
   * Meta reports bans, restrictions and other account-level changes here.
   * A ban stops sending outright, so it is worth an email rather than a log
   * line nobody reads.
   */
  handleAccountUpdate(value: unknown, wabaId?: string): void {
    const update = (value ?? {}) as {
      phone_number?: string;
      event?: string;
      ban_info?: { waba_ban_state?: string };
    };
    this.logger.warn(
      `Account update: phone=${update.phone_number}, event=${update.event}`,
    );

    const banState = update.ban_info?.waba_ban_state;
    const event = String(update.event ?? '');
    const restricted = !!banState || /BAN|RESTRICT|DISABLE/i.test(event);

    if (restricted && wabaId) {
      void this.mail.wabaBanned(wabaId, banState ?? event);
    }
  }

  async handlePhoneQualityUpdate(
    value: unknown,
    wabaId?: string,
  ): Promise<void> {
    const { display_phone_number, event, current_limit } = (value ?? {}) as {
      display_phone_number?: string;
      event?: string;
      current_limit?: string;
    };
    this.logger.log(
      `Phone quality update: ${display_phone_number} → ${event} (limit: ${current_limit})`,
    );

    if (wabaId) {
      void this.mail.phoneQualityChanged({
        wabaId,
        displayPhoneNumber: String(display_phone_number ?? ''),
        event: String(event ?? ''),
        currentLimit: current_limit ? String(current_limit) : undefined,
      });
    }

    try {
      // Scoped to the account the webhook is about. A display number is not
      // unique across accounts, so without `wabaId` one WABA's quality drop was
      // written onto every number in the system that happened to share it.
      await this.prisma.wabaPhoneNumber.updateMany({
        where: { displayPhoneNumber: display_phone_number, ...(wabaId ? { wabaId } : {}) },
        data: { qualityRating: current_limit ?? event },
      });

      // The row above is overwritten on every change, so the history would be
      // lost exactly when it becomes interesting — a drop to RED matters mostly
      // for when it happened. Recorded as an event too.
      const number = await this.prisma.wabaPhoneNumber.findFirst({
        where: { displayPhoneNumber: display_phone_number, ...(wabaId ? { wabaId } : {}) },
        select: { phoneNumberId: true, wabaId: true },
      });
      if (number) {
        await this.prisma.phoneQualityEvent.create({
          data: {
            phoneNumberId: number.phoneNumberId,
            wabaId: number.wabaId,
            qualityRating: String(event ?? current_limit ?? 'UNKNOWN'),
            limitTier: current_limit ? String(current_limit) : null,
          },
        });
      }
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to update phone quality for ${display_phone_number}: ${detail}`,
      );
    }
  }

  handlePhoneNameUpdate(value: unknown, wabaId?: string): void {
    this.logger.log(`Phone name update: ${JSON.stringify(value)}`);

    const update = (value ?? {}) as {
      display_phone_number?: string;
      decision?: string;
      requested_verified_name?: string;
    };

    if (wabaId) {
      void this.mail.displayNameDecision({
        wabaId,
        displayPhoneNumber: update.display_phone_number,
        decision: update.decision,
        requestedName: update.requested_verified_name,
      });
    }
  }
}
