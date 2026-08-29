import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { isGstin, stateCodeOfGstin, stateName } from 'src/billing/gst';

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

/** Trimmed, with an empty string treated as "cleared" rather than as text. */
function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const DEFAULTS = (ssoOrgId: string): OrgSettings => ({
  ssoOrgId,
  agencyOrgId: null,
  isAgency: false,
  clientName: null,
  payerVersion: 0,
});

/**
 * An organisation's tax identity, as it must appear on its invoices.
 *
 * `stateCode` is the load-bearing field: it is the place of supply, and it
 * decides whether a charge is CGST plus SGST or IGST. It is separate from the
 * GSTIN because an unregistered customer still has a state, and the split
 * still depends on it.
 */
export interface TaxDetails {
  gstin: string | null;
  legalName: string | null;
  billingAddress: string | null;
  billingCity: string | null;
  billingPostalCode: string | null;
  stateCode: string | null;
  /** Resolved from the code, for display: "Karnataka". */
  stateName: string | null;
}

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
   * The tax identity on file, or empty fields where none has been entered.
   *
   * The state falls back to the one the registration carries: a customer who
   * gave a GSTIN has told us their state already, and asking twice for
   * something we can read off what they typed is how forms get abandoned.
   */
  async taxDetails(ssoOrgId: string): Promise<TaxDetails> {
    const row = await this.prisma.organisationSettings.findUnique({
      where: { ssoOrgId },
      select: {
        gstin: true,
        legalName: true,
        billingAddress: true,
        billingCity: true,
        billingPostalCode: true,
        stateCode: true,
      },
    });

    const stateCode = row?.stateCode ?? stateCodeOfGstin(row?.gstin) ?? null;
    return {
      gstin: row?.gstin ?? null,
      legalName: row?.legalName ?? null,
      billingAddress: row?.billingAddress ?? null,
      billingCity: row?.billingCity ?? null,
      billingPostalCode: row?.billingPostalCode ?? null,
      stateCode,
      stateName: stateName(stateCode),
    };
  }

  /**
   * Set it, having checked it is usable.
   *
   * The GSTIN's check digit is validated, not just its shape: a regex accepts
   * a transposed pair of characters, which is the mistake somebody actually
   * makes copying fifteen of them off a certificate — and a wrong GSTIN on an
   * *issued* invoice cannot be corrected by reissuing it.
   *
   * A GSTIN whose state disagrees with the state chosen is refused rather than
   * silently preferred either way. One of the two is wrong, and guessing which
   * would put the wrong heads of tax on every invoice from here on.
   */
  async setTaxDetails(
    ssoOrgId: string,
    input: {
      gstin?: string | null;
      legalName?: string | null;
      billingAddress?: string | null;
      billingCity?: string | null;
      billingPostalCode?: string | null;
      stateCode?: string | null;
    },
  ): Promise<TaxDetails> {
    const gstin = clean(input.gstin)?.toUpperCase() ?? null;
    if (gstin && !isGstin(gstin)) {
      throw new BadRequestException(
        'That GSTIN is not valid. Check it against your registration certificate — one wrong character makes the whole number invalid.',
      );
    }

    const chosen = clean(input.stateCode);
    if (chosen && !stateName(chosen)) {
      throw new BadRequestException(`${chosen} is not a GST state code.`);
    }

    const fromGstin = stateCodeOfGstin(gstin);
    if (chosen && fromGstin && chosen !== fromGstin) {
      throw new BadRequestException(
        `Your GSTIN is registered in ${stateName(fromGstin)}, but you have selected ${stateName(chosen)}. They have to agree — the state decides how tax is charged.`,
      );
    }

    const stateCode = chosen ?? fromGstin ?? null;
    const data = {
      gstin,
      legalName: clean(input.legalName),
      billingAddress: clean(input.billingAddress),
      billingCity: clean(input.billingCity),
      billingPostalCode: clean(input.billingPostalCode),
      stateCode,
    };

    await this.prisma.organisationSettings.upsert({
      where: { ssoOrgId },
      // Most organisations have no row until something needs one, so this is
      // as often an insert as an update.
      create: { ssoOrgId, ...data },
      update: data,
    });

    return { ...data, stateName: stateName(stateCode) };
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
   * An agency's clients, with what the agency calls each one.
   *
   * `clientName` is ours, not the SSO's: an agency names a client when it takes
   * it on, and nobody in that client organisation has to have logged in for the
   * agency's switcher to read properly.
   */
  async clientRoster(
    agencyOrgId: string,
  ): Promise<{ ssoOrgId: string; clientName: string | null }[]> {
    return this.prisma.organisationSettings.findMany({
      where: { agencyOrgId },
      select: { ssoOrgId: true, clientName: true },
      orderBy: { createdAt: 'asc' },
    });
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
