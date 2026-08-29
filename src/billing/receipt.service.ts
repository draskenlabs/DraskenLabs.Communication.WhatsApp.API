import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Receipt } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  financialYear,
  financialYearLabel,
  isReceiptNumber,
  receiptNumber,
} from './invoice.number';
import type { InvoiceSeller } from './invoice.pdf';
import { renderReceiptPdf } from './receipt.pdf';
import type { InvoiceWithLines } from './invoice.service';
import { ReceiptDto } from './dto/billing.dto';

/** Defaults, so a deployment that configures nothing still issues receipts. */
const DEFAULT_SERIES = 'WAC';
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/**
 * Receipts.
 *
 * An invoice says what is owed; a receipt says what was received. On a prepaid
 * subscription both become true at the same instant, which is exactly why they
 * are two documents rather than one: a customer proving payment — to a
 * financier, an auditor, their own accounts team — needs the document that says
 * *received*, and an invoice that also claims to be a receipt is neither.
 *
 * One per invoice, raised in the same transaction as the invoice so the pair
 * cannot come apart, and numbered from its own counter so that a receipt can
 * never punch a gap in the invoice series.
 *
 * Nothing here throws at its caller. A receipt is raised on the back of money
 * that has already moved, and failing a webhook over a document would have
 * Razorpay redeliver the charge instead.
 */
@Injectable()
export class ReceiptService {
  private readonly logger = new Logger(ReceiptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Write the receipt for an invoice inside the transaction that wrote it.
   *
   * Takes the transaction client rather than opening its own: an invoice
   * without its receipt is a customer who cannot prove they paid, and the two
   * must commit or roll back together.
   */
  async recordIn(
    tx: Prisma.TransactionClient,
    invoice: {
      id: number;
      number: string;
      ssoOrgId: string;
      razorpayPaymentId: string;
      billedToName: string | null;
      billedToEmail: string | null;
      organisationName: string | null;
      summary: string | null;
      total: number;
      currency: string;
      paymentMethod: string | null;
      issuedAt: Date;
      paidAt: Date | null;
    },
  ): Promise<Receipt> {
    const year = financialYear(
      invoice.paidAt ?? invoice.issuedAt,
      this.timeZone,
    );
    const sequence = await this.nextSequence(tx, year);

    return tx.receipt.create({
      data: {
        number: receiptNumber(this.series, year, sequence),
        financialYear: year,
        sequence,
        invoiceId: invoice.id,
        razorpayPaymentId: invoice.razorpayPaymentId,
        ssoOrgId: invoice.ssoOrgId,
        billedToName: invoice.billedToName,
        billedToEmail: invoice.billedToEmail,
        organisationName: invoice.organisationName,
        summary: invoice.summary,
        // What was received is the whole debit. A receipt does not divide into
        // tax — the heads are stated on the invoice it points at.
        amount: invoice.total,
        currency: invoice.currency,
        paymentMethod: invoice.paymentMethod,
        paymentReference: invoice.razorpayPaymentId,
        issuedAt: invoice.issuedAt,
        receivedAt: invoice.paidAt,
      },
    });
  }

  /**
   * The next number in a financial year's series.
   *
   * One statement, so the read and the increment cannot be separated by
   * another transaction, and its own table: sharing the invoice counter would
   * mean a receipt rolled back takes an invoice number with it.
   */
  private async nextSequence(
    tx: Prisma.TransactionClient,
    year: string,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ sequence: number }[]>`
      INSERT INTO "ReceiptCounter" ("financialYear", "nextSequence", "updatedAt")
      VALUES (${year}, 2, NOW())
      ON CONFLICT ("financialYear") DO UPDATE
        SET "nextSequence" = "ReceiptCounter"."nextSequence" + 1,
            "updatedAt" = NOW()
      RETURNING "nextSequence" - 1 AS sequence
    `;
    const sequence = Number(rows[0]?.sequence);
    if (!Number.isFinite(sequence) || sequence < 1) {
      throw new Error(`Receipt counter returned nothing for ${year}`);
    }
    return sequence;
  }

  /* ---------------------------------------------------------------- *
   * Reading                                                           *
   * ---------------------------------------------------------------- */

  /** Every receipt issued to an organisation, newest first. */
  async listForOrg(ssoOrgId: string, take = 60): Promise<Receipt[]> {
    return this.prisma.receipt.findMany({
      where: { ssoOrgId },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take,
    });
  }

  /** Every receipt an agency should see: its own, and its clients'. */
  async listForAgency(
    agencyOrgId: string,
    clientOrgIds: string[],
    take = 120,
  ): Promise<Receipt[]> {
    return this.prisma.receipt.findMany({
      where: { ssoOrgId: { in: [agencyOrgId, ...clientOrgIds] } },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take,
    });
  }

  /**
   * One receipt, for an organisation it was actually issued to.
   *
   * Strict, like the invoice's own PDF lookup: the numbers are sequential, so
   * an unscoped lookup would let anyone with a session walk the series.
   */
  async findAddressedTo(
    allowed: string[],
    number: string,
  ): Promise<Receipt | null> {
    if (!isReceiptNumber(number)) return null;
    const receipt = await this.prisma.receipt.findUnique({ where: { number } });
    return receipt && allowed.includes(receipt.ssoOrgId) ? receipt : null;
  }

  /** Unscoped, for the operator console only. */
  async find(number: string): Promise<Receipt | null> {
    if (!isReceiptNumber(number)) return null;
    return this.prisma.receipt.findUnique({ where: { number } });
  }

  /** The receipt raised for an invoice, if one was. */
  async forInvoice(invoiceId: number): Promise<Receipt | null> {
    return this.prisma.receipt.findUnique({ where: { invoiceId } });
  }

  /* ---------------------------------------------------------------- *
   * Rendering                                                         *
   * ---------------------------------------------------------------- */

  /**
   * The document itself.
   *
   * Takes the invoice as well, for the customer's address and registration:
   * those live on the invoice, which is where they belong — a receipt states
   * who paid, and the invoice is what states who they are for tax.
   */
  pdf(receipt: Receipt, invoice: InvoiceWithLines | null): Buffer {
    return renderReceiptPdf(
      {
        number: receipt.number,
        financialYearLabel: financialYearLabel(receipt.financialYear),
        issuedAt: receipt.issuedAt,
        receivedAt: receipt.receivedAt,
        invoiceNumber: invoice?.number ?? '—',
        billedToName: receipt.billedToName,
        billedToEmail: receipt.billedToEmail,
        organisationName: receipt.organisationName,
        billedToAddress: invoice?.billedToAddress ?? null,
        billedToGstin: invoice?.billedToGstin ?? null,
        summary: receipt.summary,
        amount: receipt.amount,
        currency: receipt.currency,
        paymentMethod: receipt.paymentMethod,
        paymentReference: receipt.paymentReference,
      },
      this.seller,
    );
  }

  /** What the file is called when it lands in somebody's downloads. */
  filename(receipt: Receipt): string {
    return `${receipt.number}.pdf`;
  }

  /** The console's shape of a receipt. */
  toDto(receipt: Receipt, invoiceNumber: string | null): ReceiptDto {
    return {
      number: receipt.number,
      financialYear: receipt.financialYear,
      issuedAt: receipt.issuedAt,
      receivedAt: receipt.receivedAt,
      invoiceNumber,
      ssoOrgId: receipt.ssoOrgId,
      organisationName: receipt.organisationName,
      summary: receipt.summary,
      amount: receipt.amount,
      currency: receipt.currency,
      paymentMethod: receipt.paymentMethod,
      emailedAt: receipt.emailedAt,
      razorpayPaymentId: receipt.razorpayPaymentId,
    };
  }

  /* ---------------------------------------------------------------- *
   * Configuration                                                     *
   * ---------------------------------------------------------------- */

  /** The book this deployment writes in — the `WAC` in `RCT-WAC-2627-0001`. */
  private get series(): string {
    const value = (
      this.config.get<string>('INVOICE_SERIES') ?? DEFAULT_SERIES
    ).toUpperCase();
    return /^[A-Z0-9]{2,8}$/.test(value) ? value : DEFAULT_SERIES;
  }

  private get timeZone(): string {
    return this.config.get<string>('INVOICE_TIMEZONE') ?? DEFAULT_TIMEZONE;
  }

  /** Who the receipt is from. Shared with the invoice, so the pair agree. */
  private get seller(): InvoiceSeller {
    const address = this.config.get<string>('INVOICE_SELLER_ADDRESS') ?? '';
    return {
      name:
        this.config.get<string>('INVOICE_SELLER_NAME') ??
        'Drasken Labs Private Limited',
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
