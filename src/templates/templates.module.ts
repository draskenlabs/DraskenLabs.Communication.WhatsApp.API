import { MiddlewareConsumer, Module } from '@nestjs/common';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { SubscriptionAccessModule } from 'src/billing/subscription-access.module';
import { WabaMembershipModule } from 'src/waba/waba-membership.module';
import { CommonModule } from 'src/common/common.module';
import { UserModule } from 'src/user/user.module';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';

@Module({
  imports: [CommonModule, UserModule, SubscriptionAccessModule, WabaMembershipModule],
  controllers: [TemplatesController],
  providers: [TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes(TemplatesController);
  }
}
