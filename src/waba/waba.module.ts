import { Module, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { WabaService } from './waba.service';
import { WabaController } from './waba.controller';
import { UserModule } from 'src/user/user.module';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';
import { RedisModule } from 'src/redis/redis.module';
import { WabaMembershipModule } from './waba-membership.module';

@Module({
  imports: [UserModule, RedisModule, WabaMembershipModule],
  providers: [WabaService],
  controllers: [WabaController],
  exports: [WabaService],
})
export class WabaModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes(WabaController);
  }
}
