import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Invoice, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { OrgDirectoryService } from 'src/org/org-directory.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import {
  financialYear,
  financialYearLabel,
  invoiceNumber,
} from './invoice.number';
import { InvoiceSeller, formatAmount, renderInvoicePdf } from './invoice.pdf';
import { InvoiceDto } from './dto/billing.dto';

/** What a captured debit tells us, gathered where the payment was recorded. */
export interface InvoiceRequest {
  /** The stored debit, so the document and the row can be joined. */
  paymentId: number | null;
  razorpayPaymentId: string;
  razorpayInvoiceId: string | null;

  subscriptionId: number;
  ssoOrgId: string;
  wabaId: string | null;
  /** Who took the subscription out — the person the invoice goes to. */
  userId: number;

  accountName: string | null;
  planName: string | null;

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

/** Defaults, so a deployment that configures nothing still raises invoices. */
const DEFAULT_SERIES = 'WAC';
const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_TAX_LABEL = 'GST';

/**
 * Invoices.
 *
 * A subscription used to leave nothing behind but a row in Razorpay's
 * dashboard, and a payment id no accountant can enter in a return. This raises
 * a numbered document for every captured debit, in our own series
 * — `INV-WAC-2627-0001` — and mails it to the person who took the subscription
 * out, with the PDF attached.
 *
 * Two properties this is built around, because they are the ones an audit
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
  async issueFor(request: InvoiceRequest): Promise<Invoice | null> {
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
  private async record(request: InvoiceRequest): Promise<Invoice | null> {
    const existing = await this.prisma.invoice.findUnique({
      where: { razorpayPaymentId: request.razorpayPaymentId },
    });
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
            wabaId: request.wabaId,
            billedToName,
            billedToEmail: user?.email ?? null,
            organisationName,
            accountName: request.accountName,
            planName: request.planName,
            description: this.describe(request),
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
          },
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
        return this.prisma.invoice.findUnique({
          where: { razorpayPaymentId: request.razorpayPaymentId },
        });
      }
      throw err;
    }
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

  /** The single line item, in the words the customer recognises. */
  private describe(request: InvoiceRequest): string {
    const plan = request.planName ? `${request.planName} plan` : 'Subscription';
    return request.accountName
      ? `${plan} — ${request.accountName}`
      : `${plan} — WhatsApp Business Account`;
  }

  /* ---------------------------------------------------------------- *
   * Sending                                                           *
   * ---------------------------------------------------------------- */

  /**
   * Mail an invoice to the address on it, with the PDF attached, and record
   * that it went.
   *
   * A send that fails is left un-stamped rather than retried here: MailService
   * already retries a failed message on its own schedule, and `resend` below
   * covers the case where the row never reached it at all.
   */
  async deliver(invoice: Invoice): Promise<boolean> {
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
      accountName: invoice.accountName,
      planName: invoice.planName,
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

  /** Every invoice an organisation has, newest first. */
  async listForOrg(ssoOrgId: string, take = 60): Promise<Invoice[]> {
    return this.prisma.invoice.findMany({
      where: { ssoOrgId },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take,
    });
  }

  /**
   * One invoice, by number, scoped to the organisation asking.
   *
   * The scope is the point: the numbers are sequential, so an unscoped lookup
   * would let anyone with a session walk the whole series.
   */
  async findForOrg(ssoOrgId: string, number: string): Promise<Invoice | null> {
    const invoice = await this.prisma.invoice.findUnique({ where: { number } });
    return invoice?.ssoOrgId === ssoOrgId ? invoice : null;
  }

  /** The console's shape of an invoice: the snapshot, and nothing internal. */
  toDto(invoice: Invoice): InvoiceDto {
    return {
      number: invoice.number,
      financialYear: invoice.financialYear,
      issuedAt: invoice.issuedAt,
      paidAt: invoice.paidAt,
      organisationName: invoice.organisationName,
      accountName: invoice.accountName,
      planName: invoice.planName,
      description: invoice.description,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      subtotal: invoice.subtotal,
      taxAmount: invoice.taxAmount,
      taxRateBps: invoice.taxRateBps,
      taxLabel: invoice.taxLabel,
      total: invoice.total,
      currency: invoice.currency,
      emailedAt: invoice.emailedAt,
      emailedTo: invoice.emailedTo,
      razorpayPaymentId: invoice.razorpayPaymentId,
    };
  }

  /** The document itself. */
  pdf(invoice: Invoice): Buffer {
    return renderInvoicePdf(
      {
        number: invoice.number,
        financialYearLabel: financialYearLabel(invoice.financialYear),
        issuedAt: invoice.issuedAt,
        paidAt: invoice.paidAt,
        billedToName: invoice.billedToName,
        billedToEmail: invoice.billedToEmail,
        organisationName: invoice.organisationName,
        accountName: invoice.accountName,
        description: invoice.description,
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
