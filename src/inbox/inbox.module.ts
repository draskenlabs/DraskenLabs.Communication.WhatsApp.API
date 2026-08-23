import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { InboxMediaService } from './inbox-media.service';
import { MessagingModule } from 'src/messaging/messaging.module';
import { MessagingAuthMiddleware } from 'src/messaging/middleware/messaging-auth.middleware';
import { SubscriptionMiddleware } from 'src/billing/middleware/subscription.middleware';
import { ApiKeyModule } from 'src/api-key/api-key.module';
import { UserModule } from 'src/user/user.module';
import { BillingModule } from 'src/billing/billing.module';
import { PlansModule } from 'src/plans/plans.module';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';

/**
 * The inbox: reading conversations, and answering in one.
 *
 * Sends go through `MessagingService` rather than posting to Meta here, so
 * membership, an API key's WABA scope, the subscription and the recipient's
 * opt-out are checked in exactly one place. What this module adds on top is
 * the 24-hour window, which only a conversation knows.
 *
 * The write path that keeps the conversation list current is not here — it is
 * `ConversationWriterModule`, imported by the webhook and the send path, so
 * that this module can depend on messaging without a cycle.
 */
@Module({
  imports: [
    MessagingModule,
    ApiKeyModule,
    UserModule,
    BillingModule,
    PlansModule,
  ],
  controllers: [InboxController],
  providers: [
    InboxService,
    InboxMediaService,
    AuthMiddleware,
    MessagingAuthMiddleware,
  ],
})
export class InboxModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Console JWT or API key, then the paywall on the key path — the same pair
    // the messaging routes use, in the same order, because the second reads
    // the `authType` the first sets.
    consumer
      .apply(MessagingAuthMiddleware, SubscriptionMiddleware)
      .forRoutes(
        { path: 'inbox', method: RequestMethod.GET },
        { path: 'inbox/media/:messageId', method: RequestMethod.GET },
        { path: 'inbox/:id', method: RequestMethod.PATCH },
        { path: 'inbox/:id/messages', method: RequestMethod.GET },
        { path: 'inbox/:id/messages', method: RequestMethod.POST },
        { path: 'inbox/:id/read', method: RequestMethod.POST },
      );
  }
}
