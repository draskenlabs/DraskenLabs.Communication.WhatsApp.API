import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { RazorpayService } from '../razorpay.service';

/**
 * Razorpay signs each webhook with HMAC-SHA256 of the raw body under the
 * webhook secret — a different secret from the API key, and a different scheme
 * from Meta's, which is why this is not the Meta middleware with a new header.
 */
@Injectable()
export class RazorpaySignatureMiddleware implements NestMiddleware {
  constructor(private readonly razorpay: RazorpayService) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const signature = req.headers['x-razorpay-signature'] as string | undefined;
    if (!signature) throw new UnauthorizedException('Missing X-Razorpay-Signature');

    const secret = this.razorpay.webhookSecret;
    if (!secret) throw new UnauthorizedException('Webhook secret not configured');

    const rawBody: Buffer | undefined = (req as any).rawBody;
    if (!rawBody) throw new UnauthorizedException('Raw body not available');

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const receivedBuf = Buffer.from(signature, 'hex');

    if (
      expectedBuf.length !== receivedBuf.length ||
      !timingSafeEqual(expectedBuf, receivedBuf)
    ) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    next();
  }
}
