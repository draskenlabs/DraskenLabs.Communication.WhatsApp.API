import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { SesService } from './ses.service';
import { layout } from './mail.templates';

/**
 * Which email a message belongs to. The `email*` keys map to columns on
 * NotificationPreference; `transactional` is never suppressed by preference
 * because it reports something the account holder did or must know about.
 */
export type MailKind =
  | 'transactional'
  | 'emailTemplateStatus'
  | 'emailDailySummary'
  | 'emailWeeklySummary'
  | 'emailProductNews';

/** The preference columns an unsubscribe link may switch off. */
const UNSUBSCRIBABLE = new Set<string>([
  'emailTemplateStatus',
  'emailDailySummary',
  'emailWeeklySummary',
  'emailProductNews',
]);

interface Recipient {
  userId: number;
  email: string;
  firstName: string | null;
}

interface SendOptions {
  kind: MailKind;
  /** Template key recorded in MailLog, e.g. "template.status". */
  template: string;
  subject: string;
  heading: string;
  intro: string;
  facts?: [string, string][];
  paragraphs?: string[];
  action?: { label: string; path: string };
  footnote?: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ses: SesService,
    private readonly config: ConfigService,
  ) {}

  get enabled(): boolean {
    return this.ses.enabled;
  }

  /* ---------------------------------------------------------------- *
   * Recipients                                                        *
   * ---------------------------------------------------------------- */

  /** The people who connected a WABA — the ones holding its credentials. */
  async recipientsForWaba(wabaId: string): Promise<Recipient[]> {
    const connections = await this.prisma.userWhatsapp.findMany({
      where: { wabaId },
      select: { userId: true },
    });
    const userIds = [...new Set(connections.map((c) => c.userId))];
    return this.recipientsByIds(userIds);
  }

  async recipientsByIds(userIds: number[]): Promise<Recipient[]> {
    if (userIds.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds }, email: { not: null } },
      select: { id: true, email: true, firstName: true },
    });
    return users.map((u) => ({
      userId: u.id,
      email: u.email as string,
      firstName: u.firstName,
    }));
  }

  /* ---------------------------------------------------------------- *
   * Sending                                                           *
   * ---------------------------------------------------------------- */

  /**
   * Send to one recipient, honouring their preferences and the suppression
   * list, and record the outcome. Never throws.
   */
  async sendTo(recipient: Recipient, options: SendOptions): Promise<boolean> {
    if (!this.ses.enabled) return false;

    try {
      if (await this.isSuppressed(recipient.email)) {
        await this.log(recipient, options, 'suppressed');
        return false;
      }
      if (!(await this.wants(recipient.userId, options.kind))) {
        await this.log(recipient, options, 'skipped');
        return false;
      }

      const unsubscribeUrl =
        options.kind === 'transactional'
          ? undefined
          : this.unsubscribeUrl(recipient.userId, options.kind);

      const { html, text } = layout({
        heading: options.heading,
        intro: options.intro,
        facts: options.facts,
        paragraphs: options.paragraphs,
        action: options.action
          ? {
              label: options.action.label,
              url: this.appUrl(options.action.path),
            }
          : undefined,
        footnote: options.footnote,
        unsubscribeUrl,
      });

      const result = await this.ses.send({
        to: recipient.email,
        subject: options.subject,
        html,
        text,
        unsubscribeUrl,
      });

      await this.log(
        recipient,
        options,
        result.ok ? 'sent' : 'failed',
        result.messageId,
        result.error,
      );
      return result.ok;
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Could not send ${options.template}: ${detail}`);
      return false;
    }
  }

  /** Send the same message to several people. */
  async sendToAll(
    recipients: Recipient[],
    options: SendOptions,
  ): Promise<number> {
    let sent = 0;
    for (const recipient of recipients) {
      if (await this.sendTo(recipient, options)) sent++;
    }
    return sent;
  }

  /** Send to an address with no account behind it — a support acknowledgement. */
  async sendRaw(
    email: string,
    options: Omit<SendOptions, 'kind'> & { kind?: MailKind },
  ): Promise<boolean> {
    return this.sendTo(
      { userId: 0, email, firstName: null },
      { ...options, kind: options.kind ?? 'transactional' },
    );
  }

  /* ---------------------------------------------------------------- *
   * Preferences, suppression and unsubscribe                          *
   * ---------------------------------------------------------------- */

  /** Transactional mail always goes; the rest respects the stored preference. */
  private async wants(userId: number, kind: MailKind): Promise<boolean> {
    if (kind === 'transactional' || userId === 0) return true;
    const row = await this.prisma.notificationPreference.findUnique({
      where: { userId },
    });
    // No row means defaults, which the schema already encodes.
    if (!row) {
      return kind === 'emailTemplateStatus' || kind === 'emailDailySummary';
    }
    return row[kind];
  }

  async isSuppressed(email: string): Promise<boolean> {
    const row = await this.prisma.mailSuppression.findUnique({
      where: { email: email.toLowerCase() },
    });
    return row !== null;
  }

  /** Record a bounce, complaint or unsubscribe so we stop mailing an address. */
  async suppress(
    email: string,
    reason: string,
    detail?: string,
  ): Promise<void> {
    const address = email.toLowerCase();
    await this.prisma.mailSuppression.upsert({
      where: { email: address },
      create: { email: address, reason, detail: detail ?? null },
      update: { reason, detail: detail ?? null },
    });
    this.logger.log(`Suppressed ${address} (${reason})`);
  }

  /**
   * A signed link, so an unsubscribe needs no session — people click these
   * from a mail client, often on another device.
   */
  unsubscribeUrl(userId: number, kind: MailKind): string {
    const token = this.signUnsubscribe(userId, kind);
    return this.appUrl(
      `/unsubscribe?u=${userId}&k=${encodeURIComponent(kind)}&t=${token}`,
    );
  }

  private signUnsubscribe(userId: number, kind: MailKind): string {
    const secret = this.config.getOrThrow<string>('JWT_SECRET');
    return createHmac('sha256', secret)
      .update(`${userId}:${kind}`)
      .digest('hex');
  }

  /** Constant-time check, so the token cannot be guessed a byte at a time. */
  verifyUnsubscribe(userId: number, kind: string, token: string): boolean {
    const expected = this.signUnsubscribe(userId, kind as MailKind);
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Turn one kind off for a user, or suppress the address entirely. */
  async applyUnsubscribe(userId: number, kind: string): Promise<void> {
    if (kind === 'all') {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (user?.email) await this.suppress(user.email, 'unsubscribe');
      return;
    }
    // A kind we no longer send is a link already sitting in somebody's inbox,
    // signed and still valid. Writing it would fail on a column that is gone,
    // so it succeeds quietly instead: "you will not receive that kind of email
    // again" is true — we stopped sending it altogether.
    if (!UNSUBSCRIBABLE.has(kind)) return;

    await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, [kind]: false },
      update: { [kind]: false },
    });
  }

  /* ---------------------------------------------------------------- *
   * Helpers                                                           *
   * ---------------------------------------------------------------- */

  /** Absolute URL into the console, for links in emails. */
  appUrl(path: string): string {
    const base = (this.config.get<string>('APP_BASE_URL') ?? '').replace(
      /\/$/,
      '',
    );
    return `${base}${path}`;
  }

  private async log(
    recipient: Recipient,
    options: SendOptions,
    status: string,
    messageId?: string,
    error?: string,
  ): Promise<void> {
    try {
      await this.prisma.mailLog.create({
        data: {
          userId: recipient.userId || null,
          email: recipient.email,
          kind: options.template,
          subject: options.subject,
          status,
          messageId: messageId ?? null,
          error: error ?? null,
        },
      });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not record mail log: ${detail}`);
    }
  }
}
