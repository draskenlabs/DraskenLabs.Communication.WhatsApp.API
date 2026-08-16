import { createHmac } from 'crypto';
import { EncryptionService } from 'src/common/services/crypto.service';
import {
  MAX_DELIVERY_RETRIES,
  WebhookDispatcherService,
} from 'src/webhooks/webhook-dispatcher.service';
import { describeEvent } from 'src/webhooks/event-describer';
import { Harness, ORG, seedAccount, startHarness } from './harness';
import { Receiver } from './receiver';

const WABA = 'waba_integration';

/** One inbound message, in the shape Meta posts a `messages` change. */
const INBOUND = {
  messages: [
    {
      id: 'wamid.integration.1',
      from: '919822010210',
      type: 'text',
      text: { body: 'Is anybody there?' },
    },
  ],
  contacts: [{ profile: { name: 'A Customer' } }],
};

/** A template decision, which is a different kind of event. */
const TEMPLATE = {
  message_template_id: 12345,
  message_template_name: 'order_update',
  event: 'APPROVED',
};

/**
 * Outbound webhooks, delivered for real.
 *
 * The dispatcher is an outbox: rows go in, a sweep posts them, failures come
 * back later. None of that is observable from a unit test with a mocked axios
 * — the retry schedule lives in the database, the claim is a compare-and-set
 * two replicas race on, and the signature is over the exact bytes that go on
 * the wire. Here a real HTTP server on the other end says what actually
 * arrived.
 */
describe('Webhook delivery (integration)', () => {
  let h: Harness;
  let dispatcher: WebhookDispatcherService;
  let encryption: EncryptionService;
  const receiver = new Receiver();

  beforeAll(async () => {
    h = await startHarness();
    dispatcher = h.app.get(WebhookDispatcherService);
    encryption = h.app.get(EncryptionService);
    await receiver.start();
  }, 60_000);

  afterAll(async () => {
    await receiver.stop();
    await h?.close();
  });

  beforeEach(async () => {
    await h.reset();
    receiver.reset();
    await seedAccount(h.prisma);
  });

  /**
   * An endpoint pointing at the receiver.
   *
   * Written straight to the table on purpose: the URL guard governs what a
   * customer may register, and 127.0.0.1 is precisely what it refuses — but a
   * row that exists must still be delivered to.
   */
  async function endpoint(
    options: { secret?: string; events?: string[]; path?: string } = {},
  ): Promise<{ id: number; url: string }> {
    const user = await h.prisma.user.findFirstOrThrow();
    const row = await h.prisma.webhookEndpoint.create({
      data: {
        userId: user.id,
        ssoOrgId: ORG,
        wabaId: WABA,
        url: `${receiver.url}${options.path ?? '/hooks'}`,
        secret: options.secret ? encryption.encrypt(options.secret) : null,
        events: options.events ?? [],
      },
    });
    return { id: row.id, url: row.url };
  }

  /** Queue a Meta change for whoever is listening, as the ingest does. */
  async function queue(
    metaField: 'messages' | 'message_template_status_update',
    payload: Record<string, unknown>,
  ): Promise<void> {
    const event = await h.prisma.webhookEvent.create({
      data: {
        eventType: metaField,
        wabaId: WABA,
        payload: payload as object,
        processed: true,
      },
    });
    await dispatcher.enqueue(
      WABA,
      event.id,
      metaField,
      describeEvent(metaField, payload),
      payload,
    );
  }

  /* ------------------------------------------------------------------ *
   * Fan-out                                                             *
   * ------------------------------------------------------------------ */

  describe('queueing', () => {
    it('queues one delivery per listening endpoint and posts the envelope', async () => {
      const first = await endpoint({ path: '/hooks/one' });
      await endpoint({ path: '/hooks/two' });

      await queue('messages', INBOUND);
      const result = await dispatcher.sweep();

      expect(result).toMatchObject({ attempted: 2, sent: 2, abandoned: 0 });
      expect(receiver.received.map((r) => r.path).sort()).toEqual([
        '/hooks/one',
        '/hooks/two',
      ]);

      const delivered = receiver.received.find((r) => r.path === '/hooks/one')!;
      expect(delivered.body).toMatchObject({
        event: 'inbound_message',
        wabaId: WABA,
      });
      // The id in the envelope is the delivery's own row — the value a
      // receiver deduplicates on, and the same one on every retry.
      const stored = await h.prisma.webhookDelivery.findFirstOrThrow({
        where: { endpointId: first.id },
      });
      expect(delivered.body.id).toBe(stored.id);
      expect(delivered.headers['x-drasken-delivery-id']).toBe(
        String(stored.id),
      );
      expect(delivered.headers['x-drasken-event']).toBe('inbound_message');
      expect(delivered.headers['content-type']).toContain('application/json');
      expect(stored.status).toBe('sent');
      expect(stored.attempts).toBe(1);
      expect(stored.retryAt).toBeNull();
      expect(stored.responseCode).toBe(200);
    });

    it('only queues for endpoints subscribed to that kind', async () => {
      const inboundOnly = await endpoint({
        events: ['inbound_message'],
        path: '/inbound',
      });
      const templatesOnly = await endpoint({
        events: ['template_status'],
        path: '/templates',
      });
      const everything = await endpoint({ path: '/all' });

      await queue('messages', INBOUND);

      const queued = await h.prisma.webhookDelivery.findMany({
        select: { endpointId: true },
      });
      expect(queued.map((d) => d.endpointId).sort()).toEqual(
        [inboundOnly.id, everything.id].sort(),
      );
      expect(queued.map((d) => d.endpointId)).not.toContain(templatesOnly.id);
    });

    it('routes a different kind to the endpoint that asked for it', async () => {
      await endpoint({ events: ['inbound_message'], path: '/inbound' });
      await endpoint({ events: ['template_status'], path: '/templates' });

      await queue('message_template_status_update', TEMPLATE);
      await dispatcher.sweep();

      expect(receiver.received).toHaveLength(1);
      expect(receiver.received[0].path).toBe('/templates');
      expect(receiver.received[0].body).toMatchObject({
        event: 'template_status',
      });
    });

    it('queues nothing for a disabled endpoint', async () => {
      const off = await endpoint();
      await h.prisma.webhookEndpoint.update({
        where: { id: off.id },
        data: { status: false },
      });

      await queue('messages', INBOUND);

      expect(await h.prisma.webhookDelivery.count()).toBe(0);
    });

    it('does not fail the event when the fan-out cannot be written', async () => {
      const target = await endpoint();
      // A delivery row referencing an event that has been deleted violates the
      // foreign key — the customer's fan-out fails, and our own processing of
      // the event must not.
      const orphan = await h.prisma.webhookEvent.create({
        data: {
          eventType: 'messages',
          wabaId: WABA,
          payload: INBOUND,
          processed: true,
        },
      });
      await h.prisma.webhookEvent.delete({ where: { id: orphan.id } });

      await expect(
        dispatcher.enqueue(
          WABA,
          orphan.id,
          'messages',
          describeEvent('messages', INBOUND),
          INBOUND,
        ),
      ).resolves.toBeUndefined();
      expect(
        await h.prisma.webhookDelivery.count({
          where: { endpointId: target.id },
        }),
      ).toBe(0);
    });
  });

  /* ------------------------------------------------------------------ *
   * Signing                                                             *
   * ------------------------------------------------------------------ */

  describe('signing', () => {
    it('signs the exact bytes sent, over a timestamp the receiver can check', async () => {
      const secret = 'whsec_customer_chose_this';
      await endpoint({ secret });

      await queue('messages', INBOUND);
      await dispatcher.sweep();

      const [delivery] = receiver.received;
      const timestamp = delivery.headers['x-drasken-timestamp'];
      const signature = delivery.headers['x-drasken-signature-256'];
      expect(timestamp).toMatch(/^\d{10}$/);

      // Verified the way the documentation tells a customer to verify it: over
      // the raw body, not a re-serialisation of the parsed one.
      const expected =
        'sha256=' +
        createHmac('sha256', secret)
          .update(`${timestamp}.${delivery.raw}`)
          .digest('hex');
      expect(signature).toBe(expected);

      // A replayed body with a fresh timestamp does not verify.
      const replayed =
        'sha256=' +
        createHmac('sha256', secret)
          .update(`${Number(timestamp) + 60}.${delivery.raw}`)
          .digest('hex');
      expect(signature).not.toBe(replayed);
    });

    it('sends nothing to sign when the endpoint has no secret', async () => {
      await endpoint();

      await queue('messages', INBOUND);
      await dispatcher.sweep();

      expect(
        receiver.received[0].headers['x-drasken-signature-256'],
      ).toBeUndefined();
      // The delivery still happens: a secret is optional, not required.
      expect(receiver.received).toHaveLength(1);
    });

    it('delivers unsigned rather than not at all when the secret will not decrypt', async () => {
      const broken = await endpoint();
      await h.prisma.webhookEndpoint.update({
        where: { id: broken.id },
        // What a rotated ENCRYPTION_KEY leaves behind.
        data: { secret: 'not-a-ciphertext-this-key-can-read' },
      });

      await queue('messages', INBOUND);
      await dispatcher.sweep();

      expect(receiver.received).toHaveLength(1);
      expect(
        receiver.received[0].headers['x-drasken-signature-256'],
      ).toBeUndefined();
    });
  });

  /* ------------------------------------------------------------------ *
   * Failure, retry and giving up                                        *
   * ------------------------------------------------------------------ */

  describe('when the endpoint is unhappy', () => {
    /** Make everything that is waiting due now, as time passing would. */
    async function timePasses(): Promise<void> {
      await h.prisma.webhookDelivery.updateMany({
        where: { status: { in: ['pending', 'failed'] } },
        data: { retryAt: new Date(Date.now() - 1000) },
      });
    }

    it('keeps a 500 for a later attempt, with the backoff on the row', async () => {
      await endpoint();
      receiver.answers(500);

      await queue('messages', INBOUND);
      const result = await dispatcher.sweep();

      expect(result).toMatchObject({ attempted: 1, sent: 0, abandoned: 0 });
      const row = await h.prisma.webhookDelivery.findFirstOrThrow();
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(1);
      expect(row.responseCode).toBe(500);
      expect(row.error).toContain('upstream is unhappy');
      // A minute out — not immediately, which would hammer a struggling host.
      const wait = row.retryAt!.getTime() - Date.now();
      expect(wait).toBeGreaterThan(30_000);
      expect(wait).toBeLessThan(90_000);
    });

    it('does not try again in the same sweep', async () => {
      await endpoint();
      receiver.answers(503);

      await queue('messages', INBOUND);
      await dispatcher.sweep();
      await dispatcher.sweep();

      // The second sweep sees a row that is not due yet.
      expect(receiver.received).toHaveLength(1);
    });

    it('delivers on a later attempt once the endpoint recovers', async () => {
      await endpoint();
      receiver.answers(502);

      await queue('messages', INBOUND);
      await dispatcher.sweep();

      receiver.answers(200);
      await timePasses();
      await dispatcher.sweep();

      const row = await h.prisma.webhookDelivery.findFirstOrThrow();
      expect(row.status).toBe('sent');
      expect(row.attempts).toBe(2);
      expect(row.retryAt).toBeNull();
      // The same envelope, twice — the delivery id is what makes the retry
      // safe for the receiver to discard.
      expect(receiver.received[0].body.id).toBe(receiver.received[1].body.id);
    });

    it('gives up after the last attempt and counts it against the endpoint', async () => {
      const target = await endpoint();
      receiver.answers(500);

      await queue('messages', INBOUND);
      // The attempts before the last one are the backoff schedule, which is
      // minutes of waiting; the row is put where the final attempt starts.
      await h.prisma.webhookDelivery.updateMany({
        data: { attempts: MAX_DELIVERY_RETRIES, retryAt: new Date() },
      });

      const result = await dispatcher.sweep();

      expect(result).toMatchObject({ attempted: 1, abandoned: 1 });
      const row = await h.prisma.webhookDelivery.findFirstOrThrow();
      expect(row.status).toBe('abandoned');
      expect(row.attempts).toBe(MAX_DELIVERY_RETRIES + 1);
      expect(row.retryAt).toBeNull();

      const endpointRow = await h.prisma.webhookEndpoint.findUniqueOrThrow({
        where: { id: target.id },
      });
      expect(endpointRow.failureCount).toBe(1);
      expect(endpointRow.status).toBe(true);
    });

    it('switches an endpoint off once it has failed ten times in a row', async () => {
      const target = await endpoint();
      receiver.answers(500);
      await h.prisma.webhookEndpoint.update({
        where: { id: target.id },
        data: { failureCount: 9 },
      });

      await queue('messages', INBOUND);
      await h.prisma.webhookDelivery.updateMany({
        data: { attempts: MAX_DELIVERY_RETRIES, retryAt: new Date() },
      });
      await dispatcher.sweep();

      const endpointRow = await h.prisma.webhookEndpoint.findUniqueOrThrow({
        where: { id: target.id },
      });
      expect(endpointRow.failureCount).toBe(10);
      expect(endpointRow.status).toBe(false);
      expect(endpointRow.disabledAt).not.toBeNull();
    });

    it('clears the run of failures when one gets through', async () => {
      const target = await endpoint();
      await h.prisma.webhookEndpoint.update({
        where: { id: target.id },
        data: { failureCount: 7 },
      });

      await queue('messages', INBOUND);
      await dispatcher.sweep();

      const endpointRow = await h.prisma.webhookEndpoint.findUniqueOrThrow({
        where: { id: target.id },
      });
      // Consecutive means consecutive: Monday's failures do not add to
      // Tuesday's.
      expect(endpointRow.failureCount).toBe(0);
      expect(endpointRow.lastSuccessAt).not.toBeNull();
    });

    it('abandons a queued delivery for an endpoint switched off since', async () => {
      const target = await endpoint();
      await queue('messages', INBOUND);

      await h.prisma.webhookEndpoint.update({
        where: { id: target.id },
        data: { status: false },
      });
      const result = await dispatcher.sweep();

      // Disabling stops the backlog too, not just what comes next.
      expect(result).toMatchObject({ attempted: 0, abandoned: 1 });
      expect(receiver.received).toHaveLength(0);
      const row = await h.prisma.webhookDelivery.findFirstOrThrow();
      expect(row.status).toBe('abandoned');
      expect(row.error).toBe('Endpoint disabled');
    });

    it('does not follow a redirect', async () => {
      await endpoint();
      // The standard way around a URL check: register a public host, then
      // bounce the deliverer at something internal.
      receiver.redirectsTo('http://169.254.169.254/latest/meta-data/');

      await queue('messages', INBOUND);
      await dispatcher.sweep();

      const row = await h.prisma.webhookDelivery.findFirstOrThrow();
      expect(row.status).toBe('failed');
      expect(row.responseCode).toBe(302);
      // One request, to the endpoint as registered.
      expect(receiver.received).toHaveLength(1);
    });

    it('records a transport failure without a status code', async () => {
      const target = await endpoint();
      await h.prisma.webhookEndpoint.update({
        where: { id: target.id },
        // A port nothing is listening on: connection refused, not an answer.
        data: { url: 'http://127.0.0.1:9/hooks' },
      });

      await queue('messages', INBOUND);
      await dispatcher.sweep();

      const row = await h.prisma.webhookDelivery.findFirstOrThrow();
      expect(row.status).toBe('failed');
      expect(row.responseCode).toBeNull();
      expect(row.error).toBeTruthy();
      expect(row.durationMs).not.toBeNull();
    });
  });

  /* ------------------------------------------------------------------ *
   * Two replicas                                                        *
   * ------------------------------------------------------------------ */

  describe('more than one sweep at a time', () => {
    it('delivers once when two sweeps run together', async () => {
      await endpoint();
      // Slow enough that the second sweep is inside the first one's window.
      receiver.takes(150);

      await queue('messages', INBOUND);
      await Promise.all([dispatcher.sweep(), dispatcher.sweep()]);

      // The claim is a compare-and-set on the row: only one sweep may have it.
      expect(receiver.received).toHaveLength(1);
      const row = await h.prisma.webhookDelivery.findFirstOrThrow();
      expect(row.attempts).toBe(1);
      expect(row.status).toBe('sent');
    });
  });

  /* ------------------------------------------------------------------ *
   * The test ping                                                       *
   * ------------------------------------------------------------------ */

  describe('the test ping', () => {
    it('posts straight away and answers with what came back', async () => {
      const target = await endpoint({ secret: 'whsec_test' });

      const { outcome, deliveryId } = await dispatcher.sendTest({
        id: target.id,
        url: target.url,
        secret: (
          await h.prisma.webhookEndpoint.findUniqueOrThrow({
            where: { id: target.id },
          })
        ).secret,
        wabaId: WABA,
      });

      expect(outcome).toMatchObject({ success: true, responseCode: 200 });
      expect(receiver.received).toHaveLength(1);
      expect(receiver.received[0].body).toMatchObject({
        event: 'endpoint.test',
        wabaId: WABA,
        id: deliveryId,
      });
      // Signed like any other delivery, so a receiver that verifies can
      // actually be tested with it.
      expect(
        receiver.received[0].headers['x-drasken-signature-256'],
      ).toBeDefined();

      const row = await h.prisma.webhookDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });
      expect(row.status).toBe('sent');
      expect(row.retryAt).toBeNull();
    });

    it('never queues a retry for a test that failed', async () => {
      const target = await endpoint();
      receiver.answers(404);

      const { outcome, deliveryId } = await dispatcher.sendTest({
        id: target.id,
        url: target.url,
        secret: null,
        wabaId: WABA,
      });

      expect(outcome.success).toBe(false);
      expect(outcome.responseCode).toBe(404);
      const row = await h.prisma.webhookDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });
      // A failed test is a result to show somebody, not work to redo.
      expect(row.status).toBe('abandoned');
      expect(row.retryAt).toBeNull();
      await dispatcher.sweep();
      expect(receiver.received).toHaveLength(1);
    });

    it('counts a successful ping as proof the endpoint is reachable', async () => {
      const target = await endpoint();
      await h.prisma.webhookEndpoint.update({
        where: { id: target.id },
        data: { failureCount: 4 },
      });

      await dispatcher.sendTest({
        id: target.id,
        url: target.url,
        secret: null,
        wabaId: WABA,
      });

      const endpointRow = await h.prisma.webhookEndpoint.findUniqueOrThrow({
        where: { id: target.id },
      });
      expect(endpointRow.failureCount).toBe(0);
    });
  });
});
