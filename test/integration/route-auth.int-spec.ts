import * as request from 'supertest';
import type { Server } from 'http';
import { Harness, ORG, seedAccount, startHarness } from './harness';

/**
 * Every route the application registers, probed for who may reach it.
 *
 * Written after a regression no unit test could see. `AuthMiddleware` was bound
 * to an enumerated list of paths; five routes were added without adding them to
 * the list; the controller reads `req.orgId`, which only that middleware sets,
 * so each answered 401 — and the console treats a 401 as a dead session, so
 * opening the billing page signed the customer out. A sixth route went the
 * other way and answered anybody who asked.
 *
 * Both directions are one mistake: **the route list and the middleware list are
 * two places, and they drifted.** So this suite reads neither list. It asks the
 * running application what it registered, and probes it.
 *
 * Two properties, opposite ends of the same rule:
 *
 *   - nothing outside `PUBLIC` answers a caller with no credential;
 *   - nothing at all refuses a signed-in one *for want of a session*.
 *
 * Widening either allowlist shows up in a diff and has to be argued for. That
 * is the point of them.
 */

/** Routes that answer anybody, by design. */
const PUBLIC: { route: string; because: string }[] = [
  { route: 'GET /', because: 'Health check, hit by the cluster' },
  {
    route: 'POST /auth/callback',
    because: 'Exchanges the SSO code for a session; there is none yet',
  },
  {
    route: 'GET /plans',
    because: 'The public price list — the pricing page has no session',
  },
  { route: 'GET /plans/:code', because: 'Same, for one tier' },
  {
    route: 'POST /billing/webhook',
    because: 'Razorpay authenticates by signature, not a session',
  },
  {
    route: 'GET /webhooks',
    because: "Meta's subscription verification handshake",
  },
  { route: 'POST /webhooks', because: 'Meta authenticates by signature' },
  {
    route: 'POST /mail/events',
    because: 'SES delivery notifications, authenticated by signature',
  },
  {
    route: 'POST /mail/unsubscribe',
    because: 'Reached from a link in an email, by somebody signed out',
  },
  {
    route: 'POST /mail/support',
    because: 'Somebody locked out, or with no account, still has to reach us',
  },
];

/**
 * Routes that authenticate *inside the handler* rather than through the JWT
 * middleware, and so are neither public nor covered by the session checks.
 *
 * Each carries its own credential. They are listed rather than probed because
 * this suite holds none of those credentials: it can prove they are not open,
 * but not that they work — that is each module's own test.
 */
const SELF_AUTHENTICATING: { route: string; credential: string }[] = [
  {
    route: 'POST /mail/broadcast',
    credential: 'x-mail-admin-token; off unless configured',
  },
  {
    route: 'POST /agency/internal/convert',
    credential: 'x-agency-admin-token; off unless configured',
  },
  {
    route: 'POST /agency/internal/clients',
    credential: 'x-agency-admin-token; off unless configured',
  },
  {
    route: 'DELETE /agency/internal/clients/:agencyOrgId/:ssoOrgId',
    credential: 'x-agency-admin-token',
  },
  {
    route: 'GET /auth/organisations',
    credential: "The SSO's own bearer token, exchanged in the handler",
  },
  { route: 'POST /auth/organisations', credential: 'Same' },
  { route: 'POST /auth/select-org', credential: 'Same' },
  {
    route: 'GET /organisation',
    credential: 'Same — this module proxies the SSO',
  },
  { route: 'GET /organisation/:orgId', credential: 'Same' },
  { route: 'PATCH /organisation/:orgId', credential: 'Same' },
  { route: 'GET /organisation/:orgId/members', credential: 'Same' },
  { route: 'POST /organisation/:orgId/members/invite', credential: 'Same' },
  {
    route: 'PATCH /organisation/:orgId/members/:userId/role',
    credential: 'Same',
  },
  { route: 'DELETE /organisation/:orgId/members/:userId', credential: 'Same' },
  { route: 'GET /organisation/:orgId/invitations', credential: 'Same' },
  {
    // Not self-authenticating at all, and listed here so that it is not
    // silently counted as fine: it mints a session for user id 1 for anybody
    // who asks, and the only thing standing in front of it is
    // `NODE_ENV === 'production'`. Any environment where that variable is
    // unset or spelled differently — a staging cluster, a review app — hands
    // out a working session to whoever can reach the port. Flagged rather
    // than changed, because removing it would break whatever local workflow
    // depends on it; the fix is a guard that fails closed.
    route: 'POST /user/test-token',
    credential: 'None. Refused only when NODE_ENV is exactly "production"',
  },
];

const isPublic = new Set(PUBLIC.map((p) => p.route));
const isSelfAuth = new Set(SELF_AUTHENTICATING.map((p) => p.route));

interface Layer {
  route?: { path?: string; methods?: Record<string, boolean> };
}

/** Fill `:params` with something harmless and syntactically plausible. */
function concrete(path: string): string {
  return path
    .replace(/:number\b/g, 'INV-WAC-2627-0001')
    .replace(/:(wabaId|messageId|id|userId)\b/g, '0')
    .replace(/:[A-Za-z]+/g, 'probe');
}

describe('Route authentication (integration)', () => {
  let h: Harness;
  const routes: { method: string; path: string; key: string }[] = [];

  beforeAll(async () => {
    h = await startHarness();

    const express = h.app.getHttpAdapter().getInstance() as unknown as {
      router?: { stack: Layer[] };
      _router?: { stack: Layer[] };
    };
    const stack = express.router?.stack ?? express._router?.stack ?? [];

    const seen = new Set<string>();
    for (const layer of stack) {
      const path = layer.route?.path;
      if (!path) continue;
      for (const [method, on] of Object.entries(layer.route?.methods ?? {})) {
        if (!on || method === '_all') continue;
        // Nest registers a trailing-slash variant of some paths; the same
        // route probed twice tells us nothing new.
        const clean = path.length > 1 ? path.replace(/\/$/, '') : path;
        const key = `${method.toUpperCase()} ${clean}`;
        if (seen.has(key)) continue;
        seen.add(key);
        routes.push({ method: method.toUpperCase(), path: clean, key });
      }
    }
    routes.sort((a, b) => a.key.localeCompare(b.key));
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.reset();
  });

  const http = () => request(h.app.getHttpServer() as Server);

  it('found a route table to probe', () => {
    // If enumeration ever breaks, every assertion below would vacuously pass.
    expect(routes.length).toBeGreaterThan(60);
  });

  it('refuses every non-public route to a caller with no credential', async () => {
    // Every method, including the mutating ones: they are meant to be refused
    // before the handler, so nothing is written.
    const open: string[] = [];

    for (const route of routes) {
      if (isPublic.has(route.key)) continue;

      const res = await http()
        [route.method.toLowerCase() as 'get'](concrete(route.path))
        .send({});

      // 401 is the answer we want. 404 is stricter and also fine — the admin
      // console hides its existence rather than admitting to it. 403 is a
      // deliberate refusal by a guard.
      const refused = [401, 403, 404].includes(res.status);

      // A route that authenticates in its own handler validates the body
      // first, so an empty probe is rejected as malformed before it is
      // rejected as unauthenticated. Still a refusal.
      const validated = isSelfAuth.has(route.key) && res.status === 400;

      if (!refused && !validated) {
        open.push(`${route.key} answered ${res.status}`);
      }
    }

    expect(open).toEqual([]);
  }, 180_000);

  it('refuses no route to a signed-in customer for want of a session', async () => {
    // Reads only. A GET cannot write, so probing every one is safe; the
    // mutating routes are covered by the anonymous pass above.
    const { userId } = await seedAccount(h.prisma);
    const token = await h.signIn(userId, ORG);

    const refused: string[] = [];

    for (const route of routes) {
      if (route.method !== 'GET') continue;
      if (isPublic.has(route.key) || isSelfAuth.has(route.key)) continue;

      const res = await http()
        .get(concrete(route.path))
        .set('Authorization', `Bearer ${token}`);

      // 404 is fine: a document that does not exist, or the admin console
      // hiding from a customer. 401 is not — this caller has a session.
      if (res.status === 401) refused.push(route.key);
    }

    expect(refused).toEqual([]);
  }, 180_000);

  it('has a justification recorded against every exception', () => {
    // The two allowlists are the security surface. An entry with no reason is
    // an entry nobody reviewed.
    for (const entry of PUBLIC) {
      expect(entry.because.length).toBeGreaterThan(10);
    }
    for (const entry of SELF_AUTHENTICATING) {
      expect(entry.credential.length).toBeGreaterThan(3);
    }
  });

  it('lists no exception the application does not register', () => {
    // A stale allowlist quietly excuses a route that has since been renamed,
    // and the route under its new name is then never probed properly.
    const registered = new Set(routes.map((r) => r.key));
    const stale = [...isPublic, ...isSelfAuth].filter(
      (r) => !registered.has(r),
    );

    expect(stale).toEqual([]);
  });
});
