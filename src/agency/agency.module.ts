import { MiddlewareConsumer, Module, RequestMethod } from '@nestjs/common';
import { AgencyController } from './agency.controller';
import { AgencyService } from './agency.service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { PlansModule } from 'src/plans/plans.module';
import { OrgDirectoryModule } from 'src/org/org-directory.module';
import { UserModule } from 'src/user/user.module';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';
import { BillingModule } from 'src/billing/billing.module';

/**
 * Agencies and the organisations they pay for.
 *
 * Auth is applied per route rather than to the controller: the two operator
 * endpoints are reached by our own tooling with a shared secret and no user
 * session at all, so a blanket `AuthMiddleware` would lock out the only
 * callers they have.
 */
@Module({
  imports: [
    PrismaModule,
    PlansModule,
    OrgDirectoryModule,
    UserModule,
    // Taking a client on is a purchase: the agency's mandate for that plan
    // grows by one. `BillingModule` does not import this one, so no cycle.
    BillingModule,
  ],
  controllers: [AgencyController],
  providers: [AgencyService],
  exports: [AgencyService],
})
export class AgencyModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes(
        { path: 'agency/clients', method: RequestMethod.GET },
        { path: 'agency/clients', method: RequestMethod.POST },
        { path: 'agency/mandates', method: RequestMethod.GET },
        { path: 'agency/clients/:ssoOrgId', method: RequestMethod.PATCH },
        { path: 'agency/invoices', method: RequestMethod.GET },
        { path: 'agency/invoices/:number/pdf', method: RequestMethod.GET },
      );
  }
}
