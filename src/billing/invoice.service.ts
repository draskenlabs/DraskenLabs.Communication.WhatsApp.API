import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Invoice, InvoiceLine, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { OrgDirectoryService } from 'src/org/org-directory.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import {
  financialYear,
  financialYearLabel,
  invoiceNumber,
  isInvoiceNumber,
} from './invoice.number';
import { InvoiceSeller, formatAmount, renderInvoicePdf } from './invoice.pdf';
import { InvoiceDto } from './dto/billing.dto';

/** An invoice with the lines that make it up, which is the only useful shape. */
export type InvoiceWithLines = Invoice & { lines: InvoiceLine[] };

/** What a captured debit tells us, gathered where the payment was recorded. */
export interface InvoiceRequest {
  /** The stored debit, so the document and the row can be joined. */
  paymentId: number | null;
  razorpayPaymentId: string;
  razorpayInvoiceId: string | null;

  /**
   * The organisation charged — whose bank moved.
   *
   * For an agency's debit this is the agency, not any of its clients: one
   * mandate covers several, and only one account was debited.
   */
  ssoOrgId: string;

  /**
   * The agency group charged, when the debit was one of those. Set, the lines
   * are built from the clients riding the mandate; unset, it is one line for
   * one subscription.
   */
  billingGroupId?: number | null;

  /** Who the document goes to — the person who took the mandate out. */
  userId: number;

  /** For a self-paid debit: the tier it bought. */
  planCode?: string | null;
  planName?: string | null;

  /** What was actually taken, in the smallest currency unit. */
  amount: number;
  currency: string;
  paidAt: Date | null;
  method: string | null;
  methodDetail: string | null;

  /** The cycle the charge bought, as Razorpay reported it. */
  periodStart: Date | null;
  periodEnd: Date | null;
}

/** One line before it is written — amounts still to be scaled to the subtotal. */
interface DraftLine {
  ssoOrgId: string | null;
  description: string;
  detail: string | null;
  planCode: string | null;
  planName: string | null;
  quantity: number;
  /** What the price list says this is worth, used only to divide the total. */
  weight: number;
}

/** Defaults, so a deployment that configures nothing still raises invoices. */
const DEFAULT_SERIES = 'WAC';
const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_TAX_LABEL = 'GST';

/**
 * Invoices.
 *
 * A subscription used to leave nothing behind but a row in Razorpay's
 * dashboard and a payment id no accountant can enter in a return. This raises
 * a numbered document for every captured debit, in our own series —
 * `INV-WAC-2627-0001` — and mails it to whoever took the mandate out, with the
 * PDF attached.
 *
 * Three properties this is built around, because they are the ones an audit
 * checks:
 *
 *   **One invoice per debit.** Razorpay retries webhooks, and a retried
 *   `subscription.charged` must never draw a second number. The payment id is
 *   unique on the table, so the second attempt finds the first invoice and
 *   returns it.
 *
 *   **No gaps, no reuse.** The number comes from a counter incremented in the
 *   same transaction that writes the invoice, so two webhooks arriving together
 *   cannot be handed the same number, and a transaction that rolls back takes
 *   its number with it.
 *
 *   **The total is not derived.** It is what the bank moved. Everything else on
 *   the document — the lines, the subtotal, the tax — divides that number and
 *   is reconciled back to it, so the arithmetic on the page always closes.
 *
 * Nothing here throws at its caller: an invoice is raised on the back of money
 * that has already moved, and failing a webhook over a document would have
 * Razorpay redeliver the charge instead.
 */
@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly orgDirectory: OrgDirectoryService,
    private readonly mail: MailNotifications,
  ) {}

  /* ---------------------------------------------------------------- *
   * Raising                                                           *
   * ---------------------------------------------------------------- */

  /**
   * Raise the invoice for one captured payment, and send it.
   *
   * Returns the invoice — the one just written, or the one that was already
   * there. Null only when it could not be raised at all, which is logged and
   * otherwise left alone: the customer has still been charged, and the sweep
   * below picks the document up on the next pass.
   */
  async issueFor(request: InvoiceRequest): Promise<InvoiceWithLines | null> {
    try {
      const invoice = await this.record(request);
      if (!invoice) return null;
      await this.deliver(invoice);
      return invoice;
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Could not invoice payment ${request.razorpayPaymentId}: ${detail}`,
      );
      return null;
    }
  }

  /** Write the invoice, or return the one this payment already has. */
  private async record(
    request: InvoiceRequest,
  ): Promise<InvoiceWithLines | null> {
    const existing = await this.byPayment(request.razorpayPaymentId);
    if (existing) return existing;

    const issuedAt = request.paidAt ?? new Date();
    const year = financialYear(issuedAt, this.timeZone);

    // Read straight from the user row rather than through the mail service:
    // this is the "billed to" line on a document, and it has to be written
    // even when the person has no address to send it to.
    const user = await this.prisma.user.findUnique({
      where: { id: request.userId },
      select: { email: true, firstName: true, lastName: true },
    });
    const billedToName =
      [user?.firstName, user?.lastName].filter(Boolean).join(' ') || null;
    const organisationName = await this.orgDirectory.name(request.ssoOrgId);

    const { subtotal, taxAmount, taxRateBps } = this.divide(request.amount);
    const drafts = await this.drafts(request);
    const lines = this.apportion(drafts, subtotal);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const sequence = await this.nextSequence(tx, year);
        return tx.invoice.create({
          data: {
            number: invoiceNumber(this.series, year, sequence),
            financialYear: year,
            sequence,
            razorpayPaymentId: request.razorpayPaymentId,
            razorpayInvoiceId: request.razorpayInvoiceId,
            paymentId: request.paymentId,
            ssoOrgId: request.ssoOrgId,
            billingGroupId: request.billingGroupId ?? null,
            billedToName,
            billedToEmail: user?.email ?? null,
            organisationName,
            summary: this.summarise(drafts),
            paymentMethod: request.methodDetail ?? request.method,
            periodStart: request.periodStart,
            periodEnd: request.periodEnd,
            subtotal,
            taxAmount,
            taxRateBps,
            taxLabel: taxRateBps > 0 ? this.taxLabel : null,
            total: request.amount,
            currency: request.currency,
            issuedAt,
            paidAt: request.paidAt,
            lines: { create: lines },
          },
          include: { lines: { orderBy: { position: 'asc' } } },
        });
      });
    } catch (err) {
      // Two deliveries of the same charge, racing. The one that lost reads the
      // invoice the winner wrote rather than raising a second number for a
      // debit that only happened once.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return this.byPayment(request.razorpayPaymentId);
      }
      throw err;
    }
  }

  /**
   * What the debit was for, before the money is divided across it.
   *
   * An agency's mandate carries several clients, so its invoice carries a line
   * each — otherwise the agency is handed one total and no way to tell what it
   * bought, and the client cannot be shown the line that paid for its month.
   */
  private async drafts(request: InvoiceRequest): Promise<DraftLine[]> {
    if (!request.billingGroupId) {
      return [
        {
          ssoOrgId: request.ssoOrgId,
          description: request.planName
            ? `${request.planName} plan`
            : 'Subscription',
          detail: null,
          planCode: request.planCode ?? null,
          planName: request.planName ?? null,
          quantity: 1,
          weight: 1,
        },
      ];
    }

    const clients = await this.prisma.subscription.findMany({
      where: { billingGroupId: request.billingGroupId },
      orderBy: { createdAt: 'asc' },
      select: {
        ssoOrgId: true,
        plan: { select: { code: true, name: true, price: true } },
      },
    });

    // A mandate charged after its last client was released. It has still taken
    // money, so it still gets a document — with the group named rather than a
    // list of nobody.
    if (clients.length === 0) {
      return [
        {
          ssoOrgId: null,
          description: request.planName
            ? `${request.planName} plan`
            : 'Client subscriptions',
          detail: 'No clients on this mandate at the time of charge',
          planCode: request.planCode ?? null,
          planName: request.planName ?? null,
          quantity: 1,
          weight: 1,
        },
      ];
    }

    // The agency's own label for a client is the one it will recognise; the
    // directory name is the fallback, and the id is the last resort.
    const settings = await this.prisma.organisationSettings.findMany({
      where: { ssoOrgId: { in: clients.map((c) => c.ssoOrgId) } },
      select: { ssoOrgId: true, clientName: true },
    });
    const labelled = new Map(
      settings.map((s) => [s.ssoOrgId, s.clientName] as const),
    );

    return Promise.all(
      clients.map(async (client) => {
        const name =
          labelled.get(client.ssoOrgId) ??
          (await this.orgDirectory.name(client.ssoOrgId)) ??
          client.ssoOrgId;
        return {
          ssoOrgId: client.ssoOrgId,
          description: `${client.plan?.name ?? 'Subscription'} — ${name}`,
          detail: null,
          planCode: client.plan?.code ?? null,
          planName: client.plan?.name ?? null,
          quantity: 1,
          // The list price divides the debit between clients on different
          // tiers. Falls back to an equal share where a tier is quoted.
          weight: client.plan?.price ?? 1,
        };
      }),
    );
  }

  /**
   * Divide the taxable value across the lines.
   *
   * The lines have to add up to the subtotal exactly — a document whose column
   * does not sum to its own total is worse than one with no column at all — so
   * the division is by weight and the last line absorbs whatever rounding left
   * over. It is at most a few paise, and it lands somewhere rather than
   * vanishing.
   */
  private apportion(
    drafts: DraftLine[],
    subtotal: number,
  ): Prisma.InvoiceLineCreateWithoutInvoiceInput[] {
    const total = drafts.reduce((sum, line) => sum + line.weight, 0) || 1;

    let allocated = 0;
    return drafts.map((draft, index) => {
      const last = index === drafts.length - 1;
      const amount = last
        ? subtotal - allocated
        : Math.round((subtotal * draft.weight) / total);
      allocated += amount;

      return {
        ssoOrgId: draft.ssoOrgId,
        description: draft.description,
        detail: draft.detail,
        planCode: draft.planCode,
        planName: draft.planName,
        quantity: draft.quantity,
        unitAmount: Math.round(amount / Math.max(1, draft.quantity)),
        amount,
        position: index,
      };
    });
  }

  /** What the money bought, in the few words a subject line has room for. */
  private summarise(drafts: DraftLine[]): string | null {
    if (drafts.length === 0) return null;
    if (drafts.length === 1) return drafts[0].planName ?? 'Subscription';

    const plans = [...new Set(drafts.map((d) => d.planName).filter(Boolean))];
    const count = `${drafts.length} client plans`;
    return plans.length === 1 ? `${count} — ${plans[0]}` : count;
  }

  /**
   * The next number in a financial year's series.
   *
   * One statement, so the read and the increment cannot be separated by
   * another transaction: `RETURNING "nextSequence" - 1` hands back the value
   * this caller claimed, and the row is locked for anyone arriving behind it
   * until this transaction commits or rolls back.
   */
  private async nextSequence(
    tx: Prisma.TransactionClient,
    year: string,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ sequence: number }[]>`
      INSERT INTO "InvoiceCounter" ("financialYear", "nextSequence", "updatedAt")
      VALUES (${year}, 2, NOW())
      ON CONFLICT ("financialYear") DO UPDATE
        SET "nextSequence" = "InvoiceCounter"."nextSequence" + 1,
            "updatedAt" = NOW()
      RETURNING "nextSequence" - 1 AS sequence
    `;
    const sequence = Number(rows[0]?.sequence);
    if (!Number.isFinite(sequence) || sequence < 1) {
      throw new Error(`Invoice counter returned nothing for ${year}`);
    }
    return sequence;
  }

  /**
   * How a charge divides into a taxable value and the tax on it.
   *
   * The price list is inclusive — what the customer authorised is what the bank
   * moved — so the tax is worked back out of the total rather than added to it.
   * The subtotal is rounded and the tax is the remainder, so the two always
   * add up to the amount actually taken, which is the one number on the
   * document that is not ours to restate.
   *
   * With no rate configured this is the identity: subtotal is the total and
   * there is no tax line.
   */
  private divide(total: number): {
    subtotal: number;
    taxAmount: number;
    taxRateBps: number;
  } {
    const taxRateBps = this.taxRateBps;
    if (taxRateBps <= 0)
      return { subtotal: total, taxAmount: 0, taxRateBps: 0 };

    const subtotal = Math.round((total * 10000) / (10000 + taxRateBps));
    return { subtotal, taxAmount: total - subtotal, taxRateBps };
  }

  /* ---------------------------------------------------------------- *
   * Sending                                                           *
   * ---------------------------------------------------------------- */

  /**
   * Mail an invoice to the address on it, with the PDF attached, and record
   * that it went.
   *
   * A send that fails is left un-stamped rather than retried here: MailService
   * already retries a failed message on its own schedule, and `deliverPending`
   * covers the case where the row never reached it at all.
   */
  async deliver(invoice: InvoiceWithLines): Promise<boolean> {
    if (!invoice.billedToEmail) {
      this.logger.warn(
        `${invoice.number} has no address to send to — the invoice is raised but not delivered`,
      );
      return false;
    }

    const sent = await this.mail.invoiceIssued({
      email: invoice.billedToEmail,
      name: invoice.billedToName,
      number: invoice.number,
      issuedAt: invoice.issuedAt,
      organisationName: invoice.organisationName,
      summary: invoice.summary,
      total: formatAmount(invoice.total, invoice.currency),
      periodEnd: invoice.periodEnd,
      pdf: this.pdf(invoice),
    });

    if (!sent) return false;

    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { emailedAt: new Date(), emailedTo: invoice.billedToEmail },
    });
    return true;
  }

  /**
   * Send again the invoices that were raised but never went out.
   *
   * Mail is disabled on a deployment until SES is configured, and a customer
   * charged in that window would otherwise never see the document at all. Run
   * from the billing reconciliation sweep, which already runs hourly.
   */
  async deliverPending(limit = 25): Promise<number> {
    const pending = await this.prisma.invoice.findMany({
      where: { emailedAt: null, billedToEmail: { not: null } },
      orderBy: { issuedAt: 'asc' },
      take: limit,
      include: { lines: { orderBy: { position: 'asc' } } },
    });

    let sent = 0;
    for (const invoice of pending) {
      try {
        if (await this.deliver(invoice)) sent++;
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Could not resend ${invoice.number}: ${detail}`);
      }
    }
    return sent;
  }

  /* ---------------------------------------------------------------- *
   * Reading                                                           *
   * ---------------------------------------------------------------- */

  /** Every invoice charged to an organisation, newest first. */
  async listForOrg(ssoOrgId: string, take = 60): Promise<InvoiceWithLines[]> {
    return this.prisma.invoice.findMany({
      where: { ssoOrgId },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take,
      include: { lines: { orderBy: { position: 'asc' } } },
    });
  }

  /**
   * Every invoice an agency should see: its own, and its clients'.
   *
   * Its own covers everything it is paying now. Its clients' covers what they
   * paid for themselves before it took them on, or after it let them go — an
   * agency asked to explain a client's billing history needs both halves, and
   * the client itself may have nobody left who can sign in.
   */
  async listForAgency(
    agencyOrgId: string,
    clientOrgIds: string[],
    take = 120,
  ): Promise<InvoiceWithLines[]> {
    return this.prisma.invoice.findMany({
      where: { ssoOrgId: { in: [agencyOrgId, ...clientOrgIds] } },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take,
      include: { lines: { orderBy: { position: 'asc' } } },
    });
  }

  /**
   * Every invoice that bought a month for one organisation.
   *
   * Not the same question as "invoices charged to it": a client an agency pays
   * for is *on* invoices addressed to the agency. This finds those through the
   * lines, which is the whole reason the lines carry an organisation.
   */
  async listCoveringOrg(
    ssoOrgId: string,
    take = 60,
  ): Promise<InvoiceWithLines[]> {
    return this.prisma.invoice.findMany({
      where: {
        OR: [{ ssoOrgId }, { lines: { some: { ssoOrgId } } }],
      },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take,
      include: { lines: { orderBy: { position: 'asc' } } },
    });
  }

  /**
   * One invoice, whole, for the organisation it is addressed to.
   *
   * Stricter than `findForOrgs` on purpose, and it is what the PDF route uses:
   * the document is the payer's entire debit, so an agency's client reading it
   * would be reading its rivals' names and prices. A client sees its own line
   * through the list instead, as an extract.
   */
  async findAddressedTo(
    allowed: string[],
    number: string,
  ): Promise<InvoiceWithLines | null> {
    if (!isInvoiceNumber(number)) return null;
    const invoice = await this.prisma.invoice.findUnique({
      where: { number },
      include: { lines: { orderBy: { position: 'asc' } } },
    });
    return invoice && allowed.includes(invoice.ssoOrgId) ? invoice : null;
  }

  /**
   * One invoice, by number, for a caller allowed to see it *at all*.
   *
   * The scope is the point: the numbers are sequential, so an unscoped lookup
   * would let anyone with a session walk the whole series. `allowed` is the set
   * of organisations this caller may read for — itself, plus an agency's
   * clients.
   */
  async findForOrgs(
    allowed: string[],
    number: string,
  ): Promise<InvoiceWithLines | null> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { number },
      include: { lines: { orderBy: { position: 'asc' } } },
    });
    if (!invoice) return null;

    const permitted =
      allowed.includes(invoice.ssoOrgId) ||
      // A client may read the invoice that bought its month even though the
      // document is addressed to whoever paid.
      invoice.lines.some(
        (line) => line.ssoOrgId && allowed.includes(line.ssoOrgId),
      );
    return permitted ? invoice : null;
  }

  /** Unscoped, for the operator console only. */
  async find(number: string): Promise<InvoiceWithLines | null> {
    return this.prisma.invoice.findUnique({
      where: { number },
      include: { lines: { orderBy: { position: 'asc' } } },
    });
  }

  /** One invoice by the debit that raised it. */
  private byPayment(
    razorpayPaymentId: string,
  ): Promise<InvoiceWithLines | null> {
    return this.prisma.invoice.findUnique({
      where: { razorpayPaymentId },
      include: { lines: { orderBy: { position: 'asc' } } },
    });
  }

  /**
   * An invoice as one organisation is allowed to see it.
   *
   * A client an agency pays for appears *on* the agency's invoice, and needs
   * to: without it, its billing history is empty for every month somebody else
   * paid. But that document also names the agency's other clients and what
   * each of them costs, which is none of this one's business.
   *
   * So a document addressed to somebody else comes back as an extract — this
   * organisation's own lines, their total, and who paid — rather than the
   * whole thing. `extract` says which it is, and `downloadable` says the PDF
   * is not on offer: the PDF is the agency's whole debit and cannot be
   * partially rendered.
   */
  toDtoFor(invoice: InvoiceWithLines, ssoOrgId: string): InvoiceDto {
    if (invoice.ssoOrgId === ssoOrgId) return this.toDto(invoice);

    const own = invoice.lines.filter((line) => line.ssoOrgId === ssoOrgId);
    const total = own.reduce((sum, line) => sum + line.amount, 0);

    return {
      ...this.toDto({ ...invoice, lines: own }),
      // The document's own tax divides the whole debit, not this share of it.
      // Restating it against a partial total would be arithmetic nobody could
      // check, so it is simply absent.
      subtotal: total,
      taxAmount: 0,
      taxRateBps: 0,
      taxLabel: null,
      total,
      // Whose document this actually is stays visible: "paid by Northwind" is
      // the useful half of showing it at all.
      extract: true,
      downloadable: false,
      // Not this organisation's email address to know.
      emailedTo: null,
    };
  }

  /** The console's shape of an invoice: the snapshot, and nothing internal. */
  toDto(invoice: InvoiceWithLines): InvoiceDto {
    return {
      number: invoice.number,
      financialYear: invoice.financialYear,
      issuedAt: invoice.issuedAt,
      paidAt: invoice.paidAt,
      ssoOrgId: invoice.ssoOrgId,
      organisationName: invoice.organisationName,
      summary: invoice.summary,
      lines: invoice.lines.map((line) => ({
        ssoOrgId: line.ssoOrgId,
        description: line.description,
        detail: line.detail,
        planCode: line.planCode,
        planName: line.planName,
        quantity: line.quantity,
        unitAmount: line.unitAmount,
        amount: line.amount,
      })),
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      subtotal: invoice.subtotal,
      taxAmount: invoice.taxAmount,
      taxRateBps: invoice.taxRateBps,
      taxLabel: invoice.taxLabel,
      total: invoice.total,
      currency: invoice.currency,
      paymentMethod: invoice.paymentMethod,
      emailedAt: invoice.emailedAt,
      emailedTo: invoice.emailedTo,
      razorpayPaymentId: invoice.razorpayPaymentId,
      extract: false,
      downloadable: true,
    };
  }

  /** The document itself. */
  pdf(invoice: InvoiceWithLines): Buffer {
    return renderInvoicePdf(
      {
        number: invoice.number,
        financialYearLabel: financialYearLabel(invoice.financialYear),
        issuedAt: invoice.issuedAt,
        paidAt: invoice.paidAt,
        billedToName: invoice.billedToName,
        billedToEmail: invoice.billedToEmail,
        organisationName: invoice.organisationName,
        summary: invoice.summary,
        lines: invoice.lines.map((line) => ({
          description: line.description,
          detail: line.detail,
          quantity: line.quantity,
          unitAmount: line.unitAmount,
          amount: line.amount,
        })),
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        subtotal: invoice.subtotal,
        taxAmount: invoice.taxAmount,
        taxRateBps: invoice.taxRateBps,
        taxLabel: invoice.taxLabel,
        total: invoice.total,
        currency: invoice.currency,
        paymentMethod: invoice.paymentMethod,
        paymentReference: invoice.razorpayPaymentId,
        placeOfSupply:
          this.config.get<string>('INVOICE_PLACE_OF_SUPPLY') ?? null,
      },
      this.seller,
    );
  }

  /** What the file is called when it lands in somebody's downloads. */
  filename(invoice: Invoice): string {
    return `${invoice.number}.pdf`;
  }

  /* ---------------------------------------------------------------- *
   * Configuration                                                     *
   * ---------------------------------------------------------------- */

  /** The book this deployment writes in — the `WAC` in `INV-WAC-2627-0001`. */
  private get series(): string {
    const value = (
      this.config.get<string>('INVOICE_SERIES') ?? DEFAULT_SERIES
    ).toUpperCase();
    // A series that does not match the format would produce numbers our own
    // route parameter rejects, so a bad value falls back rather than breaking
    // every invoice the deployment ever raises.
    return /^[A-Z0-9]{2,8}$/.test(value) ? value : DEFAULT_SERIES;
  }

  /**
   * Which day an invoice belongs to, and so which financial year.
   *
   * India's year turns at midnight on 1 April in Indian local time, not in the
   * pod's. Configurable because the series is not: a deployment invoicing from
   * another country still needs its own year boundary.
   */
  private get timeZone(): string {
    return this.config.get<string>('INVOICE_TIMEZONE') ?? DEFAULT_TIMEZONE;
  }

  private get taxRateBps(): number {
    const value = Number(this.config.get<string>('INVOICE_TAX_RATE_BPS') ?? 0);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  }

  private get taxLabel(): string {
    return this.config.get<string>('INVOICE_TAX_LABEL') ?? DEFAULT_TAX_LABEL;
  }

  /** Who the invoice is from. All optional; a missing line is simply not printed. */
  private get seller(): InvoiceSeller {
    const address = this.config.get<string>('INVOICE_SELLER_ADDRESS') ?? '';
    return {
      name:
        this.config.get<string>('INVOICE_SELLER_NAME') ??
        'Drasken Labs Private Limited',
      // Pipe-separated, because an environment variable has no newlines.
      addressLines: address
        .split('|')
        .map((line) => line.trim())
        .filter(Boolean),
      email:
        this.config.get<string>('INVOICE_SELLER_EMAIL') ??
        this.config.get<string>('SES_REPLY_TO') ??
        undefined,
      website: this.config.get<string>('INVOICE_SELLER_WEBSITE'),
      gstin: this.config.get<string>('INVOICE_SELLER_GSTIN'),
      pan: this.config.get<string>('INVOICE_SELLER_PAN'),
      registrationNumber: this.config.get<string>('INVOICE_SELLER_CIN'),
    };
  }
}
