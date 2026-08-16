/**
 * Where a support-form topic is delivered.
 *
 * One inbox, still sortable: every topic goes to the support mailbox with the
 * topic as a plus tag — `support+security@…` — so a mail client can file or
 * label on the `To:` header without anyone watching five separate mailboxes.
 *
 * Three levels of configuration, most specific first:
 *
 *   1. `<TOPIC>_EMAIL`      — an explicit mailbox for one topic, used verbatim.
 *   2. `SUPPORT_EMAIL`      — the base. Tagged with the topic, per above.
 *   3. `SUPPORT_EMAIL_TAGGING=false` — for a provider without subaddressing:
 *                             every topic goes to the base address untagged.
 *
 * The `support` topic is never tagged: it is the base mailbox, and
 * `support+support@` says nothing the address did not already say.
 */
export interface MailboxConfig {
  /** `SUPPORT_EMAIL` — the mailbox everything falls back to. */
  base?: string;
  /** `<TOPIC>_EMAIL` for this topic, when one is set. */
  override?: string;
  /** False when the provider does not support `+tag` subaddressing. */
  tagging?: boolean;
}

/** A tag we are willing to put in an address, whatever arrives as the topic. */
const SAFE_TAG = /^[a-z0-9-]+$/;

/**
 * The address for `topic`, or null when nothing is configured — the caller
 * turns that into a 400 rather than dropping the message silently.
 */
export function resolveSupportMailbox(
  topic: string,
  config: MailboxConfig,
): string | null {
  const override = config.override?.trim();
  if (override) return override;

  const base = config.base?.trim();
  if (!base) return null;

  const tag = topic.trim().toLowerCase();
  if (config.tagging === false || tag === 'support' || !SAFE_TAG.test(tag)) {
    return base;
  }

  const at = base.lastIndexOf('@');
  if (at <= 0) return base;

  // A base that already carries a tag has it replaced, not stacked:
  // "support+desk@x.com" for the abuse topic is "support+abuse@x.com".
  const local = base.slice(0, at).split('+')[0];
  const domain = base.slice(at + 1);
  return `${local}+${tag}@${domain}`;
}
