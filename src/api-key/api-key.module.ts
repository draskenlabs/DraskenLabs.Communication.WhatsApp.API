import { Module, MiddlewareConsumer } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ApiKeyController } from './api-key.controller';
import { RedisModule } from 'src/redis/redis.module';
import { UserModule } from 'src/user/user.module';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';
import { ApiKeyAuthMiddleware } from './middleware/api-key-auth.middleware';
import { PlansModule } from 'src/plans/plans.module';

@Module({
  imports: [RedisModule, UserModule, PlansModule],
  providers: [ApiKeyService, ApiKeyAuthMiddleware],
  controllers: [ApiKeyController],
  exports: [ApiKeyService, ApiKeyAuthMiddleware],
})
export class ApiKeyModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes(ApiKeyController);
  }
}
