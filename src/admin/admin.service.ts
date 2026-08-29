import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { OrgDirectoryService } from 'src/org/org-directory.service';
import { OrganisationSettingsService } from 'src/organisation-settings/organisation-settings.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { AgencyService } from 'src/agency/agency.service';
import { RazorpayService } from 'src/billing/razorpay.service';
import { InvoiceService, InvoiceWithLines } from 'src/billing/invoice.service';
import { AdminAuditService } from './admin-audit.service';
import type { AdminActor } from './admin.guard';
import type {
  AdminAuditPageDto,
  AdminInvoicePageDto,
  CreatePlanDto,
  AdminOrganisationDetailDto,
  AdminOrganisationPageDto,
  AdminOrganisationRowDto,
  AdminOverviewDto,
  AdminPlanDto,
  AdminSubscriptionRowDto,
  AdminUserDto,
  UpdatePlanDto,
} from './dto/admin.dto';

/** Statuses that mean a subscription is paying for something right now. */
const LIVE_STATUSES = ['active', 'authenticated', 'pending', 'halted'] as const;

/** The columns the plan editor reads and writes. */
const PLAN_SELECT = {
  code: true,
  name: true,
  audience: true,
  price: true,
  priceLabel: true,
  currency: true,
  unit: true,
  additionalWabaPrice: true,
  additionalNumberPrice: true,
  includedWabas: true,
  includedPhoneNumbersPerWaba: true,
  includedClients: true,
  maxTeamMembers: true,
  maxWebhookEndpoints: true,
  maxApiKeysPerWaba: true,
  maxContacts: true,
  maxMessagesPerMinute: true,
  historyDays: true,
  rank: true,
  sortOrder: true,
  recommended: true,
  active: true,
  ctaKind: true,
  ctaLabel: true,
  ssoOrgId: true,
  razorpayPlanId: true,
} as const;

/** Fields a plan edit may touch. Price is not among them; see `UpdatePlanDto`. */
const EDITABLE = [
  'name',
  'audience',
  'unit',
  'priceLabel',
  'additionalWabaPrice',
  'additionalNumberPrice',
  'includedWabas',
  'includedPhoneNumbersPerWaba',
  'includedClients',
  'maxTeamMembers',
  'maxWebhookEndpoints',
  'maxApiKeysPerWaba',
  'maxContacts',
  'maxMessagesPerMinute',
  'historyDays',
  'rank',
  'sortOrder',
  'recommended',
  'active',
  'ctaKind',
  'ctaLabel',
  'razorpayPlanId',
] as const;

const PAGE_SIZE = 25;

/** The payment columns the detail screen shows. */
type PaymentRow = {
  razorpayPaymentId: string;
  status: string;
  amount: number;
  method: string | null;
  paidAt: Date | null;
};

/** Prisma `groupBy` rows to a `wabaId → count` map, dropping the null key. */
function tally(
  rows: { wabaId: string | null; _count: { _all: number } }[],
): Map<string, number> {
  return new Map(
    rows
      .filter((r): r is { wabaId: string; _count: { _all: number } } =>
        Boolean(r.wabaId),
      )
      .map((r) => [r.wabaId, r._count._all] as const),
  );
}

/**
 * What the operator console reads and does.
 *
 * Everything here crosses organisation boundaries on purpose, which is the one
 * thing no other service in this codebase is allowed to do — every query
 * elsewhere is scoped by `ssoOrgId` from the caller's token. That is why the
 * guard in front of it refuses with a 404 rather than a 403, and why every
 * mutation writes an audit row.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgDirectory: OrgDirectoryService,
    private readonly orgSettings: OrganisationSettingsService,
    private readonly planLimits: PlanLimitsService,
    private readonly agency: AgencyService,
    private readonly audit: AdminAuditService,
    // A price only ever enters the system as a provider plan, created here.
    private readonly razorpay: RazorpayService,
    // Underscored to keep the name free for the method that lists them.
    private readonly invoices_: InvoiceService,
  ) {}

  // ---------------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------------

  async overview(): Promise<AdminOverviewDto> {
    const [byStatusRows, wabas, phoneNumbers, contacts, orgIds] =
      await Promise.all([
        this.prisma.subscription.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        this.prisma.waba.count(),
        this.prisma.wabaPhoneNumber.count(),
        this.prisma.contact.count(),
        this.organisationIds(),
      ]);

    const byStatus: Record<string, number> = {};
    for (const row of byStatusRows) byStatus[row.status] = row._count._all;

    // Recurring revenue from what is live, at the price each subscription is
    // actually on. A quoted plan carries no price and contributes nothing —
    // counting it as zero understates, but inventing a number would be worse.
    const live = await this.prisma.subscription.findMany({
      where: { status: { in: [...LIVE_STATUSES] } },
      select: { plan: { select: { price: true, currency: true } } },
    });
    const mrr = live.reduce((sum, s) => sum + (s.plan?.price ?? 0), 0);

    return {
      organisations: orgIds.size,
      activeSubscriptions: byStatus.active ?? 0,
      mrr,
      currency: live.find((s) => s.plan?.currency)?.plan?.currency ?? 'INR',
      wabas,
      phoneNumbers,
      contacts,
      byStatus,
      atRisk: {
        pending: byStatus.pending ?? 0,
        halted: byStatus.halted ?? 0,
        // Chosen and never paid for: the quietest way to lose a sale, since
        // nothing fails and nobody is told.
        neverAuthorised:
          (byStatus.created ?? 0) + (byStatus.authenticated ?? 0),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Organisations
  // ---------------------------------------------------------------------------

  /**
   * Every organisation we have any record of.
   *
   * Organisations live in the SSO, so there is no table to select from — an
   * organisation is real here the moment it connects an account, subscribes, or
   * gets settings written for it. The id set is assembled from those three and
   * held in memory.
   *
   * That is a deliberate ceiling: it is fine for the hundreds this will hold
   * for a long while, and the fix when it is not is an `Organisation` table
   * written at sign-in, not a cleverer query.
   */
  private async organisationIds(): Promise<Set<string>> {
    const [memberships, subscriptions, settings] = await Promise.all([
      this.prisma.wabaOrganisation.findMany({
        distinct: ['ssoOrgId'],
        select: { ssoOrgId: true },
      }),
      this.prisma.subscription.findMany({
        distinct: ['ssoOrgId'],
        select: { ssoOrgId: true },
      }),
      this.prisma.organisationSettings.findMany({
        select: { ssoOrgId: true },
      }),
    ]);

    return new Set([
      ...memberships.map((m) => m.ssoOrgId),
      ...subscriptions.map((s) => s.ssoOrgId),
      ...settings.map((s) => s.ssoOrgId),
    ]);
  }

  async organisations(opts: {
    search?: string;
    page?: number;
  }): Promise<AdminOrganisationPageDto> {
    const ids = [...(await this.organisationIds())];
    const rows = await Promise.all(ids.map((id) => this.summarise(id)));

    const term = opts.search?.trim().toLowerCase();
    const matched = term
      ? rows.filter(
          (row) =>
            row.ssoOrgId.toLowerCase().includes(term) ||
            (row.name ?? '').toLowerCase().includes(term),
        )
      : rows;

    // Newest first, and an organisation we have no date for last rather than
    // first — an unknown date is not a recent one.
    matched.sort(
      (a, b) => (b.firstSeen?.getTime() ?? 0) - (a.firstSeen?.getTime() ?? 0),
    );

    const page = Math.max(1, opts.page ?? 1);
    const total = matched.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return {
      organisations: matched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      total,
      page,
      totalPages,
    };
  }

  /** The row shape, for one organisation. */
  private async summarise(ssoOrgId: string): Promise<AdminOrganisationRowDto> {
    const [name, settings, subscription, memberships, contacts] =
      await Promise.all([
        this.orgDirectory.name(ssoOrgId),
        this.orgSettings.get(ssoOrgId),
        this.liveSubscription(ssoOrgId),
        this.prisma.wabaOrganisation.findMany({
          where: { ssoOrgId },
          select: { wabaId: true, createdAt: true },
        }),
        this.prisma.contact.count({ where: { ssoOrgId } }),
      ]);

    const wabaIds = memberships.map((m) => m.wabaId);
    const phoneNumbers = wabaIds.length
      ? await this.prisma.wabaPhoneNumber.count({
          where: { wabaId: { in: wabaIds } },
        })
      : 0;

    const dates = [
      ...memberships.map((m) => m.createdAt),
      ...(subscription ? [subscription.createdAt] : []),
    ];

    return {
      ssoOrgId,
      name,
      planCode: subscription?.plan?.code ?? null,
      planName: subscription?.plan?.name ?? null,
      status: subscription?.status ?? null,
      // The same rule the paywall applies: a paid month runs to its end
      // whatever the status, including after cancelling.
      active: this.grants(subscription),
      currentEnd: subscription?.currentEnd ?? null,
      wabas: memberships.length,
      phoneNumbers,
      contacts,
      isAgency: settings.isAgency,
      agencyOrgId: settings.agencyOrgId,
      // Who is charged, which is only ever somebody else for an agency's
      // client. Named rather than left as an id: an operator reading this row
      // is asking "who pays for this", and an opaque `org_…` does not answer it.
      payerOrgId: subscription?.payerOrgId ?? null,
      payerName: subscription?.payerOrgId
        ? await this.orgDirectory.name(subscription.payerOrgId)
        : null,
      firstSeen: dates.length
        ? new Date(Math.min(...dates.map((d) => d.getTime())))
        : null,
    };
  }

  async organisation(ssoOrgId: string): Promise<AdminOrganisationDetailDto> {
    const known = await this.organisationIds();
    if (!known.has(ssoOrgId)) {
      throw new NotFoundException(`No organisation ${ssoOrgId}`);
    }

    const row = await this.summarise(ssoOrgId);
    const subscription = await this.liveSubscription(ssoOrgId);

    const [wabas, limits, clients, apiKeys, webhookEndpoints, messages] =
      await Promise.all([
        this.prisma.wabaOrganisation.findMany({
          where: { ssoOrgId },
          select: { wabaId: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        }),
        this.planLimits.forOrg(ssoOrgId),
        this.orgSettings.clientsOf(ssoOrgId),
        this.prisma.userApiKey.count({ where: { ssoOrgId, status: true } }),
        this.prisma.webhookEndpoint.count({ where: { ssoOrgId } }),
        this.prisma.message.count({
          where: {
            ssoOrgId,
            createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          },
        }),
      ]);

    const wabaIds = wabas.map((w) => w.wabaId);
    const [named, numbers, endpoints, keys, payments] = await Promise.all([
      this.prisma.waba.findMany({
        where: { wabaId: { in: wabaIds } },
        select: { wabaId: true, name: true },
      }),
      wabaIds.length
        ? this.prisma.wabaPhoneNumber.groupBy({
            by: ['wabaId'],
            where: { wabaId: { in: wabaIds } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      wabaIds.length
        ? this.prisma.webhookEndpoint.groupBy({
            by: ['wabaId'],
            where: { ssoOrgId, wabaId: { in: wabaIds } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      wabaIds.length
        ? this.prisma.userApiKey.groupBy({
            by: ['wabaId'],
            // Revoked keys are not held against the ceiling, so they are not
            // counted towards it here either.
            where: { ssoOrgId, wabaId: { in: wabaIds }, status: true },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      subscription
        ? this.prisma.subscriptionPayment.findMany({
            where: { subscriptionId: subscription.id },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: {
              razorpayPaymentId: true,
              status: true,
              amount: true,
              method: true,
              paidAt: true,
            },
          })
        : Promise.resolve<PaymentRow[]>([]),
    ]);

    const clientNames = await Promise.all(
      clients.map(async (id) => ({
        ssoOrgId: id,
        name: await this.orgDirectory.name(id),
      })),
    );

    const nameOf = new Map(named.map((w) => [w.wabaId, w.name] as const));
    const numbersBy = tally(numbers);
    const endpointsBy = tally(endpoints);
    const keysBy = tally(keys);

    return {
      ...row,
      razorpaySubscriptionId: subscription?.razorpaySubscriptionId ?? null,
      currentStart: subscription?.currentStart ?? null,
      cancelAtCycleEnd: subscription?.cancelAtCycleEnd ?? false,
      pendingPlanCode: subscription?.pendingPlan?.code ?? null,
      pendingPlanAt: subscription?.pendingPlanAt ?? null,
      accounts: wabas.map((w) => ({
        wabaId: w.wabaId,
        name: nameOf.get(w.wabaId) ?? null,
        phoneNumbers: numbersBy.get(w.wabaId) ?? 0,
        webhookEndpoints: endpointsBy.get(w.wabaId) ?? 0,
        apiKeys: keysBy.get(w.wabaId) ?? 0,
        connectedAt: w.createdAt,
      })),
      payments: payments.map((p) => ({
        id: p.razorpayPaymentId,
        status: p.status,
        amount: p.amount,
        method: p.method,
        paidAt: p.paidAt,
      })),
      clients: clientNames,
      limits: { ...limits },
      apiKeys,
      webhookEndpoints,
      messagesLast30Days: messages,
    };
  }

  /** The organisation-level subscription, with the plan it names. */
  private liveSubscription(ssoOrgId: string) {
    return this.prisma.subscription.findFirst({
      where: { ssoOrgId, wabaId: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        currentStart: true,
        currentEnd: true,
        cancelAtCycleEnd: true,
        createdAt: true,
        razorpaySubscriptionId: true,
        payerOrgId: true,
        pendingPlanAt: true,
        plan: {
          select: { code: true, name: true, price: true, currency: true },
        },
        pendingPlan: { select: { code: true, name: true } },
      },
    });
  }

  /** Whether a subscription grants access right now — the paywall's own rule. */
  private grants(
    sub: { status: string; currentEnd: Date | null } | null,
  ): boolean {
    if (!sub) return false;
    if (sub.status === 'superseded') return false;
    if (!sub.currentEnd) return false;
    return sub.currentEnd.getTime() > Date.now();
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  async subscriptions(status?: string): Promise<AdminSubscriptionRowDto[]> {
    const rows = await this.prisma.subscription.findMany({
      where: status ? { status: status as never } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        ssoOrgId: true,
        status: true,
        currentEnd: true,
        cancelAtCycleEnd: true,
        razorpaySubscriptionId: true,
        createdAt: true,
        plan: {
          select: { code: true, name: true, price: true, currency: true },
        },
        payments: {
          where: { status: 'captured' },
          orderBy: { paidAt: 'desc' },
          take: 1,
          select: { paidAt: true },
        },
      },
    });

    return Promise.all(
      rows.map(async (row) => ({
        ssoOrgId: row.ssoOrgId,
        organisationName: await this.orgDirectory.name(row.ssoOrgId),
        status: row.status,
        planCode: row.plan?.code ?? null,
        planName: row.plan?.name ?? null,
        price: row.plan?.price ?? null,
        currency: row.plan?.currency ?? 'INR',
        currentEnd: row.currentEnd,
        cancelAtCycleEnd: row.cancelAtCycleEnd,
        razorpaySubscriptionId: row.razorpaySubscriptionId,
        lastPaymentAt: row.payments[0]?.paidAt ?? null,
        createdAt: row.createdAt,
      })),
    );
  }

  // ---------------------------------------------------------------------------
  // Invoices
  // ---------------------------------------------------------------------------

  /**
   * Every invoice raised, newest first, optionally narrowed.
   *
   * Unscoped by design — this is the only place a document can be found
   * without knowing whose it is, which is what "somebody wrote in asking about
   * INV-WAC-2627-0412" needs.
   */
  async invoices(opts: {
    search?: string;
    ssoOrgId?: string;
    page?: number;
  }): Promise<AdminInvoicePageDto> {
    const term = opts.search?.trim();
    const where: Prisma.InvoiceWhereInput = {
      ...(opts.ssoOrgId
        ? {
            // A client's page shows what bought its month, not only what was
            // charged to it — which for an agency's client is neither.
            OR: [
              { ssoOrgId: opts.ssoOrgId },
              { lines: { some: { ssoOrgId: opts.ssoOrgId } } },
            ],
          }
        : {}),
      ...(term
        ? {
            AND: [
              {
                OR: [
                  { number: { contains: term, mode: 'insensitive' } },
                  { organisationName: { contains: term, mode: 'insensitive' } },
                  { billedToEmail: { contains: term, mode: 'insensitive' } },
                  {
                    razorpayPaymentId: { contains: term, mode: 'insensitive' },
                  },
                  { ssoOrgId: { contains: term, mode: 'insensitive' } },
                ],
              },
            ],
          }
        : {}),
    };

    const page = Math.max(1, opts.page ?? 1);
    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { lines: { orderBy: { position: 'asc' } } },
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return {
      invoices: rows.map((invoice) => this.invoices_.toDto(invoice)),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      // What has been raised and never reached anybody. The one number on this
      // screen that is a job rather than a record.
      undelivered: await this.prisma.invoice.count({
        where: { emailedAt: null },
      }),
    };
  }

  /** One invoice, for the operator console. Unscoped, like everything here. */
  async invoice(number: string): Promise<InvoiceWithLines> {
    const invoice = await this.invoices_.find(number);
    if (!invoice) throw new NotFoundException(`No invoice ${number}`);
    return invoice;
  }

  /**
   * Send an invoice again, to the address on it.
   *
   * For the support case this screen exists for: a customer who says it never
   * arrived. It goes to the address recorded on the document, not to one
   * supplied with the request — an operator-triggered send to an arbitrary
   * address is a way to mail somebody else's invoice anywhere.
   */
  async resendInvoice(
    actor: AdminActor,
    number: string,
  ): Promise<{ sent: boolean; to: string | null }> {
    const invoice = await this.invoice(number);
    const sent = await this.invoices_.deliver(invoice);

    await this.audit.record(actor, {
      action: 'invoice.resend',
      targetType: 'invoice',
      targetId: number,
      summary: sent
        ? `Re-sent ${number} to ${invoice.billedToEmail}`
        : `Could not re-send ${number}`,
    });

    return { sent, to: invoice.billedToEmail };
  }

  // ---------------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------------

  async plans(): Promise<AdminPlanDto[]> {
    const [rows, counts] = await Promise.all([
      this.prisma.plan.findMany({
        orderBy: [{ active: 'desc' }, { sortOrder: 'asc' }],
        select: PLAN_SELECT,
      }),
      this.prisma.subscription.groupBy({
        by: ['planRefId'],
        where: { status: { in: [...LIVE_STATUSES] } },
        _count: { _all: true },
      }),
    ]);

    const ids = await this.prisma.plan.findMany({
      select: { id: true, code: true },
    });
    const codeOf = new Map(ids.map((p) => [p.id, p.code] as const));
    const subscribers = new Map<string, number>();
    for (const row of counts) {
      const code = row.planRefId ? codeOf.get(row.planRefId) : undefined;
      if (code) subscribers.set(code, row._count._all);
    }

    return rows.map(({ razorpayPlanId, ...plan }) => ({
      ...plan,
      // Shown so an operator repointing a tier can see what it is pointed at
      // now. It is not a secret — it names a plan at the provider, and the
      // console this is served to is already operator-only.
      razorpayPlanId,
      // A tier with no Razorpay plan cannot be checked out, whatever the price
      // list says about it.
      sellable: Boolean(razorpayPlanId) && plan.active,
      subscribers: subscribers.get(plan.code) ?? 0,
    }));
  }

  /**
   * A new plan, and the provider plan behind it.
   *
   * Both in one call on purpose. A plan row with a price and no provider plan
   * cannot be checked out, and the console would show it as sellable while
   * every attempt to buy it failed — so either both exist or neither does.
   *
   * A quoted plan (`ctaKind: 'contact'`) carries no amount and needs nothing at
   * the provider: it is a card that invites a conversation.
   */
  async createPlan(
    actor: AdminActor,
    dto: CreatePlanDto,
  ): Promise<AdminPlanDto> {
    const existing = await this.prisma.plan.findUnique({
      where: { code: dto.code },
      select: { code: true },
    });
    if (existing) {
      throw new BadRequestException(
        `A plan with code ${dto.code} already exists`,
      );
    }

    const ctaKind = dto.ctaKind ?? (dto.price ? 'subscribe' : 'contact');
    if (ctaKind === 'subscribe' && !dto.price) {
      throw new BadRequestException(
        'A plan that can be subscribed to needs a price. Use ctaKind "contact" for a quoted plan.',
      );
    }
    if (ctaKind === 'contact' && !dto.priceLabel && !dto.price) {
      throw new BadRequestException(
        'A quoted plan needs a priceLabel — it is what the card shows instead of an amount.',
      );
    }

    const currency = (dto.currency ?? 'INR').toUpperCase();

    // Created before the row, so a provider failure leaves nothing behind. The
    // other order leaves a plan nobody can buy and no error explaining why.
    let razorpayPlanId: string | null = null;
    if (ctaKind === 'subscribe' && dto.price) {
      const created = await this.razorpay.createPlan({
        name: dto.name,
        amount: dto.price,
        currency,
        description: dto.audience,
      });
      razorpayPlanId = created.id;
    }

    const plan = await this.prisma.plan.create({
      data: {
        code: dto.code,
        name: dto.name,
        audience: dto.audience,
        price: dto.price ?? null,
        priceLabel: dto.priceLabel ?? null,
        currency,
        unit: dto.unit ?? '/month',
        ssoOrgId: dto.ssoOrgId ?? null,
        ctaKind,
        ctaLabel:
          dto.ctaLabel ??
          (ctaKind === 'subscribe' ? `Choose ${dto.name}` : 'Contact sales'),
        razorpayPlanId,
        additionalWabaPrice: dto.additionalWabaPrice ?? null,
        additionalNumberPrice: dto.additionalNumberPrice ?? null,
        includedWabas: dto.includedWabas ?? null,
        includedPhoneNumbersPerWaba: dto.includedPhoneNumbersPerWaba ?? null,
        includedClients: dto.includedClients ?? null,
        maxTeamMembers: dto.maxTeamMembers ?? null,
        maxWebhookEndpoints: dto.maxWebhookEndpoints ?? null,
        maxApiKeysPerWaba: dto.maxApiKeysPerWaba ?? null,
        maxContacts: dto.maxContacts ?? null,
        maxMessagesPerMinute: dto.maxMessagesPerMinute ?? null,
        historyDays: dto.historyDays ?? null,
        rank: dto.rank ?? 0,
        sortOrder: dto.sortOrder ?? 0,
        // Never on creation. A new tier becoming the highlighted one is a
        // separate decision, made with the price list in front of you.
        recommended: false,
        active: true,
      },
      select: PLAN_SELECT,
    });

    await this.audit.record(actor, {
      action: 'plan.created',
      targetType: 'plan',
      targetId: plan.code,
      summary: dto.ssoOrgId
        ? `Created ${plan.name}, private to ${dto.ssoOrgId}`
        : `Created ${plan.name} on the public price list`,
      after: {
        price: plan.price,
        currency: plan.currency,
        ssoOrgId: plan.ssoOrgId,
        ctaKind: plan.ctaKind,
      },
    });

    return (await this.plans()).find((p) => p.code === plan.code)!;
  }

  async updatePlan(
    actor: AdminActor,
    code: string,
    dto: UpdatePlanDto,
  ): Promise<AdminPlanDto> {
    const current = await this.prisma.plan.findUnique({
      where: { code },
      select: PLAN_SELECT,
    });
    if (!current) throw new NotFoundException(`No plan ${code}`);

    // Checked before anything is written. A tier pointed at the wrong provider
    // plan charges the wrong amount, and the first anybody would know is a
    // customer's bank statement.
    if (
      dto.razorpayPlanId !== undefined &&
      dto.razorpayPlanId !== current.razorpayPlanId
    ) {
      await this.assertProviderPlanMatches(dto.razorpayPlanId, current);
    }

    const patch: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    for (const field of EDITABLE) {
      const value = (dto as Record<string, unknown>)[field];
      if (value === undefined) continue;
      const existing = (current as Record<string, unknown>)[field];
      if (value === existing) continue;
      patch[field] = value;
      before[field] = existing;
      after[field] = value;
    }

    if (Object.keys(patch).length === 0) {
      return (await this.plans()).find((p) => p.code === code)!;
    }

    // Only one plan is highlighted, so setting this has to clear the others —
    // two recommended tiers is a pricing page that recommends nothing.
    if (patch.recommended === true) {
      await this.prisma.plan.updateMany({
        where: { recommended: true, NOT: { code } },
        data: { recommended: false },
      });
    }

    await this.prisma.plan.update({ where: { code }, data: patch });

    await this.audit.record(actor, {
      action: 'plan.updated',
      targetType: 'plan',
      targetId: code,
      summary: `Updated ${Object.keys(patch).join(', ')} on ${current.name}`,
      before: before as never,
      after: after as never,
    });

    return (await this.plans()).find((p) => p.code === code)!;
  }

  /**
   * That a provider plan exists and agrees with what this tier says it costs.
   *
   * Both halves matter. An id that does not resolve leaves a tier the console
   * shows as sellable and every checkout refuses; one that resolves to a
   * different amount is worse, because nothing looks wrong until somebody is
   * charged it.
   */
  private async assertProviderPlanMatches(
    razorpayPlanId: string,
    plan: { name: string; price: number | null; currency: string },
  ): Promise<void> {
    const remote = await this.razorpay.fetchPlan(razorpayPlanId);
    if (!remote) {
      throw new BadRequestException(
        `No plan ${razorpayPlanId} at the payment provider, or it could not be read. Nothing has been changed.`,
      );
    }

    if (plan.price !== null && remote.item.amount !== plan.price) {
      throw new BadRequestException(
        `${razorpayPlanId} charges ${remote.item.amount} and ${plan.name} is priced at ${plan.price}. ` +
          'Point it at a plan for the same amount, or reprice the tier by creating a new one.',
      );
    }

    const currency = remote.item.currency?.toUpperCase();
    if (currency && currency !== plan.currency.toUpperCase()) {
      throw new BadRequestException(
        `${razorpayPlanId} is in ${currency} and ${plan.name} is in ${plan.currency}.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Agency
  // ---------------------------------------------------------------------------

  async convert(
    actor: AdminActor,
    ssoOrgId: string,
    isAgency: boolean,
  ): Promise<{ ssoOrgId: string; isAgency: boolean }> {
    const result = await this.agency.convert(ssoOrgId, isAgency, actor.id);
    await this.audit.record(actor, {
      action: isAgency ? 'organisation.made_agency' : 'organisation.demoted',
      targetType: 'organisation',
      targetId: ssoOrgId,
      summary: isAgency
        ? `Made ${ssoOrgId} an agency`
        : `Removed agency status from ${ssoOrgId}`,
      after: { isAgency },
    });
    return result;
  }

  async attachClient(
    actor: AdminActor,
    agencyOrgId: string,
    ssoOrgId: string,
    clientName?: string,
  ) {
    const result = await this.agency.attachClient(
      agencyOrgId,
      ssoOrgId,
      clientName,
    );
    await this.audit.record(actor, {
      action: 'organisation.client_attached',
      targetType: 'organisation',
      targetId: ssoOrgId,
      // The billing consequence, not just the relationship: this is the line
      // somebody reads when they ask why an invoice moved.
      summary: `${agencyOrgId} now pays for ${ssoOrgId}`,
      after: { agencyOrgId, clientName: clientName ?? null },
    });
    return result;
  }

  async detachClient(
    actor: AdminActor,
    agencyOrgId: string,
    ssoOrgId: string,
  ): Promise<void> {
    await this.agency.detachClient(agencyOrgId, ssoOrgId);
    await this.audit.record(actor, {
      action: 'organisation.client_detached',
      targetType: 'organisation',
      targetId: ssoOrgId,
      summary: `${ssoOrgId} no longer billed to ${agencyOrgId}`,
      before: { agencyOrgId },
    });
  }

  // ---------------------------------------------------------------------------
  // Who else may use this console
  // ---------------------------------------------------------------------------

  async admins(): Promise<AdminUserDto[]> {
    const rows = await this.prisma.user.findMany({
      where: { isAdmin: true },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isAdmin: true,
        createdAt: true,
      },
    });
    return rows.map((u) => this.toUser(u));
  }

  /** Somebody to grant it to. Searched, never listed — this is not a directory. */
  async findUsers(search: string): Promise<AdminUserDto[]> {
    const term = search.trim();
    if (term.length < 3) return [];

    const rows = await this.prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: term, mode: 'insensitive' } },
          { firstName: { contains: term, mode: 'insensitive' } },
          { lastName: { contains: term, mode: 'insensitive' } },
        ],
      },
      take: 10,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isAdmin: true,
        createdAt: true,
      },
    });
    return rows.map((u) => this.toUser(u));
  }

  /**
   * Grant or remove access to this console.
   *
   * Two refusals, both of them about the same failure: an estate with nobody
   * who can administer it. You cannot demote yourself — the mistake is one
   * click and the recovery is a database session — and you cannot remove the
   * last admin, however it is attempted.
   */
  async setAdmin(
    actor: AdminActor,
    userId: number,
    isAdmin: boolean,
  ): Promise<AdminUserDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isAdmin: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException(`No user ${userId}`);

    if (!isAdmin && user.id === actor.id) {
      throw new BadRequestException(
        'You cannot remove your own admin access. Ask another admin to do it.',
      );
    }

    if (!isAdmin && user.isAdmin) {
      const remaining = await this.prisma.user.count({
        where: { isAdmin: true, NOT: { id: userId } },
      });
      if (remaining === 0) {
        throw new BadRequestException(
          'This is the only admin. Grant somebody else access first.',
        );
      }
    }

    if (user.isAdmin === isAdmin) return this.toUser(user);

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { isAdmin },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isAdmin: true,
        createdAt: true,
      },
    });

    await this.audit.record(actor, {
      action: isAdmin ? 'admin.granted' : 'admin.revoked',
      targetType: 'user',
      targetId: String(userId),
      summary: `${isAdmin ? 'Granted' : 'Revoked'} admin for ${user.email ?? `user ${userId}`}`,
      before: { isAdmin: user.isAdmin },
      after: { isAdmin },
    });

    return this.toUser(updated);
  }

  private toUser(u: {
    id: number;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    isAdmin: boolean;
    createdAt: Date;
  }): AdminUserDto {
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
    return {
      id: u.id,
      email: u.email,
      name: name || null,
      isAdmin: u.isAdmin,
      createdAt: u.createdAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  async auditLog(page = 1): Promise<AdminAuditPageDto> {
    const current = Math.max(1, page);
    const [entries, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (current - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          actorUserId: true,
          actorEmail: true,
          action: true,
          targetType: true,
          targetId: true,
          summary: true,
          createdAt: true,
        },
      }),
      this.prisma.adminAuditLog.count(),
    ]);

    return {
      entries,
      total,
      page: current,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    };
  }
}
