import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
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

/** A plan, as much of it as the console needs to show a price. */
export interface RazorpayPlan {
  id: string;
  period: string;
  interval: number;
  item: {
    amount: number;
    currency: string;
    name?: string;
    description?: string;
  };
}

/** A payment, as the `subscription.charged` webhook carries it. */
export interface RazorpayPayment {
  id: string;
  invoice_id?: string | null;
  amount: number;
  currency: string;
  status: string;
  method?: string;
  card?: { network?: string; last4?: string; issuer?: string } | null;
  bank?: string | null;
  wallet?: string | null;
  vpa?: string | null;
  created_at?: number;
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
  /** Plans are immutable, so this only ever grows by one per configured plan. */
  private readonly plans = new Map<string, RazorpayPlan>();
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
    // Overridable so an integration test can point the whole client at a
    // local stand-in and assert on the requests we actually send. Unset — as
    // it is in every deployment — this is Razorpay.
    const baseURL =
      config.get<string>('RAZORPAY_API_BASE') ?? 'https://api.razorpay.com/v1';

    this.client =
      keyId && keySecret
        ? axios.create({
            baseURL,
            auth: { username: keyId, password: keySecret },
            timeout: 15000,
          })
        : null;

    if (!this.client) {
      this.logger.warn(
        'Razorpay is not configured — subscriptions are disabled',
      );
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
      throw new BadGatewayException(
        'Payments are not configured on this deployment',
      );
    }
    return this.client;
  }

  private fail(context: string, err: unknown): never {
    const error = err as AxiosError<{ error?: { description?: string } }>;
    const description = error.response?.data?.error?.description;
    this.logger.error(`${context}: ${description ?? error.message}`);
    // Their wording is usually the actionable part ("plan is not active"), so
    // it is passed through rather than replaced with a generic failure.
    throw new BadGatewayException(
      description ?? 'Payment provider request failed',
    );
  }

  /** Razorpay's wording when an email or contact is already on a customer. */
  private isDuplicateCustomer(err: unknown): boolean {
    const error = err as AxiosError<{ error?: { description?: string } }>;
    return /already exists/i.test(
      error.response?.data?.error?.description ?? '',
    );
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
        // rejected for reusing an email. Their API documents this as a string
        // and does not honour the integer form.
        fail_existing: '0',
      });
      return data;
    } catch (err) {
      // Razorpay dedupes customers by email across the whole merchant account,
      // so this collides whenever we ask for a customer that exists but whose
      // id we never stored: the same person subscribing under a second
      // organisation, or an earlier attempt that created the customer and then
      // failed before the subscription row was written. `fail_existing` is
      // meant to hand back the existing customer instead of erroring and
      // cannot be relied on to, so the id is recovered by hand — the
      // alternative is somebody permanently unable to pay us.
      const existing =
        this.isDuplicateCustomer(err) && input.email
          ? await this.findCustomerByEmail(input.email)
          : null;

      if (existing) {
        this.logger.log(
          `Razorpay customer for that email already exists — reusing ${existing.id}`,
        );
        // It may predate having a name to give it, exactly as for a customer
        // reused from our own records. Only the name: the email is what it was
        // matched on, and re-sending it is what their edit call rejects.
        await this.updateCustomer(existing.id, { name: input.name });
        return existing;
      }

      this.fail('Razorpay customer creation failed', err);
    }
  }

  /**
   * The customer holding an email address, if the merchant account has one.
   *
   * Razorpay has no lookup by email — `GET /customers` takes only `count` and
   * `skip` — so this pages through them. Newest first, so the duplicate that
   * provoked the search is normally on the first page; the cap stops a large
   * merchant account turning one failed registration into a hundred requests.
   * Only ever reached on the duplicate path, never on a first-time customer.
   */
  async findCustomerByEmail(email: string): Promise<{ id: string } | null> {
    const wanted = email.trim().toLowerCase();
    if (!wanted || !this.client) return null;

    const pageSize = 100;
    const maxPages = 10;

    try {
      for (let page = 0; page < maxPages; page++) {
        const { data } = await this.api().get<{
          items?: { id: string; email?: string | null }[];
        }>('/customers', {
          params: { count: pageSize, skip: page * pageSize },
        });

        const items = data.items ?? [];
        const hit = items.find(
          (customer) => customer.email?.trim().toLowerCase() === wanted,
        );
        if (hit) return { id: hit.id };
        // A short page is the last one.
        if (items.length < pageSize) return null;
      }

      this.logger.warn(
        `Gave up looking for an existing Razorpay customer after ${maxPages * pageSize} records`,
      );
      return null;
    } catch (err) {
      // The caller reports the original creation failure; this is only ever a
      // recovery attempt, so its own failure must not replace that error.
      const error = err as AxiosError<{ error?: { description?: string } }>;
      this.logger.warn(
        'Could not search Razorpay customers: ' +
          (error.response?.data?.error?.description ?? error.message),
      );
      return null;
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
   *
   * @param input.planId The tier being sold. Falls back to the deployment's
   * configured plan, which is what a deployment with one price still uses.
   */
  async createSubscription(input: {
    customerId?: string;
    notes?: Record<string, string>;
    planId?: string;
  }): Promise<RazorpaySubscription> {
    try {
      const { data } = await this.api().post<RazorpaySubscription>(
        '/subscriptions',
        {
          plan_id: input.planId ?? this.planId,
          total_count: 120,
          customer_id: input.customerId,
          // Razorpay sends the mandate and pre-debit notifications the RBI
          // requires; doing it ourselves would duplicate them.
          customer_notify: 1,
          notes: input.notes,
        },
      );
      return data;
    } catch (err) {
      this.fail('Razorpay subscription creation failed', err);
    }
  }

  /**
   * Add a recurring extra to the *next* invoice of a subscription.
   *
   * Razorpay has no second recurring price on a plan, so a per-number charge
   * is an add-on raised once per cycle: this is called as each cycle is
   * charged, for the cycle after it. That is also why a number added today is
   * billed from the next invoice rather than prorated into the current one —
   * nobody is charged mid-month for something they have just switched on.
   */
  async addSubscriptionAddon(
    subscriptionId: string,
    input: { name: string; amount: number; currency: string; quantity: number },
  ): Promise<{ id: string } | null> {
    try {
      const { data } = await this.api().post<{ id: string }>(
        `/subscriptions/${subscriptionId}/addons`,
        {
          item: {
            name: input.name,
            amount: input.amount,
            currency: input.currency,
          },
          quantity: input.quantity,
        },
      );
      return data;
    } catch (err) {
      // Never fatal: the add-on is money we have not collected, not a state
      // the subscription depends on, and the caller is a webhook Razorpay will
      // stop retrying if we throw.
      const error = err as AxiosError<{ error?: { description?: string } }>;
      this.logger.error(
        `Could not add the extra-numbers charge to ${subscriptionId}: ` +
          (error.response?.data?.error?.description ?? error.message),
      );
      return null;
    }
  }

  /**
   * Move a running subscription onto another plan.
   *
   * `schedule_change_at` is the whole decision: `now` ends the current cycle
   * and starts one on the new plan, `cycle_end` leaves the month already paid
   * for alone and switches at the renewal. Nothing here prorates, because
   * nothing else in this module does either.
   *
   * A mandate is authorised up to an amount, so an upgrade past that ceiling
   * is refused by Razorpay rather than silently debited — that refusal is
   * turned into something the customer can act on instead of a gateway error.
   */
  async changeSubscriptionPlan(
    subscriptionId: string,
    input: { planId: string; atCycleEnd: boolean },
  ): Promise<RazorpaySubscription> {
    try {
      const { data } = await this.api().patch<RazorpaySubscription>(
        `/subscriptions/${subscriptionId}`,
        {
          plan_id: input.planId,
          schedule_change_at: input.atCycleEnd ? 'cycle_end' : 'now',
          // Razorpay sends the pre-debit notice the RBI requires for the new
          // amount; doing it ourselves would duplicate it.
          customer_notify: 1,
        },
      );
      return data;
    } catch (err) {
      if (this.isMandateCeiling(err)) {
        throw new BadRequestException(
          'This plan costs more than the payment mandate on this account allows. ' +
            'Cancel the subscription and take out a new one on the higher plan — ' +
            'the bank has to authorise the larger amount, and only the customer can do that.',
        );
      }
      this.fail('Razorpay subscription plan change failed', err);
    }
  }

  /**
   * Whether Razorpay refused because the new amount is above what the customer
   * authorised. Matched on their wording, which is the only signal they give:
   * the error code is the same `BAD_REQUEST_ERROR` as any other refusal.
   */
  private isMandateCeiling(err: unknown): boolean {
    const error = err as AxiosError<{ error?: { description?: string } }>;
    const description = error.response?.data?.error?.description ?? '';
    return /max.?amount|authoriz|mandate/i.test(description);
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

  /**
   * The plan behind the subscriptions, cached for the process's lifetime.
   *
   * Plans are immutable at Razorpay — a price change is a new plan id — so
   * there is nothing to invalidate, and the console asking "what does this
   * cost" on every page load has no business becoming a request per view.
   */
  async fetchPlan(planId?: string): Promise<RazorpayPlan | null> {
    const id = planId ?? this.planId;
    if (!id || !this.client) return null;

    const cached = this.plans.get(id);
    if (cached) return cached;

    try {
      const { data } = await this.api().get<RazorpayPlan>(`/plans/${id}`);
      this.plans.set(id, data);
      return data;
    } catch (err) {
      // A price the console cannot show is not a reason to fail the page.
      const error = err as AxiosError<{ error?: { description?: string } }>;
      this.logger.warn(
        `Could not read Razorpay plan ${id}: ` +
          (error.response?.data?.error?.description ?? error.message),
      );
      return null;
    }
  }

  async fetchSubscription(
    subscriptionId: string,
  ): Promise<RazorpaySubscription> {
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
