import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
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

/** What one delivery attempt came to. Written verbatim to `MailLog.status`. */
type MailOutcome = 'sent' | 'failed' | 'suppressed' | 'skipped';

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

/**
 * Retries after the first attempt before a message is given up on. SES is
 * usually down for minutes, not hours, so three tries over roughly two and a
 * half hours covers a blip without mailing someone yesterday's news.
 */
export const MAX_MAIL_RETRIES = 3;

/** Minutes to wait before attempt 2, 3 and 4. */
const BACKOFF_MINUTES = [5, 30, 120];

/**
 * How long a claimed row is held before another replica may take it. Longer
 * than a send takes, short enough that a pod killed mid-send is not a message
 * lost for the afternoon.
 */
const LEASE_MINUTES = 10;

/** When the next attempt is due, or null once there are none left. */
function nextRetryAt(attempts: number, now: Date): Date | null {
  const wait = BACKOFF_MINUTES[attempts - 1];
  if (wait === undefined) return null;
  return new Date(now.getTime() + wait * 60_000);
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
      const outcome = await this.attempt(recipient, options);
      await this.log(
        recipient,
        options,
        outcome.status,
        outcome.messageId,
        outcome.error,
      );
      return outcome.status === 'sent';
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Could not send ${options.template}: ${detail}`);
      return false;
    }
  }

  /**
   * One delivery attempt: the checks, the layout and the SES call, with no
   * logging. Shared by the first send and every retry, so a retry cannot skip
   * a suppression that landed in between.
   */
  private async attempt(
    recipient: Recipient,
    options: SendOptions,
  ): Promise<{ status: MailOutcome; messageId?: string; error?: string }> {
    if (await this.isSuppressed(recipient.email))
      return { status: 'suppressed' };
    if (!(await this.wants(recipient.userId, options.kind))) {
      return { status: 'skipped' };
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

    return result.ok
      ? { status: 'sent', messageId: result.messageId }
      : { status: 'failed', error: result.error };
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
    const failed = status === 'failed';
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
          attempts: 1,
          // Only a failure is worth keeping the content for: it is the one
          // outcome another attempt could change.
          ...(failed
            ? {
                retryAt: nextRetryAt(1, new Date()),
                payload: {
                  recipient,
                  options,
                } as unknown as Prisma.InputJsonValue,
              }
            : {}),
        },
      });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Could not record mail log: ${detail}`);
    }
  }

  /* ---------------------------------------------------------------- *
   * Retry                                                             *
   * ---------------------------------------------------------------- */

  /**
   * Try again on the sends that failed and are due another attempt.
   *
   * A failed send used to end there: the row said what went wrong and nothing
   * ever acted on it, so a support request lost to a network blip was lost for
   * good. Each attempt goes through the ordinary send path, so an address
   * suppressed since the failure, or a preference switched off in the
   * meantime, is honoured rather than overridden by a queue.
   *
   * Every row is claimed before it is sent, because the API runs more than one
   * replica and each of them runs this timer: without the claim, two pods pick
   * up the same failed row in the same tick and the recipient gets it twice.
   *
   * Returns what happened, for the scheduler's log.
   */
  async retryFailed(
    limit = 50,
  ): Promise<{ retried: number; sent: number; abandoned: number }> {
    const result = { retried: 0, sent: 0, abandoned: 0 };
    if (!this.ses.enabled) return result;

    const now = new Date();
    const due = await this.prisma.mailLog.findMany({
      where: { status: 'failed', retryAt: { not: null, lte: now } },
      orderBy: { retryAt: 'asc' },
      take: limit,
    });

    for (const row of due) {
      try {
        await this.retryRow(row, result, now);
      } catch (err: unknown) {
        // One unreadable row must not stop the sweep clearing the rest.
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Retry of mail log ${row.id} failed: ${detail}`);
      }
    }

    return result;
  }

  /** One row's retry, split out so a failure is contained to that row. */
  private async retryRow(
    row: {
      id: number;
      kind: string;
      email: string;
      attempts: number;
      payload: unknown;
    },
    result: { retried: number; sent: number; abandoned: number },
    now: Date,
  ): Promise<void> {
    // Compare-and-set: only the replica whose update matches gets to send.
    // The lease also covers a pod that dies mid-send — the row falls due again
    // rather than being stuck as "being retried" forever.
    const claimed = await this.prisma.mailLog.updateMany({
      where: { id: row.id, status: 'failed', retryAt: { lte: now } },
      data: { retryAt: new Date(now.getTime() + LEASE_MINUTES * 60_000) },
    });
    if (claimed.count === 0) return;

    const parsed = this.parsePayload(row.payload);
    if (!parsed) {
      // Nothing to rebuild the message from — a row written before retries
      // existed, or one whose payload was cleared. Settle it rather than
      // asking again every five minutes forever.
      await this.settle(row.id, 'abandoned', row.attempts, 'no payload');
      result.abandoned++;
      return;
    }

    result.retried++;
    const attempts = row.attempts + 1;
    const outcome = await this.attempt(parsed.recipient, parsed.options);

    if (outcome.status === 'sent') {
      await this.settle(row.id, 'sent', attempts, null, outcome.messageId);
      result.sent++;
      return;
    }
    // Suppressed or switched off since the failure: settled, not retried.
    if (outcome.status !== 'failed') {
      await this.settle(row.id, outcome.status, attempts);
      result.abandoned++;
      return;
    }

    const retryAt =
      attempts > MAX_MAIL_RETRIES ? null : nextRetryAt(attempts, now);
    if (!retryAt) {
      await this.settle(row.id, 'abandoned', attempts, outcome.error);
      result.abandoned++;
      this.logger.error(
        `Gave up on ${row.kind} to ${row.email} after ${attempts} attempts: ${outcome.error ?? 'unknown error'}`,
      );
      return;
    }
    await this.prisma.mailLog.update({
      where: { id: row.id },
      data: { attempts, retryAt, error: outcome.error ?? null },
    });
  }

  /** Write a row's final state, dropping the content it no longer needs. */
  private async settle(
    id: number,
    status: string,
    attempts: number,
    error?: string | null,
    messageId?: string,
  ): Promise<void> {
    await this.prisma.mailLog.update({
      where: { id },
      data: {
        status,
        attempts,
        retryAt: null,
        payload: Prisma.DbNull,
        ...(messageId ? { messageId } : {}),
        ...(error !== undefined ? { error } : {}),
      },
    });
  }

  /** A stored payload, or null when it is not the shape we wrote. */
  private parsePayload(
    payload: unknown,
  ): { recipient: Recipient; options: SendOptions } | null {
    if (!payload || typeof payload !== 'object') return null;
    const { recipient, options } = payload as {
      recipient?: Recipient;
      options?: SendOptions;
    };
    if (!recipient?.email || !options?.subject || !options?.template)
      return null;
    return { recipient, options };
  }
}
