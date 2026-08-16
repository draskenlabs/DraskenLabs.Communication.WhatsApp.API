import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

/** Anything that survives a JSON round trip. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export interface JsonObject {
  [key: string]: Json | undefined;
}

/** Read a nested object out of a recorded body: `object(req.body, 'item')`. */
export function object(body: JsonObject, key: string): JsonObject {
  const value = body[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `Expected an object at "${key}", got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** One request the API made, as the stand-in received it. */
export interface RecordedRequest {
  method: string;
  path: string;
  body: JsonObject;
  auth: { keyId: string; keySecret: string } | null;
}

interface Handler {
  (body: JsonObject, path: string): { status?: number; body: unknown };
}

/** A subscription the stand-in is holding, in Razorpay's own shape. */
interface SubscriptionRecord extends JsonObject {
  id: string;
  status: string;
}

/**
 * A stand-in for Razorpay's REST API, over real HTTP.
 *
 * Unit tests mock `RazorpayService` and so can only prove we call our own mock
 * correctly. This is the other half: axios actually serialises the body, sends
 * basic auth and parses a response, and the suite asserts on what arrived —
 * the plan id a subscription was created against, the amount and quantity of
 * an add-on, whether a cancellation asked for the end of the cycle.
 *
 * It is not a Razorpay emulator. It answers the four calls this API makes,
 * with the shapes their API documents, and records everything.
 */
export class FakeRazorpay {
  private server?: Server;
  private readonly handlers: {
    match: RegExp;
    method: string;
    handler: Handler;
  }[] = [];

  /** Every request received, oldest first. */
  readonly requests: RecordedRequest[] = [];

  /** Subscriptions "created", by id — what a later fetch or cancel returns. */
  readonly subscriptions = new Map<string, SubscriptionRecord>();

  private nextId = 1;

  async start(): Promise<string> {
    this.installDefaults();

    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });

    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((err) => (err ? reject(err) : resolve())),
    );
    this.server = undefined;
  }

  /** Forget every recorded request. Called between tests. */
  reset(): void {
    this.requests.length = 0;
    this.subscriptions.clear();
    this.nextId = 1;
    this.handlers.length = 0;
    this.installDefaults();
  }

  /** Replace the answer for one route — for the failure paths. */
  on(method: string, match: RegExp, handler: Handler): void {
    this.handlers.unshift({ method, match, handler });
  }

  /** Requests to one route, in order. */
  received(method: string, match: RegExp): RecordedRequest[] {
    return this.requests.filter(
      (r) => r.method === method && match.test(r.path),
    );
  }

  /** The single request to one route, failing loudly when that is not true. */
  only(method: string, match: RegExp): RecordedRequest {
    const matches = this.received(method, match);
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one ${method} to ${match}, saw ${matches.length}: ` +
          JSON.stringify(this.requests.map((r) => `${r.method} ${r.path}`)),
      );
    }
    return matches[0];
  }

  private installDefaults(): void {
    this.handlers.push({
      method: 'POST',
      match: /^\/customers$/,
      handler: (body) => ({
        body: { id: `cust_${this.nextId++}`, ...body },
      }),
    });

    this.handlers.push({
      method: 'PATCH',
      match: /^\/customers\//,
      handler: (body, path) => ({ body: { id: path.split('/')[2], ...body } }),
    });

    this.handlers.push({
      method: 'POST',
      match: /^\/subscriptions$/,
      handler: (body) => {
        // Razorpay answers a creation with `created`: nothing is charged until
        // the customer authorises the mandate, and `current_end` is absent
        // until then.
        const subscription: SubscriptionRecord = {
          id: `sub_${this.nextId++}`,
          plan_id: body.plan_id,
          customer_id: body.customer_id,
          status: 'created',
          short_url: 'https://rzp.io/i/test',
          notes: body.notes,
          current_start: null,
          current_end: null,
        };
        this.subscriptions.set(subscription.id, subscription);
        return { body: subscription };
      },
    });

    this.handlers.push({
      method: 'POST',
      match: /^\/subscriptions\/[^/]+\/cancel$/,
      handler: (body, path) => {
        const id = path.split('/')[2];
        const existing: SubscriptionRecord = this.subscriptions.get(id) ?? {
          id,
          status: 'active',
        };
        // At cycle end Razorpay keeps it active until the period runs out;
        // immediately, it is cancelled there and then.
        const status = body.cancel_at_cycle_end ? existing.status : 'cancelled';
        const updated: SubscriptionRecord = { ...existing, status };
        this.subscriptions.set(id, updated);
        return { body: updated };
      },
    });

    this.handlers.push({
      method: 'POST',
      match: /^\/subscriptions\/[^/]+\/addons$/,
      handler: (body, path) => ({
        body: {
          id: `ao_${this.nextId++}`,
          subscription_id: path.split('/')[2],
          item: body.item,
          quantity: body.quantity,
        },
      }),
    });

    this.handlers.push({
      method: 'GET',
      match: /^\/subscriptions\/[^/]+$/,
      handler: (_body, path) => {
        const id = path.split('/')[2];
        const existing = this.subscriptions.get(id);
        return existing
          ? { body: existing }
          : { status: 404, body: { error: { description: 'not found' } } };
      },
    });

    this.handlers.push({
      method: 'GET',
      match: /^\/plans\//,
      handler: (_body, path) => {
        const id = path.split('/')[2];
        // Prices as the tiers publish them, so a test can assert the console
        // is told what the customer will actually be charged.
        const amounts: Record<string, number> = {
          plan_starter: 49900,
          plan_growth: 99900,
          plan_business: 199900,
        };
        return {
          body: {
            id,
            period: 'monthly',
            interval: 1,
            item: { amount: amounts[id] ?? 49900, currency: 'INR', name: id },
          },
        };
      },
    });
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');

    let body: JsonObject = {};
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        body =
          typeof parsed === 'object' &&
          parsed !== null &&
          !Array.isArray(parsed)
            ? (parsed as JsonObject)
            : { raw };
      } catch {
        body = { raw };
      }
    }

    const path = (req.url ?? '').split('?')[0];
    const header = req.headers.authorization ?? '';
    const decoded = header.startsWith('Basic ')
      ? Buffer.from(header.slice(6), 'base64').toString('utf8').split(':')
      : null;

    this.requests.push({
      method: req.method ?? 'GET',
      path,
      body,
      auth: decoded ? { keyId: decoded[0], keySecret: decoded[1] } : null,
    });

    const route = this.handlers.find(
      (h) => h.method === (req.method ?? 'GET') && h.match.test(path),
    );
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: { description: `no stub for ${path}` } }),
      );
      return;
    }

    const { status = 200, body: payload } = route.handler(body, path);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
}
