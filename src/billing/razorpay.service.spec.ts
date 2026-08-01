import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { RazorpayService } from './razorpay.service';

const SECRET = 'rzp_secret_test';

const config = (values: Record<string, string | undefined>) => ({
  get: (key: string) => values[key],
});

async function build(values: Record<string, string | undefined>) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      RazorpayService,
      { provide: ConfigService, useValue: config(values) },
    ],
  }).compile();
  return module.get<RazorpayService>(RazorpayService);
}

const CONFIGURED = {
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: SECRET,
  RAZORPAY_PLAN_ID: 'plan_1',
  RAZORPAY_WEBHOOK_SECRET: 'whsec',
};

/** The signature Checkout returns: HMAC over `payment_id|subscription_id`. */
const sign = (paymentId: string, subscriptionId: string) =>
  createHmac('sha256', SECRET).update(`${paymentId}|${subscriptionId}`).digest('hex');

describe('RazorpayService', () => {
  describe('isConfigured', () => {
    it('is true only with a key pair and a plan', async () => {
      expect((await build(CONFIGURED)).isConfigured()).toBe(true);
    });

    it('is false without credentials, so nothing is sold or charged for', async () => {
      expect((await build({})).isConfigured()).toBe(false);
      expect(
        (await build({ ...CONFIGURED, RAZORPAY_PLAN_ID: undefined })).isConfigured(),
      ).toBe(false);
    });
  });

  describe('verifyCheckoutSignature', () => {
    it('accepts the signature Razorpay produced', async () => {
      const service = await build(CONFIGURED);

      expect(
        service.verifyCheckoutSignature({
          paymentId: 'pay_1',
          subscriptionId: 'sub_1',
          signature: sign('pay_1', 'sub_1'),
        }),
      ).toBe(true);
    });

    it('rejects a signature for a different subscription', async () => {
      // The browser chooses what it posts; the subscription id is inside the
      // signed string precisely so it cannot be swapped.
      const service = await build(CONFIGURED);

      expect(
        service.verifyCheckoutSignature({
          paymentId: 'pay_1',
          subscriptionId: 'sub_2',
          signature: sign('pay_1', 'sub_1'),
        }),
      ).toBe(false);
    });

    it('rejects a signature of the wrong length rather than throwing', async () => {
      // timingSafeEqual throws on a length mismatch; the guard comes first.
      const service = await build(CONFIGURED);

      expect(
        service.verifyCheckoutSignature({
          paymentId: 'pay_1',
          subscriptionId: 'sub_1',
          signature: 'abcd',
        }),
      ).toBe(false);
    });

    it('rejects everything when no secret is configured', async () => {
      const service = await build({});

      expect(
        service.verifyCheckoutSignature({
          paymentId: 'pay_1',
          subscriptionId: 'sub_1',
          signature: sign('pay_1', 'sub_1'),
        }),
      ).toBe(false);
    });
  });
});
