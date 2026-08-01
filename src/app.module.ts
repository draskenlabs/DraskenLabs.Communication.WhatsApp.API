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
        ALLOW_MANUAL_CONNECT: Joi.boolean().truthy('true').falsy('false').default(false),
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
