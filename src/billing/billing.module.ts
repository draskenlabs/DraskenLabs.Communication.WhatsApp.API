import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { AgencyBillingService } from './agency-billing.service';
import { InvoiceService } from './invoice.service';
import { ReceiptService } from './receipt.service';
import { RazorpaySignatureMiddleware } from './middleware/razorpay-signature.middleware';
import { SubscriptionMiddleware } from './middleware/subscription.middleware';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';
import { UserModule } from 'src/user/user.module';
import { MailModule } from 'src/mail/mail.module';
import { SubscriptionAccessModule } from './subscription-access.module';
import { ProvisioningModule } from 'src/provisioning/provisioning.module';
import { PlansModule } from 'src/plans/plans.module';
import { OrgModule } from 'src/org/org.module';
import { OrgDirectoryModule } from 'src/org/org-directory.module';

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
    // What an organisation is called, for "paid by …" on a client's page.
    OrgDirectoryModule,
  ],
  controllers: [BillingController],
  providers: [
    BillingService,
    AgencyBillingService,
    InvoiceService,
    ReceiptService,
    RazorpaySignatureMiddleware,
    SubscriptionMiddleware,
    AuthMiddleware,
  ],
  // MessagingModule applies the paywall; it needs both to decide. Razorpay and
  // the gate come through `SubscriptionAccessModule`, which owns them.
  exports: [
    BillingService,
    AgencyBillingService,
    InvoiceService,
    ReceiptService,
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

    // Every route on the controller, rather than a list of them.
    //
    // This used to enumerate each path and method, with a comment warning that
    // a new route needed a new entry. It did not survive contact: five routes
    // were added without one, and because the controller reads `req.orgId` —
    // which only this middleware sets — each of them answered 401. The console
    // treats a 401 as a dead session, so opening the billing page signed the
    // customer out.
    //
    // Bound to the controller, a route cannot be forgotten. The webhook is the
    // one exception and is excluded by name: Razorpay authenticates by
    // signature and carries no session, so the JWT middleware would reject
    // every charge we are told about.
    consumer
      .apply(AuthMiddleware)
      .exclude({ path: 'billing/webhook', method: RequestMethod.POST })
      .forRoutes(BillingController);
  }
}
