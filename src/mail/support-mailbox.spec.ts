import { resolveSupportMailbox } from './support-mailbox';

const base = 'support@draskenlabs.com';

describe('resolveSupportMailbox', () => {
  it('tags the topic onto the support mailbox', () => {
    expect(resolveSupportMailbox('security', { base })).toBe(
      'support+security@draskenlabs.com',
    );
    expect(resolveSupportMailbox('privacy', { base })).toBe(
      'support+privacy@draskenlabs.com',
    );
  });

  it('leaves the support topic untagged — it is the mailbox itself', () => {
    expect(resolveSupportMailbox('support', { base })).toBe(base);
  });

  it('lets a topic override the tagged address entirely', () => {
    expect(
      resolveSupportMailbox('security', {
        base,
        override: 'security@draskenlabs.com',
      }),
    ).toBe('security@draskenlabs.com');
  });

  it('sends everything to the base when the provider has no subaddressing', () => {
    expect(resolveSupportMailbox('abuse', { base, tagging: false })).toBe(base);
  });

  it('replaces a tag the base already carries rather than stacking one', () => {
    expect(
      resolveSupportMailbox('abuse', { base: 'support+desk@draskenlabs.com' }),
    ).toBe('support+abuse@draskenlabs.com');
  });

  it('refuses to put anything but a plain tag in an address', () => {
    // The DTO whitelists the topic, but an address is not the place to trust it.
    expect(resolveSupportMailbox('a@b.com>, evil', { base })).toBe(base);
    expect(resolveSupportMailbox('sec urity', { base })).toBe(base);
  });

  it('is null when nothing is configured, so the caller can say so', () => {
    expect(resolveSupportMailbox('privacy', {})).toBeNull();
    expect(resolveSupportMailbox('privacy', { base: '  ' })).toBeNull();
  });

  it('tolerates a base that is not an address rather than mangling it', () => {
    expect(resolveSupportMailbox('privacy', { base: 'not-an-address' })).toBe(
      'not-an-address',
    );
  });
});
