import { Module } from '@nestjs/common';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { PlanLimitsService } from './plan-limits.service';
import { PlanSyncService } from './plan-sync.service';
import { PrismaModule } from 'src/prisma/prisma.module';

/**
 * The price list.
 *
 * No middleware: both routes are public on purpose, like the legal pages the
 * console serves. Nothing here is per-customer, and nothing here can be
 * written over HTTP — the price list is changed by a migration, not by a call.
 */
@Module({
  imports: [PrismaModule],
  controllers: [PlansController],
  providers: [PlansService, PlanLimitsService, PlanSyncService],
  // The limits are asked for by every module that can exceed one.
  exports: [PlansService, PlanLimitsService],
})
export class PlansModule {}
