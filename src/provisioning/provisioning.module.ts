import { Module } from '@nestjs/common';
import { CommonModule } from 'src/common/common.module';
import { WabaModule } from 'src/waba/waba.module';
import { WabaMembershipModule } from 'src/waba/waba-membership.module';
import { WabaPhoneNumberModule } from 'src/waba-phone-number/waba-phone-number.module';
import { TemplatesModule } from 'src/templates/templates.module';
import { WabaProvisioningService } from './waba-provisioning.service';

/**
 * Sits between billing and the account modules.
 *
 * It can import all three because they gate on `SubscriptionAccessModule`
 * rather than on the whole of `BillingModule` — otherwise "billing provisions
 * an account" and "the account modules check billing" would be a cycle.
 */
@Module({
  imports: [
    CommonModule,
    WabaModule,
    WabaMembershipModule,
    WabaPhoneNumberModule,
    TemplatesModule,
  ],
  providers: [WabaProvisioningService],
  exports: [WabaProvisioningService],
})
export class ProvisioningModule {}
