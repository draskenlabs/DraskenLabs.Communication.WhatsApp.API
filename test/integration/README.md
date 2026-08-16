# Integration suite

Tests that run the real API against a real Postgres. Everything here exists
because a mock could not have caught the bug: hand-written migrations, raw SQL
deletes, HMAC over the exact bytes on the wire, a foreign key, a unique index
that makes a retry idempotent, and what Razorpay is actually sent.

It already earned its keep — the first run found `confirm()` answering with
`planCode: null` because the `update` that re-read the subscription had no
`include: { plan: … }`.

## What it needs

| Requirement | Why |
|---|---|
| Postgres 16, a database it may **truncate at will** | Every test writes rows and asserts on them |
| Redis | `AppModule` boots the queue module |
| Nothing else | Razorpay, Meta, SES and SSO never leave the machine |

`DATABASE_URL_TEST` is required and deliberately has **no fallback** to
`DATABASE_URL` — the suite truncates whatever it is pointed at.

```bash
# once
sudo -u postgres createuser wa_test --pwprompt
sudo -u postgres createdb wa_console_test -O wa_test

# every run — migrations are applied automatically by the global setup
DATABASE_URL_TEST="postgresql://wa_test:wa_test@127.0.0.1:5432/wa_console_test" \
  npm run test:int
```

`REDIS_URL_TEST` is optional and defaults to `redis://127.0.0.1:6379`.

Run one file, or one test:

```bash
DATABASE_URL_TEST=… npx jest --config test/jest-integration.json --runInBand \
  --testPathPattern billing-payment -t 'add-on'
```

## How it is put together

| File | What it is |
|---|---|
| `harness.ts` | Boots the real `AppModule` with the same bootstrap as `main.ts` — raw-body parser, validation pipe, response interceptor, exception filter. Cron jobs are deleted so nothing sweeps mid-test. Exposes `reset()`, `signIn()`, and the two Razorpay signatures. |
| `fake-razorpay.ts` | A stand-in for Razorpay's REST API over real HTTP, wired in through `RAZORPAY_API_BASE`. Records every request — body, path, basic-auth pair — and lets a test replace one route's answer. |
| `receiver.ts` | A customer's webhook endpoint, over real HTTP. Records the raw bytes, so a signature can be verified the way the docs tell a customer to verify it. |
| `global-setup.ts` | `prisma migrate deploy` once per run. This is also the first real check on every migration in the repository. |

Tests are `*.int-spec.ts` so the unit config (`*.spec.ts`) never picks them up,
and they run `--runInBand`: one database, one truncation between tests.

## What is covered

| File | Tests | Ground it covers |
|---|---|---|
| `billing-payment.int-spec.ts` | 27 | Plan ids applied at boot; the published price list; subscribing on a chosen tier over the service and over HTTP (auth, wrong org, quoted tier); the Checkout signature (forged, genuine, another subscription's); `subscription.charged` over a signed webhook (unsigned and tampered are 401); the ₹199 add-on — quantity, amount, Cloud-API-only counting, none for the included number; the same event delivered three times billing once; an add-on failure not losing the payment; out-of-order events not shortening a paid month; cancelling at cycle end and immediately, and Razorpay refusing; reconciliation |
| `webhook-delivery.int-spec.ts` | 21 | Fan-out by event kind; the envelope and its headers; HMAC over the raw body with a replay-proof timestamp; unsigned when there is no secret and when the secret will not decrypt; a 500 held for the backoff; recovery on a later attempt; giving up after the last try; disabling after ten consecutive give-ups; a disabled endpoint's backlog abandoned; redirects not followed; a transport failure with no status; two sweeps racing delivering once; the test ping |
| `plan-limits.int-spec.ts` | 11 | The tier a subscription actually holds; the cheapest plan as the floor; best tier across an organisation; a cancelled and expired plan stopping; endpoint and account limits counted against real rows |
| `retention.int-spec.ts` | 7 | The raw-SQL sweep: deleting past the window, keeping outstanding work whatever its age, batching, and each organisation's own history window once `PLAN_RETENTION_ENFORCED` is on |

## Adding to it

- Assert on **rows and requests**, not on calls. If the assertion would pass
  with a mock, it belongs in the unit suite.
- Add any new table a test writes to `MUTABLE_TABLES` in `harness.ts`, or the
  next test inherits its rows.
- `Plan` and `PlanFeature` are seeded by a migration and survive `reset()`;
  only the `razorpayPlanId` a deployment configures is restored.
