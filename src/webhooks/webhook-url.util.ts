import { BadRequestException } from '@nestjs/common';

/**
 * Hostnames that name the machine we are running on, whatever the DNS says.
 */
const LOCAL_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

/** Suffixes used for names that only resolve inside a private network. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.cluster.local'];

function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map((part) => {
    // "010" and "0x7f" both parse as numbers elsewhere; only plain decimal is
    // a legal dotted quad, and anything else is an obfuscation attempt.
    if (!/^\d{1,3}$/.test(part)) return NaN;
    return Number(part);
  });
  if (octets.some((n) => Number.isNaN(n) || n > 255)) return false;

  const [a, b] = octets;
  return (
    a === 0 || // "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, and the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

function isPrivateIPv6(host: string): boolean {
  // URL parsing keeps the brackets on an IPv6 literal.
  const address = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!address.includes(':')) return false;

  if (address === '::' || address === '::1') return true;
  // Unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(address)) return true;
  // ::ffff:10.0.0.1 — an IPv4 address wearing an IPv6 hat.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return isPrivateIPv4(mapped[1]);

  // The same thing after normalisation: `new URL()` rewrites
  // `::ffff:169.254.169.254` as `::ffff:a9fe:a9fe`, so the dotted check above
  // never sees it. Unpack the two hextets back into a dotted quad.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return isPrivateIPv4(
      [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'),
    );
  }
  return false;
}

/**
 * Reject a callback URL that points back inside our own network.
 *
 * A webhook endpoint is a URL a customer types and we then fetch from a server
 * that sits inside a VPC — which is the definition of an SSRF sink. Someone can
 * register `http://169.254.169.254/latest/meta-data/` and read our instance
 * credentials out of the delivery log, or point at an internal service and use
 * our own network as a proxy. So: HTTPS only, no credentials in the URL, and no
 * address that resolves to us.
 *
 * The check is on the literal host. A hostname that resolves to a private
 * address through DNS still gets through, which is why the deliverer also
 * refuses redirects — an endpoint cannot bounce us somewhere better.
 *
 * `allowInsecure` exists for local development, where the endpoint under test
 * genuinely is `http://localhost:4000/hooks`. It is off unless a deployment
 * turns it on.
 */
export function assertSafeWebhookUrl(
  raw: string,
  allowInsecure = false,
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('Webhook URL is not a valid URL');
  }

  if (
    url.protocol !== 'https:' &&
    !(allowInsecure && url.protocol === 'http:')
  ) {
    throw new BadRequestException('Webhook URL must use https://');
  }

  if (url.username || url.password) {
    throw new BadRequestException(
      'Webhook URL must not contain credentials — use a signing secret or a header-bearing gateway instead',
    );
  }

  const host = url.hostname.toLowerCase();
  if (!host) throw new BadRequestException('Webhook URL must have a hostname');

  if (!allowInsecure) {
    const local =
      LOCAL_HOSTNAMES.has(host) ||
      LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
      isPrivateIPv4(host) ||
      isPrivateIPv6(host);

    if (local) {
      throw new BadRequestException(
        'Webhook URL must be publicly reachable — private, loopback and link-local addresses are refused',
      );
    }
  }

  // Stored normalised, so two rows that differ only in a default port or a
  // trailing empty query do not read as two different endpoints.
  return url.toString();
}
