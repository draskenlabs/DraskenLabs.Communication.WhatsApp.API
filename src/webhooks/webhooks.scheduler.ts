import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { RetentionService } from './retention.service';

/**
 * The scheduled half of outbound webhooks.
 *
 * `enqueue` writes rows and returns; this is what actually posts them. Every
 * minute rather than every five, unlike the mail sweep: an integration reacting
 * to a customer's reply is doing it while the customer is still there, so the
 * first attempt has to be close to immediate. The backoff carries the waiting
 * after that.
 */
@Injectable()
export class WebhooksScheduler {
  private readonly logger = new Logger(WebhooksScheduler.name);

  constructor(
    private readonly dispatcher: WebhookDispatcherService,
    private readonly retention: RetentionService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'webhook-delivery' })
  async deliverDue(): Promise<void> {
    try {
      const { attempted, sent, abandoned } = await this.dispatcher.sweep();
      if (attempted === 0) return;
      this.logger.log(
        `Webhook deliveries: ${attempted} attempted, ${sent} delivered, ${abandoned} given up on`,
      );
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Webhook delivery sweep failed: ${detail}`);
    }
  }

  /**
   * Retention, nightly and off-peak.
   *
   * Raw events and the delivery log both hold customer message content, and
   * the Privacy Policy puts a window on them; message history is held to
   * whatever window the organisation's plan names. Left to run for ever,
   * "30-day history" is a line on a pricing page and nothing else.
   */
  @Cron('30 3 * * *', { name: 'retention-sweep' })
  async pruneExpired(): Promise<void> {
    try {
      const { events, deliveries, messages, inbound } = await this.retention.sweep();
      if (!events && !deliveries && !messages && !inbound) return;
      this.logger.log(
        `Retention: removed ${events} webhook events, ${deliveries} deliveries, ` +
          `${messages} sent and ${inbound} received messages`,
      );
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Retention sweep failed: ${detail}`);
    }
  }
}
