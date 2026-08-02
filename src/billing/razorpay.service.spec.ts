import { Test, TestingModule } from '@nestjs/testing';
import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import axios from 'axios';
import { RazorpayService } from './razorpay.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const SECRET = 'rzp_secret_test';

const config = (values: Record<string, string | undefined>) => ({
  get: (key: string) => values[key],
});

/** The axios instance `axios.create` hands the service. */
const httpDouble = () => ({ post: jest.fn(), get: jest.fn(), patch: jest.fn() });

/** Razorpay's 400 for an email that is already on a customer. */
const duplicateError = () => ({
  message: 'Request failed with status code 400',
  response: {
    status: 400,
    data: { error: { description: 'Customer already exists for the merchant' } },
  },
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

  describe('createCustomer', () => {
    let http: ReturnType<typeof httpDouble>;

    beforeEach(() => {
      http = httpDouble();
      mockedAxios.create = jest.fn().mockReturnValue(http);
    });

    it('asks Razorpay to hand back an existing customer rather than erroring', async () => {
      // Documented as a string; the integer form is not honoured.
      http.post.mockResolvedValue({ data: { id: 'cust_1' } });
      const service = await build(CONFIGURED);

      await service.createCustomer({ email: 'a@example.com' });

      expect(http.post).toHaveBeenCalledWith(
        '/customers',
        expect.objectContaining({ fail_existing: '0' }),
      );
    });

    it('reuses the existing customer when the email is already taken', async () => {
      // The failure this fixes: the customer exists at Razorpay — another
      // organisation, or an attempt that died before the row was written — and
      // we hold no id for it, so registration used to dead-end here.
      http.post.mockRejectedValue(duplicateError());
      http.get.mockResolvedValue({
        data: { items: [{ id: 'cust_existing', email: 'A@Example.com' }] },
      });
      const service = await build(CONFIGURED);

      await expect(service.createCustomer({ email: 'a@example.com' })).resolves.toEqual({
        id: 'cust_existing',
      });
    });

    it('names the customer it recovered, without re-sending the email', async () => {
      // Re-sending the matched email is what their edit call rejects.
      http.post.mockRejectedValue(duplicateError());
      http.get.mockResolvedValue({
        data: { items: [{ id: 'cust_existing', email: 'a@example.com' }] },
      });
      const service = await build(CONFIGURED);

      await service.createCustomer({ name: 'Ada', email: 'a@example.com' });

      expect(http.patch).toHaveBeenCalledWith('/customers/cust_existing', { name: 'Ada' });
    });

    it('pages until it finds the customer', async () => {
      http.post.mockRejectedValue(duplicateError());
      const page = (n: number) =>
        Array.from({ length: 100 }, (_, i) => ({
          id: `cust_${n}_${i}`,
          email: `other${n}_${i}@example.com`,
        }));
      http.get
        .mockResolvedValueOnce({ data: { items: page(0) } })
        .mockResolvedValueOnce({
          data: { items: [{ id: 'cust_existing', email: 'a@example.com' }] },
        });
      const service = await build(CONFIGURED);

      await expect(service.createCustomer({ email: 'a@example.com' })).resolves.toEqual({
        id: 'cust_existing',
      });
      expect(http.get).toHaveBeenLastCalledWith('/customers', {
        params: { count: 100, skip: 100 },
      });
    });

    it('stops at a short page rather than paging forever', async () => {
      http.post.mockRejectedValue(duplicateError());
      http.get.mockResolvedValue({ data: { items: [{ id: 'cust_x', email: 'x@e.com' }] } });
      const service = await build(CONFIGURED);

      await expect(service.createCustomer({ email: 'a@example.com' })).rejects.toThrow(
        BadGatewayException,
      );
      expect(http.get).toHaveBeenCalledTimes(1);
    });

    it('reports the original failure when the customer cannot be found', async () => {
      // The search is a recovery attempt; its own failure must not mask why
      // the creation failed.
      http.post.mockRejectedValue(duplicateError());
      http.get.mockRejectedValue(new Error('network'));
      const service = await build(CONFIGURED);

      await expect(service.createCustomer({ email: 'a@example.com' })).rejects.toThrow(
        'Customer already exists for the merchant',
      );
    });

    it('does not search for anything else that goes wrong', async () => {
      http.post.mockRejectedValue({
        message: 'boom',
        response: { status: 400, data: { error: { description: 'Invalid email' } } },
      });
      const service = await build(CONFIGURED);

      await expect(service.createCustomer({ email: 'a@example.com' })).rejects.toThrow(
        'Invalid email',
      );
      expect(http.get).not.toHaveBeenCalled();
    });
  });
});
