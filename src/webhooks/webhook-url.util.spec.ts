import { BadRequestException } from '@nestjs/common';
import { assertSafeWebhookUrl } from './webhook-url.util';

describe('assertSafeWebhookUrl', () => {
  it('accepts a public https URL and returns it normalised', () => {
    expect(assertSafeWebhookUrl('https://api.example.com/hooks')).toBe(
      'https://api.example.com/hooks',
    );
    expect(assertSafeWebhookUrl('https://api.example.com:443/hooks')).toBe(
      'https://api.example.com/hooks',
    );
  });

  it('refuses plain http', () => {
    expect(() => assertSafeWebhookUrl('http://api.example.com/hooks')).toThrow(
      BadRequestException,
    );
  });

  it('refuses anything that is not a URL', () => {
    expect(() => assertSafeWebhookUrl('example.com/hooks')).toThrow(
      BadRequestException,
    );
  });

  it('refuses credentials in the URL', () => {
    expect(() =>
      assertSafeWebhookUrl('https://user:pass@api.example.com/h'),
    ).toThrow(BadRequestException);
  });

  it.each([
    'https://localhost/hooks',
    'https://api.localhost/hooks',
    'https://orders.internal/hooks',
    'https://svc.cluster.local/hooks',
    'https://127.0.0.1/hooks',
    'https://10.1.2.3/hooks',
    'https://172.16.0.9/hooks',
    'https://192.168.1.10/hooks',
    // The cloud metadata address — the whole reason this check exists.
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/hooks',
    'https://[fd00::1]/hooks',
  ])('refuses %s', (url) => {
    expect(() => assertSafeWebhookUrl(url)).toThrow(BadRequestException);
  });

  it('refuses an IPv4 address dressed as IPv6', () => {
    expect(() =>
      assertSafeWebhookUrl('https://[::ffff:169.254.169.254]/x'),
    ).toThrow(BadRequestException);
  });

  it('allows http and loopback only when a deployment turns it on', () => {
    expect(assertSafeWebhookUrl('http://localhost:4000/hooks', true)).toBe(
      'http://localhost:4000/hooks',
    );
    // Still not a free-for-all: the URL must parse and carry no credentials.
    expect(() =>
      assertSafeWebhookUrl('https://a:b@localhost/hooks', true),
    ).toThrow(BadRequestException);
  });

  it('is not fooled by a public-looking prefix on a private host', () => {
    // "10.0.0.1.example.com" is a real public name and must pass; the literal
    // must not.
    expect(assertSafeWebhookUrl('https://10.0.0.1.example.com/h')).toContain(
      'example.com',
    );
    expect(() => assertSafeWebhookUrl('https://10.0.0.1/h')).toThrow(
      BadRequestException,
    );
  });
});
