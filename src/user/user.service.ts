import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { User } from '@prisma/client';
import { RedisService } from 'src/redis/redis.service';
import { DeleteAccountResultDto } from './dto/delete-account.dto';
import { MailNotifications } from 'src/mail/mail.notifications';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly mail: MailNotifications,
  ) {}

  async findById(id: number): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findBySsoId(ssoId: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { ssoId } });
  }

  /**
   * Find or create the local user, refreshing the contact details copied from
   * SSO. The email is held here because every notification email is triggered
   * by a webhook or a scheduled job, where there is no user token to read the
   * SSO profile with.
   */
  async findOrCreateBySsoId(
    ssoId: string,
    contact?: { email?: string; firstName?: string; lastName?: string },
  ): Promise<User> {
    const details = {
      ...(contact?.email ? { email: contact.email } : {}),
      ...(contact?.firstName ? { firstName: contact.firstName } : {}),
      ...(contact?.lastName ? { lastName: contact.lastName } : {}),
    };

    return this.prisma.user.upsert({
      where: { ssoId },
      create: { ssoId, ...details },
      update: details,
    });
  }

  /**
   * Deletes everything this platform holds for a user, and nothing else.
   *
   * Scope is deliberately narrow: the user's DraskenLabs SSO account is
   * untouched (they keep signing in elsewhere), and their WhatsApp Business
   * Account, phone numbers and approved templates stay with Meta — this only
   * removes the copy of that data held here, along with the credentials that
   * let us reach it.
   *
   * Contacts are organisation-scoped rather than user-owned, so they are only
   * removed when no other user of this platform is left in the organisation.
   * Deleting one member's account must never wipe a colleague's contact list.
   *
   * Runs as a single transaction in foreign-key-safe order, so a failure part
   * way through leaves the account intact rather than half-deleted.
   */
  async deleteAccount(
    userId: number,
    sessionId?: string,
  ): Promise<DeleteAccountResultDto> {
    // Read before the row goes: after the transaction there is no address to
    // send the receipt to.
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    // Accounts this user brought into an organisation. The membership row is
    // the link that matters — `Waba.userId` only records who connected first,
    // and deleting on that basis took a shared account away from every other
    // organisation holding it.
    const memberships = await this.prisma.wabaOrganisation.findMany({
      where: { userId },
      select: { wabaId: true, ssoOrgId: true },
    });
    const touchedWabaIds = [...new Set(memberships.map((m) => m.wabaId))];
    const touchedOrgIds = [...new Set(memberships.map((m) => m.ssoOrgId))];

    // An account is deleted only when losing this user's memberships leaves no
    // organisation holding it at all. Anything still held stays exactly as it
    // is, data included.
    const orphanedWabaIds: string[] = [];
    for (const wabaId of touchedWabaIds) {
      const remaining = await this.prisma.wabaOrganisation.count({
        where: { wabaId, userId: { not: userId } },
      });
      if (remaining === 0) orphanedWabaIds.push(wabaId);
    }

    // Cached values have to be read before the rows go, so the cache entries
    // can be purged afterwards — a stale API key cache would keep working.
    const apiKeys = await this.prisma.userApiKey.findMany({
      where: { userId },
      select: { accessKey: true },
    });
    const phoneNumbers = orphanedWabaIds.length
      ? await this.prisma.wabaPhoneNumber.findMany({
          where: { wabaId: { in: orphanedWabaIds } },
          select: { phoneNumberId: true },
        })
      : [];

    // Organisations left holding nothing once this user's memberships go. Their
    // contacts have no account to act on, so they go too; an organisation that
    // still holds an account keeps everything.
    const orphanedOrgs: string[] = [];
    for (const ssoOrgId of touchedOrgIds) {
      const others = await this.prisma.wabaOrganisation.count({
        where: { ssoOrgId, userId: { not: userId } },
      });
      if (others === 0) orphanedOrgs.push(ssoOrgId);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const byWaba = { wabaId: { in: orphanedWabaIds } };
      const hasOrphans = orphanedWabaIds.length > 0;

      const templates = hasOrphans
        ? await tx.messageTemplate.deleteMany({ where: byWaba })
        : { count: 0 };
      const inbound = hasOrphans
        ? await tx.inboundMessage.deleteMany({ where: byWaba })
        : { count: 0 };
      const numbers = hasOrphans
        ? await tx.wabaPhoneNumber.deleteMany({ where: byWaba })
        : { count: 0 };
      const events = hasOrphans
        ? await tx.webhookEvent.deleteMany({ where: byWaba })
        : { count: 0 };

      // This user's own connections always go. Other users' connections go only
      // to accounts nobody is left holding — otherwise they belong to an
      // organisation that still has the account and must keep working.
      const connections = await tx.userWhatsapp.deleteMany({
        where: hasOrphans ? { OR: [{ userId }, byWaba] } : { userId },
      });
      const messages = await tx.message.deleteMany({ where: { userId } });
      const keys = await tx.userApiKey.deleteMany({ where: { userId } });
      // Push registrations and preferences are per-user, so they go with the
      // account — otherwise a device would keep a foreign key to a dead row.
      const devices = await tx.deviceToken.deleteMany({ where: { userId } });
      await tx.notificationPreference.deleteMany({ where: { userId } });
      const contacts = orphanedOrgs.length
        ? await tx.contact.deleteMany({
            where: { ssoOrgId: { in: orphanedOrgs } },
          })
        : { count: 0 };

      // The memberships this user created, whether or not the account survives.
      await tx.wabaOrganisation.deleteMany({ where: { userId } });
      const removedWabas = hasOrphans
        ? await tx.waba.deleteMany({ where: { wabaId: { in: orphanedWabaIds } } })
        : { count: 0 };

      await tx.user.delete({ where: { id: userId } });

      return {
        wabas: removedWabas.count,
        phoneNumbers: numbers.count,
        templates: templates.count,
        messages: messages.count,
        inboundMessages: inbound.count,
        apiKeys: keys.count,
        metaConnections: connections.count,
        contacts: contacts.count,
        webhookEvents: events.count,
        devices: devices.count,
      };
    });

    // Caches outlive the rows, so a missed purge would keep a deleted API key
    // authenticating. Best-effort: the data is already gone either way.
    try {
      await this.redisService.invalidateUserCache(userId);
      if (sessionId) await this.redisService.deleteSsoSession(sessionId);
      for (const { accessKey } of apiKeys) {
        await this.redisService.deleteApiKeyCache(accessKey);
      }
      for (const { phoneNumberId } of phoneNumbers) {
        await this.redisService.invalidatePhoneCache(phoneNumberId);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Deleted user ${userId} but failed to purge caches: ${message}`,
      );
    }

    this.logger.log(
      `Deleted account for user ${userId}: ${JSON.stringify(result)}`,
    );

    // The user's record of exactly what was removed — the Data Deletion page
    // promises this in writing.
    if (account?.email) {
      void this.mail.accountDeleted(
        account.email,
        result as unknown as Record<string, number>,
      );
    }

    return result;
  }
}
