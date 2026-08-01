import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { RazorpayService } from './razorpay.service';
import { RazorpaySignatureMiddleware } from './middleware/razorpay-signature.middleware';
import { SubscriptionMiddleware } from './middleware/subscription.middleware';
import { AuthMiddleware } from 'src/user/middleware/auth.middleware';
import { UserModule } from 'src/user/user.module';
import { MailModule } from 'src/mail/mail.module';

@Module({
  imports: [UserModule, MailModule],
  controllers: [BillingController],
  providers: [
    BillingService,
    RazorpayService,
    RazorpaySignatureMiddleware,
    SubscriptionMiddleware,
    AuthMiddleware,
  ],
  // MessagingModule applies the paywall; it needs both to decide.
  exports: [BillingService, RazorpayService, SubscriptionMiddleware],
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
        { path: 'billing/subscription', method: RequestMethod.GET },
        { path: 'billing/subscription', method: RequestMethod.POST },
        { path: 'billing/subscription', method: RequestMethod.DELETE },
      );
  }
}
