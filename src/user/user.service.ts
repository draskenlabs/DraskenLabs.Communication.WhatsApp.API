import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { User } from '@prisma/client';
import { RedisService } from 'src/redis/redis.service';
import { DeleteAccountResultDto } from './dto/delete-account.dto';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  async findById(id: number): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findBySsoId(ssoId: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { ssoId } });
  }

  async findOrCreateBySsoId(ssoId: string): Promise<User> {
    const existing = await this.prisma.user.findUnique({ where: { ssoId } });
    if (existing) return existing;
    return this.prisma.user.create({ data: { ssoId } });
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
    const wabas = await this.prisma.waba.findMany({
      where: { userId },
      select: { wabaId: true, ssoOrgId: true },
    });
    const wabaIds = wabas.map((w) => w.wabaId);
    const orgIds = [...new Set(wabas.map((w) => w.ssoOrgId))];

    // Cached values have to be read before the rows go, so the cache entries
    // can be purged afterwards — a stale API key cache would keep working.
    const apiKeys = await this.prisma.userApiKey.findMany({
      where: { userId },
      select: { accessKey: true },
    });
    const phoneNumbers = wabaIds.length
      ? await this.prisma.wabaPhoneNumber.findMany({
          where: { wabaId: { in: wabaIds } },
          select: { phoneNumberId: true },
        })
      : [];

    // Organisations where this user is the last one holding a WABA here.
    const orphanedOrgs: string[] = [];
    for (const ssoOrgId of orgIds) {
      const others = await this.prisma.waba.count({
        where: { ssoOrgId, userId: { not: userId } },
      });
      if (others === 0) orphanedOrgs.push(ssoOrgId);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const byWaba = { wabaId: { in: wabaIds } };

      const templates = wabaIds.length
        ? await tx.messageTemplate.deleteMany({ where: byWaba })
        : { count: 0 };
      const inbound = wabaIds.length
        ? await tx.inboundMessage.deleteMany({ where: byWaba })
        : { count: 0 };
      const numbers = wabaIds.length
        ? await tx.wabaPhoneNumber.deleteMany({ where: byWaba })
        : { count: 0 };
      const events = wabaIds.length
        ? await tx.webhookEvent.deleteMany({ where: byWaba })
        : { count: 0 };

      // Also covers connections other users made to these WABAs, which would
      // otherwise block the WABA delete on its foreign key.
      const connections = await tx.userWhatsapp.deleteMany({
        where: wabaIds.length ? { OR: [{ userId }, byWaba] } : { userId },
      });
      const messages = await tx.message.deleteMany({ where: { userId } });
      const keys = await tx.userApiKey.deleteMany({ where: { userId } });
      const contacts = orphanedOrgs.length
        ? await tx.contact.deleteMany({
            where: { ssoOrgId: { in: orphanedOrgs } },
          })
        : { count: 0 };
      const removedWabas = await tx.waba.deleteMany({ where: { userId } });

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
    return result;
  }
}
