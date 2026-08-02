import { Module } from '@nestjs/common';
import { RazorpayService } from './razorpay.service';
import { SubscriptionAccessService } from './subscription-access.service';

/**
 * The paywall on its own, importable by the services it gates.
 *
 * `BillingModule` provisions an account once it is paid for, which means it
 * depends on the WABA, phone-number and template modules. Those same modules
 * need the gate. Handing them this module instead of the whole of billing is
 * what keeps that from being a cycle.
 */
@Module({
  providers: [SubscriptionAccessService, RazorpayService],
  exports: [SubscriptionAccessService, RazorpayService],
})
export class SubscriptionAccessModule {}
