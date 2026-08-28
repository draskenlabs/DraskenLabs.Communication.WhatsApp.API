import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { BaseResponseInterceptor } from './common/interceptors/base-response.interceptor';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { BaseResponse } from './common/responses/base-response';
import { FieldErrorResponse } from './common/responses/field-error.util';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as cookieParser from 'cookie-parser';
import { json } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Preserve raw body bytes for webhook HMAC signature validation.
  //
  // The size limit is express's own default (100kb) raised to 1mb and made
  // explicit. A bulk contact import is the largest legitimate body here and
  // needs the headroom; nothing on this API needs more than that, and leaving
  // it unbounded lets one request hold megabytes of parsed JSON per worker.
  app.use(
    json({
      limit: '1mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.use(cookieParser());
  app.enableCors();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      forbidUnknownValues: true,
      exceptionFactory: (validationErrors: any[]) => {
        const errors: FieldErrorResponse[] = [];

        const collect = (errs: any[], parent?: string) => {
          for (const err of errs) {
            const field = parent ? `${parent}.${err.property}` : err.property;
            if (err.constraints && Object.values(err.constraints).length > 0) {
              const firstMsg = Object.values(err.constraints)[0] as string;
              errors.push({ field, message: firstMsg });
            } else if (err.children && err.children.length > 0) {
              collect(err.children, field);
            }
          }
        };
        collect(validationErrors);

        return BaseResponse.fieldError(422, errors);
      },
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new BaseResponseInterceptor());

  // Swagger describes every endpoint, its payloads and its auth scheme — a map
  // of the API for anyone who finds the URL. It is off unless a deployment asks
  // for it, so the public one publishes nothing it did not mean to.
  if (isSwaggerEnabled(app.get(ConfigService))) {
    mountSwagger(app);
  }

  const shutdown = async (signal: NodeJS.Signals) => {
    await app.close();
    process.exit(signal === 'SIGINT' ? 130 : 0);
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  await app.listen(process.env.PORT ?? 3000);
}

/**
 * Whether this deployment serves the API docs.
 *
 * Read as a string rather than a boolean: the same value arrives as `'true'`
 * from the environment and as `true` once Joi has coerced it, and only one of
 * those is a boolean.
 */
function isSwaggerEnabled(config: ConfigService): boolean {
  return String(config.get('SWAGGER_ENABLED')).toLowerCase() === 'true';
}

function mountSwagger(app: INestApplication): void {
  const swaggerConfig = new DocumentBuilder()
    .setTitle('DraskenLabs WhatsApp Communication API')
    .setDescription(
      'NestJS backend for DraskenLabs WhatsApp Communication API using PostgreSQL, Prisma, and Redis.\n\n' +
      '**Authentication**\n\n' +
      'Most endpoints use the internal JWT issued by `POST /auth/callback` in the `Authorization: Bearer <token>` header.\n\n' +
      '**Organisation endpoints** (`/organisation/*`) are a thin proxy to the Drasken SSO API. ' +
      'Pass the **SSO access token** (received from the SSO during login) in the `Authorization: Bearer <sso_token>` header — not the internal JWT.',
    )
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Internal JWT issued by POST /auth/callback' }, 'jwt')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'SSO access token from Drasken SSO (used for /organisation endpoints)' }, 'sso-token')
    .addTag('Auth', 'PKCE login flow and JWT issuance')
    .addTag('WABAs', 'WhatsApp Business Account management')
    .addTag('WABA Phone Numbers', 'Phone number management within a WABA')
    .addTag('Messaging', 'Send and retrieve WhatsApp messages')
    .addTag('Templates', 'Message template management via Meta Graph API')
    .addTag('Contacts', 'Contact and opt-out management')
    .addTag('API Keys', 'Programmatic access key management')
    .addTag('Organisations', 'SSO organisation and member management — pass the SSO access token, not the internal JWT')
    .addTag('Webhooks', 'Meta webhook verification and event ingestion')
    .setVersion('1.0.0')
    .build();

  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('swagger/docs', app, swaggerDocument);
  app
    .getHttpAdapter()
    .getInstance()
    .get('/swagger/json', (_req, res) => res.json(swaggerDocument));
}
bootstrap();
