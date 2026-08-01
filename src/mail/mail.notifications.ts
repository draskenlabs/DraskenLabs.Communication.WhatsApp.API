import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailService } from './mail.service';

/** Human wording for a template decision. */
const TEMPLATE_HEADLINE: Record<string, string> = {
  APPROVED: 'Template approved',
  REJECTED: 'Template rejected',
  PAUSED: 'Template paused by Meta',
  DISABLED: 'Template disabled by Meta',
  FLAGGED: 'Template flagged for quality',
  ARCHIVED: 'Template archived',
};

/**
 * One method per email the platform sends, so the trigger sites read as a
 * single line and every wording decision lives here.
 *
 * Nothing in this class throws: an email is a courtesy on top of an action
 * that has already happened.
 */
@Injectable()
export class MailNotifications {
  private readonly logger = new Logger(MailNotifications.name);

  constructor(
    private readonly mail: MailService,
    private readonly prisma: PrismaService,
  ) {}

  /* ---------------- Transactional: account and security ---------------- */

  /** T1/T3 — what a console deletion actually removed. */
  async accountDeleted(
    email: string,
    counts: Record<string, number>,
  ): Promise<void> {
    const facts = Object.entries(counts)
      .filter(([, value]) => value > 0)
      .map(([key, value]): [string, string] => [
        this.humanise(key),
        String(value),
      ]);

    await this.mail.sendRaw(email, {
      template: 'account.deleted',
      subject: 'Your WhatsApp Console data has been deleted',
      heading: 'Your data has been deleted',
      intro:
        'Everything WhatsApp Console held for your account has been removed. This is your record of what went.',
      facts: facts.length ? facts : [['Records removed', '0']],
      paragraphs: [
        'Your DraskenLabs account is untouched, and your WhatsApp Business Account, phone numbers and approved templates remain with Meta.',
        'Nothing here can be undone. If this was not you, contact us immediately.',
      ],
    });
  }

  /** T2 — a key was issued. The secret itself is never emailed. */
  async apiKeyCreated(userId: number, accessKey: string): Promise<void> {
    const [recipient] = await this.mail.recipientsByIds([userId]);
    if (!recipient) return;

    await this.mail.sendTo(recipient, {
      kind: 'transactional',
      template: 'api-key.created',
      subject: 'A new API key was created',
      heading: 'A new API key was created',
      intro:
        'Someone created an API key on your WhatsApp Console account. The secret is only ever shown once, in the console — it is not in this email.',
      facts: [['Access key', accessKey]],
      paragraphs: [
        'If this was not you, revoke the key now and review who has access to your account.',
      ],
      action: { label: 'Review API keys', path: '/api-keys' },
    });
  }

  /** T3 — a key was revoked. */
  async apiKeyRevoked(userId: number, accessKey: string): Promise<void> {
    const [recipient] = await this.mail.recipientsByIds([userId]);
    if (!recipient) return;

    await this.mail.sendTo(recipient, {
      kind: 'transactional',
      template: 'api-key.revoked',
      subject: 'An API key was revoked',
      heading: 'An API key was revoked',
      intro:
        'This key stops working immediately. Anything using it will start failing authentication.',
      facts: [['Access key', accessKey]],
      action: { label: 'Review API keys', path: '/api-keys' },
    });
  }

  /** T4 + M1 — a WABA was connected; the first one gets the welcome. */
  async wabaConnected(
    userId: number,
    wabaId: string,
    wabaName: string | null,
  ): Promise<void> {
    const [recipient] = await this.mail.recipientsByIds([userId]);
    if (!recipient) return;

    const connections = await this.prisma.userWhatsapp.count({
      where: { userId },
    });
    const first = connections <= 1;

    await this.mail.sendTo(recipient, {
      kind: 'transactional',
      template: first ? 'waba.welcome' : 'waba.connected',
      subject: first
        ? 'Your WhatsApp Business Account is connected'
        : `${wabaName || wabaId} is now connected`,
      heading: first
        ? 'You are connected — here is what to do next'
        : 'A WhatsApp Business Account was connected',
      intro: first
        ? 'Your WhatsApp Business Account is linked to WhatsApp Console. You can send messages, manage templates and watch delivery from one place.'
        : 'A WhatsApp Business Account was linked to your WhatsApp Console account.',
      facts: [
        ['Account', wabaName || wabaId],
        ['WABA ID', wabaId],
      ],
      paragraphs: first
        ? [
            'Start by syncing your templates from Meta, then send a test message to your own number.',
            'If you did not expect this, disconnect the account in Settings and change your password.',
          ]
        : ['If this was not you, disconnect it and review who has access.'],
      action: {
        label: first ? 'Open the console' : 'Review accounts',
        path: '/wabas',
      },
    });
  }

  /** T5 — a WABA was disconnected; everyone who used it needs to know. */
  async wabaDisconnected(
    wabaId: string,
    wabaName: string | null,
  ): Promise<void> {
    const recipients = await this.mail.recipientsForWaba(wabaId);
    await this.mail.sendToAll(recipients, {
      kind: 'transactional',
      template: 'waba.disconnected',
      subject: `${wabaName || wabaId} was disconnected`,
      heading: 'A WhatsApp Business Account was disconnected',
      intro:
        'WhatsApp Console can no longer send or receive on this account. Messages sent through the API will start failing.',
      facts: [
        ['Account', wabaName || wabaId],
        ['WABA ID', wabaId],
      ],
      paragraphs: [
        'Reconnect it from the console if this was not intended. Your templates and phone numbers stay with Meta either way.',
      ],
      action: { label: 'Reconnect', path: '/connect' },
    });
  }

  /** T6 — Meta rejected our stored token. Sending is down until it is fixed. */
  async metaTokenRejected(wabaId: string, detail?: string): Promise<void> {
    const recipients = await this.mail.recipientsForWaba(wabaId);
    await this.mail.sendToAll(recipients, {
      kind: 'transactional',
      template: 'waba.token-rejected',
      subject: 'Action needed: WhatsApp access has stopped working',
      heading: 'Meta rejected our access to your account',
      intro:
        'The access token for your WhatsApp Business Account is no longer valid, so sending and receiving have stopped. This usually means the token was revoked in Meta Business Settings, or it expired.',
      facts: [
        ['WABA ID', wabaId],
        ...(detail ? ([['Meta says', detail]] as [string, string][]) : []),
      ],
      paragraphs: [
        'Reconnect the account in the console to issue a fresh token. Nothing is lost — your templates and history stay where they are.',
      ],
      action: { label: 'Reconnect the account', path: '/connect' },
    });
  }

  /** T7 — Meta banned or restricted the account. */
  async wabaBanned(wabaId: string, state: string | undefined): Promise<void> {
    const recipients = await this.mail.recipientsForWaba(wabaId);
    await this.mail.sendToAll(recipients, {
      kind: 'transactional',
      template: 'waba.banned',
      subject: 'Urgent: Meta has restricted your WhatsApp Business Account',
      heading: 'Meta has restricted your account',
      intro:
        'Meta has applied a restriction to your WhatsApp Business Account. Sending may be blocked entirely until it is resolved with Meta.',
      facts: [
        ['WABA ID', wabaId],
        ['State', state ?? 'Restricted'],
      ],
      paragraphs: [
        'This is Meta’s decision and we cannot overturn it. Open WhatsApp Manager to see the reason and to appeal.',
        'We have not changed anything on your account.',
      ],
      action: { label: 'Open your accounts', path: '/wabas' },
    });
  }

  /* ---------------- Notification: Meta events ---------------- */

  /** N1/N2 — a template decision. */
  async templateDecision(input: {
    wabaId: string;
    templateId: number;
    name: string;
    status: string;
    reason: string | null;
  }): Promise<void> {
    const headline = TEMPLATE_HEADLINE[input.status];
    if (!headline) return;

    const recipients = await this.mail.recipientsForWaba(input.wabaId);
    await this.mail.sendToAll(recipients, {
      kind: 'emailTemplateStatus',
      template: 'template.status',
      subject: `${headline}: ${input.name}`,
      heading: headline,
      intro:
        input.status === 'APPROVED'
          ? 'Meta approved your template. You can start sending with it now.'
          : 'Meta made a decision about one of your message templates.',
      facts: [
        ['Template', input.name],
        ['Status', this.humanise(input.status)],
        ...(input.reason
          ? ([['Reason', input.reason]] as [string, string][])
          : []),
      ],
      paragraphs:
        input.status === 'ARCHIVED'
          ? [
              'Meta archives a template after 12 months without activity and deletes it 28 days later. Unarchive it in WhatsApp Manager to keep it.',
            ]
          : input.status === 'REJECTED'
            ? ['Edit the template to address the reason above and resubmit it.']
            : undefined,
      action: {
        label: 'Open the template',
        path: `/templates/${input.templateId}`,
      },
      footnote:
        'You are receiving this because template emails are on in your notification settings.',
    });
  }

  /** N3 — quality rating or messaging limit changed. */
  async phoneQualityChanged(input: {
    wabaId: string;
    displayPhoneNumber: string;
    event: string;
    currentLimit?: string;
  }): Promise<void> {
    const recipients = await this.mail.recipientsForWaba(input.wabaId);
    await this.mail.sendToAll(recipients, {
      kind: 'emailTemplateStatus',
      template: 'phone.quality',
      subject: `Messaging quality changed for ${input.displayPhoneNumber}`,
      heading: 'Your number’s messaging quality changed',
      intro:
        'Meta updates this rating from how recipients react to your messages. A low rating reduces how many people you can message per day.',
      facts: [
        ['Number', input.displayPhoneNumber],
        ['Change', this.humanise(input.event)],
        ...(input.currentLimit
          ? ([['Messaging limit', this.humanise(input.currentLimit)]] as [
              string,
              string,
            ][])
          : []),
      ],
      paragraphs: [
        'If the rating dropped, review what you are sending and to whom: blocks and "not useful" reports are what move it.',
      ],
      action: { label: 'Open phone numbers', path: '/phone-numbers' },
      footnote:
        'You are receiving this because account emails are on in your notification settings.',
    });
  }

  /** N4 — Meta decided on a display-name review. */
  async displayNameDecision(input: {
    wabaId: string;
    displayPhoneNumber?: string;
    decision?: string;
    requestedName?: string;
  }): Promise<void> {
    const recipients = await this.mail.recipientsForWaba(input.wabaId);
    await this.mail.sendToAll(recipients, {
      kind: 'emailTemplateStatus',
      template: 'phone.display-name',
      subject: `Display name ${(input.decision ?? 'reviewed').toLowerCase()}`,
      heading: 'Meta reviewed your display name',
      intro:
        'The name customers see next to your messages has been reviewed by Meta.',
      facts: [
        ...(input.displayPhoneNumber
          ? ([['Number', input.displayPhoneNumber]] as [string, string][])
          : []),
        ...(input.requestedName
          ? ([['Requested name', input.requestedName]] as [string, string][])
          : []),
        ['Decision', this.humanise(input.decision ?? 'Reviewed')],
      ],
      action: { label: 'Open phone numbers', path: '/phone-numbers' },
      footnote:
        'You are receiving this because account emails are on in your notification settings.',
    });
  }

  /* ---------------- Support ---------------- */

  /** A4 — the acknowledgement promised on the support page. */
  async supportAcknowledgement(email: string, subject: string): Promise<void> {
    await this.mail.sendRaw(email, {
      template: 'support.ack',
      subject: `We received your message: ${subject}`,
      heading: 'Thanks — we have your message',
      intro:
        'A person will read this and reply. Our target for a first reply is one business day.',
      facts: [['Subject', subject]],
      paragraphs: [
        'Reply to this email if you have anything to add — it reaches the same place.',
      ],
    });
  }

  /** The copy that reaches our own support inbox. */
  async supportRequest(input: {
    to: string;
    fromEmail: string;
    fromName?: string;
    subject: string;
    message: string;
    userId?: number;
  }): Promise<void> {
    await this.mail.sendRaw(input.to, {
      template: 'support.request',
      subject: `[Support] ${input.subject}`,
      heading: input.subject,
      intro: input.message,
      facts: [
        [
          'From',
          input.fromName
            ? `${input.fromName} <${input.fromEmail}>`
            : input.fromEmail,
        ],
        ...(input.userId
          ? ([['User ID', String(input.userId)]] as [string, string][])
          : []),
      ],
    });
  }

  /** "Human-readable" wording for a SCREAMING_SNAKE constant. */
  private humanise(value: string): string {
    const words = value
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
}
