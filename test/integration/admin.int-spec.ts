import * as request from 'supertest';
import type { Server } from 'http';
import { Harness, ORG, seedAccount, startHarness } from './harness';

/** The wrapper every response comes in. */
function data<T>(res: request.Response): T {
  return (res.body as { data: T }).data;
}

/**
 * The operator console, against a real database and a real HTTP stack.
 *
 * The unit suite proves the guard's decision in isolation. This proves the two
 * things it cannot: that the guard is actually wired to the controller — a
 * guard declared and not applied is the exact bug a unit test misses — and that
 * refusal reaches the client as a 404 rather than a 401 or a 403.
 */
describe('Admin console (integration)', () => {
  let h: Harness;
  /** The seeded `growth` row, so the edits below can be put back. */
  let seededGrowth: { maxContacts: number | null; recommended: boolean };

  beforeAll(async () => {
    h = await startHarness();
    const growth = await h.prisma.plan.findUniqueOrThrow({
      where: { code: 'growth' },
      select: { maxContacts: true, recommended: true },
    });
    seededGrowth = growth;
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.reset();
  });

  // `reset()` truncates what a test writes but not the price list, which a
  // migration seeds — so the one suite that edits a plan has to put it back,
  // or every later suite reads limits this one invented.
  afterEach(async () => {
    await h.prisma.plan.update({
      where: { code: 'growth' },
      data: seededGrowth,
    });
  });

  const http = () => request(h.app.getHttpServer() as Server);

  /** A signed-in person, admin or not. */
  async function signedIn(isAdmin: boolean): Promise<string> {
    const { userId } = await seedAccount(h.prisma);
    await h.prisma.user.update({ where: { id: userId }, data: { isAdmin } });
    return h.signIn(userId, ORG);
  }

  describe('who can see that this exists at all', () => {
    it('is not found to somebody with no token', async () => {
      await http().get('/admin/me').expect(404);
    });

    it('is not found to somebody holding a rubbish token', async () => {
      await http()
        .get('/admin/me')
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(404);
    });

    it('is not found to a signed-in customer', async () => {
      // The important one. A 403 here would confirm the console exists to
      // every customer who ever pointed a browser at /admin.
      const token = await signedIn(false);

      await http()
        .get('/admin/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('opens for an admin', async () => {
      const token = await signedIn(true);

      const res = await http()
        .get('/admin/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(data<{ email: string }>(res).email).toBe(
        'integration@example.test',
      );
    });

    it('closes again the moment the flag is taken away', async () => {
      // No cache to wait out: the flag is read per request, so a demotion is
      // immediate rather than eventual.
      const { userId } = await seedAccount(h.prisma);
      await h.prisma.user.update({
        where: { id: userId },
        data: { isAdmin: true },
      });
      const token = await h.signIn(userId, ORG);

      await http()
        .get('/admin/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      await h.prisma.user.update({
        where: { id: userId },
        data: { isAdmin: false },
      });

      await http()
        .get('/admin/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('guards every route on the prefix, not only the one', async () => {
      const token = await signedIn(false);

      for (const path of [
        '/admin/overview',
        '/admin/organisations',
        '/admin/subscriptions',
        '/admin/plans',
        '/admin/admins',
        '/admin/audit',
      ]) {
        await http()
          .get(path)
          .set('Authorization', `Bearer ${token}`)
          .expect(404);
      }
    });
  });

  describe('what an admin sees', () => {
    it('lists an organisation that has only ever connected an account', async () => {
      const token = await signedIn(true);
      await seedAccount(h.prisma, {
        wabaId: 'waba_other',
        ssoOrgId: 'org_other',
        numbers: 2,
      });

      const res = await http()
        .get('/admin/organisations')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const { organisations: orgs } = data<{
        organisations: { ssoOrgId: string; phoneNumbers: number }[];
      }>(res);
      const other = orgs.find((o) => o.ssoOrgId === 'org_other');
      expect(other?.phoneNumbers).toBe(2);
    });

    it('reads one organisation in full', async () => {
      const token = await signedIn(true);

      const res = await http()
        .get(`/admin/organisations/${ORG}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const detail = data<{ accounts: unknown[]; ssoOrgId: string }>(res);
      expect(detail.accounts).toHaveLength(1);
      expect(detail.ssoOrgId).toBe(ORG);
    });

    it('404s for an organisation with no trace of it', async () => {
      const token = await signedIn(true);

      await http()
        .get('/admin/organisations/org_nothing')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('shows the seeded price list, private plans and all', async () => {
      const token = await signedIn(true);

      const res = await http()
        .get('/admin/plans')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const codes = data<{ code: string }[]>(res).map((p) => p.code);
      expect(codes).toContain('starter');
      expect(codes).toContain('growth');
    });
  });

  describe('what an admin changes', () => {
    it('edits a plan and leaves a record of the edit', async () => {
      const token = await signedIn(true);

      await http()
        .patch('/admin/plans/growth')
        .set('Authorization', `Bearer ${token}`)
        .send({ maxContacts: 25_000 })
        .expect(200);

      const plan = await h.prisma.plan.findUnique({
        where: { code: 'growth' },
      });
      expect(plan?.maxContacts).toBe(25_000);

      const entry = await h.prisma.adminAuditLog.findFirst({
        where: { action: 'plan.updated' },
      });
      expect(entry?.targetId).toBe('growth');
      expect(entry?.before).toEqual({ maxContacts: 10_000 });
      expect(entry?.after).toEqual({ maxContacts: 25_000 });
    });

    it('refuses to price a plan here, whatever is sent', async () => {
      // A Razorpay plan is immutable and a subscription is charged against the
      // one it was created on. The field is not in the DTO, and the validator
      // strips it rather than letting it reach the update.
      const token = await signedIn(true);
      const before = await h.prisma.plan.findUnique({
        where: { code: 'growth' },
      });

      await http()
        .patch('/admin/plans/growth')
        .set('Authorization', `Bearer ${token}`)
        .send({ price: 1 })
        .expect(200);

      const after = await h.prisma.plan.findUnique({
        where: { code: 'growth' },
      });
      expect(after?.price).toBe(before?.price);
    });

    it('makes an organisation an agency, naming who did it', async () => {
      const token = await signedIn(true);

      await http()
        .post(`/admin/organisations/${ORG}/agency`)
        .set('Authorization', `Bearer ${token}`)
        .send({ isAgency: true })
        .expect(201);

      const settings = await h.prisma.organisationSettings.findUnique({
        where: { ssoOrgId: ORG },
      });
      expect(settings?.isAgency).toBe(true);
      // The row that explains why somebody could read another organisation's
      // messages names a person, not a shared token.
      expect(settings?.convertedBy).toBeGreaterThan(0);
    });

    it('will not let the last admin remove themselves', async () => {
      const { userId } = await seedAccount(h.prisma);
      await h.prisma.user.update({
        where: { id: userId },
        data: { isAdmin: true },
      });
      const token = await h.signIn(userId, ORG);

      await http()
        .patch(`/admin/users/${userId}/admin`)
        .set('Authorization', `Bearer ${token}`)
        .send({ isAdmin: false })
        .expect(400);

      const still = await h.prisma.user.findUnique({ where: { id: userId } });
      expect(still?.isAdmin).toBe(true);
    });
  });

  describe('the user directory and one user', () => {
    it('does not let /users/:id swallow /users/directory', async () => {
      // Both are two segments under /admin/users. Declared the other way round,
      // ':id' matches the literal "directory" and the list 400s on a
      // ParseIntPipe — which reads as a broken page, not a routing mistake.
      const token = await signedIn(true);

      const res = await http()
        .get('/admin/users/directory')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(Array.isArray(data<{ users: unknown[] }>(res).users)).toBe(true);
    });

    it('opens one user by id', async () => {
      const token = await signedIn(true);
      const me = await h.prisma.user.findFirstOrThrow({
        where: { isAdmin: true },
      });

      const res = await http()
        .get(`/admin/users/${me.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(data<{ id: number }>(res).id).toBe(me.id);
    });

    it('404s for a user who does not exist', async () => {
      const token = await signedIn(true);

      await http()
        .get('/admin/users/999999')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('is not found to a customer, like the rest of the console', async () => {
      const token = await signedIn(false);

      await http()
        .get('/admin/users/directory')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });
});
