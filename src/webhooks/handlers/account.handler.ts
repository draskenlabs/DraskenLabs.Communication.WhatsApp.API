import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailNotifications } from 'src/mail/mail.notifications';

/**
 * Meta's `decision` on a name review, in the vocabulary `name_status` uses, or
 * null for a decision we do not recognise — better no answer than a wrong one
 * written over what a sync knows.
 *
 * `DEFERRED` is Meta holding the request for a longer look rather than a
 * verdict, so it reads as still in review; it used to fall through to null and
 * leave the console showing the previous answer.
 */
function nameStatusFor(decision: unknown): string | null {
  const value = typeof decision === 'string' ? decision.toUpperCase() : '';
  if (value === 'APPROVED') return 'APPROVED';
  if (value === 'REJECTED' || value === 'DECLINED') return 'DECLINED';
  if (
    value === 'PENDING' ||
    value === 'PENDING_REVIEW' ||
    value === 'DEFERRED'
  ) {
    return 'PENDING_REVIEW';
  }
  if (value === 'EXPIRED') return 'EXPIRED';
  return null;
}

/**
 * Whether this number already has a name Meta will show to recipients.
 *
 * `AVAILABLE_WITHOUT_REVIEW` counts: a name that matches the verified business
 * clears with no manual review at all, and it is in use exactly like an
 * approved one. It is the common case for a first number, not an edge.
 */
function hasNameInUse(nameStatus: string | null | undefined): boolean {
  const value = (nameStatus ?? '').toUpperCase();
  return value === 'APPROVED' || value === 'AVAILABLE_WITHOUT_REVIEW';
}

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

  /**
   * Meta's verdict on a *requested* display name.
   *
   * Recorded, not just emailed: the console reads the status off the row, and
   * a decision that only reached an inbox left the number claiming its
   * previous answer until somebody happened to run a sync.
   *
   * Which column it lands in depends on whether the number already has a name
   * in use. The request is always about a name Meta has not shown yet, so
   * while an approved name is live the verdict belongs to the pending rename —
   * writing a refused rename to `nameStatus` reported the name customers are
   * actually seeing as declined. Only where there is no name in use does the
   * verdict describe the number's own display name.
   */
  async handlePhoneNameUpdate(value: unknown, wabaId?: string): Promise<void> {
    this.logger.log(`Phone name update: ${JSON.stringify(value)}`);

    const update = (value ?? {}) as {
      display_phone_number?: string;
      decision?: string;
      requested_verified_name?: string;
      rejection_reason?: string;
    };

    if (wabaId) {
      void this.mail.displayNameDecision({
        wabaId,
        displayPhoneNumber: update.display_phone_number,
        decision: update.decision,
        requestedName: update.requested_verified_name,
        rejectionReason: update.rejection_reason,
      });
    }

    const nameStatus = nameStatusFor(update.decision);
    if (!nameStatus || !update.display_phone_number) return;

    // Scoped to the account the webhook is about, for the same reason the
    // quality update is: a display number is not unique across accounts.
    const where = {
      displayPhoneNumber: update.display_phone_number,
      ...(wabaId ? { wabaId } : {}),
    };

    try {
      const current = await this.prisma.wabaPhoneNumber.findFirst({
        where,
        select: { nameStatus: true },
      });

      await this.prisma.wabaPhoneNumber.updateMany({
        where,
        data: this.nameDecisionUpdate(
          nameStatus,
          update.requested_verified_name,
          current?.nameStatus,
        ),
      });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to record the name decision for ${update.display_phone_number}: ${detail}`,
      );
    }
  }

  /** The columns a name decision changes, given what the number has today. */
  private nameDecisionUpdate(
    decision: string,
    requestedName: string | undefined,
    currentStatus: string | null | undefined,
  ): {
    nameStatus?: string;
    verifiedName?: string;
    newDisplayName?: string | null;
    newNameStatus?: string | null;
  } {
    // An approval is the moment the requested name becomes the name Meta
    // shows, whether it replaces an older one or is the number's first. The
    // request is settled either way, so nothing is left pending.
    if (decision === 'APPROVED') {
      return {
        nameStatus: 'APPROVED',
        ...(requestedName ? { verifiedName: requestedName } : {}),
        newDisplayName: null,
        newNameStatus: null,
      };
    }

    // A verdict on a rename, with a live name to protect: the name in use is
    // untouched and keeps being shown, and the requested one carries the
    // verdict so the console can say which name was refused or is still out.
    if (hasNameInUse(currentStatus)) {
      return {
        newNameStatus: decision,
        ...(requestedName ? { newDisplayName: requestedName } : {}),
      };
    }

    // No name in use, so the verdict is about the only name there is.
    return { nameStatus: decision, newDisplayName: null, newNameStatus: null };
  }
}
