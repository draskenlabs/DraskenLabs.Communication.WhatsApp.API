import { HttpException, HttpStatus, Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { BillingService } from '../billing.service';
import { RazorpayService } from '../razorpay.service';

/**
 * The paywall on the programmatic API.
 *
 * Subscriptions are per WhatsApp Business Account and API keys are scoped to
 * one, so the account to charge for is the one the key names — already
 * resolved onto the request by the API-key middleware, which is why this runs
 * after it. No allocation of paid accounts to requests, and no way for a key
 * to ride on an account somebody else paid for.
 *
 * `authType` decides who pays: the console authenticates with a JWT and stays
 * free. Someone who has stopped paying can still read their history, export it
 * and re-subscribe, which is the difference between ending a subscription and
 * locking someone out of their own account.
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

    // The subscription belongs to an organisation as well as an account: the
    // same WABA connected in two organisations is two subscriptions, and a key
    // issued in one must not ride on the other's payment.
    const wabaId = (req as any).apiKeyWabaId as string | undefined;
    const ssoOrgId = (req as any).orgId as string | undefined;
    if (wabaId && ssoOrgId && (await this.billing.hasAccess(ssoOrgId, wabaId))) {
      return next();
    }

    throw new HttpException(
      wabaId
        ? `WhatsApp Business Account ${wabaId} has no active subscription. Subscribe in the console to use the API with this key.`
        : 'This API key is not scoped to a WhatsApp Business Account.',
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
