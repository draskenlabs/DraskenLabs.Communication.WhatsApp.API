import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { InvoiceService } from './invoice.service';
import { RazorpayService } from './razorpay.service';
import { RazorpaySignatureMiddleware } from './middleware/razorpay-signature.middleware';
import { SubscriptionMiddleware } from './middleware/subscription.middleware';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';
import { UserModule } from 'src/user/user.module';
import { MailModule } from 'src/mail/mail.module';
import { SubscriptionAccessModule } from './subscription-access.module';
import { ProvisioningModule } from 'src/provisioning/provisioning.module';
import { OrgDirectoryModule } from 'src/org/org-directory.module';

@Module({
  imports: [
    UserModule,
    MailModule,
    SubscriptionAccessModule,
    ProvisioningModule,
    // Invoices name the organisation they were billed to, and the directory is
    // the only thing that can turn an SSO id into a name.
    OrgDirectoryModule,
  ],
  controllers: [BillingController],
  providers: [
    BillingService,
    InvoiceService,
    RazorpaySignatureMiddleware,
    SubscriptionMiddleware,
    AuthMiddleware,
  ],
  // MessagingModule applies the paywall; it needs both to decide. Razorpay and
  // the gate come through `SubscriptionAccessModule`, which owns them.
  exports: [
    BillingService,
    InvoiceService,
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
      { path: 'billing/subscriptions', method: RequestMethod.GET },
      { path: 'billing/subscriptions/:wabaId', method: RequestMethod.POST },
      {
        path: 'billing/subscriptions/:wabaId/confirm',
        method: RequestMethod.POST,
      },
      // Bound by method and path, so a new route is a new entry here: the
      // controller reads `req.orgId`, which only this middleware sets.
      {
        path: 'billing/subscriptions/:wabaId/plan',
        method: RequestMethod.PATCH,
      },
      { path: 'billing/subscriptions/:wabaId', method: RequestMethod.DELETE },
      { path: 'billing/invoices', method: RequestMethod.GET },
      { path: 'billing/invoices/:number', method: RequestMethod.GET },
      { path: 'billing/invoices/:number/pdf', method: RequestMethod.GET },
    );
  }
}
