import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { App, cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';

/** What a caller wants delivered; the transport shape is built here. */
export interface PushMessage {
  title: string;
  body: string;
  /** Where clicking the notification should land, e.g. "/messages". */
  link?: string;
  /** Extra key/values delivered to the service worker. Values must be strings. */
  data?: Record<string, string>;
}

export interface PushResult {
  sent: number;
  failed: number;
  /** Tokens Firebase says are dead — the caller should delete them. */
  staleTokens: string[];
}

/**
 * Firebase Cloud Messaging transport.
 *
 * Credentials arrive as a base64-encoded service-account JSON in
 * `FIREBASE_SERVICE_ACCOUNT_BASE64` rather than a file on disk, so the
 * deployment needs nothing but a Secret. Without it the service stays disabled
 * and every send is a no-op: push is an enhancement, and a missing key must
 * never take the API down or break a webhook.
 */
@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private app: App | null = null;
  private messaging: Messaging | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const encoded = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT_BASE64');
    if (!encoded) {
      this.logger.warn(
        'FIREBASE_SERVICE_ACCOUNT_BASE64 is not set — push notifications are disabled.',
      );
      return;
    }

    try {
      const json = Buffer.from(encoded, 'base64').toString('utf8');
      const parsed = JSON.parse(json) as {
        project_id?: string;
        client_email?: string;
        private_key?: string;
      };

      if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
        throw new Error(
          'service account JSON is missing project_id, client_email or private_key',
        );
      }

      this.app = initializeApp(
        {
          credential: cert({
            projectId: parsed.project_id,
            clientEmail: parsed.client_email,
            // Secret managers routinely turn the newlines in a PEM into the
            // two characters \ and n; Firebase rejects the key if they stay.
            privateKey: parsed.private_key.replace(/\\n/g, '\n'),
          }),
        },
        // Named so a second initialisation (tests, hot reload) cannot collide
        // with the default app.
        'whatsapp-push',
      );
      this.messaging = getMessaging(this.app);
      this.logger.log(
        `Push notifications enabled for Firebase project ${parsed.project_id}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Could not initialise Firebase — push notifications are disabled: ${message}`,
      );
      this.app = null;
      this.messaging = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.app) await deleteApp(this.app);
  }

  /** True when credentials were supplied and accepted. */
  get enabled(): boolean {
    return this.messaging !== null;
  }

  /**
   * Deliver one message to many devices. Never throws: a push failure must not
   * fail the webhook or request that triggered it.
   */
  async sendToTokens(
    tokens: string[],
    message: PushMessage,
  ): Promise<PushResult> {
    const empty: PushResult = { sent: 0, failed: 0, staleTokens: [] };
    if (!this.messaging || tokens.length === 0) return empty;

    try {
      const response = await this.messaging.sendEachForMulticast({
        tokens,
        // Sent as data rather than as a `notification` block so the service
        // worker renders every message itself — otherwise Chrome shows its own
        // notification in the background and ours in the foreground, and the
        // click target is lost.
        data: {
          title: message.title,
          body: message.body,
          ...(message.link ? { link: message.link } : {}),
          ...(message.data ?? {}),
        },
        webpush: {
          fcmOptions: message.link ? { link: message.link } : undefined,
          headers: { Urgency: 'high' },
        },
      });

      const staleTokens: string[] = [];
      response.responses.forEach((result, i) => {
        if (result.success) return;
        const code = result.error?.code ?? '';
        // The device uninstalled, cleared site data or the token expired —
        // it will never work again, so the caller should forget it.
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument'
        ) {
          staleTokens.push(tokens[i]);
        } else {
          this.logger.warn(`Push to a device failed: ${code}`);
        }
      });

      return {
        sent: response.successCount,
        failed: response.failureCount,
        staleTokens,
      };
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Push send failed: ${detail}`);
      return { ...empty, failed: tokens.length };
    }
  }
}
