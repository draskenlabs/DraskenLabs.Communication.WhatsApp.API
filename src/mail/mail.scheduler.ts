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

  /**
   * N5/N6 — yesterday, in one email.
   *
   * This is the only thing that reports a failed send. Nothing is mailed or
   * pushed as messages fail any more: a bad campaign can fail hundreds in a
   * row, and per-failure alerts made that a stream of interruptions about
   * something nobody can act on one message at a time. The same email carries
   * what was sent and what came back, so a quiet day is one email and a bad day
   * is still one email.
   */
  @Cron('0 8 * * *', { name: 'mail-daily-summary' })
  async sendDailySummary(): Promise<void> {
    if (!this.mail.enabled) return;

    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const wanted = await this.prisma.notificationPreference.findMany({
        where: { emailDailySummary: true },
        select: { userId: true },
      });
      // A user with no preference row has the schema's defaults, and the daily
      // summary is one of them — so they are candidates too, or the people who
      // never touched their settings would silently stop hearing about
      // failures.
      const configured = new Set(wanted.map((w) => w.userId));
      const unconfigured = await this.prisma.user.findMany({
        where: { email: { not: null }, NotificationPreference: { is: null } },
        select: { id: true },
      });
      const userIds = [
        ...configured,
        ...unconfigured.map((u) => u.id).filter((id) => !configured.has(id)),
      ];
      if (userIds.length === 0) return;

      const recipients = await this.mail.recipientsByIds(userIds);

      for (const recipient of recipients) {
        const activity = await this.activitySince(recipient.userId, since);

        // A day where nothing happened is not worth an email.
        if (
          activity.sent === 0 &&
          activity.failed === 0 &&
          activity.inbound === 0
        ) {
          continue;
        }

        await this.mail.sendTo(recipient, {
          kind: 'emailDailySummary',
          template: 'summary.daily',
          subject: activity.failed
            ? `Yesterday on WhatsApp — ${activity.failed} failed to deliver`
            : 'Yesterday on WhatsApp',
          heading: 'Yesterday on your account',
          intro: activity.failed
            ? 'Here is yesterday, including the messages WhatsApp could not deliver.'
            : 'Here is what happened on your account yesterday.',
          facts: [
            ['Messages sent', String(activity.sent)],
            ['Failed to deliver', String(activity.failed)],
            ['Replies received', String(activity.inbound)],
          ],
          paragraphs: activity.failed
            ? [
                'Open the console to see which messages failed and why. A run of failures usually points at one cause — an expired template, a number that has opted out, or a messaging limit.',
              ]
            : undefined,
          action: { label: 'Open the console', path: '/dashboard' },
          footnote:
            'You are receiving this because the daily summary is on in your notification settings.',
        });
      }
    } catch (err: unknown) {
      this.logger.error(`Daily summary failed: ${this.reason(err)}`);
    }
  }

  /** What one person's account did in a window. */
  private async activitySince(
    userId: number,
    since: Date,
  ): Promise<{ sent: number; failed: number; inbound: number }> {
    const [sent, failed, wabas] = await Promise.all([
      this.prisma.message.count({ where: { userId, createdAt: { gte: since } } }),
      this.prisma.message.count({
        where: { userId, status: 'failed', createdAt: { gte: since } },
      }),
      this.prisma.userWhatsapp.findMany({
        where: { userId },
        select: { wabaId: true },
      }),
    ]);

    const wabaIds = wabas.map((w) => w.wabaId);
    const inbound = wabaIds.length
      ? await this.prisma.inboundMessage.count({
          where: { wabaId: { in: wabaIds }, createdAt: { gte: since } },
        })
      : 0;

    return { sent, failed, inbound };
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
