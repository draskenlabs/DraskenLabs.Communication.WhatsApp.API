import { RetentionService } from 'src/webhooks/retention.service';
import { BillingService } from 'src/billing/billing.service';
import { PlanLimitsService } from 'src/plans/plan-limits.service';
import { Harness, ORG, seedAccount, startHarness } from './harness';

/**
 * Retention, against a real database.
 *
 * The sweep deletes with raw SQL — `deleteMany` cannot be limited — so a
 * mocked `$executeRaw` proves nothing about it: a quoting or syntax error
 * would pass the unit suite and fail the first night in production. Every
 * statement here is executed by Postgres, and every assertion is a row count
 * afterwards.
 */
describe('Retention (integration)', () => {
  let h: Harness;
  let retention: RetentionService;

  const days = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000);

  beforeAll(async () => {
    h = await startHarness();
    retention = h.app.get(RetentionService);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.reset();
  });

  /** A stored Meta event, at a given age. */
  async function event(age: number): Promise<number> {
    const row = await h.prisma.webhookEvent.create({
      data: {
        eventType: 'messages',
        wabaId: 'waba_integration',
        payload: { messages: [{ id: 'wamid.x' }] },
        processed: true,
      },
    });
    await h.prisma.webhookEvent.update({
      where: { id: row.id },
      data: { createdAt: days(age) },
    });
    return row.id;
  }

  async function endpoint(): Promise<number> {
    const { userId, wabaId } = await seedAccount(h.prisma);
    const row = await h.prisma.webhookEndpoint.create({
      data: {
        userId,
        ssoOrgId: ORG,
        wabaId,
        url: 'https://api.example.com/hooks',
      },
    });
    return row.id;
  }

  async function delivery(
    endpointId: number,
    status: string,
    age: number,
  ): Promise<number> {
    const row = await h.prisma.webhookDelivery.create({
      data: {
        endpointId,
        eventType: 'status_update',
        payload: { event: 'status_update' },
        status,
        attempts: 1,
      },
    });
    await h.prisma.webhookDelivery.update({
      where: { id: row.id },
      data: { createdAt: days(age) },
    });
    return row.id;
  }

  describe('webhook events and the delivery log', () => {
    it('deletes past the window and keeps everything inside it', async () => {
      const old = await event(40);
      const recent = await event(10);
      const endpointId = await endpoint();
      const oldSent = await delivery(endpointId, 'sent', 40);
      const oldAbandoned = await delivery(endpointId, 'abandoned', 40);
      const recentSent = await delivery(endpointId, 'sent', 5);

      const result = await retention.sweep();

      expect(result.events).toBe(1);
      expect(result.deliveries).toBe(2);
      expect(
        await h.prisma.webhookEvent.findUnique({ where: { id: old } }),
      ).toBeNull();
      expect(
        await h.prisma.webhookEvent.findUnique({ where: { id: recent } }),
      ).not.toBeNull();
      for (const id of [oldSent, oldAbandoned]) {
        expect(
          await h.prisma.webhookDelivery.findUnique({ where: { id } }),
        ).toBeNull();
      }
      expect(
        await h.prisma.webhookDelivery.findUnique({
          where: { id: recentSent },
        }),
      ).not.toBeNull();
    });

    it('never deletes work still outstanding, however old the event', async () => {
      const endpointId = await endpoint();
      const queued = await delivery(endpointId, 'pending', 90);
      const retrying = await delivery(endpointId, 'failed', 90);

      await retention.sweep();

      // Old and undelivered is a backlog, not history.
      expect(
        await h.prisma.webhookDelivery.findUnique({ where: { id: queued } }),
      ).not.toBeNull();
      expect(
        await h.prisma.webhookDelivery.findUnique({ where: { id: retrying } }),
      ).not.toBeNull();
    });

    it('runs on an empty database without error', async () => {
      await expect(retention.sweep()).resolves.toMatchObject({
        events: 0,
        deliveries: 0,
      });
    });

    it('deletes a backlog larger than one batch', async () => {
      const endpointId = await endpoint();
      // Enough rows that the loop has to run more than once would be 5,000 per
      // pass; this proves the loop terminates and the count is cumulative
      // without writing that many.
      const ids: number[] = [];
      for (let n = 0; n < 25; n++)
        ids.push(await delivery(endpointId, 'sent', 45));

      const { deliveries } = await retention.sweep();

      expect(deliveries).toBe(25);
      expect(await h.prisma.webhookDelivery.count()).toBe(0);
    });
  });

  describe('message history', () => {
    async function messagesFor(
      userId: number,
      ssoOrgId: string,
      wabaId: string,
      ages: number[],
    ) {
      for (const age of ages) {
        const sent = await h.prisma.message.create({
          data: {
            phoneNumberId: `phone_${wabaId}_0`,
            to: '919822010210',
            type: 'text',
            payload: { text: 'hello' },
            userId,
            ssoOrgId,
          },
        });
        await h.prisma.message.update({
          where: { id: sent.id },
          data: { createdAt: days(age) },
        });

        const received = await h.prisma.inboundMessage.create({
          data: {
            metaMessageId: `wamid.${wabaId}.${age}.${Math.random()}`,
            wabaId,
            phoneNumberId: `phone_${wabaId}_0`,
            from: '919822010210',
            type: 'text',
            payload: { text: 'hi' },
            timestamp: days(age),
          },
        });
        await h.prisma.inboundMessage.update({
          where: { id: received.id },
          data: { createdAt: days(age) },
        });
      }
    }

    it('only counts while the sweep is not turned on', async () => {
      const { userId, wabaId } = await seedAccount(h.prisma, { numbers: 1 });
      const billing = h.app.get(BillingService);
      await billing.register(userId, ORG, wabaId, 'starter');
      await h.prisma.subscription.updateMany({
        where: { wabaId },
        data: {
          status: 'active',
          currentEnd: new Date(Date.now() + 86_400_000),
        },
      });
      await messagesFor(userId, ORG, wabaId, [60, 45, 10]);

      const { messages: deleted } = await retention.sweep();

      // Somebody's own record of what they sent is not deleted on a default.
      expect(deleted).toBe(0);
      expect(await h.prisma.message.count()).toBe(3);
      expect(await h.prisma.inboundMessage.count()).toBe(3);
    });

    it('applies each organisation’s own window once it is turned on', async () => {
      // The flag is read once, at construction — so this is the same service,
      // against the same database, built the way a deployment that has turned
      // retention on builds it.
      const enforcing = new RetentionService(
        h.prisma,
        {
          get: (key: string) =>
            key === 'PLAN_RETENTION_ENFORCED' ? 'true' : undefined,
        } as never,
        h.app.get(PlanLimitsService),
      );
      const billing = h.app.get(BillingService);

      const starter = await seedAccount(h.prisma, {
        wabaId: 'waba_starter',
        ssoOrgId: 'org_starter',
        numbers: 1,
      });
      const business = await seedAccount(h.prisma, {
        wabaId: 'waba_business',
        ssoOrgId: 'org_business',
        numbers: 1,
      });
      await billing.register(
        starter.userId,
        'org_starter',
        'waba_starter',
        'starter',
      );
      await billing.register(
        business.userId,
        'org_business',
        'waba_business',
        'business',
      );
      await h.prisma.subscription.updateMany({
        data: {
          status: 'active',
          currentEnd: new Date(Date.now() + 86_400_000),
        },
      });

      // 45 days old: past Starter's thirty, well inside Business's year.
      await messagesFor(
        starter.userId,
        'org_starter',
        'waba_starter',
        [45, 10],
      );
      await messagesFor(
        business.userId,
        'org_business',
        'waba_business',
        [45, 10],
      );

      const { messages: deleted, inbound } = await enforcing.sweep();

      expect(deleted).toBe(1);
      expect(inbound).toBe(1);
      expect(
        await h.prisma.message.count({ where: { ssoOrgId: 'org_starter' } }),
      ).toBe(1);
      // The Business customer keeps a year, and 45 days is nowhere near it.
      expect(
        await h.prisma.message.count({ where: { ssoOrgId: 'org_business' } }),
      ).toBe(2);
    });

    it('keeps everything for a plan that names no window', async () => {
      const enforcing = new RetentionService(
        h.prisma,
        {
          get: (key: string) =>
            key === 'PLAN_RETENTION_ENFORCED' ? 'true' : undefined,
        } as never,
        h.app.get(PlanLimitsService),
      );
      // Nothing subscribed and no price list to fall back on: a deployment
      // that never sold a plan must not have its data deleted by one.
      await h.prisma.plan.updateMany({ data: { active: false } });
      const seeded = await seedAccount(h.prisma, { numbers: 1 });
      await messagesFor(seeded.userId, ORG, seeded.wabaId, [400]);

      const { messages: deleted } = await enforcing.sweep();

      expect(deleted).toBe(0);
      expect(await h.prisma.message.count()).toBe(1);
      await h.prisma.plan.updateMany({ data: { active: true } });
    });
  });
});
