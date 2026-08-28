import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { OrganisationSettingsModule } from './organisation-settings/organisation-settings.module';
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
import { InboxModule } from './inbox/inbox.module';
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
import { AgencyModule } from './agency/agency.module';
import { AdminModule } from './admin/admin.module';
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
        // Enables the operator endpoints under /agency/internal, which convert
        // an organisation to an agency and move who pays for a client. Unset
        // means disabled, which is what a self-hosted deployment wants.
        AGENCY_ADMIN_TOKEN: Joi.string().optional(),
        // Razorpay — optional, like push and email. Without a key pair the API
        // runs normally, sells nothing and charges no one for the Messaging
        // API, which is what development and self-hosting need.
        RAZORPAY_KEY_ID: Joi.string().optional(),
        RAZORPAY_KEY_SECRET: Joi.string().optional(),
        // Which Razorpay plan charges for each published tier, as
        // `code:plan_id` pairs — written onto the tiers at boot, since the id
        // belongs to the plan row and not to the deployment. Without it no
        // tier can be bought, and the console offers to talk rather than
        // opening a checkout that would be refused.
        RAZORPAY_PLAN_IDS: Joi.string().optional(),
        RAZORPAY_WEBHOOK_SECRET: Joi.string().optional(),
        // Only ever set by the integration suite, which points the client at a
        // local stand-in for Razorpay.
        RAZORPAY_API_BASE: Joi.string().uri().optional(),
      }),
    }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 5 }]),
    ScheduleModule.forRoot(),
    OrganisationSettingsModule,
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
    InboxModule,
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
    AgencyModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
