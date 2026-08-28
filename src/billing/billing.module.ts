import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { AgencyBillingService } from './agency-billing.service';
import { RazorpayService } from './razorpay.service';
import { RazorpaySignatureMiddleware } from './middleware/razorpay-signature.middleware';
import { SubscriptionMiddleware } from './middleware/subscription.middleware';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';
import { UserModule } from 'src/user/user.module';
import { MailModule } from 'src/mail/mail.module';
import { SubscriptionAccessModule } from './subscription-access.module';
import { ProvisioningModule } from 'src/provisioning/provisioning.module';
import { PlansModule } from 'src/plans/plans.module';
import { OrgModule } from 'src/org/org.module';

@Module({
  imports: [
    UserModule,
    MailModule,
    SubscriptionAccessModule,
    ProvisioningModule,
    // What the tier includes, for the "3 of 1 accounts" line on the billing
    // page and the price of the next one.
    PlansModule,
    // Seats live in the SSO, so the team-members meter is read through here.
    OrgModule,
  ],
  controllers: [BillingController],
  providers: [
    BillingService,
    AgencyBillingService,
    RazorpaySignatureMiddleware,
    SubscriptionMiddleware,
    AuthMiddleware,
  ],
  // MessagingModule applies the paywall; it needs both to decide. Razorpay and
  // the gate come through `SubscriptionAccessModule`, which owns them.
  exports: [
    BillingService,
    AgencyBillingService,
    SubscriptionMiddleware,
    SubscriptionAccessModule,
  ],
})
export class BillingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Razorpay authenticates by signature, not by a session, so the webhook
    // route must not be behind the JWT middleware.
    consumer
      .apply(RazorpaySignatureMiddleware)
      .forRoutes({ path: 'billing/webhook', method: RequestMethod.POST });

    consumer.apply(AuthMiddleware).forRoutes(
      { path: 'billing/subscription', method: RequestMethod.GET },
      { path: 'billing/subscription', method: RequestMethod.POST },
      { path: 'billing/subscription/confirm', method: RequestMethod.POST },
      // Bound by method and path, so a new route is a new entry here: the
      // controller reads `req.orgId`, which only this middleware sets.
      { path: 'billing/subscription/plan', method: RequestMethod.PATCH },
      { path: 'billing/subscription', method: RequestMethod.DELETE },
    );
  }
}
