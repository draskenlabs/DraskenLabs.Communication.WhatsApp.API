import { WebhookEventKind } from './dto/webhook-event.dto';

/** The display fields derived from one raw Meta change payload. */
export interface DescribedEvent {
  kind: WebhookEventKind;
  title: string;
  detail?: string;
  status?: string;
  recipient?: string;
  messageId?: string;
  reason?: string;
}

/** Narrowing helpers — webhook payloads are untrusted and loosely shaped. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** "marketing" → "Marketing", "TIER_1K" → "Tier 1k". */
function humanise(value: string): string {
  const words = value.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A short preview of what the customer actually sent. */
function inboundPreview(
  message: Record<string, unknown>,
  senderName?: string,
): string | undefined {
  const body =
    asString(asObject(message.text)?.body) ??
    asString(asObject(message.button)?.text) ??
    asString(asObject(asObject(message.interactive)?.button_reply)?.title) ??
    asString(asObject(asObject(message.interactive)?.list_reply)?.title) ??
    asString(asObject(message.image)?.caption) ??
    asString(asObject(message.video)?.caption);

  const preview = body && body.length > 140 ? `${body.slice(0, 139)}…` : body;
  return [senderName, preview].filter(Boolean).join(': ') || undefined;
}

/** A delivery status update: who it was for, and why it failed. */
function describeStatus(status: Record<string, unknown>): DescribedEvent {
  const state = asString(status.status);
  // Meta reports a failure as an array; the title is the short form
  // ("Message undeliverable") and the details add the specifics.
  const error = asObject(asArray(status.errors)[0]);
  const reason = error
    ? [
        asString(error.title),
        asString(asObject(error.error_data)?.details) ??
          asString(error.message),
      ]
        .filter((part): part is string => part !== undefined)
        .join(' — ')
    : undefined;

  const category = asString(
    asObject(asObject(status.conversation)?.origin)?.type,
  );
  const billable = asObject(status.pricing)?.billable;
  const detail = category
    ? billable === false
      ? `${humanise(category)} conversation · free`
      : `${humanise(category)} conversation`
    : undefined;

  return {
    kind: 'status_update',
    title: state ? `Message ${state}` : 'Message status updated',
    status: state,
    recipient: asString(status.recipient_id),
    messageId: asString(status.id),
    reason: reason || undefined,
    detail,
  };
}

/**
 * Turn a raw Meta change payload into something a human can read.
 *
 * The raw payload is all ids — a `wamid` is 60-odd characters of base64 and
 * tells an operator nothing. What they want to know is what happened, to which
 * number, and why it failed. Everything below is pulled out into named fields
 * so the console can lay it out rather than parse a sentence back apart.
 *
 * The same fields go out to customer endpoints, which is why this lives in its
 * own module rather than inside the service: an integrator reading our webhook
 * gets the named parts too, not just Meta's shape passed through.
 *
 * Payloads are untrusted input from a webhook, so every access is narrowed
 * rather than asserted.
 */
export function describeEvent(
  eventType: string,
  payload: unknown,
): DescribedEvent {
  const value = asObject(payload) ?? {};

  switch (eventType) {
    case 'messages': {
      const status = asObject(asArray(value.statuses)[0]);
      if (status) return describeStatus(status);

      const message = asObject(asArray(value.messages)[0]);
      if (message) {
        const contact = asObject(asArray(value.contacts)[0]);
        const senderName = asString(asObject(contact?.profile)?.name);
        const type = asString(message.type) ?? 'message';
        return {
          kind: 'inbound_message',
          title: type === 'text' ? 'Reply received' : `Inbound ${type}`,
          recipient: asString(message.from),
          messageId: asString(message.id),
          detail: inboundPreview(message, senderName),
        };
      }
      return { kind: 'status_update', title: 'Message event' };
    }

    case 'message_template_status_update': {
      const event = asString(value.event);
      const reason = asString(value.reason);
      return {
        kind: 'template_status',
        title: event ? `Template ${event.toLowerCase()}` : 'Template updated',
        status: event,
        // "NONE" is Meta's no-reason sentinel, not a reason.
        reason: reason && reason.toUpperCase() !== 'NONE' ? reason : undefined,
        detail: [
          asString(value.message_template_name),
          asString(value.message_template_language),
        ]
          .filter((part): part is string => part !== undefined)
          .join(' · '),
      };
    }

    case 'phone_number_quality_update': {
      const limit = asString(value.current_limit);
      return {
        kind: 'account_update',
        title: 'Number quality changed',
        status: asString(value.event),
        recipient: asString(value.display_phone_number),
        detail: limit ? `Messaging limit now ${humanise(limit)}` : undefined,
      };
    }

    case 'phone_number_name_update':
      return {
        kind: 'account_update',
        title: 'Display name review',
        status: asString(value.decision),
        recipient: asString(value.display_phone_number),
        detail: asString(value.requested_verified_name),
      };

    case 'account_update': {
      const event = asString(value.event);
      return {
        kind: 'account_update',
        title: event ? `Account ${humanise(event)}` : 'Account updated',
        status: event,
        detail: asString(asObject(value.ban_info)?.waba_ban_state),
      };
    }

    default:
      return { kind: 'account_update', title: eventType.replace(/_/g, ' ') };
  }
}
