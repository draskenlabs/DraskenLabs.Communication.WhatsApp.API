import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { JwtService } from '@nestjs/jwt';
import { json } from 'express';
import { createHmac } from 'crypto';
import { IncomingMessage } from 'http';
import { PrismaService } from 'src/prisma/prisma.service';
import { BaseResponseInterceptor } from 'src/common/interceptors/base-response.interceptor';
import { GlobalExceptionFilter } from 'src/common/filters/global-exception.filter';
import { MailService } from 'src/mail/mail.service';
import { FakeRazorpay } from './fake-razorpay';
import Redis from 'ioredis';

/**
 * The whole API, against a real Postgres and a stand-in for Razorpay.
 *
 * Deliberately not a unit test's testing module: this compiles `AppModule`, so
 * the wiring under test is the wiring that ships — middleware, validation
 * pipes, the response interceptor, Prisma against a database that has had the
 * real migrations applied, and `PlanSyncService` running at boot exactly as it
 * would in a deployment.
 *
 * Requires:
 *   DATABASE_URL_TEST  a Postgres this suite may truncate at will
 *   REDIS_URL_TEST     optional, defaults to a local Redis
 */

export const KEY_ID = 'rzp_test_integration';
export const KEY_SECRET = 'rzp_test_secret';
export const WEBHOOK_SECRET = 'whsec_integration';
export const JWT_SECRET = 'x'.repeat(32);

/** The tiers, wired to the stand-in's plan ids. */
export const PLAN_IDS = {
  starter: 'plan_starter',
  growth: 'plan_growth',
  business: 'plan_business',
} as const;

export interface Harness {
  app: INestApplication;
  prisma: PrismaService;
  razorpay: FakeRazorpay;
  /** Truncate everything a test writes, leaving the seeded price list. */
  reset(): Promise<void>;
  /** A console JWT for a user that exists in the database. */
  signIn(userId: number, ssoOrgId: string): Promise<string>;
  /** Razorpay's own signature over a webhook body. */
  webhookSignature(body: unknown): string;
  /** What Checkout hands back, signed as Razorpay signs it. */
  checkoutSignature(paymentId: string, subscriptionId: string): string;
  close(): Promise<void>;
}

/** Tables the suite writes to. `Plan`/`PlanFeature` are seeded by a migration. */
const MUTABLE_TABLES = [
  'WebhookDelivery',
  'WebhookEndpoint',
  'WebhookEvent',
  'SubscriptionPayment',
  'SubscriptionEvent',
  'Subscription',
  'Conversation',
  'InboundMessage',
  'Message',
  'MessageTemplate',
  'Contact',
  'PhoneQualityEvent',
  'WabaPhoneNumber',
  'WabaOrganisation',
  // Agency and client relationships. Missing until an agency test finally
  // counted rows and found somebody else's clients on its roster — every
  // suite before that wrote these and none of them cleared them.
  'OrganisationSettings',
  'UserApiKey',
  'UserWhatsapp',
  'Waba',
  'MailLog',
  'MailSuppression',
  'Notification',
  'NotificationPreference',
  'DeviceToken',
  'User',
];

export async function startHarness(): Promise<Harness> {
  const databaseUrl = process.env.DATABASE_URL_TEST;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL_TEST is required — the integration suite truncates the ' +
        'database it points at, so it will never fall back to DATABASE_URL.',
    );
  }

  const razorpay = new FakeRazorpay();
  const apiBase = await razorpay.start();

  // The suite's own connection, so `reset()` can clear the cache without
  // widening RedisService's public surface for a test.
  const cache = new Redis(
    process.env.REDIS_URL_TEST ?? 'redis://127.0.0.1:6379',
  );

  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    REDIS_URL: process.env.REDIS_URL_TEST ?? 'redis://127.0.0.1:6379',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    JWT_SECRET,
    META_APP_ID: 'app',
    META_APP_SECRET: 'meta-secret',
    META_REDIRECT_URI: 'https://example.test/cb',
    WEBHOOK_VERIFY_TOKEN: 'verify',
    SSO_CLIENT_ID: 'sso',
    SSO_CLIENT_SECRET: 'sso-secret',
    SSO_API_URL: 'https://sso.test',
    SSO_REDIRECT_URI: 'https://example.test/sso',
    RAZORPAY_KEY_ID: KEY_ID,
    RAZORPAY_KEY_SECRET: KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RAZORPAY_PLAN_IDS: `starter:${PLAN_IDS.starter},growth:${PLAN_IDS.growth},business:${PLAN_IDS.business}`,
    RAZORPAY_API_BASE: apiBase,
  });

  const { AppModule } = await import('src/app.module');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // SES is not configured here, so mail is a no-op already; overriding it
    // keeps a failed lookup from logging over the test output.
    .overrideProvider(MailService)
    .useValue({
      enabled: false,
      sendTo: () => Promise.resolve(false),
      sendToAll: () => Promise.resolve(0),
      sendRaw: () => Promise.resolve(false),
      recipientsByIds: () => Promise.resolve([]),
      retryFailed: () => Promise.resolve({ retried: 0, sent: 0, abandoned: 0 }),
    })
    .compile();

  const app = moduleRef.createNestApplication({ bodyParser: false });

  // The same bootstrap as `main.ts`: the raw body is what the webhook
  // signature is computed over, so a test that skipped this would be checking
  // a different request from the one production handles.
  app.use(
    json({
      verify: (req, _res, buf) => {
        (req as IncomingMessage & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new BaseResponseInterceptor());
  app.useGlobalFilters(new GlobalExceptionFilter());

  await app.init();

  // Nothing scheduled runs on its own: a delivery sweep firing mid-test would
  // change rows a test is asserting on. Each job is invoked directly instead.
  const scheduler = app.get(SchedulerRegistry);
  for (const [name] of scheduler.getCronJobs()) scheduler.deleteCronJob(name);

  const prisma = app.get(PrismaService);
  const jwt = app.get(JwtService);

  return {
    app,
    prisma,
    razorpay,

    async reset() {
      razorpay.reset();
      // Access answers are cached under a key carrying the payer's version, so
      // a database truncated back to version 0 starts matching entries written
      // before it. The version was never a cache-buster; it only looked like
      // one while the rows survived the reset.
      await cache.flushdb();
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE ${MUTABLE_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
      );
      // The price list survives; only what a deployment configures is reset.
      await prisma.plan.updateMany({
        where: { code: 'starter' },
        data: { razorpayPlanId: PLAN_IDS.starter },
      });
      await prisma.plan.updateMany({
        where: { code: 'growth' },
        data: { razorpayPlanId: PLAN_IDS.growth },
      });
      await prisma.plan.updateMany({
        where: { code: 'business' },
        data: { razorpayPlanId: PLAN_IDS.business },
      });
    },

    async signIn(userId: number, ssoOrgId: string) {
      return jwt.signAsync({
        sub: userId,
        orgId: ssoOrgId,
        role: 'org:admin',
        sessionId: `sess_${userId}`,
      });
    },

    webhookSignature(body: unknown) {
      return createHmac('sha256', WEBHOOK_SECRET)
        .update(JSON.stringify(body))
        .digest('hex');
    },

    checkoutSignature(paymentId: string, subscriptionId: string) {
      return createHmac('sha256', KEY_SECRET)
        .update(`${paymentId}|${subscriptionId}`)
        .digest('hex');
    },

    async close() {
      await app.close();
      await cache.quit();
      await razorpay.stop();
    },
  };
}

/* -------------------------------------------------------------------------- *
 * Fixtures                                                                    *
 * -------------------------------------------------------------------------- */

export const ORG = 'org_integration';

/** A user, an account and the membership that ties them to an organisation. */
export async function seedAccount(
  prisma: PrismaService,
  options: { wabaId?: string; ssoOrgId?: string; numbers?: number } = {},
): Promise<{ userId: number; wabaId: string; ssoOrgId: string }> {
  const ssoOrgId = options.ssoOrgId ?? ORG;
  const wabaId = options.wabaId ?? 'waba_integration';

  const user = await prisma.user.create({
    data: {
      ssoId: `sso_${wabaId}_${ssoOrgId}`,
      email: 'integration@example.test',
      firstName: 'Inte',
      lastName: 'Gration',
    },
  });

  await prisma.waba.create({
    data: { wabaId, userId: user.id, ssoOrgId, name: 'Integration Account' },
  });
  await prisma.wabaOrganisation.create({
    data: { wabaId, ssoOrgId, userId: user.id },
  });

  for (let i = 0; i < (options.numbers ?? 0); i++) {
    await prisma.wabaPhoneNumber.create({
      data: {
        phoneNumberId: `phone_${wabaId}_${i}`,
        wabaId,
        verifiedName: 'Integration',
        codeVerificationStatus: 'VERIFIED',
        displayPhoneNumber: `+9198220102${i}0`,
        qualityRating: 'GREEN',
        // Registered on the Cloud API: the only ones that count against a plan
        // and the only ones charged for.
        platformType: 'CLOUD_API',
        throughputLevel: 'STANDARD',
      },
    });
  }

  return { userId: user.id, wabaId, ssoOrgId };
}

/** A `subscription.charged` webhook, as Razorpay sends one. */
export function chargedEvent(input: {
  subscriptionId: string;
  planId: string;
  paymentId?: string;
  amount?: number;
  currentStart?: number;
  currentEnd?: number;
  notes?: Record<string, string>;
}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    event: 'subscription.charged',
    payload: {
      subscription: {
        entity: {
          id: input.subscriptionId,
          plan_id: input.planId,
          status: 'active',
          current_start: input.currentStart ?? now,
          current_end: input.currentEnd ?? now + 30 * 24 * 3600,
          notes: input.notes,
        },
      },
      payment: {
        entity: {
          id: input.paymentId ?? 'pay_integration_1',
          invoice_id: 'inv_integration_1',
          amount: input.amount ?? 49900,
          currency: 'INR',
          status: 'captured',
          method: 'upi',
          vpa: 'integration@upi',
          created_at: now,
        },
      },
    },
  };
}
