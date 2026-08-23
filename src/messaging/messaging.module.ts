import { MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { MessagingController } from './messaging.controller';
import { ApiKeyModule } from 'src/api-key/api-key.module';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';
import { MessagingAuthMiddleware } from './middleware/messaging-auth.middleware';
import { UserModule } from 'src/user/user.module';
import { ContactsModule } from 'src/contacts/contacts.module';
import { BillingModule } from 'src/billing/billing.module';
import { WabaMembershipModule } from 'src/waba/waba-membership.module';
import { SubscriptionMiddleware } from 'src/billing/middleware/subscription.middleware';
import { ConversationWriterModule } from 'src/inbox/conversation-writer.module';

@Module({
  imports: [
    ApiKeyModule,
    UserModule,
    ContactsModule,
    BillingModule,
    WabaMembershipModule,
    ConversationWriterModule,
  ],
  providers: [MessagingService, AuthMiddleware, MessagingAuthMiddleware],
  controllers: [MessagingController],
  // The inbox sends its replies through this service, so every check a send
  // must pass — membership, WABA scope, subscription, opt-out — is the same
  // one, written once.
  exports: [MessagingService],
})
export class MessagingModule {
  configure(consumer: MiddlewareConsumer) {
    // Accept either the console JWT or a server-to-server API key, then charge
    // for the API-key path — the subscription middleware runs second because
    // it reads the `authType` the first one sets. The `messages/:id` pattern
    // also covers `messages/analytics`.
    consumer
      .apply(MessagingAuthMiddleware, SubscriptionMiddleware)
      .forRoutes(
        { path: 'messages', method: RequestMethod.POST },
        { path: 'messages', method: RequestMethod.GET },
        { path: 'messages/:id', method: RequestMethod.GET },
      );
  }
}
