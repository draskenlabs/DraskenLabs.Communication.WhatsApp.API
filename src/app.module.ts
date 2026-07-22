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
        SSO_CLIENT_ID: Joi.string().required(),
        SSO_CLIENT_SECRET: Joi.string().required(),
        SSO_API_URL: Joi.string().required(),
      }),
    }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 5 }]),
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
