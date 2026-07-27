import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookSignatureMiddleware } from './middleware/webhook-signature.middleware';
import { InboundMessageHandler } from './handlers/inbound-message.handler';
import { StatusUpdateHandler } from './handlers/status-update.handler';
import { AccountHandler } from './handlers/account.handler';
import { TemplateStatusHandler } from './handlers/template-status.handler';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';
import { UserModule } from 'src/user/user.module';

@Module({
  imports: [UserModule],
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    WebhookSignatureMiddleware,
    AuthMiddleware,
    InboundMessageHandler,
    StatusUpdateHandler,
    AccountHandler,
    TemplateStatusHandler,
  ],
})
export class WebhooksModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Meta-facing verify (GET /webhooks) stays open; the receive route keeps
    // its HMAC signature check. The console read endpoints require a JWT.
    consumer
      .apply(WebhookSignatureMiddleware)
      .forRoutes({ path: 'webhooks', method: RequestMethod.POST });
    consumer
      .apply(AuthMiddleware)
      .forRoutes(
        { path: 'webhooks/config', method: RequestMethod.GET },
        { path: 'webhooks/events', method: RequestMethod.GET },
      );
  }
}
