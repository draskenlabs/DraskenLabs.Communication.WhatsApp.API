import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { OrganisationSettingsService } from 'src/organisation-settings/organisation-settings.service';
import { OrgDirectoryService } from 'src/org/org-directory.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { AgencyRosterDto, ClientSummaryDto } from './dto/agency.dto';

/** The first of the current month, which is what "this month" is counted from. */
function startOfMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Agencies and the organisations they pay for.
 *
 * The relationship is ours, not the SSO's: a client is an ordinary
 * organisation that nobody at the agency is a member of, and what makes it a
 * client is a row here. Two consequences run through everything below — an
 * agency may enter an organisation it does not belong to, and one subscription
 * answers for several organisations.
 *
 * Both edges are operator-only on purpose. Converting an organisation to an
 * agency hands it a privilege the plan does not describe, and taking a client
 * on moves who pays for it; neither is something to be reached by a checkout.
 */
@Injectable()
export class AgencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: OrganisationSettingsService,
    private readonly orgDirectory: OrgDirectoryService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  /** Mark an organisation an agency, or demote one back. */
  async convert(
    ssoOrgId: string,
    isAgency: boolean,
    convertedBy?: number,
  ): Promise<{ ssoOrgId: string; isAgency: boolean }> {
    const current = await this.settings.get(ssoOrgId);

    // One level, no chains. An agency that is itself somebody's client would
    // make "who pays" a walk rather than a lookup, and every limit question
    // starts with that answer.
    if (isAgency && current.agencyOrgId) {
      throw new BadRequestException(
        'This organisation is a client of another agency. Detach it first.',
      );
    }

    if (!isAgency) {
      const clients = await this.settings.clientsOf(ssoOrgId);
      if (clients.length > 0) {
        // Demoting with clients still attached would leave them inheriting from
        // an organisation that no longer manages anything — subscribed to
        // nothing, with no error anyone could act on.
        throw new BadRequestException(
          `This agency still has ${clients.length} client${clients.length === 1 ? '' : 's'}. ` +
            'Detach them before demoting it.',
        );
      }
    }

    await this.prisma.organisationSettings.upsert({
      where: { ssoOrgId },
      update: {
        isAgency,
        convertedBy: convertedBy ?? null,
        convertedAt: isAgency ? new Date() : null,
        // Its own clients read the agency's version, so a change of status has
        // to orphan whatever was cached under the old one.
        payerVersion: { increment: 1 },
      },
      create: {
        ssoOrgId,
        isAgency,
        convertedBy: convertedBy ?? null,
        convertedAt: isAgency ? new Date() : null,
      },
    });

    return { ssoOrgId, isAgency };
  }

  /** Put a client organisation under an agency, so the agency pays for it. */
  async attachClient(
    agencyOrgId: string,
    ssoOrgId: string,
    clientName?: string,
  ): Promise<ClientSummaryDto> {
    if (agencyOrgId === ssoOrgId) {
      throw new BadRequestException(
        'An organisation cannot be its own client.',
      );
    }

    const agency = await this.settings.get(agencyOrgId);
    if (!agency.isAgency) {
      throw new BadRequestException(`${agencyOrgId} is not an agency.`);
    }

    const client = await this.settings.get(ssoOrgId);
    if (client.isAgency) {
      throw new BadRequestException(
        'An agency cannot be taken on as a client. Demote it first.',
      );
    }
    if (client.agencyOrgId && client.agencyOrgId !== agencyOrgId) {
      // Moving a client between agencies silently would change who is billed
      // for it without either agency being told.
      throw new BadRequestException(
        'This organisation already belongs to another agency. Detach it first.',
      );
    }

    // Only a client that is not already on the roster takes a place. Calling
    // this again for one the agency has is a rename, and refusing that at the
    // limit would leave a full agency unable to correct a label.
    if (client.agencyOrgId !== agencyOrgId) {
      const [limits, held] = await Promise.all([
        this.planLimits.forOrg(agencyOrgId),
        this.prisma.organisationSettings.count({ where: { agencyOrgId } }),
      ]);
      // Classed as an inclusion rather than a ceiling in the schema, because
      // the intention is to sell clients by the unit. Until there is a
      // per-client price to charge, "included" with nothing beyond it is a
      // number that means nothing — and each client carries a *full* set of
      // the plan's limits, so an unbounded roster is an unbounded estate on
      // one subscription. Enforced as a ceiling until it can be billed.
      this.planLimits.assertWithin(
        limits,
        limits.includedClients,
        held,
        'client',
      );
    }

    await this.prisma.organisationSettings.upsert({
      where: { ssoOrgId },
      update: {
        agencyOrgId,
        clientName: clientName ?? client.clientName,
        // From now on this organisation's access is read off the agency's
        // version, so anything cached against its own has to stop matching.
        payerVersion: { increment: 1 },
      },
      create: { ssoOrgId, agencyOrgId, clientName: clientName ?? null },
    });

    const [summary] = await this.summarise([
      {
        ssoOrgId,
        clientName: clientName ?? client.clientName,
        createdAt: new Date(),
      },
    ]);
    return summary;
  }

  /**
   * Let a client go.
   *
   * It keeps its data and its organisation; what it loses is the agency's
   * subscription. Until it buys one of its own the API answers "not
   * subscribed", which is the same thing it answers anyone who has never paid.
   */
  async detachClient(agencyOrgId: string, ssoOrgId: string): Promise<void> {
    const client = await this.settings.get(ssoOrgId);
    if (client.agencyOrgId !== agencyOrgId) {
      throw new NotFoundException(
        `${ssoOrgId} is not a client of ${agencyOrgId}`,
      );
    }

    await this.prisma.organisationSettings.update({
      where: { ssoOrgId },
      data: { agencyOrgId: null, payerVersion: { increment: 1 } },
    });
  }

  /** What the agency's clients page renders: the roster and what it adds up to. */
  async roster(agencyOrgId: string): Promise<AgencyRosterDto> {
    await this.assertAgency(agencyOrgId);

    const rows = await this.prisma.organisationSettings.findMany({
      where: { agencyOrgId },
      select: { ssoOrgId: true, clientName: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const clients = await this.summarise(rows);
    const limits = await this.planLimits.forOrg(agencyOrgId);

    return {
      clients,
      totals: {
        clients: clients.length,
        wabas: clients.reduce((sum, c) => sum + c.wabas, 0),
        phoneNumbers: clients.reduce((sum, c) => sum + c.phoneNumbers, 0),
        includedClients: limits.includedClients,
        includedWabas: limits.includedWabas,
        planName: limits.planName,
      },
    };
  }

  /** Rename a client. The label is the agency's, so this is theirs to change. */
  async renameClient(
    agencyOrgId: string,
    ssoOrgId: string,
    clientName: string,
  ): Promise<{ ssoOrgId: string; clientName: string }> {
    const client = await this.settings.get(ssoOrgId);
    if (client.agencyOrgId !== agencyOrgId) {
      throw new NotFoundException(
        `${ssoOrgId} is not a client of ${agencyOrgId}`,
      );
    }

    await this.prisma.organisationSettings.update({
      where: { ssoOrgId },
      data: { clientName },
    });
    return { ssoOrgId, clientName };
  }

  /** Refuse a request that reads an agency's roster from somewhere that is not one. */
  async assertAgency(ssoOrgId: string): Promise<void> {
    const settings = await this.settings.get(ssoOrgId);
    if (!settings.isAgency) {
      throw new ForbiddenException('This organisation does not manage clients');
    }
  }

  /**
   * The counters behind each row of the roster.
   *
   * Four queries for the whole roster rather than four per client: an agency
   * with fifty clients is the case this page exists for, and a per-row query
   * would make it slowest exactly there.
   */
  private async summarise(
    rows: { ssoOrgId: string; clientName: string | null; createdAt: Date }[],
  ): Promise<ClientSummaryDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.ssoOrgId);

    const memberships = await this.prisma.wabaOrganisation.findMany({
      where: { ssoOrgId: { in: ids } },
      select: { ssoOrgId: true, wabaId: true },
    });
    const wabaIds = [...new Set(memberships.map((m) => m.wabaId))];

    const numbers = wabaIds.length
      ? await this.prisma.wabaPhoneNumber.groupBy({
          by: ['wabaId'],
          where: { wabaId: { in: wabaIds } },
          _count: { _all: true },
        })
      : [];

    const [contacts, messages] = await Promise.all([
      this.prisma.contact.groupBy({
        by: ['ssoOrgId'],
        where: { ssoOrgId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.message.groupBy({
        by: ['ssoOrgId'],
        where: { ssoOrgId: { in: ids }, createdAt: { gte: startOfMonth() } },
        _count: { _all: true },
      }),
    ]);

    const numbersByWaba = new Map(
      numbers.map((n) => [n.wabaId, n._count._all] as const),
    );
    const contactsByOrg = new Map(
      contacts.map((c) => [c.ssoOrgId, c._count._all] as const),
    );
    const messagesByOrg = new Map(
      messages.map((m) => [m.ssoOrgId, m._count._all] as const),
    );

    return Promise.all(
      rows.map(async (row) => {
        const owned = memberships.filter((m) => m.ssoOrgId === row.ssoOrgId);
        return {
          ssoOrgId: row.ssoOrgId,
          name:
            row.clientName ??
            (await this.orgDirectory.name(row.ssoOrgId)) ??
            'Client',
          wabas: owned.length,
          phoneNumbers: owned.reduce(
            (sum, m) => sum + (numbersByWaba.get(m.wabaId) ?? 0),
            0,
          ),
          contacts: contactsByOrg.get(row.ssoOrgId) ?? 0,
          messagesThisMonth: messagesByOrg.get(row.ssoOrgId) ?? 0,
          addedAt: row.createdAt,
        };
      }),
    );
  }
}
