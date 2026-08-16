import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookEndpointsService } from './webhook-endpoints.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhooksScheduler } from './webhooks.scheduler';
import { RetentionService } from './retention.service';
import { WebhookSignatureMiddleware } from './middleware/webhook-signature.middleware';
import { InboundMessageHandler } from './handlers/inbound-message.handler';
import { StatusUpdateHandler } from './handlers/status-update.handler';
import { AccountHandler } from './handlers/account.handler';
import { TemplateStatusHandler } from './handlers/template-status.handler';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';
import { UserModule } from 'src/user/user.module';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { PlansModule } from 'src/plans/plans.module';

@Module({
  imports: [UserModule, NotificationsModule, PlansModule],
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    WebhookEndpointsService,
    WebhookDispatcherService,
    WebhooksScheduler,
    RetentionService,
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
    consumer.apply(AuthMiddleware).forRoutes(
      { path: 'webhooks/config', method: RequestMethod.GET },
      { path: 'webhooks/events', method: RequestMethod.GET },
      // The customer's own endpoints. Listed one by one rather than as a
      // wildcard: `webhooks/*` would swallow Meta's POST /webhooks, which
      // authenticates with an HMAC and carries no JWT at all.
      { path: 'webhooks/endpoints', method: RequestMethod.GET },
      { path: 'webhooks/endpoints', method: RequestMethod.POST },
      { path: 'webhooks/endpoints/:id', method: RequestMethod.PATCH },
      { path: 'webhooks/endpoints/:id', method: RequestMethod.DELETE },
      { path: 'webhooks/endpoints/:id/test', method: RequestMethod.POST },
      { path: 'webhooks/endpoints/:id/deliveries', method: RequestMethod.GET },
      { path: 'webhooks/deliveries/:id/redeliver', method: RequestMethod.POST },
    );
  }
}
