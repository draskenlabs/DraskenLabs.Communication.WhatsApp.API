import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';

/**
 * What an organisation is called, for anything that has only its id.
 *
 * Organisations live in the SSO, not here, so an email sent from a webhook or a
 * billing cron has an `ssoOrgId` and no way to turn it into a name — and
 * "Subscription renewed" with no mention of which organisation is no use to
 * somebody who belongs to three.
 *
 * Two layers, both filled in as a side effect of work that already happens:
 * Redis whenever a session lists its organisations, and a column on
 * `WabaOrganisation` written at connect. Redis expires; the column is what
 * makes the name survive a restart with nobody logged in.
 */
@Injectable()
export class OrgDirectoryService {
  private readonly logger = new Logger(OrgDirectoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Cache the names on a set of organisations we have just been told about. */
  async remember(orgs: { id: string; name: string }[]): Promise<void> {
    try {
      await Promise.all(
        orgs
          .filter((o) => o.id && o.name)
          .map((o) => this.redis.setOrgName(o.id, o.name)),
      );
    } catch (err) {
      // A missing name costs an email a line. It is not worth failing a login.
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not cache organisation names: ${detail}`);
    }
  }

  /**
   * The organisation's name, or null if nothing has ever told us.
   *
   * Never throws: every caller is composing an email, and an email is a
   * courtesy on top of an action that already happened.
   */
  async name(ssoOrgId: string | null | undefined): Promise<string | null> {
    if (!ssoOrgId) return null;

    try {
      const cached = await this.redis.getOrgName(ssoOrgId);
      if (cached) return cached;

      const membership = await this.prisma.wabaOrganisation.findFirst({
        where: { ssoOrgId, orgName: { not: null } },
        select: { orgName: true },
        orderBy: { id: 'desc' },
      });

      if (membership?.orgName) {
        await this.redis.setOrgName(ssoOrgId, membership.orgName);
        return membership.orgName;
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not read the name of organisation ${ssoOrgId}: ${detail}`);
    }

    return null;
  }

  /**
   * The organisation an account belongs to, when there is exactly one.
   *
   * An account connected by two organisations has no single answer, and
   * guessing would put the wrong organisation's name in front of somebody. The
   * emails triggered by Meta webhooks carry only a `wabaId`, so this is how
   * they name an organisation when it is safe to and stay quiet when it is not.
   */
  async soleOrgFor(wabaId: string): Promise<string | null> {
    try {
      const memberships = await this.prisma.wabaOrganisation.findMany({
        where: { wabaId },
        select: { ssoOrgId: true },
        take: 2,
      });
      if (memberships.length !== 1) return null;
      return this.name(memberships[0].ssoOrgId);
    } catch {
      return null;
    }
  }
}
