import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConnectModule } from './connect/connect.module';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { RedisModule } from './redis/redis.module';
import { CommonModule } from './common/common.module';
import { PrismaModule } from './prisma/prisma.module';
import { UserModule } from './user/user.module';
import { ApiKeyModule } from './api-key/api-key.module';
import { WabaModule } from './waba/waba.module';
import { WabaPhoneNumberModule } from './waba-phone-number/waba-phone-number.module';
import { AuthModule } from './auth/auth.module';
import { MessagingModule } from './messaging/messaging.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { TemplatesModule } from './templates/templates.module';
import { ContactsModule } from './contacts/contacts.module';
import { OrgModule } from './org/org.module';
import { NotificationsModule } from './notifications/notifications.module';
import { MailModule } from './mail/mail.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { SearchModule } from './search/search.module';
import { BillingModule } from './billing/billing.module';
import { PlansModule } from './plans/plans.module';
import { ScheduleModule } from '@nestjs/schedule';
import * as Joi from 'joi';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        PORT: Joi.number().default(3000),
        DATABASE_URL: Joi.string().required(),
        REDIS_URL: Joi.string().required(),
        ENCRYPTION_KEY: Joi.string().required(),
        JWT_SECRET: Joi.string().required(),
        META_APP_ID: Joi.string().required(),
        META_APP_SECRET: Joi.string().required(),
        META_REDIRECT_URI: Joi.string().required(),
        WEBHOOK_VERIFY_TOKEN: Joi.string().required(),
        // Outbound webhooks — how long we wait on a customer's endpoint before
        // calling the attempt failed, and whether a plain-http or private
        // address may be registered at all. The second is for local
        // development: in production it is what stops an endpoint from being
        // pointed at our own network.
        WEBHOOK_DELIVERY_TIMEOUT_MS: Joi.number().min(1000).max(60000).default(10000),
        WEBHOOK_ALLOW_INSECURE_URLS: Joi.boolean()
          .truthy('true')
          .falsy('false')
          .default(false),
        // Retention. The webhook window is what the Privacy Policy promises for
        // raw Meta envelopes and the delivery log that carries them. Message
        // history is held to the window each plan publishes — destructive, so
        // it only counts and logs until a deployment turns it on.
        WEBHOOK_EVENT_RETENTION_DAYS: Joi.number().min(1).max(3650).default(30),
        PLAN_RETENTION_ENFORCED: Joi.boolean()
          .truthy('true')
          .falsy('false')
          .default(false),
        ALLOW_MANUAL_CONNECT: Joi.boolean().truthy('true').falsy('false').default(false),
        // Off by default, so a deployment publishes the API docs only when it
        // says to rather than because nobody remembered to turn them off.
        SWAGGER_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
        SSO_CLIENT_ID: Joi.string().required(),
        SSO_CLIENT_SECRET: Joi.string().required(),
        SSO_API_URL: Joi.string().required(),
        SSO_REDIRECT_URI: Joi.string().required(),
        // Firebase Cloud Messaging — optional. Without it the API runs
        // normally and push is simply disabled, so a deployment that does not
        // want notifications needs no extra configuration.
        FIREBASE_SERVICE_ACCOUNT_BASE64: Joi.string().base64().optional(),
        // Amazon SES — optional, like push. Without a region and a verified
        // From address the API runs normally and sends no email.
        AWS_REGION: Joi.string().optional(),
        AWS_ACCESS_KEY_ID: Joi.string().optional(),
        AWS_SECRET_ACCESS_KEY: Joi.string().optional(),
        SES_FROM_ADDRESS: Joi.string().email().optional(),
        SES_FROM_NAME: Joi.string().optional(),
        SES_REPLY_TO: Joi.string().email().optional(),
        SES_CONFIGURATION_SET: Joi.string().optional(),
        // Absolute base URL of the console, for links inside emails.
        APP_BASE_URL: Joi.string().uri().optional(),
        // Mailboxes the support form delivers to.
        SUPPORT_EMAIL: Joi.string().email().optional(),
        PRIVACY_EMAIL: Joi.string().email().optional(),
        SECURITY_EMAIL: Joi.string().email().optional(),
        ABUSE_EMAIL: Joi.string().email().optional(),
        LEGAL_EMAIL: Joi.string().email().optional(),
        // Enables POST /mail/broadcast when set. Unset means disabled.
        MAIL_ADMIN_TOKEN: Joi.string().optional(),
        // Razorpay — optional, like push and email. Without a key pair and a
        // plan the API runs normally, sells nothing and charges no one for the
        // Messaging API, which is what development and self-hosting need.
        RAZORPAY_KEY_ID: Joi.string().optional(),
        RAZORPAY_KEY_SECRET: Joi.string().optional(),
        RAZORPAY_PLAN_ID: Joi.string().optional(),
        // Which Razorpay plan charges for each published tier, as
        // `code:plan_id` pairs. Without it only RAZORPAY_PLAN_ID above can be
        // sold, and the console offers to talk about the rest rather than
        // opening a checkout that would be refused.
        RAZORPAY_PLAN_IDS: Joi.string().optional(),
        RAZORPAY_WEBHOOK_SECRET: Joi.string().optional(),
        // Only ever set by the integration suite, which points the client at a
        // local stand-in for Razorpay.
        RAZORPAY_API_BASE: Joi.string().uri().optional(),
        // Invoicing. Every value is optional and every default is safe: a
        // deployment that configures none of this still raises numbered
        // invoices and still emails them — it simply prints no seller address
        // and shows no tax line.
        //
        // The series is the `WAC` in `INV-WAC-2627-0001`, and it must not be
        // changed once a deployment has issued invoices: the number is what a
        // customer's accounts refer to, and two books under one name is the
        // one thing a statutory series may not be.
        INVOICE_SERIES: Joi.string()
          .pattern(/^[A-Za-z0-9]{2,8}$/)
          .optional(),
        // Which local midnight the financial year turns at. India's runs
        // 1 April to 31 March, and a payment captured at 03:00 IST on 1 April
        // belongs to the new year even though it is still 31 March in UTC.
        INVOICE_TIMEZONE: Joi.string().optional(),
        // Tax rate in basis points — 1800 is 18% GST. Zero, or unset, prints
        // no tax line at all, which is what a deployment not registered for
        // GST needs. The published price is treated as inclusive either way.
        INVOICE_TAX_RATE_BPS: Joi.number().min(0).max(10000).optional(),
        INVOICE_TAX_LABEL: Joi.string().optional(),
        INVOICE_PLACE_OF_SUPPLY: Joi.string().optional(),
        // Who the invoice is from. The address is pipe-separated, because an
        // environment variable has no newlines.
        INVOICE_SELLER_NAME: Joi.string().optional(),
        INVOICE_SELLER_ADDRESS: Joi.string().optional(),
        INVOICE_SELLER_EMAIL: Joi.string().email().optional(),
        INVOICE_SELLER_WEBSITE: Joi.string().optional(),
        INVOICE_SELLER_GSTIN: Joi.string().optional(),
        INVOICE_SELLER_PAN: Joi.string().optional(),
        INVOICE_SELLER_CIN: Joi.string().optional(),
      }),
    }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 5 }]),
    ScheduleModule.forRoot(),
    ConnectModule,
    RedisModule,
    CommonModule,
    PrismaModule,
    UserModule,
    ApiKeyModule,
    WabaModule,
    WabaPhoneNumberModule,
    AuthModule,
    MessagingModule,
    WebhooksModule,
    TemplatesModule,
    ContactsModule,
    OrgModule,
    NotificationsModule,
    MailModule,
    AnalyticsModule,
    SearchModule,
    BillingModule,
    PlansModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
