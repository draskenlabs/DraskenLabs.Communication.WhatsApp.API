/**
 * The one line a conversation shows in the list.
 *
 * Written once as each message lands, rather than derived when the list is
 * read: the alternative is opening a JSON payload per row on every poll, for a
 * string that cannot change after the message is sent.
 *
 * Two vocabularies, because the list reads as a sentence about the other
 * person. A reply is described from their side ("Sent a photo"), our own send
 * from ours ("Photo") — the direction is already on the row, and duplicating
 * "You:" into the text would be a second place to get it wrong.
 */

/** The longest a preview is stored at. Past this the list truncates anyway. */
const MAX_PREVIEW = 120;

/** What a reply was, when it carries no words of its own. */
const INBOUND_SUMMARY: Record<string, string> = {
  image: 'Sent a photo',
  video: 'Sent a video',
  audio: 'Sent a voice message',
  document: 'Sent a document',
  sticker: 'Sent a sticker',
  location: 'Shared a location',
  contacts: 'Shared a contact',
  reaction: 'Reacted to a message',
  button: 'Tapped a button',
  interactive: 'Made a choice',
  order: 'Sent an order',
  unsupported: 'Sent an unsupported message',
};

/** What we sent, when the payload has no caption to quote. */
const OUTBOUND_SUMMARY: Record<string, string> = {
  image: 'Photo',
  video: 'Video',
  audio: 'Voice message',
  document: 'Document',
  location: 'Location',
  contacts: 'Contact',
  reaction: 'Reaction',
  interactive: 'Interactive message',
  template: 'Template',
};

function clamp(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_PREVIEW
    ? `${clean.slice(0, MAX_PREVIEW - 1)}…`
    : clean;
}

/**
 * A reply's preview, from the payload Meta delivered.
 *
 * The inbound payload is the message's own type block — `message.text` for a
 * text, `message.image` for a photo — so the words live at `body` or `caption`
 * with nothing wrapping them.
 */
export function inboundPreview(type: string, payload: unknown): string {
  const fields = (payload ?? {}) as {
    body?: unknown;
    caption?: unknown;
    text?: unknown;
  };
  const words = fields.body ?? fields.caption ?? fields.text;
  if (typeof words === 'string' && words.trim()) return clamp(words);
  return INBOUND_SUMMARY[type] ?? 'Sent a message';
}

/**
 * Our own send's preview, from the Meta payload as posted.
 *
 * Outbound payloads keep the type block under a key of its own
 * (`{ text: { body } }`), which is why this cannot share the inbound reader.
 */
export function outboundPreview(
  type: string,
  payload: unknown,
  templateName?: string | null,
): string {
  const body = (payload ?? {}) as Record<
    string,
    { body?: unknown; caption?: unknown }
  >;

  // A template is named rather than quoted: its text lives with Meta, not in
  // the payload, so there are no words here to show even when it is all words.
  if (type === 'template') {
    const name =
      templateName ?? (body.template as { name?: string } | undefined)?.name;
    return name ? clamp(`Template · ${name}`) : 'Template';
  }

  const block = body[type];
  const words = block?.body ?? block?.caption;
  if (typeof words === 'string' && words.trim()) return clamp(words);

  // An interactive message's words are one level further down.
  if (type === 'interactive') {
    const interactive = body.interactive as
      | { body?: { text?: unknown } }
      | undefined;
    const text = interactive?.body?.text;
    if (typeof text === 'string' && text.trim()) return clamp(text);
  }

  return OUTBOUND_SUMMARY[type] ?? 'Message';
}
