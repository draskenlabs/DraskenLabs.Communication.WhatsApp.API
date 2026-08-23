import { inboundPreview, outboundPreview } from './preview';

describe('inboundPreview', () => {
  it('quotes the words a reply carries', () => {
    expect(inboundPreview('text', { body: 'Thanks!' })).toBe('Thanks!');
  });

  it('prefers a caption over describing the attachment', () => {
    expect(inboundPreview('image', { caption: 'My receipt' })).toBe(
      'My receipt',
    );
  });

  it('describes a reply that has no words of its own', () => {
    expect(inboundPreview('image', { id: 'MEDIA1' })).toBe('Sent a photo');
    expect(inboundPreview('sticker', {})).toBe('Sent a sticker');
  });

  it('falls back for a type nobody has taught it', () => {
    expect(inboundPreview('hologram', {})).toBe('Sent a message');
  });

  it('collapses whitespace and truncates a long reply', () => {
    const long = 'a'.repeat(200);
    const preview = inboundPreview('text', { body: long });
    expect(preview).toHaveLength(120);
    expect(preview.endsWith('…')).toBe(true);
    expect(inboundPreview('text', { body: ' hello \n  world ' })).toBe(
      'hello world',
    );
  });

  it('survives a missing payload', () => {
    expect(inboundPreview('text', undefined)).toBe('Sent a message');
    expect(inboundPreview('text', { body: '   ' })).toBe('Sent a message');
  });
});

describe('outboundPreview', () => {
  it('reads the words out of the type block', () => {
    expect(outboundPreview('text', { text: { body: 'Hello there' } })).toBe(
      'Hello there',
    );
    expect(outboundPreview('image', { image: { caption: 'Here it is' } })).toBe(
      'Here it is',
    );
  });

  it('names a template rather than quoting it', () => {
    expect(outboundPreview('template', { template: { name: 'welcome' } })).toBe(
      'Template · welcome',
    );
  });

  it('prefers the denormalised template name, which is the one the list shows', () => {
    expect(
      outboundPreview(
        'template',
        { template: { name: 'stale' } },
        'order_update',
      ),
    ).toBe('Template · order_update');
  });

  it('describes a template whose name was never recorded', () => {
    expect(outboundPreview('template', {})).toBe('Template');
  });

  it('reaches one level further down for an interactive body', () => {
    expect(
      outboundPreview('interactive', {
        interactive: { body: { text: 'Pick one' } },
      }),
    ).toBe('Pick one');
  });

  it('describes a send with nothing to quote', () => {
    expect(
      outboundPreview('image', { image: { link: 'https://x/y.jpg' } }),
    ).toBe('Photo');
    expect(outboundPreview('location', { location: {} })).toBe('Location');
  });

  it('speaks from our side, not the customer’s', () => {
    expect(outboundPreview('image', {})).toBe('Photo');
    expect(inboundPreview('image', {})).toBe('Sent a photo');
  });
});
