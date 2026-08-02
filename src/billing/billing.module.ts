import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { RazorpayService } from './razorpay.service';
import { RazorpaySignatureMiddleware } from './middleware/razorpay-signature.middleware';
import { SubscriptionMiddleware } from './middleware/subscription.middleware';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';
import { UserModule } from 'src/user/user.module';
import { MailModule } from 'src/mail/mail.module';
import { SubscriptionAccessModule } from './subscription-access.module';
import { ProvisioningModule } from 'src/provisioning/provisioning.module';

@Module({
  imports: [UserModule, MailModule, SubscriptionAccessModule, ProvisioningModule],
  controllers: [BillingController],
  providers: [
    BillingService,
    RazorpaySignatureMiddleware,
    SubscriptionMiddleware,
    AuthMiddleware,
  ],
  // MessagingModule applies the paywall; it needs both to decide. Razorpay and
  // the gate come through `SubscriptionAccessModule`, which owns them.
  exports: [BillingService, SubscriptionMiddleware, SubscriptionAccessModule],
})
export class BillingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Razorpay authenticates by signature, not by a session, so the webhook
    // route must not be behind the JWT middleware.
    consumer
      .apply(RazorpaySignatureMiddleware)
      .forRoutes({ path: 'billing/webhook', method: RequestMethod.POST });

    consumer
      .apply(AuthMiddleware)
      .forRoutes(
        { path: 'billing/subscriptions', method: RequestMethod.GET },
        { path: 'billing/subscriptions/:wabaId', method: RequestMethod.POST },
        { path: 'billing/subscriptions/:wabaId/confirm', method: RequestMethod.POST },
        { path: 'billing/subscriptions/:wabaId', method: RequestMethod.DELETE },
      );
  }
}
