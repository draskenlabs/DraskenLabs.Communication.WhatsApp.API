import { Injectable, NotFoundException } from '@nestjs/common';
import { UserWhatsapp } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Who may act on a WhatsApp Business Account, and with whose Meta token.
 *
 * Two mistakes this exists to stop making, both of which look like "it works
 * for me and 404s for everyone else":
 *
 * 1. **Scoping by `Waba.userId` or `Waba.ssoOrgId`.** Those record who
 *    connected the account *first*. An account can be connected by several
 *    organisations, so membership is `WabaOrganisation` and nothing else.
 *
 * 2. **Requiring the caller's own Meta token.** The token lives on
 *    `UserWhatsapp`, one row per user who completed the signup. A colleague in
 *    the same organisation has no row of their own, and refusing them is
 *    refusing an account their organisation owns. The organisation's own
 *    connection is the fallback — never another organisation's, which would
 *    let one act on a token it was never given.
 */
@Injectable()
export class WabaMembershipService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The account, if this organisation holds it.
   *
   * @throws NotFoundException phrased as "not found" rather than "forbidden":
   * an organisation has no business learning that an id it cannot see exists.
   */
  async require(
    ssoOrgId: string,
    wabaId: string,
  ): Promise<{ wabaId: string; name: string | null }> {
    const waba = await this.prisma.waba.findFirst({
      where: { wabaId, WabaOrganisation: { some: { ssoOrgId } } },
      select: { wabaId: true, name: true },
    });
    if (!waba) throw new NotFoundException(`WABA ${wabaId} not found in this organisation`);
    return waba;
  }

  /** Whether this organisation holds the account, without throwing. */
  async holds(ssoOrgId: string, wabaId: string): Promise<boolean> {
    const count = await this.prisma.wabaOrganisation.count({
      where: { wabaId, ssoOrgId },
    });
    return count > 0;
  }

  /**
   * A Meta connection this organisation may act through.
   *
   * The caller's own is preferred — it is the one whose permissions they
   * consented to. Failing that, the connection belonging to whoever brought the
   * account into *this* organisation. Both are inside the organisation, so a
   * second organisation never borrows the first one's token.
   */
  async connection(
    ssoOrgId: string,
    wabaId: string,
    userId?: number,
  ): Promise<UserWhatsapp> {
    await this.require(ssoOrgId, wabaId);

    if (userId !== undefined) {
      const own = await this.prisma.userWhatsapp.findFirst({
        where: { userId, wabaId },
      });
      if (own) return own;
    }

    const membership = await this.prisma.wabaOrganisation.findUnique({
      where: { wabaId_ssoOrgId: { wabaId, ssoOrgId } },
      select: { userId: true },
    });

    const shared = membership
      ? await this.prisma.userWhatsapp.findFirst({
          where: { userId: membership.userId, wabaId },
        })
      : null;

    if (!shared) throw new NotFoundException('No connection found for this WABA');
    return shared;
  }
}
