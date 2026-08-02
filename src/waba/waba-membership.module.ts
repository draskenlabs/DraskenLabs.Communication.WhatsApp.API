import { Module } from '@nestjs/common';
import { WabaMembershipService } from './waba-membership.service';

/**
 * Membership on its own, so every module that acts on an account can ask the
 * same question without pulling in the whole of `WabaModule`.
 */
@Module({
  providers: [WabaMembershipService],
  exports: [WabaMembershipService],
})
export class WabaMembershipModule {}
