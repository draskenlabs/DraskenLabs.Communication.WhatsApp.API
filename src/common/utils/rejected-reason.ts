/**
 * Meta's Graph API and its `message_template_status_update` webhook both use
 * the string `"NONE"` — not `null` — to mean "this template was never
 * rejected". Storing that verbatim makes every approved template look like it
 * carries a rejection reason, so clients that render `rejectedReason` when it
 * is truthy end up showing "NONE" in an error box.
 *
 * Normalise at every boundary where a reason enters the system, so that a
 * non-null `rejectedReason` always means an actual rejection.
 */
export function normalizeRejectedReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === 'NONE') return null;
  return trimmed;
}

/**
 * The most informative reason in a `message_template_status_update` payload.
 *
 * Meta puts the machine-readable enum in `reason` (`INCORRECT_CATEGORY`, …)
 * and, when it has one, the sentence a person can act on in `other_info` —
 * `{ title, description }`, sometimes delivered as a JSON string rather than an
 * object. Reading only `reason` threw the sentence away and, worse, left
 * nothing at all whenever Meta sent `reason: "NONE"` alongside a populated
 * `other_info`: the console then showed a rejected template with no explanation
 * of what to fix.
 *
 * Preference order is most specific first — the description, then the title,
 * then the enum — and `"NONE"` in any of them means "not this one" rather than
 * a reason.
 */
export function templateStatusReason(value: {
  reason?: unknown;
  other_info?: unknown;
}): string | null {
  const info = parseOtherInfo(value?.other_info);
  return (
    normalizeRejectedReason(info?.description) ??
    normalizeRejectedReason(info?.title) ??
    normalizeRejectedReason(value?.reason)
  );
}

/** `other_info` arrives as an object or as a JSON string of one. */
function parseOtherInfo(
  raw: unknown,
): { title?: unknown; description?: unknown } | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // A bare sentence is not JSON, and is a description in its own right.
    if (!trimmed.startsWith('{')) return { description: trimmed };
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
      return { description: trimmed };
    }
  }
  return typeof raw === 'object' && raw !== null ? raw : null;
}
