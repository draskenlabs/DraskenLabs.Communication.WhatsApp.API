import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  Prisma,
  Subscription,
  SubscriptionPayment,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import {
  RazorpayPayment,
  RazorpayService,
  RazorpaySubscription,
} from './razorpay.service';
import { SubscriptionAccessService } from './subscription-access.service';
import { OrganisationSettingsService } from 'src/organisation-settings/organisation-settings.service';
import { CLOUD_API_PLATFORM } from 'src/waba-phone-number/waba-phone-number.service';
import { WabaProvisioningService } from 'src/provisioning/waba-provisioning.service';
import {
  ConfirmSubscriptionDto,
  CoveredAccountDto,
  PendingAuthorisationDto,
  SubscriptionPaymentDto,
  SubscriptionPlanDto,
  SubscriptionRegisteredDto,
  SubscriptionStateDto,
  SubscriptionUsageDto,
} from './dto/billing.dto';
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { OrgService } from 'src/org/org.service';
import { AgencyBillingService } from './agency-billing.service';
import { InvoiceService } from './invoice.service';
import { OrgDirectoryService } from 'src/org/org-directory.service';

/** Razorpay's status strings, which are also ours. Anything else is ignored. */
const STATUSES = new Set<string>([
  'created',
  'authenticated',
  'active',
  'pending',
  'halted',
  'cancelled',
  'completed',
  'expired',
]);

/** What an organisation with nothing connected uses, before any plan applies. */
const EMPTY_USAGE: SubscriptionUsageDto = {
  wabas: 0,
  phoneNumbers: 0,
  includedWabas: null,
  includedPhoneNumbersPerWaba: null,
  additionalWabaPrice: null,
  additionalNumberPrice: null,
  clients: null,
  includedClients: null,
  contacts: 0,
  maxContacts: null,
  webhookEndpoints: 0,
  maxWebhookEndpointsPerWaba: null,
  apiKeys: 0,
  maxApiKeysPerWaba: null,
  teamMembers: null,
  maxTeamMembers: null,
  maxMessagesPerMinute: null,
  historyDays: null,
};

/** Unix seconds to a Date, tolerating the nulls Razorpay sends before a charge. */
function at(seconds: number | null | undefined): Date | null {
  return seconds ? new Date(seconds * 1000) : null;
}

/**
 * Enough of the instrument to recognise it, and no more.
 *
 * "Visa ···· 4242" tells the customer which card was debited. The number, the
 * token and everything else stay at Razorpay — there is nothing here worth
 * stealing and nothing that could be replayed.
 */
function describeMethod(payment: RazorpayPayment): string | null {
  if (payment.card?.last4) {
    const network = payment.card.network ?? payment.card.issuer ?? 'Card';
    return `${network} ···· ${payment.card.last4}`;
  }
  if (payment.vpa) return payment.vpa;
  if (payment.bank) return payment.bank;
  if (payment.wallet) return payment.wallet;
  return null;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly razorpay: RazorpayService,
    private readonly mail: MailNotifications,
    private readonly access: SubscriptionAccessService,
    private readonly provisioning: WabaProvisioningService,
    private readonly orgSettings: OrganisationSettingsService,
    private readonly planLimits: PlanLimitsService,
    // Seats are the SSO's to count, not ours. Read here so the billing page
    // can show the allowance it sells against what is actually taken.
    private readonly org: OrgService,
    // An agency's mandate covers several clients at once; its webhooks reach
    // no single subscription and are applied through here.
    private readonly agencyBilling: AgencyBillingService,
    // Every captured debit leaves a numbered document behind. Raised here
    // because this is where a payment is known to have been captured.
    private readonly invoices: InvoiceService,
    private readonly orgDirectory: OrgDirectoryService,
  ) {}

  /**
   * The organisation's subscription.
   *
   * One per organisation, covering every account it has connected. It used to
   * be one per account, which made the price list incoherent: the card said
   * "per WABA per month" while the limit on it counted the organisation's
   * accounts, so a customer with three was told to buy Growth three times to
   * get a limit of three.
   *
   * `wabaId: null` is what makes a row the organisation's. The rows that still
   * carry one are history — a subscription whose account was deleted, or one
   * superseded when the migration collapsed the per-account ones.
   */
  private find(ssoOrgId: string) {
    return this.prisma.subscription.findFirst({
      where: { ssoOrgId, wabaId: null },
      include: {
        plan: { select: { code: true, name: true } },
        pendingPlan: { select: { code: true, name: true } },
      },
    });
  }

  /**
   * The tier being bought, checked against what can actually be charged.
   *
   * Null for a request that names no plan: a deployment with a single
   * configured Razorpay plan carries on exactly as it did.
   */
  private async sellablePlan(planCode?: string, ssoOrgId?: string) {
    if (!planCode) return null;

    const plan = await this.prisma.plan.findFirst({
      // A private plan is only sellable to the organisation it was written for.
      // Without the match, knowing a code would be enough to buy somebody
      // else's negotiated rate.
      where: {
        code: planCode,
        active: true,
        OR: [{ ssoOrgId: null }, ...(ssoOrgId ? [{ ssoOrgId }] : [])],
      },
      select: {
        id: true,
        name: true,
        code: true,
        ctaKind: true,
        razorpayPlanId: true,
        // Read here so a change of tier can tell an upgrade from a downgrade
        // without a second query.
        price: true,
      },
    });
    if (!plan) throw new NotFoundException(`Plan ${planCode} is not on offer`);

    // The public Custom and Agency cards are marketing, not products: they
    // carry no numbers and no Razorpay plan. A signed deal is a row of its own,
    // scoped to the organisation and marked `subscribe`, so it checks out here
    // like any other tier.
    if (plan.ctaKind === 'contact') {
      throw new BadRequestException(
        `${plan.name} is priced individually — contact sales rather than subscribing here.`,
      );
    }
    // A tier with no Razorpay plan behind it cannot be debited. Better to say
    // so than to sell it against the default plan at the wrong price.
    if (!plan.razorpayPlanId) {
      throw new BadRequestException(
        `${plan.name} is not available for checkout on this deployment yet.`,
      );
    }
    return plan;
  }

  private toState(
    sub:
      | (Subscription & {
          plan?: { code: string; name: string } | null;
          pendingPlan?: { code: string; name: string } | null;
        })
      | null,
    extras: {
      plan?: SubscriptionPlanDto | null;
      payments?: SubscriptionPaymentDto[];
      covers?: CoveredAccountDto[];
      usage?: SubscriptionUsageDto;
      payerName?: string | null;
      pendingAuthorisation?: PendingAuthorisationDto | null;
    } = {},
  ): SubscriptionStateDto {
    const awaiting =
      !!sub && (sub.status === 'created' || sub.status === 'authenticated');
    const payments = extras.payments ?? [];
    const covers = extras.covers ?? [];

    return {
      active: SubscriptionAccessService.grants(sub),
      covers,
      usage: extras.usage ?? EMPTY_USAGE,
      payerOrgId: sub?.payerOrgId ?? null,
      payerName: extras.payerName ?? null,
      status: sub?.status ?? null,
      currentStart: sub?.currentStart ?? null,
      currentEnd: sub?.currentEnd ?? null,
      cancelAtCycleEnd: sub?.cancelAtCycleEnd ?? false,
      // Only worth offering while there is nothing to charge against: once the
      // mandate exists, Checkout has nothing left to authorise.
      subscriptionId: awaiting ? sub.razorpaySubscriptionId : null,
      authorisationUrl: awaiting ? sub.shortUrl : null,
      keyId:
        awaiting || extras.pendingAuthorisation
          ? (this.razorpay.keyId ?? null)
          : null,
      billingEnabled: this.razorpay.isConfigured(),
      // Which published tier this is. Null for a subscription taken out before
      // the price list existed, which the boot-time adoption could not match
      // to a tier; `plan` below still says what it costs.
      planCode: sub?.plan?.code ?? null,
      planName: sub?.plan?.name ?? null,
      // A tier chosen but not yet in force. Shown as "Starter from 14
      // September" rather than applied early: the customer paid for the month
      // they are in, and it is the tier above that they paid for.
      pendingPlanCode: sub?.pendingPlan?.code ?? null,
      pendingPlanName: sub?.pendingPlan?.name ?? null,
      pendingPlanAt: sub?.pendingPlanAt ?? null,
      plan: extras.plan ?? null,
      lastPayment: payments[0] ?? null,
      payments,
      // The renewal date *is* the next debit, until there is not going to be
      // one: a cancelled subscription runs to the end of the month already
      // paid for and then stops, so showing a date would be a lie.
      nextChargeAt:
        sub && !sub.cancelAtCycleEnd && !this.isFinished(sub)
          ? sub.currentEnd
          : null,
      paidCount: payments.filter((p) => p.status === 'captured').length,
      pendingAuthorisation: extras.pendingAuthorisation ?? null,
    };
  }

  /**
   * The stored debits for a subscription, newest first.
   *
   * Each carries the number of the invoice raised for it, so the console can
   * link the document rather than making somebody go looking for the email it
   * arrived in. Null on a payment taken before invoicing shipped, and on one
   * that was never captured.
   */
  private async paymentsFor(
    subscriptionId: number | undefined,
  ): Promise<SubscriptionPaymentDto[]> {
    if (!subscriptionId) return [];
    const payments = await this.prisma.subscriptionPayment.findMany({
      where: { subscriptionId },
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
      take: 12,
      select: {
        razorpayPaymentId: true,
        razorpayInvoiceId: true,
        amount: true,
        currency: true,
        status: true,
        method: true,
        methodDetail: true,
        paidAt: true,
        invoice: { select: { number: true } },
      },
    });

    return payments.map(({ invoice, ...payment }) => ({
      ...payment,
      invoiceNumber: invoice?.number ?? null,
    }));
  }

  /**
   * The organisation's subscription, and what it covers.
   *
   * Answers even when there is none: the console's job is to say whether the
   * organisation is paid up and to offer a tier if it is not, and an empty
   * response would read as an error rather than as "not subscribed".
   *
   * The accounts come back whether or not anything is paid, because nothing
   * here is a cap. An organisation may connect as many accounts and numbers as
   * it likes; what the plan decides is how many are included and what the rest
   * cost, so the console shows a price for the next one rather than a refusal.
   */
  async state(
    ssoOrgId: string,
    authorization?: string,
  ): Promise<SubscriptionStateDto> {
    return this.stateOf(ssoOrgId, await this.find(ssoOrgId), authorization);
  }

  /**
   * The same answer from a subscription already in hand.
   *
   * Every write path ends by reporting the new state, and re-reading the row it
   * has just written would be a query for something it knows — and, worse, a
   * chance for a replica to answer with the version from before the write.
   */
  private async stateOf(
    ssoOrgId: string,
    sub:
      | (Subscription & {
          plan?: { code: string; name: string } | null;
          pendingPlan?: { code: string; name: string } | null;
        })
      | null,
    /**
     * The caller's bearer token, when there is one. Only the team-member count
     * needs it, and only the console's own request carries one — the webhook
     * and write paths reach here without a session, and report that count as
     * unknown rather than as zero.
     */
    authorization?: string,
  ): Promise<SubscriptionStateDto> {
    const [covers, limits, settings, contacts] = await Promise.all([
      this.coveredAccounts(ssoOrgId),
      this.planLimits.forOrg(ssoOrgId),
      this.orgSettings.get(ssoOrgId),
      this.prisma.contact.count({ where: { ssoOrgId } }),
    ]);

    // Counted for the organisation being looked at, which is how the limit is
    // applied: a client of an agency has its own contacts measured against the
    // agency's allowance, not the agency's total across every client.
    const clients = settings.isAgency
      ? (await this.orgSettings.clientsOf(ssoOrgId)).length
      : null;

    const teamMembers = authorization
      ? await this.teamMemberCount(ssoOrgId, authorization)
      : null;

    const pendingAuthorisation = sub?.pendingRazorpaySubscriptionId
      ? {
          subscriptionId: sub.pendingRazorpaySubscriptionId,
          authorisationUrl: sub.pendingShortUrl,
          planCode: sub.pendingPlan?.code ?? null,
          planName: sub.pendingPlan?.name ?? null,
          prorationAmount: null,
        }
      : null;

    // Named where we know it, so the page can say "paid by Northwind Digital"
    // rather than an opaque id.
    const payerName = sub?.payerOrgId
      ? await this.orgDirectory.name(sub.payerOrgId)
      : null;

    return this.toState(sub, {
      payerName,
      plan: sub ? await this.plan(sub.planId) : null,
      payments: await this.paymentsFor(sub?.id),
      covers,
      usage: {
        wabas: covers.length,
        phoneNumbers: covers.reduce((sum, w) => sum + w.phoneNumbers, 0),
        includedWabas: limits.includedWabas,
        includedPhoneNumbersPerWaba: limits.includedPhoneNumbersPerWaba,
        additionalWabaPrice: limits.additionalWabaPrice,
        additionalNumberPrice: limits.additionalNumberPrice,
        clients,
        includedClients: limits.includedClients,
        contacts,
        maxContacts: limits.contacts,
        webhookEndpoints: covers.reduce(
          (sum, w) => sum + w.webhookEndpoints,
          0,
        ),
        maxWebhookEndpointsPerWaba: limits.webhookEndpoints,
        apiKeys: covers.reduce((sum, w) => sum + w.apiKeys, 0),
        maxApiKeysPerWaba: limits.apiKeysPerWaba,
        teamMembers,
        maxTeamMembers: limits.teamMembers,
        maxMessagesPerMinute: limits.messagesPerMinute,
        historyDays: limits.historyDays,
      },
      pendingAuthorisation,
    });
  }

  /**
   * Members plus pending invitations, or null if the SSO could not be asked.
   *
   * The only count on this page that does not live in our database. It is
   * never allowed to fail the request: a billing page that 500s because the
   * SSO is slow would hide the payment state over a line about seat usage, so
   * an unreachable SSO reports "unknown" and the console shows the allowance
   * without a figure against it.
   *
   * An invitation counts, because it is a seat somebody is about to take —
   * which is exactly how `inviteMember` counts it when it refuses.
   */
  private async teamMemberCount(
    ssoOrgId: string,
    authorization: string,
  ): Promise<number | null> {
    try {
      // The SSO client is untyped, so both answers arrive as `any`. Narrowed
      // here rather than trusted: a shape we did not expect is "unknown", not
      // a count.
      const [members, invitations] = await Promise.all([
        this.org.listMembers(ssoOrgId, authorization),
        this.org.listInvitations(ssoOrgId, authorization),
      ]);
      if (!Array.isArray(members)) return null;
      return (
        members.length + (Array.isArray(invitations) ? invitations.length : 0)
      );
    } catch (err) {
      this.logger.warn(
        `Could not read team members for ${ssoOrgId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Every account in the organisation, with how many numbers each carries.
   *
   * Two queries rather than one per account: this is on the billing page, and
   * the count is what the add-on is charged from.
   */
  private async coveredAccounts(
    ssoOrgId: string,
  ): Promise<CoveredAccountDto[]> {
    const wabas = await this.prisma.waba.findMany({
      where: { WabaOrganisation: { some: { ssoOrgId } } },
      select: { wabaId: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    if (wabas.length === 0) return [];

    const wabaIds = wabas.map((w) => w.wabaId);

    // Grouped rather than one query per account: this is the billing page, and
    // the counts are what the meters and the add-on charge are read from.
    const [numbers, endpoints, keys] = await Promise.all([
      this.prisma.wabaPhoneNumber.groupBy({
        by: ['wabaId'],
        where: { wabaId: { in: wabaIds } },
        _count: { _all: true },
      }),
      this.prisma.webhookEndpoint.groupBy({
        by: ['wabaId'],
        where: { ssoOrgId, wabaId: { in: wabaIds } },
        _count: { _all: true },
      }),
      // Revoked keys are not held against the ceiling, so they are not counted
      // towards it here either — the enforcement filters on `status` too.
      this.prisma.userApiKey.groupBy({
        by: ['wabaId'],
        where: { ssoOrgId, wabaId: { in: wabaIds }, status: true },
        _count: { _all: true },
      }),
    ]);

    const tally = (
      rows: { wabaId: string | null; _count: { _all: number } }[],
    ): Map<string, number> =>
      new Map(
        rows
          .filter((r): r is { wabaId: string; _count: { _all: number } } =>
            Boolean(r.wabaId),
          )
          .map((r) => [r.wabaId, r._count._all] as const),
      );

    const numbersBy = tally(numbers);
    const endpointsBy = tally(endpoints);
    const keysBy = tally(keys);

    return wabas.map((waba) => ({
      wabaId: waba.wabaId,
      name: waba.name,
      phoneNumbers: numbersBy.get(waba.wabaId) ?? 0,
      webhookEndpoints: endpointsBy.get(waba.wabaId) ?? 0,
      apiKeys: keysBy.get(waba.wabaId) ?? 0,
    }));
  }

  /**
   * What a subscription costs, in the shape the console shows it.
   *
   * Read per subscription rather than once for the deployment: with more than
   * one tier on sale, a single price would show a Growth customer the Starter
   * amount. Falls back to the configured plan when no id is given.
   *
   * Null rather than an error when Razorpay cannot be reached: the page's job
   * is to say whether an account is paid for, and it can still do that without
   * a price.
   */
  private async plan(planId?: string): Promise<SubscriptionPlanDto | null> {
    const plan = await this.razorpay.fetchPlan(planId);
    if (!plan) return null;

    return {
      planId: plan.id,
      name: plan.item?.name ?? null,
      amount: plan.item?.amount ?? 0,
      currency: plan.item?.currency ?? 'INR',
      period: plan.period,
      interval: plan.interval,
    };
  }

  /**
   * Start the organisation's subscription: a Razorpay customer, a monthly
   * subscription against the chosen tier, and the hosted page where the
   * customer authorises the mandate. Nothing is charged until they do.
   *
   * One subscription covers every account the organisation has connected, and
   * accounts past what the tier includes are billed as add-ons rather than
   * refused. Subscribing is therefore something an organisation does once,
   * before or after connecting anything.
   *
   * @param planCode The tier, from `GET /plans` or from `GET /plans/mine`
   * where the organisation has one negotiated for it.
   */
  async register(
    userId: number,
    ssoOrgId: string,
    planCode: string,
  ): Promise<SubscriptionRegisteredDto> {
    if (!this.razorpay.isConfigured()) {
      throw new BadRequestException(
        'Payments are not configured on this deployment',
      );
    }

    // Checked before anything is created at Razorpay: a bad tier must fail
    // without leaving a customer or a half-made subscription behind.
    const plan = await this.sellablePlan(planCode, ssoOrgId);
    if (!plan) throw new BadRequestException('A plan is required');
    const existing = await this.find(ssoOrgId);

    // A client inherits its agency's subscription. Letting it buy one of its
    // own would charge twice for the same entitlement, and leave the agency
    // wondering why its client's usage stopped counting against the deal.
    const payer = await this.orgSettings.billingOrgFor(ssoOrgId);
    if (payer !== ssoOrgId) {
      throw new BadRequestException(
        'This organisation is billed through its agency, which holds the subscription.',
      );
    }

    // Registering again while one is running would leave two mandates against
    // the organisation, and two debits a month.
    if (existing && !this.isFinished(existing)) {
      if (existing.cancelAtCycleEnd) {
        throw new BadRequestException(
          'This subscription is set to end at the close of the paid month. It cannot be replaced until then.',
        );
      }
      throw new BadRequestException(
        'This organisation already has a subscription. Change its tier rather than starting another.',
      );
    }

    // Read the name and email from our own user row. The request only carries
    // an id and an SSO id — everything else was copied from SSO at sign-in and
    // lives here, which is why the first customers reached Razorpay blank.
    const profile = await this.profileFor(userId);

    // One Razorpay customer per organisation, so a customer paying for three
    // accounts still has one payment history rather than three. Razorpay
    // dedupes by email across the merchant account, so one person running two
    // organisations gets one customer for both whatever we ask for; the
    // subscription's notes are what tie a payment back to an organisation.
    const reused =
      existing?.razorpayCustomerId ?? (await this.orgCustomerId(ssoOrgId));

    if (reused) {
      // The customer may predate having a name to give it.
      await this.razorpay.updateCustomer(reused, profile);
    }

    const customerId =
      reused ??
      (
        await this.razorpay.createCustomer({
          ...profile,
          notes: { ssoOrgId },
        })
      ).id;

    // The organisation and the tier travel on the subscription so a webhook —
    // or a support question against Razorpay's dashboard — can be traced back
    // even if the local row were lost.
    const created = await this.razorpay.createSubscription({
      customerId,
      planId: plan.razorpayPlanId!,
      notes: { ssoOrgId, userId: String(userId), planCode: plan.code },
    });

    const data = {
      razorpayCustomerId: customerId,
      razorpaySubscriptionId: created.id,
      // What Razorpay says it will charge, and which published tier that was
      // sold as. The first is the record of the agreement; the second is how
      // the console names it.
      planId: created.plan_id,
      planRefId: plan.id,
      status: this.toStatus(created.status),
      currentStart: at(created.current_start),
      currentEnd: at(created.current_end),
      cancelAtCycleEnd: false,
      cancelledAt: null,
      shortUrl: created.short_url ?? null,
      createdByUserId: userId,
    };

    // `upsert` cannot be used here: the row is identified by "this
    // organisation, no account", and Prisma has no unique input for a null.
    // The constraint that enforces it is the partial index in the database.
    if (existing) {
      await this.prisma.subscription.update({
        where: { id: existing.id },
        data,
      });
    } else {
      await this.prisma.subscription.create({
        data: { ssoOrgId, wabaId: null, ...data },
      });
    }
    await this.access.invalidatePayer(ssoOrgId);

    return {
      // Checkout opens against the subscription itself; the hosted page stays
      // in the response as a fallback for a browser that cannot run it.
      subscriptionId: created.id,
      keyId: this.razorpay.keyId ?? '',
      authorisationUrl: created.short_url ?? '',
      status: data.status,
      planCode: plan.code,
      // A first subscription has no month behind it to make up.
      prorationAmount: null,
    };
  }

  /**
   * Record the mandate Checkout just authorised.
   *
   * The browser reports its own success, so the signature is checked before
   * anything is written — otherwise a crafted request would mark a
   * subscription paid. The state itself is then taken from Razorpay rather
   * than from the browser: the payload says a mandate exists, not what period
   * it bought.
   *
   * This duplicates what `subscription.authenticated` and `charged` will say,
   * on purpose. Waiting for a webhook would leave the customer looking at
   * "awaiting authorisation" seconds after paying.
   */
  async confirm(
    ssoOrgId: string,
    dto: ConfirmSubscriptionDto,
  ): Promise<SubscriptionStateDto> {
    const sub = await this.find(ssoOrgId);

    if (!sub) throw new NotFoundException('No subscription to confirm');

    // Two subscriptions can be awaiting authorisation at once: the one the
    // organisation holds, and the one an upgrade created. The id decides which
    // this payment is for, and a valid signature for somebody else's
    // subscription must not pass for either.
    const upgrading =
      !!sub.pendingRazorpaySubscriptionId &&
      dto.razorpaySubscriptionId === sub.pendingRazorpaySubscriptionId;
    if (
      !upgrading &&
      dto.razorpaySubscriptionId !== sub.razorpaySubscriptionId
    ) {
      throw new BadRequestException(
        'That payment belongs to another subscription',
      );
    }

    const verified = this.razorpay.verifyCheckoutSignature({
      paymentId: dto.razorpayPaymentId,
      subscriptionId: dto.razorpaySubscriptionId,
      signature: dto.razorpaySignature,
    });

    if (!verified) {
      this.logger.warn(
        `Rejected an unverified checkout confirmation for ${dto.razorpaySubscriptionId}`,
      );
      throw new BadRequestException('Payment could not be verified');
    }

    const promoted = upgrading ? await this.promoteUpgrade(sub) : sub;

    const remote = await this.razorpay.fetchSubscription(
      this.ownMandate(promoted),
    );
    const updated = await this.applyRemote(promoted, remote);

    await this.access.invalidatePayer(ssoOrgId);
    return this.stateOf(ssoOrgId, updated);
  }

  /**
   * The upgrade is authorised: make it the organisation's subscription, and
   * stop the old one.
   *
   * Cancelled at the end of its cycle rather than now, because the customer
   * paid for that month and the new subscription only starts charging where it
   * ends. Cancelling immediately would take the month away and leave a gap
   * nobody bought.
   *
   * The old mandate failing to cancel is logged, not thrown: the customer has
   * authorised the new one and is entitled to it, and refusing here would tell
   * them their payment failed when it did not. A subscription still live at
   * Razorpay shows up in the reconciliation sweep.
   */
  private async promoteUpgrade(
    sub: Subscription & {
      plan?: { code: string; name: string } | null;
      pendingPlan?: { code: string; name: string } | null;
    },
  ) {
    try {
      await this.razorpay.cancelSubscription(this.ownMandate(sub), true);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Upgrade authorised for ${sub.ssoOrgId}, but the old subscription ` +
          `${sub.razorpaySubscriptionId} could not be cancelled: ${detail}`,
      );
    }

    return this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        razorpaySubscriptionId: sub.pendingRazorpaySubscriptionId!,
        shortUrl: sub.pendingShortUrl,
        // The tier chosen is now the tier held.
        planRefId: sub.pendingPlanRefId,
        pendingRazorpaySubscriptionId: null,
        pendingShortUrl: null,
        pendingPlanRefId: null,
        pendingPlanAt: null,
        cancelAtCycleEnd: false,
        cancelledAt: null,
      },
      include: {
        plan: { select: { code: true, name: true } },
        pendingPlan: { select: { code: true, name: true } },
      },
    });
  }

  /**
   * Write Razorpay's version of a subscription over ours. The one writer for
   * webhooks, checkout confirmations and the reconciliation sweep alike, so
   * the three cannot drift apart.
   *
   * `currentEnd` never moves backwards: events and polls can arrive out of
   * order, and a stale read must not shorten a month a charge already paid for.
   */
  private async applyRemote(
    sub: Subscription,
    remote: RazorpaySubscription,
  ): Promise<
    Subscription & {
      plan: { code: string; name: string } | null;
      pendingPlan: { code: string; name: string } | null;
    }
  > {
    const status = this.toStatus(remote.status);
    const currentEnd = at(remote.current_end);
    // Razorpay is the ledger: if the plan being charged has moved — a change
    // scheduled for the renewal that has now happened, or one made in their
    // dashboard — the tier here follows it rather than the other way round.
    const tier = await this.tierFor(sub, remote.plan_id);

    const updated = await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status,
        currentStart: at(remote.current_start) ?? sub.currentStart,
        currentEnd:
          currentEnd && (!sub.currentEnd || currentEnd > sub.currentEnd)
            ? currentEnd
            : sub.currentEnd,
        cancelledAt:
          status === 'cancelled'
            ? (sub.cancelledAt ?? new Date())
            : sub.cancelledAt,
        // Once there is a mandate the authorisation page is dead.
        shortUrl: status === 'created' ? sub.shortUrl : null,
        ...tier,
      },
      // The updated row is what the caller reports back, so it has to carry
      // the tier: without this, confirming a Growth subscription answered with
      // no plan on it and the console lost the name until the next reload.
      include: {
        plan: { select: { code: true, name: true } },
        pendingPlan: { select: { code: true, name: true } },
      },
    });

    await this.provisionIfNewlyPaid(sub, updated);
    return updated;
  }

  /**
   * The tier columns to write, given the plan Razorpay says it is charging.
   *
   * Nothing changes while the plan id is the one we already recorded, which is
   * every ordinary renewal. When it has moved, the published tier that owns
   * that Razorpay plan becomes the current one and any pending change is
   * settled — whether or not the change is the one we scheduled, because the
   * customer is being charged for it either way.
   */
  private async tierFor(
    sub: Subscription,
    remotePlanId: string | undefined,
  ): Promise<Prisma.SubscriptionUpdateInput | Record<string, never>> {
    if (!remotePlanId || remotePlanId === sub.planId) {
      // A pending change whose date has passed without the plan moving is
      // left alone: Razorpay applies it at the renewal, and until then the
      // customer is on what they are paying for.
      return {};
    }

    const plan = await this.prisma.plan.findFirst({
      where: { razorpayPlanId: remotePlanId },
      select: { id: true, code: true },
    });

    if (!plan) {
      // A plan id no published tier claims — an old single-plan deployment, or
      // one wired up in the Razorpay dashboard by hand. Record what is charged
      // and leave the tier alone rather than guessing at one.
      this.logger.warn(
        `Subscription ${sub.razorpaySubscriptionId} moved to Razorpay plan ${remotePlanId}, which no published tier claims`,
      );
      return { planId: remotePlanId };
    }

    this.logger.log(
      `Subscription ${sub.razorpaySubscriptionId} is now charged on ${plan.code}`,
    );
    return {
      planId: remotePlanId,
      plan: { connect: { id: plan.id } },
      pendingPlan: { disconnect: true },
      pendingPlanAt: null,
    };
  }

  /**
   * Fill the organisation's accounts in the first time it is paid for.
   *
   * Connecting deliberately syncs nothing, so this is what turns a connected
   * account into a working one. It fires on the edge — not-granting to granting
   * — so a renewal, a reconciliation sweep or a replayed webhook does not set it
   * off again; `isProvisioned` is the second guard, for the case where the edge
   * itself is replayed after the data is already there.
   *
   * Every account, not one: the subscription is the organisation's now, so
   * paying for it is what entitles all of them. An account connected *after*
   * this point is provisioned by the connect path, which sees a subscription
   * already granting.
   *
   * Deliberately not awaited by the caller's transaction and never allowed to
   * throw: Razorpay has taken the money either way, and a Meta outage must not
   * turn a successful payment into a failed request.
   */
  private async provisionIfNewlyPaid(
    before: Subscription,
    after: Subscription,
  ): Promise<void> {
    if (SubscriptionAccessService.grants(before)) return;
    if (!SubscriptionAccessService.grants(after)) return;

    const ssoOrgId = after.ssoOrgId;
    // A row that still names an account covers only that one — it predates the
    // move to organisation-level billing, or its account has since been
    // deleted, in which case there is nothing to fill in.
    const wabaIds = after.wabaId
      ? [after.wabaId]
      : (
          await this.prisma.wabaOrganisation.findMany({
            where: { ssoOrgId },
            select: { wabaId: true },
          })
        ).map((row) => row.wabaId);

    for (const wabaId of wabaIds) {
      try {
        if (await this.provisioning.isProvisioned(wabaId)) continue;
        await this.provisioning.provision(ssoOrgId, wabaId);
      } catch (err) {
        // One account failing must not stop the others: they were all paid for
        // by the same debit.
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Subscription for ${wabaId} in ${ssoOrgId} is paid but provisioning failed: ${detail}`,
        );
      }
    }
  }

  /**
   * Who Razorpay should show against the payment.
   *
   * Both fields are optional on the user — SSO may not have given us a name —
   * and Razorpay rejects an empty string where it accepts an absent field, so
   * blanks are dropped rather than sent.
   */
  private async profileFor(
    userId: number,
  ): Promise<{ name?: string; email?: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, firstName: true, lastName: true },
    });

    const name = [user?.firstName, user?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();

    return {
      ...(name ? { name } : {}),
      ...(user?.email ? { email: user.email } : {}),
    };
  }

  /** Any Razorpay customer already known for this organisation. */
  private async orgCustomerId(ssoOrgId: string): Promise<string | undefined> {
    const previous = await this.prisma.subscription.findFirst({
      where: { ssoOrgId, razorpayCustomerId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { razorpayCustomerId: true },
    });
    return previous?.razorpayCustomerId ?? undefined;
  }

  /**
   * Move the organisation's subscription onto another tier.
   *
   * Two paths, and they follow from what a Razorpay mandate is. It is
   * authorised for a fixed amount, so nothing can raise what a customer is
   * charged without them approving it again.
   *
   *  - **Costs more** — a second subscription is created on the new tier and
   *    the customer is sent back to Checkout. It starts charging where the
   *    month they already paid for ends, so nobody pays twice for the same
   *    days, and the difference for the rest of that month is added as a
   *    one-off. Only once they authorise it is the old one cancelled: an
   *    upgrade they abandon leaves them exactly where they were.
   *  - **Costs the same or less** — takes effect at the renewal, with no new
   *    mandate needed. The month already paid for keeps the tier it was bought
   *    at, and the console says which tier starts when. No credit either way.
   *
   * Returns the state either way. On an upgrade the response carries the
   * subscription to open Checkout on, and the tier does not change here — it
   * changes in `confirm`, when the money is authorised.
   */
  async changePlan(
    ssoOrgId: string,
    planCode: string,
  ): Promise<SubscriptionStateDto> {
    if (!this.razorpay.isConfigured()) {
      throw new BadRequestException(
        'Payments are not configured on this deployment',
      );
    }

    // Refused before Razorpay is touched, as registering is: an unknown tier,
    // a quoted one or one this deployment has not wired up must fail without
    // changing anything.
    const target = await this.sellablePlan(planCode, ssoOrgId);
    if (!target) throw new BadRequestException('A plan is required');

    const sub = await this.find(ssoOrgId);
    if (!sub) {
      throw new NotFoundException(
        'This organisation has no subscription to change — subscribe first',
      );
    }
    if (this.isFinished(sub)) {
      throw new BadRequestException(
        'This subscription has ended. Subscribe again on the tier you want.',
      );
    }
    if (sub.cancelAtCycleEnd) {
      throw new BadRequestException(
        'This subscription is set to end at the close of the paid month, so there is nothing to move onto another tier.',
      );
    }
    // Nothing has been authorised yet, so there is no mandate to replace:
    // finishing the authorisation would charge the old tier.
    if (sub.status === 'created' || sub.status === 'authenticated') {
      throw new BadRequestException(
        'This subscription has not been authorised yet. Cancel it and subscribe on the tier you want.',
      );
    }
    if (sub.planRefId === target.id) {
      throw new BadRequestException(
        `This organisation is already on ${target.name}`,
      );
    }

    const currentPrice = await this.currentPrice(sub);
    // Immediate only where the price is provably higher. Where the current
    // price cannot be read — a subscription on a plan no tier claims, or
    // Razorpay unreachable — the change waits for the renewal, because asking
    // somebody to re-authorise on a guess is the worse mistake.
    const upgrade =
      currentPrice !== null &&
      target.price !== null &&
      target.price > currentPrice;

    return upgrade
      ? this.startUpgrade(sub, target, currentPrice)
      : this.scheduleDowngrade(sub, target);
  }

  /**
   * Ask the customer to authorise the dearer tier.
   *
   * Nothing about what they hold changes here. The new subscription exists at
   * Razorpay in `created`, the old one is still what they pay and still what
   * their limits come from, and `confirm` is where the two swap over. That is
   * the whole reason for the two `pending…` columns: an upgrade abandoned at
   * Checkout has to leave no trace beyond a subscription nobody authorised.
   */
  private async startUpgrade(
    sub: Subscription & {
      plan?: { code: string; name: string } | null;
      pendingPlan?: { code: string; name: string } | null;
    },
    target: {
      id: number;
      code: string;
      name: string;
      razorpayPlanId: string | null;
      price: number | null;
    },
    currentPrice: number,
  ): Promise<SubscriptionStateDto> {
    const startAt = sub.currentEnd;
    const proration = this.prorate(
      target.price! - currentPrice,
      sub.currentStart,
      startAt,
    );

    const created = await this.razorpay.createSubscription({
      customerId: sub.razorpayCustomerId ?? undefined,
      planId: target.razorpayPlanId!,
      // Where the month they already paid for ends. Without it Razorpay would
      // charge the new tier today and they would have bought the same days
      // twice.
      startAt: startAt ? Math.floor(startAt.getTime() / 1000) : undefined,
      notes: {
        ssoOrgId: sub.ssoOrgId,
        planCode: target.code,
        upgradeFrom: this.ownMandate(sub),
      },
    });

    // The difference for the days left of the month they are already in —
    // what the dearer tier costs them for the rest of it. Razorpay raises an
    // add-on on the subscription's next invoice, which for this one is its
    // first, so it lands with the first full charge rather than today.
    if (proration > 0) {
      await this.razorpay.addSubscriptionAddon(created.id, {
        name: `Upgrade to ${target.name} for the rest of the current month`,
        amount: proration,
        currency: 'INR',
        quantity: 1,
      });
    }

    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        pendingRazorpaySubscriptionId: created.id,
        pendingShortUrl: created.short_url ?? null,
        // The tier they have asked for, not the tier they hold. `planRefId` —
        // which the limits read — deliberately does not move until the money
        // is authorised.
        pendingPlanRefId: target.id,
        pendingPlanAt: startAt,
      },
    });

    this.logger.log(
      `${sub.ssoOrgId} is upgrading to ${target.code}; awaiting authorisation ` +
        `of ${created.id}` +
        (proration > 0 ? ` with ${proration} paise of difference` : ''),
    );

    const state = await this.stateOf(sub.ssoOrgId, sub);
    return {
      ...state,
      pendingAuthorisation: {
        subscriptionId: created.id,
        authorisationUrl: created.short_url ?? null,
        planCode: target.code,
        planName: target.name,
        prorationAmount: proration > 0 ? proration : null,
      },
    };
  }

  /** Book the cheaper tier for the renewal, keeping the month already paid for. */
  private async scheduleDowngrade(
    sub: Subscription,
    target: {
      id: number;
      code: string;
      name: string;
      razorpayPlanId: string | null;
    },
  ): Promise<SubscriptionStateDto> {
    await this.razorpay.changeSubscriptionPlan(this.ownMandate(sub), {
      planId: target.razorpayPlanId!,
      atCycleEnd: true,
    });

    const updated = await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        pendingPlanRefId: target.id,
        pendingPlanAt: sub.currentEnd,
        // A downgrade replaces an upgrade nobody got round to authorising.
        pendingRazorpaySubscriptionId: null,
        pendingShortUrl: null,
      },
      include: {
        plan: { select: { code: true, name: true } },
        pendingPlan: { select: { code: true, name: true } },
      },
    });

    await this.access.invalidatePayer(sub.ssoOrgId);

    this.logger.log(
      `${sub.ssoOrgId} moves to ${target.code} at ` +
        `${sub.currentEnd?.toISOString() ?? 'the next renewal'}`,
    );

    return this.stateOf(sub.ssoOrgId, updated);
  }

  /**
   * The share of a monthly difference that the days left in the cycle are
   * worth, in paise.
   *
   * Rounded down, so a rounding error is never charged to the customer. Zero
   * where the cycle's bounds are unknown or already past — better to charge
   * nothing than to invent a period and bill for it.
   */
  private prorate(
    difference: number,
    cycleStart: Date | null,
    cycleEnd: Date | null,
  ): number {
    if (difference <= 0 || !cycleStart || !cycleEnd) return 0;

    const cycle = cycleEnd.getTime() - cycleStart.getTime();
    const remaining = cycleEnd.getTime() - Date.now();
    if (cycle <= 0 || remaining <= 0) return 0;

    return Math.floor((difference * Math.min(remaining, cycle)) / cycle);
  }

  /**
   * What this subscription costs a month, in paise.
   *
   * The published tier's own price where there is one, and Razorpay's plan
   * amount where there is not — an older subscription is on a plan the price
   * list never named, and that amount is still what the customer pays.
   */
  private async currentPrice(sub: Subscription): Promise<number | null> {
    if (sub.planRefId) {
      const plan = await this.prisma.plan.findUnique({
        where: { id: sub.planRefId },
        select: { price: true },
      });
      if (plan?.price != null) return plan.price;
    }
    const remote = await this.plan(sub.planId);
    return remote?.amount ?? null;
  }

  /**
   * Cancel the organisation's subscription. The month already paid for is not
   * refunded and not cut short — Razorpay stops at the end of the cycle, and
   * access here follows `currentEnd`. A subscription whose mandate was never
   * authorised has no paid month to protect, so it stops immediately.
   */
  async cancel(ssoOrgId: string): Promise<SubscriptionStateDto> {
    const sub = await this.find(ssoOrgId);

    if (!sub) throw new NotFoundException('No subscription to cancel');
    if (this.isFinished(sub)) {
      throw new BadRequestException('This subscription has already ended');
    }
    if (sub.cancelAtCycleEnd) {
      throw new BadRequestException('This subscription is already set to end');
    }

    const paidMonthLeft =
      !!sub.currentEnd && sub.currentEnd.getTime() > Date.now();
    const remote = await this.razorpay.cancelSubscription(
      this.ownMandate(sub),
      paidMonthLeft,
    );

    // An upgrade the customer never authorised is abandoned with the rest.
    // Leaving it would have Razorpay open a mandate on a tier for an
    // organisation that has just said it wants to stop paying.
    if (sub.pendingRazorpaySubscriptionId) {
      try {
        await this.razorpay.cancelSubscription(
          sub.pendingRazorpaySubscriptionId,
          false,
        );
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Could not cancel the unauthorised upgrade ` +
            `${sub.pendingRazorpaySubscriptionId}: ${detail}`,
        );
      }
    }

    const updated = await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: this.toStatus(remote.status),
        cancelAtCycleEnd: paidMonthLeft,
        cancelledAt: new Date(),
        shortUrl: null,
        pendingRazorpaySubscriptionId: null,
        pendingShortUrl: null,
      },
      include: {
        plan: { select: { code: true, name: true } },
        pendingPlan: { select: { code: true, name: true } },
      },
    });
    await this.access.invalidatePayer(ssoOrgId);

    void this.mail.subscriptionCancelled(
      sub.createdByUserId,
      ssoOrgId,
      paidMonthLeft ? sub.currentEnd : null,
    );

    return this.stateOf(ssoOrgId, updated);
  }

  /**
   * Apply a Razorpay webhook.
   *
   * Their webhooks retry, and a retry of `subscription.charged` must not be
   * able to move a billing period twice — so the event id is written first and
   * a duplicate stops there.
   */
  async handleWebhook(eventId: string, body: any): Promise<void> {
    const event: string = body?.event ?? 'unknown';
    const entity: RazorpaySubscription | undefined =
      body?.payload?.subscription?.entity;
    // `subscription.charged` carries the payment alongside the subscription;
    // the other events have no payment half.
    const payment: RazorpayPayment | undefined = body?.payload?.payment?.entity;
    const ssoOrgId: string | undefined = entity?.notes?.ssoOrgId;

    try {
      await this.prisma.subscriptionEvent.create({
        data: {
          eventId,
          event,
          ssoOrgId: ssoOrgId ?? null,
          razorpaySubscriptionId: entity?.id ?? null,
          payload: (body ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.log(`Ignoring repeat delivery of ${event} (${eventId})`);
        return;
      }
      throw err;
    }

    if (!entity?.id || !event.startsWith('subscription.')) return;

    const sub = await this.prisma.subscription.findUnique({
      where: { razorpaySubscriptionId: entity.id },
      include: {
        waba: { select: { name: true } },
        // Named on the invoice this charge raises, snapshotted at issue so a
        // tier renamed next month cannot rewrite a document already sent.
        plan: { select: { code: true, name: true } },
      },
    });

    if (!sub) {
      // An agency's mandate covers several clients and belongs to no single
      // subscription, so it is looked for separately. Without this a client's
      // period never moves and its access lapses a month after it was taken
      // on — the quietest way this could break.
      const applied = await this.agencyBilling.applyToGroup(
        entity.id,
        entity,
        this.paymentRow(payment),
      );
      if (applied) {
        // One debit, several clients, one document — addressed to the agency,
        // because the agency is whose bank moved. Which clients it bought for
        // is what the invoice's lines say.
        if (applied.payment?.status === 'captured') {
          await this.invoices.issueFor({
            paymentId: applied.payment.id,
            razorpayPaymentId: applied.payment.razorpayPaymentId,
            razorpayInvoiceId: applied.payment.razorpayInvoiceId,
            ssoOrgId: applied.agencyOrgId,
            billingGroupId: applied.billingGroupId,
            userId: applied.userId,
            planCode: applied.planCode,
            planName: applied.planName,
            amount: applied.payment.amount,
            currency: applied.payment.currency,
            paidAt: applied.payment.paidAt,
            method: applied.payment.method,
            methodDetail: applied.payment.methodDetail,
            periodStart: applied.currentStart,
            periodEnd: applied.currentEnd,
          });
        }
        return;
      }

      // A subscription created against another environment sharing the same
      // Razorpay account. Recorded above, then left alone.
      this.logger.warn(`Webhook for unknown subscription ${entity.id}`);
      return;
    }

    const status = this.toStatus(entity.status);
    const currentEnd = at(entity.current_end);

    await this.applyRemote(sub, entity);
    const recorded = await this.recordPayment(sub.id, payment);

    // Money has moved, so there is a document to raise. After the payment row,
    // so the invoice can point at it; before the emails below, so a customer
    // never gets "your subscription is active" and its invoice out of order.
    // Only a captured debit is invoiced: an authorised-but-uncaptured payment
    // is money that has not moved, and a failed one is money that never will.
    if (recorded?.status === 'captured') {
      await this.invoices.issueFor({
        paymentId: recorded.id,
        razorpayPaymentId: recorded.razorpayPaymentId,
        razorpayInvoiceId: recorded.razorpayInvoiceId,
        ssoOrgId: sub.ssoOrgId,
        userId: sub.createdByUserId,
        planCode: sub.plan?.code ?? null,
        planName: sub.plan?.name ?? null,
        amount: recorded.amount,
        currency: recorded.currency,
        paidAt: recorded.paidAt,
        method: recorded.method,
        methodDetail: recorded.methodDetail,
        // The cycle this charge bought, from the event rather than from our
        // row: the row is written from the same event, but the period is what
        // the customer is being invoiced *for*.
        periodStart: at(entity.current_start),
        periodEnd: currentEnd,
      });
    }
    // A cycle has just been paid for; queue what the next one owes for the
    // numbers on the account beyond the one the plan includes.
    if (event === 'subscription.charged') {
      await this.billOverage(sub);
    }

    // Not guarded on `sub.wabaId` any more. An organisation-level subscription
    // has none, so the guard would have skipped invalidation on exactly the
    // subscriptions that now matter — leaving a lapsed agency's clients sending
    // until the cache expired.
    await this.access.invalidatePayer(sub.ssoOrgId);
    this.notify(event, sub, status, currentEnd ?? sub.currentEnd);
  }

  /**
   * Charge for everything beyond what the plan includes.
   *
   * Raised as add-ons on the next invoice, once per cycle, because Razorpay has
   * no second recurring price on a plan. Called only from the
   * `subscription.charged` path, which is deduplicated on the event id — so a
   * webhook Razorpay retries cannot bill the same cycle twice.
   *
   * Never throws: this is money to collect, not state the subscription depends
   * on, and throwing here would fail a webhook whose real job was to record a
   * payment that has already happened.
   */
  private async billOverage(sub: {
    id: number;
    ssoOrgId: string;
    wabaId: string | null;
    razorpaySubscriptionId: string | null;
    payerOrgId: string | null;
    planRefId: number | null;
  }): Promise<void> {
    try {
      if (!sub.planRefId) return;
      // An add-on is raised against a mandate, and a client an agency pays for
      // has none of its own. Its accounts are counted against its own plan and
      // charged to the agency's group — which is where that overage belongs,
      // not on a subscription that cannot be debited.
      const mandate = sub.razorpaySubscriptionId;
      if (!mandate) return;

      const plan = await this.prisma.plan.findUnique({
        where: { id: sub.planRefId },
        select: {
          additionalNumberPrice: true,
          additionalWabaPrice: true,
          includedWabas: true,
          includedPhoneNumbersPerWaba: true,
          currency: true,
          name: true,
        },
      });
      if (!plan) return;

      // Once, an agency's clients inherited its subscription and their
      // accounts were pooled into its overage. They hold subscriptions of
      // their own now, each counted against the plan bought for it — so this
      // is the organisation itself, and only a client left on the older
      // arrangement still reaches through to its agency.
      const scope = sub.payerOrgId
        ? [sub.ssoOrgId]
        : await this.orgSettings.billingScope(sub.ssoOrgId);

      // The accounts this subscription covers. A per-WABA subscription — the
      // shape that existed before organisation-level billing — still answers
      // for exactly the one it names.
      const wabaIds = sub.wabaId
        ? [sub.wabaId]
        : (
            await this.prisma.wabaOrganisation.findMany({
              where: { ssoOrgId: { in: scope } },
              select: { wabaId: true },
            })
          ).map((row) => row.wabaId);

      await this.billExtraWabas(
        { razorpaySubscriptionId: mandate },
        plan,
        wabaIds.length,
      );
      await this.billExtraNumbers(
        { razorpaySubscriptionId: mandate },
        plan,
        wabaIds,
      );
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Could not bill overage for ${sub.id}: ${detail}`);
    }
  }

  /** Accounts beyond the number the plan includes. */
  private async billExtraWabas(
    sub: { razorpaySubscriptionId: string },
    plan: {
      additionalWabaPrice: number | null;
      includedWabas: number | null;
      currency: string;
    },
    connected: number,
  ): Promise<void> {
    if (!plan.additionalWabaPrice) return;

    // Null means the plan includes none, so every account bills. That is only
    // ever true of a plan nobody has finished configuring, but reading it as
    // "unlimited" would be the expensive way round to be wrong.
    const included = plan.includedWabas ?? 0;
    const extras = Math.max(0, connected - included);
    if (extras === 0) return;

    const addon = await this.razorpay.addSubscriptionAddon(
      sub.razorpaySubscriptionId,
      {
        name: `Additional WhatsApp Business Account${extras === 1 ? '' : 's'}`,
        amount: plan.additionalWabaPrice,
        currency: plan.currency,
        quantity: extras,
      },
    );
    if (addon) {
      this.logger.log(
        `Queued ${extras} additional account(s) on ${sub.razorpaySubscriptionId} for the next invoice`,
      );
    }
  }

  /**
   * Numbers beyond the count each account's plan includes.
   *
   * The included count comes from the plan rather than a constant. It was `1`
   * in the code and `3` on Growth's card, so Growth customers were billed for
   * two numbers their plan already covered.
   */
  private async billExtraNumbers(
    sub: { razorpaySubscriptionId: string },
    plan: {
      additionalNumberPrice: number | null;
      includedPhoneNumbersPerWaba: number | null;
      currency: string;
    },
    wabaIds: string[],
  ): Promise<void> {
    if (!plan.additionalNumberPrice || wabaIds.length === 0) return;

    const perWaba = plan.includedPhoneNumbersPerWaba ?? 0;

    // Only numbers live on the Cloud API: an unregistered one cannot send
    // and is not what the price list is charging for.
    const registered = await this.prisma.wabaPhoneNumber.groupBy({
      by: ['wabaId'],
      where: { wabaId: { in: wabaIds }, platformType: CLOUD_API_PLATFORM },
      _count: { _all: true },
    });

    // Counted per account, not across them: the allowance is "one per WABA", so
    // an account with three spare numbers cannot cover another account's fourth.
    const extras = registered.reduce(
      (sum, row) => sum + Math.max(0, row._count._all - perWaba),
      0,
    );
    if (extras === 0) return;

    const addon = await this.razorpay.addSubscriptionAddon(
      sub.razorpaySubscriptionId,
      {
        name: `Additional phone number${extras === 1 ? '' : 's'}`,
        amount: plan.additionalNumberPrice,
        currency: plan.currency,
        quantity: extras,
      },
    );
    if (addon) {
      this.logger.log(
        `Queued ${extras} additional number(s) on ${sub.razorpaySubscriptionId} for the next invoice`,
      );
    }
  }

  /**
   * Keep a copy of what was taken.
   *
   * Razorpay is the ledger and this is not trying to replace it; it is what
   * lets the console answer "what was I charged, when, on which card" without
   * a round trip, and after a payment has scrolled out of their dashboard.
   *
   * Keyed on their payment id, so a retried webhook updates the row it already
   * wrote rather than billing history growing a duplicate every retry.
   */
  /** A payment as both the self-paid and the group path record it. */
  private paymentRow(payment: RazorpayPayment | undefined) {
    if (!payment?.id) return undefined;
    return {
      razorpayPaymentId: payment.id,
      razorpayInvoiceId: payment.invoice_id ?? null,
      amount: payment.amount ?? 0,
      currency: payment.currency ?? 'INR',
      status: payment.status ?? 'captured',
      method: payment.method ?? null,
      methodDetail: describeMethod(payment),
      paidAt: at(payment.created_at),
    };
  }

  private async recordPayment(
    subscriptionId: number,
    payment: RazorpayPayment | undefined,
  ): Promise<SubscriptionPayment | null> {
    if (!payment?.id) return null;

    const data = {
      razorpayInvoiceId: payment.invoice_id ?? null,
      amount: payment.amount ?? 0,
      currency: payment.currency ?? 'INR',
      status: payment.status ?? 'captured',
      method: payment.method ?? null,
      methodDetail: describeMethod(payment),
      paidAt: at(payment.created_at),
    };

    try {
      return await this.prisma.subscriptionPayment.upsert({
        where: { razorpayPaymentId: payment.id },
        create: { subscriptionId, razorpayPaymentId: payment.id, ...data },
        update: data,
      });
    } catch (err) {
      // Billing history is worth having, not worth failing a webhook over —
      // Razorpay would retry the whole delivery and re-apply the state.
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not record payment ${payment.id}: ${detail}`);
      return null;
    }
  }

  /**
   * One email per state a customer would want to hear about.
   *
   * Nothing here is awaited: an email is a courtesy on top of a payment that
   * has already happened, and a slow mailbox must not hold up a webhook
   * Razorpay will retry if we are late acknowledging it.
   */
  private notify(
    event: string,
    sub: Subscription,
    status: SubscriptionStatus,
    currentEnd: Date | null,
  ): void {
    if (
      event === 'subscription.charged' ||
      event === 'subscription.activated'
    ) {
      // Both fire around the first successful debit; the mail is sent for the
      // one that carries the period, and only when the period actually moved.
      if (
        status === 'active' &&
        currentEnd &&
        currentEnd > (sub.currentEnd ?? new Date(0))
      ) {
        void this.mail.subscriptionCharged(
          sub.createdByUserId,
          sub.ssoOrgId,
          currentEnd,
        );
      }
      return;
    }

    if (event === 'subscription.pending' || event === 'subscription.halted') {
      void this.mail.subscriptionPaymentFailed(
        sub.createdByUserId,
        sub.ssoOrgId,
        status === 'halted',
        currentEnd,
      );
    }
  }

  /**
   * The provider subscription this row is charged on.
   *
   * Every write path in this service — confirming, upgrading, downgrading,
   * cancelling, reconciling — acts on a mandate the organisation holds itself.
   * A client an agency pays for holds none: it is a quantity on the agency's,
   * and those actions belong to the agency's subscription rather than this one.
   * Saying so once here beats seven assertions that it cannot be null.
   */
  private ownMandate(sub: { razorpaySubscriptionId: string | null }): string {
    if (!sub.razorpaySubscriptionId) {
      throw new BadRequestException(
        'This organisation is billed through its agency, which holds the mandate.',
      );
    }
    return sub.razorpaySubscriptionId;
  }

  /** Nothing more will be charged and nothing more can be reactivated. */
  private isFinished(sub: Subscription): boolean {
    return (
      sub.status === 'cancelled' ||
      sub.status === 'expired' ||
      sub.status === 'completed' ||
      // Not ours to charge or reactivate either: replaced by the
      // organisation's subscription when the per-account ones were collapsed.
      sub.status === 'superseded'
    );
  }

  private toStatus(status: string): SubscriptionStatus {
    return (STATUSES.has(status) ? status : 'created') as SubscriptionStatus;
  }

  /**
   * Hourly reconciliation.
   *
   * Webhooks get missed — a deploy mid-delivery, an outage, a misconfigured
   * endpoint — and a missed `subscription.charged` reads exactly like a lapsed
   * customer, while a missed `halted` reads like a paying one. Anything whose
   * paid month has run out is re-read from Razorpay rather than assumed.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'billing-reconcile' })
  async reconcile(): Promise<void> {
    if (!this.razorpay.isConfigured()) return;

    const stale = await this.prisma.subscription.findMany({
      where: {
        // `superseded` is excluded with the finished ones. Those rows may well
        // still be live at Razorpay — that is exactly why they are not
        // `cancelled` — but this product no longer answers for them, and
        // re-applying their remote state would resurrect an entitlement the
        // organisation's own subscription is meant to have replaced.
        status: {
          notIn: ['cancelled', 'expired', 'completed', 'superseded'],
        },
        OR: [{ currentEnd: { lt: new Date() } }, { currentEnd: null }],
        // A client an agency pays for has no provider subscription to read.
        // The agency's group is reconciled on its own.
        razorpaySubscriptionId: { not: null },
      },
      take: 100,
    });

    for (const sub of stale) {
      try {
        const remote = await this.razorpay.fetchSubscription(
          this.ownMandate(sub),
        );
        await this.applyRemote(sub, remote);
        await this.access.invalidatePayer(sub.ssoOrgId);
      } catch (err) {
        // One unreachable subscription must not stop the rest of the sweep.
        this.logger.error(
          `Reconciliation failed for ${sub.razorpaySubscriptionId}: ${(err as Error).message}`,
        );
      }
    }

    // Invoices raised but never sent — mail disabled at the time, or SES
    // refusing when the charge landed. Outside the loop, and outside the
    // Razorpay guard's concern: a document that exists and never reached its
    // customer is the failure this deployment would never otherwise notice.
    const sent = await this.invoices.deliverPending();
    if (sent > 0) this.logger.log(`Delivered ${sent} pending invoice(s)`);
  }
}
