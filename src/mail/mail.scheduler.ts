import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailService } from './mail.service';

/** How long an account may sit without a WABA before we offer help. */
const STALLED_AFTER_DAYS = 3;

/**
 * The scheduled half of email: batching what would otherwise be a message per
 * event, and the periodic summaries.
 *
 * Every job is guarded on `mail.enabled`, so a deployment without SES
 * configured runs these as no-ops rather than failing on a timer.
 */
@Injectable()
export class MailScheduler {
  private readonly logger = new Logger(MailScheduler.name);

  constructor(
    private readonly mail: MailService,
    private readonly prisma: PrismaService,
  ) {}

  /** N5/N6 — batched failed sends and inbound replies. */
  @Cron(CronExpression.EVERY_HOUR, { name: 'mail-digests' })
  async sendDigests(): Promise<void> {
    if (!this.mail.enabled) return;
    try {
      const { failed, inbound } = await this.mail.flushDigests();
      if (failed || inbound) {
        this.logger.log(
          `Digests sent — failed sends: ${failed}, inbound: ${inbound}`,
        );
      }
    } catch (err: unknown) {
      this.logger.error(`Digest flush failed: ${this.reason(err)}`);
    }
  }

  /** N7 — Monday morning summary of the week just gone. */
  @Cron('0 8 * * 1', { name: 'mail-weekly-summary' })
  async sendWeeklySummary(): Promise<void> {
    if (!this.mail.enabled) return;

    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const wanted = await this.prisma.notificationPreference.findMany({
        where: { emailWeeklySummary: true },
        select: { userId: true },
      });
      if (wanted.length === 0) return;

      const recipients = await this.mail.recipientsByIds(
        wanted.map((w) => w.userId),
      );

      for (const recipient of recipients) {
        const [sent, failed, wabas] = await Promise.all([
          this.prisma.message.count({
            where: { userId: recipient.userId, createdAt: { gte: since } },
          }),
          this.prisma.message.count({
            where: {
              userId: recipient.userId,
              status: 'failed',
              createdAt: { gte: since },
            },
          }),
          this.prisma.userWhatsapp.findMany({
            where: { userId: recipient.userId },
            select: { wabaId: true },
          }),
        ]);

        const wabaIds = wabas.map((w) => w.wabaId);
        const [inbound, decided] = await Promise.all([
          wabaIds.length
            ? this.prisma.inboundMessage.count({
                where: { wabaId: { in: wabaIds }, createdAt: { gte: since } },
              })
            : 0,
          wabaIds.length
            ? this.prisma.messageTemplate.count({
                where: { wabaId: { in: wabaIds }, updatedAt: { gte: since } },
              })
            : 0,
        ]);

        // A week where nothing happened is not worth an email.
        if (sent === 0 && inbound === 0 && decided === 0) continue;

        await this.mail.sendTo(recipient, {
          kind: 'emailWeeklySummary',
          template: 'summary.weekly',
          subject: 'Your WhatsApp week',
          heading: 'Your week on WhatsApp',
          intro:
            'Here is what happened on your account over the last seven days.',
          facts: [
            ['Messages sent', String(sent)],
            ['Failed to deliver', String(failed)],
            ['Replies received', String(inbound)],
            ['Templates changed', String(decided)],
          ],
          action: { label: 'Open the console', path: '/dashboard' },
          footnote:
            'You are receiving this because the weekly summary is on in your notification settings.',
        });
      }
    } catch (err: unknown) {
      this.logger.error(`Weekly summary failed: ${this.reason(err)}`);
    }
  }

  /** M2 — signed up, never connected an account. Sent once. */
  @Cron(CronExpression.EVERY_DAY_AT_9AM, { name: 'mail-onboarding-stalled' })
  async sendStalledOnboarding(): Promise<void> {
    if (!this.mail.enabled) return;

    try {
      const cutoff = new Date(
        Date.now() - STALLED_AFTER_DAYS * 24 * 60 * 60 * 1000,
      );
      const candidates = await this.prisma.user.findMany({
        where: {
          createdAt: { lte: cutoff },
          email: { not: null },
          UserWhatsapp: { none: {} },
        },
        select: { id: true },
        take: 200,
      });
      if (candidates.length === 0) return;

      // Sent once ever: the MailLog is the record, so nobody is nagged weekly.
      const already = await this.prisma.mailLog.findMany({
        where: {
          userId: { in: candidates.map((c) => c.id) },
          kind: 'onboarding.stalled',
        },
        select: { userId: true },
      });
      const seen = new Set(already.map((row) => row.userId));
      const recipients = await this.mail.recipientsByIds(
        candidates.map((c) => c.id).filter((id) => !seen.has(id)),
      );

      for (const recipient of recipients) {
        await this.mail.sendTo(recipient, {
          kind: 'emailProductNews',
          template: 'onboarding.stalled',
          subject: 'Need a hand connecting WhatsApp?',
          heading: 'Your account is ready, but not connected yet',
          intro:
            'You created a WhatsApp Console account but have not connected a WhatsApp Business Account. Connecting takes a few minutes and happens entirely through Meta.',
          paragraphs: [
            'If something blocked you — business verification, a phone number already in use, or a permission you could not grant — reply to this email and we will help.',
          ],
          action: { label: 'Connect an account', path: '/connect' },
          footnote:
            'You are receiving this once because your account has no connected WhatsApp Business Account.',
        });
      }
    } catch (err: unknown) {
      this.logger.error(`Stalled-onboarding mail failed: ${this.reason(err)}`);
    }
  }

  private reason(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
