import { HttpException, HttpStatus, Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { BillingService } from '../billing.service';
import { RazorpayService } from '../razorpay.service';

/**
 * The paywall on the programmatic API.
 *
 * It runs after the messaging auth middleware, so `authType` is already known:
 * only API-key traffic is charged for. The console authenticates with a JWT
 * and stays free — someone who has stopped paying can still read their
 * history, export it and re-subscribe, which is the difference between ending
 * a subscription and locking someone out of their own account.
 *
 * A deployment with no Razorpay credentials lets everything through, so the
 * self-hosted and development cases do not need a payment provider.
 */
@Injectable()
export class SubscriptionMiddleware implements NestMiddleware {
  constructor(
    private readonly billing: BillingService,
    private readonly razorpay: RazorpayService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    if ((req as any).authType !== 'apiKey' || !this.razorpay.isConfigured()) {
      return next();
    }

    const orgId = (req as any).orgId as string | undefined;
    if (orgId && (await this.billing.hasAccess(orgId))) return next();

    throw new HttpException(
      'This organisation has no active subscription. Subscribe in the console to use the API.',
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
