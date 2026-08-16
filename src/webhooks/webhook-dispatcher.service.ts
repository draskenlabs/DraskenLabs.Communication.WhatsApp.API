import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHmac } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { MailNotifications } from 'src/mail/mail.notifications';
import { DescribedEvent } from './event-describer';
import { TEST_EVENT } from './dto/webhook-endpoint.dto';

/** Attempts after the first. Five tries covers a deploy window. */
export const MAX_DELIVERY_RETRIES = 5;

/** Minutes to wait before attempts 2 through 6. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];

/**
 * How long a claimed row is held before another replica may take it. Longer
 * than a delivery can take (the HTTP timeout), short enough that a pod killed
 * mid-post is not an event stuck for the afternoon.
 */
const LEASE_MINUTES = 5;

/** Rows per sweep. A backlog drains over several sweeps rather than at once. */
const SWEEP_BATCH = 100;

/**
 * Consecutive give-ups before an endpoint is switched off.
 *
 * An endpoint whose host has been decommissioned would otherwise be retried
 * for every event forever, and each of those retries is a request we make to
 * somebody's server on a timer.
 */
const MAX_CONSECUTIVE_FAILURES = 10;

/** Enough of a failing body to recognise the error, not enough to store a page. */
const MAX_ERROR_LENGTH = 500;

/** The envelope we post. Stable across Meta's own payload changes. */
export interface OutboundPayload {
  /** Delivery id — the same value on every retry, for idempotency. */
  id: number;
  /** Event kind, or `endpoint.test`. */
  event: string;
  wabaId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface DeliveryOutcome {
  success: boolean;
  responseCode: number | null;
  error: string | null;
  durationMs: number;
}

/** The endpoint fields a delivery needs. */
interface DeliverableEndpoint {
  id: number;
  url: string;
  secret: string | null;
}

/** When the next attempt is due, or null once there are none left. */
function nextRetryAt(attempts: number, now: Date): Date | null {
  const wait = BACKOFF_MINUTES[attempts - 1];
  if (wait === undefined) return null;
  return new Date(now.getTime() + wait * 60_000);
}

/**
 * Posting events to customer endpoints.
 *
 * Deliberately an outbox rather than an inline call: Meta's POST is answered
 * with 200 in milliseconds, and a customer endpoint that takes thirty seconds
 * — or never answers — must not be able to hold that request open or lose the
 * event when we give up on it. `enqueue` writes rows; the sweep posts them.
 */
@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly mail: MailNotifications,
  ) {
    this.timeoutMs = Number(
      this.config.get<string>('WEBHOOK_DELIVERY_TIMEOUT_MS') ?? 10_000,
    );
  }

  /* ---------------------------------------------------------------- *
   * Queueing                                                          *
   * ---------------------------------------------------------------- */

  /**
   * Queue one Meta change for every endpoint listening to that account.
   *
   * Never throws: a customer's fan-out failing must not mark the event itself
   * as unprocessed, because our own handlers already ran.
   */
  async enqueue(
    wabaId: string,
    eventId: number,
    eventType: string,
    described: DescribedEvent,
    raw: unknown,
  ): Promise<void> {
    try {
      const endpoints = await this.prisma.webhookEndpoint.findMany({
        where: {
          wabaId,
          status: true,
          // An empty list is "every kind"; Postgres `has` is false for it, so
          // the two cases are asked for separately.
          OR: [
            { events: { isEmpty: true } },
            { events: { has: described.kind } },
          ],
        },
        select: { id: true },
      });
      if (endpoints.length === 0) return;

      const occurredAt = new Date();
      for (const endpoint of endpoints) {
        await this.prisma.webhookDelivery.create({
          data: {
            endpointId: endpoint.id,
            eventId,
            eventType: described.kind,
            // The id inside the envelope is the delivery's own, which is not
            // known until the row exists — it is filled in as the row is sent.
            payload: {
              event: described.kind,
              wabaId,
              occurredAt: occurredAt.toISOString(),
              data: { ...described, metaField: eventType, raw },
            } as object,
            status: 'pending',
            retryAt: occurredAt,
          },
        });
      }
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Could not queue webhook deliveries for ${wabaId}: ${detail}`,
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * Sweep                                                             *
   * ---------------------------------------------------------------- */

  /** Post everything that is due. Returns what it did, for the log line. */
  async sweep(): Promise<{
    attempted: number;
    sent: number;
    abandoned: number;
  }> {
    const now = new Date();
    const result = { attempted: 0, sent: 0, abandoned: 0 };

    const due = await this.prisma.webhookDelivery.findMany({
      where: { status: { in: ['pending', 'failed'] }, retryAt: { lte: now } },
      orderBy: { retryAt: 'asc' },
      take: SWEEP_BATCH,
      select: { id: true, attempts: true, status: true, endpointId: true },
    });

    for (const row of due) {
      try {
        await this.attemptRow(row, result, now);
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Webhook delivery ${row.id} failed to run: ${detail}`,
        );
      }
    }

    return result;
  }

  /** One row's attempt, split out so a failure is contained to that row. */
  private async attemptRow(
    row: { id: number; attempts: number; status: string; endpointId: number },
    result: { attempted: number; sent: number; abandoned: number },
    now: Date,
  ): Promise<void> {
    // Compare-and-set: only the replica whose update matches gets to post. The
    // lease also covers a pod that dies mid-post — the row falls due again
    // rather than being stuck as "being delivered" forever.
    const claimed = await this.prisma.webhookDelivery.updateMany({
      where: { id: row.id, status: row.status, retryAt: { lte: now } },
      data: { retryAt: new Date(now.getTime() + LEASE_MINUTES * 60_000) },
    });
    if (claimed.count === 0) return;

    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: row.id },
      include: {
        endpoint: {
          select: { id: true, url: true, secret: true, status: true },
        },
      },
    });
    if (!delivery) return;

    // Switched off between queueing and sending: settled, not delivered. An
    // endpoint someone disabled must stop receiving immediately, backlog
    // included.
    if (!delivery.endpoint.status) {
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'abandoned',
          retryAt: null,
          error: 'Endpoint disabled',
        },
      });
      result.abandoned++;
      return;
    }

    result.attempted++;
    const attempts = delivery.attempts + 1;
    const outcome = await this.post(
      delivery.endpoint,
      delivery.id,
      delivery.payload,
    );

    if (outcome.success) {
      await this.settleSent(
        delivery.id,
        delivery.endpointId,
        attempts,
        outcome,
      );
      result.sent++;
      return;
    }

    const retryAt =
      attempts > MAX_DELIVERY_RETRIES ? null : nextRetryAt(attempts, now);
    if (!retryAt) {
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'abandoned',
          attempts,
          retryAt: null,
          responseCode: outcome.responseCode,
          error: outcome.error,
          durationMs: outcome.durationMs,
        },
      });
      result.abandoned++;
      await this.recordEndpointFailure(delivery.endpointId);
      return;
    }

    await this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'failed',
        attempts,
        retryAt,
        responseCode: outcome.responseCode,
        error: outcome.error,
        durationMs: outcome.durationMs,
      },
    });
  }

  private async settleSent(
    deliveryId: number,
    endpointId: number,
    attempts: number,
    outcome: DeliveryOutcome,
  ): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'sent',
        attempts,
        retryAt: null,
        responseCode: outcome.responseCode,
        error: null,
        durationMs: outcome.durationMs,
      },
    });
    // A success clears the run of failures — the count is consecutive ones, so
    // an endpoint that fails on Monday and recovers on Tuesday starts over.
    await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { failureCount: 0, lastSuccessAt: new Date() },
    });
  }

  /**
   * Count a give-up against the endpoint, and switch it off once there have
   * been too many in a row.
   */
  private async recordEndpointFailure(endpointId: number): Promise<void> {
    const endpoint = await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { failureCount: { increment: 1 } },
      select: {
        id: true,
        url: true,
        userId: true,
        ssoOrgId: true,
        failureCount: true,
        status: true,
      },
    });

    if (!endpoint.status || endpoint.failureCount < MAX_CONSECUTIVE_FAILURES)
      return;

    await this.prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { status: false, disabledAt: new Date() },
    });
    this.logger.warn(
      `Disabled webhook endpoint ${endpoint.id} (${endpoint.url}) after ${endpoint.failureCount} consecutive failures`,
    );
    // Nobody watches the delivery log; the email is how they find out at all.
    void this.mail.webhookEndpointDisabled(
      endpoint.userId,
      endpoint.ssoOrgId,
      endpoint.url,
      endpoint.failureCount,
    );
  }

  /* ---------------------------------------------------------------- *
   * Test ping                                                         *
   * ---------------------------------------------------------------- */

  /**
   * Post a synthetic event and wait for the answer.
   *
   * The one delivery that is not queued: the point is to tell somebody staring
   * at the console whether their endpoint answers, so it has to happen inside
   * the request. It is logged like any other delivery, and never retried — a
   * test that failed is a test result, not a backlog.
   */
  async sendTest(endpoint: {
    id: number;
    url: string;
    secret: string | null;
    wabaId: string;
  }): Promise<{ outcome: DeliveryOutcome; deliveryId: number }> {
    const now = new Date();
    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        eventType: TEST_EVENT,
        payload: {
          event: TEST_EVENT,
          wabaId: endpoint.wabaId,
          occurredAt: now.toISOString(),
          data: {
            kind: 'account_update',
            title: 'Test event',
            detail:
              'This is a test delivery from the WhatsApp Console. No customer sent anything.',
          },
        } as object,
        status: 'pending',
        attempts: 1,
      },
    });

    const outcome = await this.post(endpoint, delivery.id, delivery.payload);

    await this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: outcome.success ? 'sent' : 'abandoned',
        retryAt: null,
        responseCode: outcome.responseCode,
        error: outcome.error,
        durationMs: outcome.durationMs,
      },
    });

    // A test that works is proof the endpoint is reachable now, which is worth
    // as much as a real delivery for the purpose of the failure count.
    if (outcome.success) {
      await this.prisma.webhookEndpoint.update({
        where: { id: endpoint.id },
        data: { failureCount: 0, lastSuccessAt: new Date() },
      });
    }

    return { outcome, deliveryId: delivery.id };
  }

  /* ---------------------------------------------------------------- *
   * The HTTP call                                                     *
   * ---------------------------------------------------------------- */

  /** One POST. Never throws — a transport failure is an outcome, not an error. */
  private async post(
    endpoint: DeliverableEndpoint,
    deliveryId: number,
    storedPayload: unknown,
  ): Promise<DeliveryOutcome> {
    const payload: OutboundPayload = {
      id: deliveryId,
      ...(storedPayload as Omit<OutboundPayload, 'id'>),
    };
    // Signed over the exact bytes sent, so the receiver can recompute the HMAC
    // from the raw body it read. Serialise once and post the string.
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'DraskenLabs-WhatsApp-Webhooks/1',
      'X-Drasken-Delivery-Id': String(deliveryId),
      'X-Drasken-Event': payload.event,
      'X-Drasken-Timestamp': timestamp,
    };

    const secret = this.readSecret(endpoint);
    if (secret) {
      // The timestamp is inside the signed string, so a captured delivery
      // cannot be replayed at the receiver a week later and still verify.
      headers['X-Drasken-Signature-256'] =
        'sha256=' +
        createHmac('sha256', secret)
          .update(`${timestamp}.${body}`)
          .digest('hex');
    }

    const startedAt = Date.now();
    try {
      const res = await axios.post(endpoint.url, body, {
        headers,
        timeout: this.timeoutMs,
        // A webhook endpoint that 302s is an endpoint that moved, not an
        // invitation to follow it: a redirect is the standard way around a
        // URL allow-list, and it would let a public host bounce us at an
        // internal one.
        maxRedirects: 0,
        validateStatus: () => true,
        // We never read the body beyond an error excerpt; a receiver returning
        // megabytes must not become our memory problem.
        maxContentLength: 64 * 1024,
        transitional: { clarifyTimeoutError: true },
      });
      const durationMs = Date.now() - startedAt;
      const success = res.status >= 200 && res.status < 300;
      return {
        success,
        responseCode: res.status,
        error: success ? null : this.excerpt(res.data),
        durationMs,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startedAt;
      const detail = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        responseCode: null,
        error: detail.slice(0, MAX_ERROR_LENGTH),
        durationMs,
      };
    }
  }

  /**
   * The endpoint's signing secret, or null when it has none.
   *
   * A secret that will not decrypt (a rotated `ENCRYPTION_KEY`, a row copied
   * between environments) sends the delivery unsigned rather than failing it:
   * the receiver rejects an unsigned body if it cares, and the alternative is
   * silently dropping every event for that endpoint.
   */
  private readSecret(endpoint: DeliverableEndpoint): string | null {
    if (!endpoint.secret) return null;
    try {
      return this.encryption.decrypt(endpoint.secret);
    } catch {
      this.logger.error(
        `Could not decrypt the signing secret for endpoint ${endpoint.id}; sending unsigned`,
      );
      return null;
    }
  }

  /** The start of a failing response body, whatever shape it came back as. */
  private excerpt(data: unknown): string | null {
    if (data === undefined || data === null || data === '') return null;
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return text ? text.slice(0, MAX_ERROR_LENGTH) : null;
  }
}
