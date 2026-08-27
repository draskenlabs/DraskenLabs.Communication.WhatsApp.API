import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

/** What we know about an organisation, beyond the SSO's own record of it. */
export interface OrgSettings {
  ssoOrgId: string;
  /** The agency that pays for this organisation, or null. */
  agencyOrgId: string | null;
  isAgency: boolean;
  clientName: string | null;
  /** Part of every access-cache key derived from this organisation. */
  payerVersion: number;
}

const DEFAULTS = (ssoOrgId: string): OrgSettings => ({
  ssoOrgId,
  agencyOrgId: null,
  isAgency: false,
  clientName: null,
  payerVersion: 0,
});

/**
 * Who an organisation is, to us.
 *
 * Organisations live in the SSO. This answers the two questions the SSO cannot:
 * **who pays for this organisation**, and **does it manage clients**. Most
 * organisations have no row at all, which is why every read falls back to
 * defaults rather than requiring one to be written at signup.
 *
 * Deliberately its own module. `PlanLimitsService` needs it and `OrgService`
 * needs `PlanLimitsService`, so putting it in either would close a cycle; it
 * depends on nothing but Prisma so both can import it.
 */
@Injectable()
export class OrganisationSettingsService {
  private readonly logger = new Logger(OrganisationSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The row, or the defaults for an organisation that has never needed one. */
  async get(ssoOrgId: string): Promise<OrgSettings> {
    const row = await this.prisma.organisationSettings.findUnique({
      where: { ssoOrgId },
      select: {
        ssoOrgId: true,
        agencyOrgId: true,
        isAgency: true,
        clientName: true,
        payerVersion: true,
      },
    });
    return row ?? DEFAULTS(ssoOrgId);
  }

  /**
   * Which organisation's subscription answers for this one.
   *
   * An agency pays once and its clients inherit, so every question about what
   * an organisation is allowed — its limits, and whether its API keys work —
   * resolves the payer first. For everyone else the payer is themselves, which
   * is why this is safe to call unconditionally.
   */
  async billingOrgFor(ssoOrgId: string): Promise<string> {
    const settings = await this.get(ssoOrgId);
    return settings.agencyOrgId ?? ssoOrgId;
  }

  /**
   * The cache-key suffix for anything derived from this organisation's payer.
   *
   * A client's access depends on its agency's subscription, so the version that
   * matters is the *payer's*: bumping it on the agency orphans every client's
   * cached answer at once, without anybody having to enumerate them.
   */
  async cacheVersionFor(ssoOrgId: string): Promise<number> {
    const settings = await this.get(ssoOrgId);
    if (!settings.agencyOrgId) return settings.payerVersion;
    const agency = await this.get(settings.agencyOrgId);
    return agency.payerVersion;
  }

  /** Every organisation an agency pays for. Empty for anyone who is not one. */
  async clientsOf(agencyOrgId: string): Promise<string[]> {
    const rows = await this.prisma.organisationSettings.findMany({
      where: { agencyOrgId },
      select: { ssoOrgId: true },
    });
    return rows.map((r) => r.ssoOrgId);
  }

  /**
   * The organisations one subscription answers for: the payer, and anyone
   * inheriting from it. What the overage counters are measured across.
   */
  async billingScope(ssoOrgId: string): Promise<string[]> {
    const payer = await this.billingOrgFor(ssoOrgId);
    const clients = await this.clientsOf(payer);
    return [payer, ...clients];
  }

  /**
   * Invalidate every cached answer derived from this organisation's payer.
   *
   * Called when a subscription changes, when a client is taken on, and when one
   * is let go. Never throws: a stale cache entry expires on its own, and
   * failing a webhook over one would lose the payment it was reporting.
   */
  async bumpPayerVersion(ssoOrgId: string): Promise<void> {
    try {
      await this.prisma.organisationSettings.upsert({
        where: { ssoOrgId },
        update: { payerVersion: { increment: 1 } },
        create: { ssoOrgId, payerVersion: 1 },
      });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Could not bump the payer version for ${ssoOrgId}: ${detail}`,
      );
    }
  }
}
