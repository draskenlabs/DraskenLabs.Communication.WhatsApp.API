/**
 * Email bodies. Plain functions returning a subject and the two body parts —
 * no template engine, because the set is small and a build step for six
 * layouts is not worth the dependency.
 *
 * Every template returns text as well as HTML: a mail client that refuses HTML
 * must still deliver the message, and a text part measurably improves the spam
 * score.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

interface LayoutOptions {
  heading: string;
  intro: string;
  /** Label/value rows shown as a small table. */
  facts?: [string, string][];
  /** Paragraphs after the facts. */
  paragraphs?: string[];
  action?: { label: string; url: string };
  /** Appended in grey — why this email arrived. */
  footnote?: string;
  unsubscribeUrl?: string;
}

const BRAND = '#1faa59';

/** Escapes text destined for HTML. Every value here comes from Meta or a user. */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One shared layout: inline styles only (mail clients drop <style> blocks),
 * a single column, and no images that could be blocked.
 */
export function layout(options: LayoutOptions): { html: string; text: string } {
  const {
    heading,
    intro,
    facts = [],
    paragraphs = [],
    action,
    footnote,
    unsubscribeUrl,
  } = options;

  const factRows = facts
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:6px 0;color:#667085;font-size:13px;">${escape(label)}</td>
          <td style="padding:6px 0;color:#101828;font-size:13px;font-weight:600;text-align:right;">${escape(value)}</td>
        </tr>`,
    )
    .join('');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f7f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;border:1px solid #e4e7ec;">
    <tr><td style="padding:24px 28px 8px;">
      <span style="display:inline-block;width:28px;height:28px;border-radius:8px;background:${BRAND};"></span>
      <span style="margin-left:8px;font-size:14px;font-weight:700;color:#101828;vertical-align:top;line-height:28px;">WhatsApp Console</span>
    </td></tr>
    <tr><td style="padding:8px 28px 0;">
      <h1 style="margin:0 0 8px;font-size:19px;line-height:1.35;color:#101828;">${escape(heading)}</h1>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#475467;">${escape(intro)}</p>
    </td></tr>
    ${
      factRows
        ? `<tr><td style="padding:16px 28px 0;">
             <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e4e7ec;">${factRows}</table>
           </td></tr>`
        : ''
    }
    ${paragraphs
      .map(
        (p) =>
          `<tr><td style="padding:14px 28px 0;font-size:14px;line-height:1.6;color:#475467;">${escape(p)}</td></tr>`,
      )
      .join('')}
    ${
      action
        ? `<tr><td style="padding:20px 28px 4px;">
             <a href="${escape(action.url)}" style="display:inline-block;padding:10px 18px;border-radius:10px;background:${BRAND};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">${escape(action.label)}</a>
           </td></tr>`
        : ''
    }
    <tr><td style="padding:22px 28px 26px;">
      <p style="margin:0;padding-top:16px;border-top:1px solid #e4e7ec;font-size:12px;line-height:1.6;color:#98a2b3;">
        ${escape(footnote ?? 'You are receiving this because you use WhatsApp Console.')}
        ${
          unsubscribeUrl
            ? ` <a href="${escape(unsubscribeUrl)}" style="color:#98a2b3;">Unsubscribe</a>.`
            : ''
        }
      </p>
      <p style="margin:10px 0 0;font-size:11px;line-height:1.6;color:#b4bcc7;">
        WhatsApp is a trademark of Meta Platforms, Inc. Drasken Labs is an independent Tech Provider and is not affiliated with or endorsed by Meta.
      </p>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    heading,
    '',
    intro,
    ...(facts.length ? ['', ...facts.map(([l, v]) => `${l}: ${v}`)] : []),
    ...(paragraphs.length ? ['', ...paragraphs] : []),
    ...(action ? ['', `${action.label}: ${action.url}`] : []),
    '',
    footnote ?? 'You are receiving this because you use WhatsApp Console.',
    ...(unsubscribeUrl ? [`Unsubscribe: ${unsubscribeUrl}`] : []),
  ].join('\n');

  return { html, text };
}
