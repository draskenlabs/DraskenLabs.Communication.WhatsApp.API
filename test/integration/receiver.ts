import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

/** One delivery as the customer's server received it. */
export interface ReceivedDelivery {
  path: string;
  headers: Record<string, string>;
  /** The exact bytes, which is what a signature is computed over. */
  raw: string;
  body: Record<string, unknown>;
}

/**
 * A customer's endpoint.
 *
 * The other side of the delivery: a real HTTP server that records what arrived
 * and answers however a test needs it to. Anything asserted here — a header, a
 * signature, the envelope — is what a customer's own server would see.
 */
export class Receiver {
  private server?: Server;
  private status = 200;
  private delay = 0;
  private location: string | null = null;

  readonly received: ReceivedDelivery[] = [];

  /** Base URL, e.g. `http://127.0.0.1:41234`. */
  url = '';

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((err) => (err ? reject(err) : resolve())),
    );
    this.server = undefined;
  }

  /** Forget what was received and answer 200 again. */
  reset(): void {
    this.received.length = 0;
    this.status = 200;
    this.delay = 0;
    this.location = null;
  }

  /** Answer with this status from now on. */
  answers(status: number): void {
    this.status = status;
  }

  /** Answer with a redirect — which a deliverer must not follow. */
  redirectsTo(location: string): void {
    this.status = 302;
    this.location = location;
  }

  /** Take this long to answer, for the timeout path. */
  takes(ms: number): void {
    this.delay = ms;
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');

    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // A body that is not JSON is a failure the assertions will show.
    }

    this.received.push({
      path: req.url ?? '/',
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(',') : (value ?? ''),
        ]),
      ),
      raw,
      body,
    });

    if (this.delay) {
      await new Promise((resolve) => setTimeout(resolve, this.delay));
    }

    const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
    if (this.location) headers.Location = this.location;
    res.writeHead(this.status, headers);
    res.end(this.status >= 400 ? 'upstream is unhappy' : 'ok');
  }
}
