import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { FirebaseService } from './firebase.service';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';
import { UserModule } from 'src/user/user.module';

/**
 * Push notifications over Firebase Cloud Messaging. Exported so the webhook
 * handlers can notify people when Meta tells us something happened.
 */
@Module({
  imports: [UserModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, FirebaseService],
  exports: [NotificationsService],
})
export class NotificationsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route here is about the signed-in user's own devices.
    consumer.apply(AuthMiddleware).forRoutes(NotificationsController);
  }
}
