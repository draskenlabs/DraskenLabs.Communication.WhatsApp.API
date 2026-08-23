import * as request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { Server } from 'http';
import axios from 'axios';
import { WebhooksService } from 'src/webhooks/webhooks.service';
import { RedisService } from 'src/redis/redis.service';
import { SubscriptionAccessService } from 'src/billing/subscription-access.service';
import { EncryptionService } from 'src/common/services/crypto.service';
import { Harness, ORG, seedAccount, startHarness } from './harness';

let h: Harness;

function api(): TestAgent<request.Test> {
  return request(h.app.getHttpServer() as Server);
}

function envelope<T>(res: request.Response): { data: T; meta?: unknown; message?: string } {
  return res.body as { data: T; meta?: unknown; message?: string };
}

interface ConversationView {
  id: number;
  contactPhone: string;
  contactName?: string;
  savedName?: string;
  optedOut?: boolean;
  lastPreview: string;
  lastDirection: string;
  unreadCount: number;
  status: string;
  window: { open: boolean; expiresAt?: string };
}

interface ThreadView {
  conversation: ConversationView;
  messages: {
    id: string;
    direction: string;
    type: string;
    timestamp: string;
    status?: string;
    mediaUrl?: string;
  }[];
  nextCursor?: string;
  historyDays?: number;
}

const CUSTOMER = '919822010210';

/**
 * The inbox, end to end.
 *
 * The unit suite proves the branches against mocks. This proves the parts a
 * mock cannot: that a reply arriving on the real webhook path writes a
 * conversation Postgres will accept, that the thread query returns both
 * directions from two tables in one order, and that the 24-hour window is
 * enforced on a real HTTP request before anything is sent to Meta.
 */
describe('Inbox (integration)', () => {
  let webhooks: WebhooksService;
  let redis: RedisService;
  let encryption: EncryptionService;
  let access: SubscriptionAccessService;
  let token: string;
  let phoneNumberId: string;
  let userId: number;

  beforeAll(async () => {
    h = await startHarness();
    webhooks = h.app.get(WebhooksService);
    redis = h.app.get(RedisService);
    encryption = h.app.get(EncryptionService);
    access = h.app.get(SubscriptionAccessService);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.reset();
    const account = await seedAccount(h.prisma, { numbers: 1 });
    userId = account.userId;
    phoneNumberId = `phone_${account.wabaId}_0`;
    token = await h.signIn(userId, ORG);
    // Sending reads the number's account token from the cache, exactly as it
    // does in a deployment.
    await redis.setPhoneCache(
      phoneNumberId,
      account.wabaId,
      encryption.encrypt('meta_token'),
    );
    // Replying is sending, and sending is what the subscription buys — the
    // console is not a free way round the paywall. Reading the inbox is not
    // gated, which is why only the reply tests need this.
    await h.prisma.subscription.create({
      data: {
        wabaId: account.wabaId,
        ssoOrgId: ORG,
        razorpaySubscriptionId: `sub_inbox_${Date.now()}`,
        planId: 'plan_starter',
        createdByUserId: account.userId,
        status: 'active',
        currentEnd: new Date(Date.now() + 20 * 24 * 3600 * 1000),
      },
    });
    await access.invalidate(ORG, account.wabaId);
  });

  /** A reply, delivered the way Meta delivers one. */
  const deliverReply = async (
    over: { type?: string; body?: unknown; id?: string; at?: Date } = {},
  ): Promise<void> => {
    const type = over.type ?? 'text';
    await webhooks.processPayload({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba_integration',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: phoneNumberId },
                contacts: [{ profile: { name: 'Priya' } }],
                messages: [
                  {
                    id: over.id ?? `wamid.${Math.random().toString(36).slice(2)}`,
                    from: CUSTOMER,
                    timestamp: String(
                      Math.floor((over.at ?? new Date()).getTime() / 1000),
                    ),
                    type,
                    [type]: over.body ?? { body: 'Where is my order?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  };

  /* ------------------------------------------------------------------ */

  describe('a reply arriving', () => {
    it('opens a conversation the list can show', async () => {
      await deliverReply();

      const res = await api()
        .get('/inbox')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const list = envelope<ConversationView[]>(res).data;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        contactPhone: CUSTOMER,
        contactName: 'Priya',
        lastPreview: 'Where is my order?',
        lastDirection: 'inbound',
        unreadCount: 1,
        status: 'open',
      });
      // The customer just wrote, so a free-form answer is allowed.
      expect(list[0].window.open).toBe(true);
    });

    it('counts a second reply into the same thread, not a second one', async () => {
      await deliverReply();
      await deliverReply({ body: { body: 'Still waiting' } });

      const res = await api()
        .get('/inbox')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const list = envelope<ConversationView[]>(res).data;
      expect(list).toHaveLength(1);
      expect(list[0].unreadCount).toBe(2);
      expect(list[0].lastPreview).toBe('Still waiting');
    });

    it('describes a photo rather than showing an empty line', async () => {
      await deliverReply({ type: 'image', body: { id: 'MEDIA1', mime_type: 'image/jpeg' } });

      const res = await api()
        .get('/inbox')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(envelope<ConversationView[]>(res).data[0].lastPreview).toBe('Sent a photo');
    });

    it('reopens a thread that had been closed', async () => {
      await deliverReply();
      const { id } = (
        await api().get('/inbox').set('Authorization', `Bearer ${token}`)
      ).body.data[0] as ConversationView;

      await api()
        .patch(`/inbox/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'closed' })
        .expect(200);

      await deliverReply({ body: { body: 'Hello?' } });

      const res = await api()
        .get('/inbox')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(envelope<ConversationView[]>(res).data[0].status).toBe('open');
    });
  });

  /* ------------------------------------------------------------------ */

  describe('the thread', () => {
    let conversationId: number;

    beforeEach(async () => {
      // A send that predates the reply, written directly: the send path itself
      // would post to Meta, which this suite does not reach.
      await h.prisma.message.create({
        data: {
          metaMessageId: 'wamid.out1',
          phoneNumberId,
          // Spelled with a `+`, as a caller may well send it — the thread has
          // to find it anyway.
          to: `+${CUSTOMER}`,
          type: 'text',
          payload: { text: { body: 'Your order shipped' } },
          status: 'delivered',
          userId,
          ssoOrgId: ORG,
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      });
      await deliverReply();

      const list = await api().get('/inbox').set('Authorization', `Bearer ${token}`);
      conversationId = (list.body.data as ConversationView[])[0].id;
    });

    it('returns both directions in one list, oldest first', async () => {
      const res = await api()
        .get(`/inbox/${conversationId}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const thread = envelope<ThreadView>(res).data;
      expect(thread.messages.map((m) => m.direction)).toEqual(['outbound', 'inbound']);
      expect(thread.messages[0]).toMatchObject({ id: 'out:1', status: 'delivered' });
      expect(thread.messages[1].id).toMatch(/^in:/);
    });

    it('offers a media path for a photo, and none for text', async () => {
      await deliverReply({ type: 'image', body: { id: 'MEDIA1', mime_type: 'image/jpeg' } });

      const res = await api()
        .get(`/inbox/${conversationId}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const thread = envelope<ThreadView>(res).data;
      const photo = thread.messages.find((m) => m.type === 'image');
      expect(photo?.mediaUrl).toBe(`/inbox/media/${photo!.id.replace('in:', '')}`);
      expect(thread.messages.find((m) => m.type === 'text' && m.direction === 'inbound')
        ?.mediaUrl).toBeUndefined();
    });

    it('pages backwards without repeating a message', async () => {
      for (let i = 0; i < 4; i++) {
        await deliverReply({
          id: `wamid.page${i}`,
          body: { body: `Message ${i}` },
          at: new Date(Date.now() - (10 - i) * 60 * 1000),
        });
      }

      const first = envelope<ThreadView>(
        await api()
          .get(`/inbox/${conversationId}/messages?limit=3`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200),
      ).data;

      expect(first.messages).toHaveLength(3);
      expect(first.nextCursor).toBeDefined();

      const second = envelope<ThreadView>(
        await api()
          .get(
            `/inbox/${conversationId}/messages?limit=3&before=${encodeURIComponent(
              first.nextCursor!,
            )}`,
          )
          .set('Authorization', `Bearer ${token}`)
          .expect(200),
      ).data;

      const overlap = second.messages
        .map((m) => m.id)
        .filter((id) => first.messages.some((m) => m.id === id));
      expect(overlap).toEqual([]);
    });

    it('marks the thread read for this organisation', async () => {
      await api()
        .post(`/inbox/${conversationId}/read`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

      const res = await api().get('/inbox').set('Authorization', `Bearer ${token}`);
      expect(envelope<ConversationView[]>(res).data[0].unreadCount).toBe(0);
    });

    it('hides another organisation’s conversation', async () => {
      const outsider = await h.signIn(userId, 'org_someone_else');

      await api()
        .get(`/inbox/${conversationId}/messages`)
        .set('Authorization', `Bearer ${outsider}`)
        .expect(404);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('replying', () => {
    let conversationId: number;

    const openThread = async (lastReplyAt: Date): Promise<number> => {
      await deliverReply({ at: lastReplyAt });
      const list = await api().get('/inbox').set('Authorization', `Bearer ${token}`);
      return (list.body.data as ConversationView[])[0].id;
    };

    it('refuses a free-form reply once the 24-hour window has closed', async () => {
      conversationId = await openThread(new Date(Date.now() - 25 * 60 * 60 * 1000));

      const res = await api()
        .post(`/inbox/${conversationId}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'text', text: 'Are you still there?' })
        .expect(400);

      expect((res.body as { message: string }).message).toMatch(/24-hour/);
    });

    it('sends a free-form reply while the window is open', async () => {
      conversationId = await openThread(new Date());
      const post = jest
        .spyOn(axios, 'post')
        .mockResolvedValue({ data: { messages: [{ id: 'wamid.reply' }] } });

      try {
        await api()
          .post(`/inbox/${conversationId}/messages`)
          .set('Authorization', `Bearer ${token}`)
          .send({ type: 'text', text: 'On its way!' })
          .expect(201);

        // Addressed to the thread's own customer, from the thread's own number.
        const [, payload] = post.mock.calls[0] as [string, { to: string }];
        expect(payload.to).toBe(CUSTOMER);
      } finally {
        post.mockRestore();
      }
    });

    it('brings the thread it answered to the top, as an outbound', async () => {
      conversationId = await openThread(new Date());
      const post = jest
        .spyOn(axios, 'post')
        .mockResolvedValue({ data: { messages: [{ id: 'wamid.reply' }] } });

      try {
        await api()
          .post(`/inbox/${conversationId}/messages`)
          .set('Authorization', `Bearer ${token}`)
          .send({ type: 'text', text: 'On its way!' })
          .expect(201);
      } finally {
        post.mockRestore();
      }

      const list = envelope<ConversationView[]>(
        await api().get('/inbox').set('Authorization', `Bearer ${token}`),
      ).data;

      expect(list[0]).toMatchObject({
        lastDirection: 'outbound',
        lastPreview: 'On its way!',
        // Answering does not mark the customer's messages read: someone else
        // on the team may still need to see them.
        unreadCount: 1,
      });
      // Nor does it extend the window, which is measured from their last word.
      expect(list[0].window.open).toBe(true);
    });

    it('refuses to reply in a conversation the caller cannot see', async () => {
      conversationId = await openThread(new Date());
      const outsider = await h.signIn(userId, 'org_someone_else');

      await api()
        .post(`/inbox/${conversationId}/messages`)
        .set('Authorization', `Bearer ${outsider}`)
        .send({ type: 'text', text: 'Hello' })
        .expect(404);
    });
  });

  /* ------------------------------------------------------------------ */

  describe('filters', () => {
    beforeEach(async () => {
      await deliverReply();
    });

    it('finds a thread by a number typed with punctuation', async () => {
      const res = await api()
        .get('/inbox?search=%2B91%2098220')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(envelope<ConversationView[]>(res).data).toHaveLength(1);
    });

    it('finds a thread by the customer’s profile name', async () => {
      const res = await api()
        .get('/inbox?search=priya')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(envelope<ConversationView[]>(res).data).toHaveLength(1);
    });

    it('shows the name the business filed them under, and their opt-out', async () => {
      await h.prisma.contact.create({
        data: { ssoOrgId: ORG, phone: `+${CUSTOMER}`, name: 'Priya Sharma', optedOut: true },
      });

      const res = await api()
        .get('/inbox')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const [row] = envelope<ConversationView[]>(res).data;
      expect(row.savedName).toBe('Priya Sharma');
      expect(row.optedOut).toBe(true);
    });

    it('filters to unread only', async () => {
      const id = (
        await api().get('/inbox').set('Authorization', `Bearer ${token}`)
      ).body.data[0].id as number;
      await api().post(`/inbox/${id}/read`).set('Authorization', `Bearer ${token}`);

      const res = await api()
        .get('/inbox?unread=true')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(envelope<ConversationView[]>(res).data).toHaveLength(0);
    });
  });
});
