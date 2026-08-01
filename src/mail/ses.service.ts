import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

export interface SesMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Sets List-Unsubscribe, so mail clients can offer a one-click opt-out. */
  unsubscribeUrl?: string;
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
          FromEmailAddress: this.fromName
            ? `${this.fromName} <${this.fromAddress}>`
            : this.fromAddress,
          Destination: { ToAddresses: [message.to] },
          ...(this.replyTo ? { ReplyToAddresses: [this.replyTo] } : {}),
          ...(this.configurationSet
            ? { ConfigurationSetName: this.configurationSet }
            : {}),
          Content: {
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
}
