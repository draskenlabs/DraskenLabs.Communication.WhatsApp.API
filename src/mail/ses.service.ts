import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { randomUUID } from 'crypto';

/** A file travelling with a message — an invoice, and so far nothing else. */
export interface SesAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface SesMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Sets List-Unsubscribe, so mail clients can offer a one-click opt-out. */
  unsubscribeUrl?: string;
  /**
   * Files to attach. Present, the message is sent as raw MIME instead of SES's
   * simple content — attachments are the one thing the simple form cannot
   * carry, and an invoice has to arrive as a file.
   */
  attachments?: SesAttachment[];
}

export interface SesResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Amazon SES transport.
 *
 * Credentials come from the environment — an access key pair, or nothing at
 * all when the pod carries an IAM role (IRSA), in which case the AWS SDK finds
 * them itself. Without a region and a From address the service stays disabled
 * and every send is a logged no-op: email is a courtesy, and a missing mail
 * config must never fail a webhook or a request.
 */
@Injectable()
export class SesService implements OnModuleInit {
  private readonly logger = new Logger(SesService.name);
  private client: SESv2Client | null = null;
  private fromAddress = '';
  private fromName = '';
  private replyTo = '';
  private configurationSet = '';

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const region = this.config.get<string>('AWS_REGION');
    this.fromAddress = this.config.get<string>('SES_FROM_ADDRESS') ?? '';
    this.fromName =
      this.config.get<string>('SES_FROM_NAME') ?? 'WhatsApp Console';
    this.replyTo = this.config.get<string>('SES_REPLY_TO') ?? '';
    this.configurationSet =
      this.config.get<string>('SES_CONFIGURATION_SET') ?? '';

    if (!region || !this.fromAddress) {
      this.logger.warn(
        'AWS_REGION or SES_FROM_ADDRESS is not set — outgoing email is disabled.',
      );
      return;
    }

    const accessKeyId = this.config.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('AWS_SECRET_ACCESS_KEY');

    this.client = new SESv2Client({
      region,
      // Omitted entirely when the pod has an IAM role: the SDK then resolves
      // credentials from the environment, which is the safer deployment.
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
    this.logger.log(
      `Email enabled — sending from ${this.fromAddress} in ${region}`,
    );
  }

  /** True when a region and a verified From address were supplied. */
  get enabled(): boolean {
    return this.client !== null;
  }

  /** Send one message. Never throws; the outcome is in the result. */
  async send(message: SesMessage): Promise<SesResult> {
    if (!this.client) return { ok: false, error: 'mail disabled' };

    try {
      const response = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [message.to] },
          ...(this.replyTo ? { ReplyToAddresses: [this.replyTo] } : {}),
          ...(this.configurationSet
            ? { ConfigurationSetName: this.configurationSet }
            : {}),
          // Attachments are the one thing SES's simple content cannot carry, so
          // a message with a file on it is assembled as MIME and handed over
          // raw. Everything else stays on the simple form, where SES does the
          // encoding and there is less of ours to get wrong.
          Content: message.attachments?.length
            ? { Raw: { Data: this.raw(message) } }
            : {
                Simple: {
                  Subject: { Data: message.subject, Charset: 'UTF-8' },
                  Body: {
                    Html: { Data: message.html, Charset: 'UTF-8' },
                    Text: { Data: message.text, Charset: 'UTF-8' },
                  },
                  ...(message.unsubscribeUrl
                    ? {
                        Headers: [
                          {
                            Name: 'List-Unsubscribe',
                            Value: `<${message.unsubscribeUrl}>`,
                          },
                          {
                            Name: 'List-Unsubscribe-Post',
                            Value: 'List-Unsubscribe=One-Click',
                          },
                        ],
                      }
                    : {}),
                },
              },
        }),
      );
      return { ok: true, messageId: response.MessageId };
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`SES send to ${message.to} failed: ${detail}`);
      return { ok: false, error: detail };
    }
  }

  /** The From header, name included where one is configured. */
  private get from(): string {
    return this.fromName
      ? `${encodeHeader(this.fromName)} <${this.fromAddress}>`
      : this.fromAddress;
  }

  /**
   * The message as MIME, for the sends that carry a file.
   *
   * multipart/mixed holding a multipart/alternative — the shape every mail
   * client expects: it picks HTML or plain text from the inner part and shows
   * the attachment beside whichever it chose. Both bodies are base64 so a long
   * line, an accent or a leading "From " cannot be mangled in transit.
   */
  raw(message: SesMessage): Buffer {
    const mixed = `mixed_${randomUUID()}`;
    const alternative = `alt_${randomUUID()}`;

    const headers = [
      `From: ${this.from}`,
      `To: ${message.to}`,
      ...(this.replyTo ? [`Reply-To: ${this.replyTo}`] : []),
      `Subject: ${encodeHeader(message.subject)}`,
      ...(message.unsubscribeUrl
        ? [
            `List-Unsubscribe: <${message.unsubscribeUrl}>`,
            'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
          ]
        : []),
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${mixed}"`,
    ];

    const parts = [
      headers.join('\r\n'),
      '',
      `--${mixed}`,
      `Content-Type: multipart/alternative; boundary="${alternative}"`,
      '',
      `--${alternative}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(Buffer.from(message.text, 'utf8')),
      `--${alternative}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(Buffer.from(message.html, 'utf8')),
      `--${alternative}--`,
      '',
    ];

    for (const attachment of message.attachments ?? []) {
      const filename = attachment.filename.replace(/["\r\n]/g, '');
      parts.push(
        `--${mixed}`,
        `Content-Type: ${attachment.contentType}; name="${filename}"`,
        `Content-Disposition: attachment; filename="${filename}"`,
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(attachment.content),
      );
    }

    parts.push(`--${mixed}--`, '');
    return Buffer.from(parts.join('\r\n'), 'utf8');
  }
}

/**
 * A header value that may not be plain ASCII, encoded per RFC 2047.
 *
 * A subject carrying an account name with an accent in it is not hypothetical,
 * and a raw UTF-8 byte in a header is what makes a message arrive as mojibake
 * — or not arrive at all.
 */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Base64, wrapped at 76 characters as MIME requires. */
function base64Lines(content: Buffer): string {
  const encoded = content.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) {
    lines.push(encoded.slice(i, i + 76));
  }
  // The CRLF before the next boundary comes from the join in `raw`, so the
  // block itself must not end in one — a MIME body and its delimiter are
  // separated by exactly one.
  return lines.join('\r\n');
}
