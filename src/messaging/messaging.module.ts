import { MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { MessagingController } from './messaging.controller';
import { ApiKeyModule } from 'src/api-key/api-key.module';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';
import { MessagingAuthMiddleware } from './middleware/messaging-auth.middleware';
import { UserModule } from 'src/user/user.module';
import { ContactsModule } from 'src/contacts/contacts.module';

@Module({
  imports: [ApiKeyModule, UserModule, ContactsModule],
  providers: [MessagingService, AuthMiddleware, MessagingAuthMiddleware],
  controllers: [MessagingController],
})
export class MessagingModule {
  configure(consumer: MiddlewareConsumer) {
    // Accept either the console JWT or a server-to-server API key. The
    // `messages/:id` pattern also covers `messages/analytics`.
    consumer
      .apply(MessagingAuthMiddleware)
      .forRoutes(
        { path: 'messages', method: RequestMethod.POST },
        { path: 'messages', method: RequestMethod.GET },
        { path: 'messages/:id', method: RequestMethod.GET },
      );
  }
}
