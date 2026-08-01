import { MiddlewareConsumer, Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { UserModule } from 'src/user/user.module';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';

@Module({
  imports: [PrismaModule, UserModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AuthMiddleware],
})
export class AnalyticsModule {
  configure(consumer: MiddlewareConsumer) {
    // Console-only: reporting reads across the whole organisation, which is a
    // different thing from the per-phone-number send an API key authorises.
    consumer.apply(AuthMiddleware).forRoutes(AnalyticsController);
  }
}
