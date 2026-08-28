import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminGuard } from './admin.guard';
import { OrgDirectoryModule } from 'src/org/org-directory.module';
import { PlansModule } from 'src/plans/plans.module';
import { AgencyModule } from 'src/agency/agency.module';
import { UserModule } from 'src/user/user.module';
import { BillingModule } from 'src/billing/billing.module';

/**
 * The operator console.
 *
 * No middleware is bound here on purpose. `AuthMiddleware` answers 401 for a
 * missing or bad token, and 401 on this prefix would confirm that `/admin` is a
 * real route to anybody who probed it. `AdminGuard` does the whole check itself
 * and answers 404 to every refusal.
 */
@Module({
  // UserModule for the JwtModule it exports — the guard verifies the token
  // itself rather than letting a middleware answer 401 on this prefix.
  imports: [
    OrgDirectoryModule,
    PlansModule,
    AgencyModule,
    UserModule,
    // For RazorpayService: a plan's price only exists once the provider has a
    // plan for it, and the console is where a plan is written.
    BillingModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminAuditService, AdminGuard],
  exports: [AdminService],
})
export class AdminModule {}
