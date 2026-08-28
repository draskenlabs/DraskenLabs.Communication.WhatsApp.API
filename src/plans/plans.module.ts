import { MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { PlanLimitsService } from './plan-limits.service';
import { PlanSyncService } from './plan-sync.service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { UserModule } from 'src/user/user.module';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';

/**
 * The price list.
 *
 * The two public routes stay public on purpose, like the legal pages the
 * console serves: somebody deciding whether to sign up has no session yet.
 * Only `/plans/mine` is behind auth, because a plan negotiated for one
 * organisation is not part of the published list. Nothing here can be written
 * over HTTP — the price list is changed by a migration, not by a call.
 */
@Module({
  imports: [PrismaModule, UserModule],
  controllers: [PlansController],
  providers: [PlansService, PlanLimitsService, PlanSyncService],
  // The limits are asked for by every module that can exceed one.
  exports: [PlansService, PlanLimitsService],
})
export class PlansModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes({ path: 'plans/mine', method: RequestMethod.GET });
  }
}
