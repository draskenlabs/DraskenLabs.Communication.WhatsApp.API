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
