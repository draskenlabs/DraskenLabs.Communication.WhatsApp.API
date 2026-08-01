import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import axios, { AxiosError, AxiosInstance } from 'axios';

/** The subscription entity as much of it as this module reads. */
export interface RazorpaySubscription {
  id: string;
  plan_id: string;
  customer_id?: string;
  status: string;
  /** Unix seconds. Absent until the mandate is authorised. */
  current_start?: number | null;
  current_end?: number | null;
  ended_at?: number | null;
  /** Hosted authorisation page. */
  short_url?: string;
  notes?: Record<string, string>;
}

/**
 * Razorpay's REST API, over axios rather than their SDK.
 *
 * The four calls used here are plain HTTP with basic auth; the SDK would add a
 * dependency for that and hide the error bodies that make a failed mandate
 * diagnosable.
 */
@Injectable()
export class RazorpayService {
  private readonly logger = new Logger(RazorpayService.name);
  private readonly client: AxiosInstance | null;
  private readonly keySecret: string | undefined;
  /** Publishable: Checkout needs it in the browser. */
  readonly keyId: string | undefined;
  readonly planId: string | undefined;
  readonly webhookSecret: string | undefined;

  constructor(private readonly config: ConfigService) {
    const keyId = config.get<string>('RAZORPAY_KEY_ID');
    const keySecret = config.get<string>('RAZORPAY_KEY_SECRET');
    this.keyId = keyId;
    this.keySecret = keySecret;
    this.planId = config.get<string>('RAZORPAY_PLAN_ID');
    this.webhookSecret = config.get<string>('RAZORPAY_WEBHOOK_SECRET');

    // Billing is optional configuration, like push and email: an instance
    // without Razorpay credentials runs normally and charges nobody.
    this.client =
      keyId && keySecret
        ? axios.create({
            baseURL: 'https://api.razorpay.com/v1',
            auth: { username: keyId, password: keySecret },
            timeout: 15000,
          })
        : null;

    if (!this.client) {
      this.logger.warn('Razorpay is not configured — subscriptions are disabled');
    }
  }

  /** Whether subscriptions can be sold at all on this deployment. */
  isConfigured(): boolean {
    return this.client !== null && !!this.planId;
  }

  /**
   * Whether Checkout's success payload really came from Razorpay.
   *
   * The browser reports its own success, so without this a crafted call could
   * mark a subscription paid. For subscriptions the signature is over
   * `payment_id|subscription_id` under the key secret.
   */
  verifyCheckoutSignature(input: {
    paymentId: string;
    subscriptionId: string;
    signature: string;
  }): boolean {
    if (!this.keySecret) return false;

    const expected = createHmac('sha256', this.keySecret)
      .update(`${input.paymentId}|${input.subscriptionId}`)
      .digest('hex');

    const expectedBuf = Buffer.from(expected, 'hex');
    const receivedBuf = Buffer.from(input.signature, 'hex');

    // Length first: timingSafeEqual throws on a mismatch rather than returning.
    return (
      expectedBuf.length === receivedBuf.length &&
      timingSafeEqual(expectedBuf, receivedBuf)
    );
  }

  private api(): AxiosInstance {
    if (!this.client) {
      throw new BadGatewayException('Payments are not configured on this deployment');
    }
    return this.client;
  }

  private fail(context: string, err: unknown): never {
    const error = err as AxiosError<{ error?: { description?: string } }>;
    const description = error.response?.data?.error?.description;
    this.logger.error(`${context}: ${description ?? error.message}`);
    // Their wording is usually the actionable part ("plan is not active"), so
    // it is passed through rather than replaced with a generic failure.
    throw new BadGatewayException(description ?? 'Payment provider request failed');
  }

  async createCustomer(input: {
    name?: string;
    email?: string;
    notes?: Record<string, string>;
  }): Promise<{ id: string }> {
    try {
      const { data } = await this.api().post<{ id: string }>('/customers', {
        ...input,
        // A repeat registration after a cancellation would otherwise be
        // rejected for reusing an email.
        fail_existing: 0,
      });
      return data;
    } catch (err) {
      this.fail('Razorpay customer creation failed', err);
    }
  }

  /**
   * Fill in a customer's details.
   *
   * Used when an organisation's existing customer is reused: the first one may
   * have been created before we had a name to give it, and an unnamed row in
   * their dashboard is no use to anyone reconciling a payment.
   */
  async updateCustomer(
    customerId: string,
    input: { name?: string; email?: string },
  ): Promise<void> {
    if (!input.name && !input.email) return;

    try {
      await this.api().patch(`/customers/${customerId}`, input);
    } catch (err) {
      // Cosmetic: never let a failed tidy-up stop somebody subscribing.
      const error = err as AxiosError<{ error?: { description?: string } }>;
      this.logger.warn(
        `Could not update Razorpay customer ${customerId}: ` +
          (error.response?.data?.error?.description ?? error.message),
      );
    }
  }

  /**
   * A monthly subscription. `total_count` is Razorpay's required cycle count;
   * ten years of months stands in for "until cancelled", which their API has
   * no way to express.
   */
  async createSubscription(input: {
    customerId?: string;
    notes?: Record<string, string>;
  }): Promise<RazorpaySubscription> {
    try {
      const { data } = await this.api().post<RazorpaySubscription>('/subscriptions', {
        plan_id: this.planId,
        total_count: 120,
        customer_id: input.customerId,
        // Razorpay sends the mandate and pre-debit notifications the RBI
        // requires; doing it ourselves would duplicate them.
        customer_notify: 1,
        notes: input.notes,
      });
      return data;
    } catch (err) {
      this.fail('Razorpay subscription creation failed', err);
    }
  }

  /**
   * @param atCycleEnd Stop after the month already paid for, rather than now.
   */
  async cancelSubscription(
    subscriptionId: string,
    atCycleEnd: boolean,
  ): Promise<RazorpaySubscription> {
    try {
      const { data } = await this.api().post<RazorpaySubscription>(
        `/subscriptions/${subscriptionId}/cancel`,
        { cancel_at_cycle_end: atCycleEnd ? 1 : 0 },
      );
      return data;
    } catch (err) {
      this.fail('Razorpay subscription cancellation failed', err);
    }
  }

  async fetchSubscription(subscriptionId: string): Promise<RazorpaySubscription> {
    try {
      const { data } = await this.api().get<RazorpaySubscription>(
        `/subscriptions/${subscriptionId}`,
      );
      return data;
    } catch (err) {
      this.fail('Razorpay subscription fetch failed', err);
    }
  }
}
