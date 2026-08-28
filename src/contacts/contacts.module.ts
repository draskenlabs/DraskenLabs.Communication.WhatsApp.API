import { MiddlewareConsumer, Module } from '@nestjs/common';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { UserModule } from 'src/user/user.module';
import { PlansModule } from 'src/plans/plans.module';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';

@Module({
  imports: [UserModule, PlansModule],
  controllers: [ContactsController],
  providers: [ContactsService],
  exports: [ContactsService],
})
export class ContactsModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes(ContactsController);
  }
}
