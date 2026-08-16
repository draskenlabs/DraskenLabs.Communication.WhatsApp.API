import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

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

  constructor(private readonly dispatcher: WebhookDispatcherService) {}

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
}
