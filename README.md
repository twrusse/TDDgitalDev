# TD Digital Labs

Application development for [tddigitallabs.com](https://tddigitallabs.com). This service hosts a small pricing page and a Stripe Billing integration:

- Stripe-hosted Checkout for the Basic and Pro monthly plans (`mode=subscription`) and a one-time project-start purchase (`mode=payment`)
- The Stripe Customer Portal for plan changes, cancellation at period end, and payment method updates
- A signed webhook that provisions and revokes access

Prices are chosen on the server. The browser sends a plan key (`basic`, `pro`, or `one_time`), and the server maps that key to a Stripe Price ID.

## Stack

Node.js 20+ and Express. There was no application in this repo before this integration, so the server lives in `src/`. Entitlements are kept in an in-memory placeholder (`src/store.js`). Replace that store with a database before production; it is wiped on restart and is not safe for more than one process.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the environment template and fill in secrets from a [Stripe sandbox](https://docs.stripe.com/sandboxes) or, for this existing catalog, the account’s test mode:

   ```bash
   cp .env.example .env
   ```

3. Start the app (default port **4242**):

   ```bash
   npm start
   ```

   Open [http://localhost:4242](http://localhost:4242).

`.env` is gitignored. Do not commit API keys or webhook secrets. `npm test` runs a scanner that fails if a secret key or webhook secret is present in the tree. To run that check on every commit:

```bash
git config core.hooksPath .githooks
```

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Yes, for Checkout and the portal | Restricted API key (`rk_…`) preferred. A secret key (`sk_…`) also works. The SDK reads this variable only; it is never sent to the browser. |
| `STRIPE_WEBHOOK_SECRET` | Yes, for webhooks | Signing secret (`whsec_…`) from `stripe listen` or the Dashboard destination. |
| `STRIPE_PUBLISHABLE_KEY` | No | Unused by hosted Checkout. Reserved for a future embedded Payment Element. |
| `APP_URL` | No | Public base URL used for success, cancel, and portal return URLs. Defaults to `http://localhost:4242`. |
| `PORT` | No | Defaults to `4242`. |
| `STRIPE_PRICE_BASIC` | No | Basic plan Price ID. Defaults to the test-mode price below. |
| `STRIPE_PRICE_PRO` | No | Pro plan Price ID. Defaults to the test-mode price below. |
| `STRIPE_PRICE_ONE_TIME` | No | One-time Price ID. Defaults to the test-mode price below. |

Documented test-mode defaults (already created):

- Basic, $10/month: `price_1Ua1iTRclY2Jm8PTvaQc59H7`
- Pro, $25/month: `price_1Ua1iaRclY2Jm8PTE7WRRG23`
- Project start, $49 once: `price_1Ua1icRclY2Jm8PTr7vkKGqe`

Use a [restricted API key](https://docs.stripe.com/keys.md#manage-your-api-keys) with only the permissions this server needs: Checkout Sessions write, Customers write, and Customer portal write. Keep a separate key for local development and for live mode. Store live keys in the platform’s secrets vault (AWS Secrets Manager, Google Secret Manager, Azure Key Vault, or the host’s equivalent). This app falls back to environment variables because it does not ship with a vault.

The Node SDK is pinned to `stripe@23.1.0`, and requests send that package’s default API version, `2026-10-28.endive`.

## What the app does

- `POST /checkout` creates a Customer (reused by email while the process is running) and a Checkout Session, then redirects to Stripe. Subscriptions are pay-up-front with no trial, and `subscription_data.billing_mode.type` is `flexible`.
- `POST /billing-portal` opens the Customer Portal for the customer stored in a signed, HttpOnly cookie set when Checkout starts. There is no login system yet. Production must look up the Stripe Customer from the authenticated user instead of this cookie.
- `POST /webhook` verifies `Stripe-Signature` against the raw body and `STRIPE_WEBHOOK_SECRET`, then updates access. Handled events:
  - `checkout.session.completed` and `checkout.session.async_payment_succeeded` (fulfill only when `payment_status` is `paid` or `no_payment_required`)
  - `checkout.session.async_payment_failed`
  - `invoice.paid`
  - `invoice.payment_failed` (renewal failures stay entitled while Smart Retries run; a failed first invoice does not grant access)
  - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.paused`, `customer.subscription.resumed`, `customer.subscription.deleted`
  - `charge.dispute.created`, `charge.refunded`, `radar.early_fraud_warning.created`
- Event IDs are recorded so retries are idempotent. The success page does not grant access.

`payment_method_types` is not set, so Checkout uses dynamic payment methods from the Dashboard.

Customer Portal behavior (switch Basic/Pro, cancel at period end, update the payment method) is configured in the Dashboard, not in code. In test mode open [Customer portal settings](https://dashboard.stripe.com/test/settings/billing/portal) and enable:

- Invoice history
- Customer payment method update
- Subscription update, with the Basic and Pro products allowed
- Subscription cancellation at the end of the billing period

For flexible billing mode, a scheduled cancellation is `cancel_at` set to the period end. The app treats that the same as `cancel_at_period_end` and keeps access until `customer.subscription.deleted`.

## Local webhook testing

Install the [Stripe CLI](https://docs.stripe.com/stripe-cli) and log in to the same account that owns the test prices. In one terminal, run the app. In another:

```bash
stripe listen --forward-to localhost:4242/webhook
```

Copy the `whsec_…` value the CLI prints into `STRIPE_WEBHOOK_SECRET` and restart the app. Then trigger a fixture event:

```bash
stripe trigger checkout.session.completed
```

`stripe trigger` builds its own test objects, so the fixture price will not match this catalog and no entitlement is granted. That still proves the endpoint verifies the signature and returns 200. To exercise provisioning, complete Checkout in the browser with a test card. The home page shows access after the webhook arrives.

Forward these event types if you configure the listener explicitly: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.paused`, `customer.subscription.resumed`, `customer.subscription.deleted`, `charge.dispute.created`, `charge.refunded`, `radar.early_fraud_warning.created`.

### Test cards

Use these only in test mode, with any future expiry, any CVC, and any postal code:

| Card | Result |
| --- | --- |
| `4242 4242 4242 4242` | Payment succeeds |
| `4000 0025 0000 3155` | 3D Secure authentication required |
| `4000 0000 0000 9995` | Card declined |

More scenarios are in [Testing Stripe](https://docs.stripe.com/testing).

## Tests

```bash
npm test
```

The suite covers signature verification (including the raw-body HTTP route), idempotent fulfillment, unpaid Checkout, subscription upgrades and cancellation, invoice payment failure and recovery, disputes, refunds, and the rule that browser-supplied prices are ignored.

## Dashboard settings that are not code

**Smart Retries / revenue recovery.** Turn on [Smart Retries](https://docs.stripe.com/billing/revenue-recovery/smart-retries) in the Dashboard under Billing → Revenue recovery. Stripe retries failed renewal invoices on its own. This app keeps access while a subscription is `past_due` so a retry can succeed, and removes it when the subscription is deleted, unpaid, or canceled. Do not build a custom retry loop.

**Tax and threshold monitoring.** `automatic_tax` is off. Enabling it without an active tax registration makes Stripe collect no tax and return no error. If you will charge customers in the US or the EU, set up [Stripe Tax for recurring payments](https://docs.stripe.com/billing/taxes/collect-taxes) with your tax advisor: head office address, an active registration in each jurisdiction where you are obligated to collect, and a product tax code chosen from the [tax code list](https://docs.stripe.com/tax/tax-codes). Threshold monitoring lives in Dashboard → Tax → Locations → Needs attention. It watches live charges only, and it is a signal to review with your advisor, not an instruction to register. Sandbox payments do not move those thresholds.

## Going live

- Create live-mode Products and Prices (one Product per plan) and set `STRIPE_PRICE_BASIC`, `STRIPE_PRICE_PRO`, and `STRIPE_PRICE_ONE_TIME` to those live Price IDs.
- Create a live restricted API key and a live webhook destination aimed at `https://<your-domain>/webhook`. Put the live signing secret in `STRIPE_WEBHOOK_SECRET`. Select the API version `2026-10-28.endive` for a snapshot destination so it matches the SDK.
- Serve the app over HTTPS. Stripe will not deliver live webhooks to plain HTTP. Set `APP_URL` to that public origin.
- Repeat the Customer Portal configuration in live mode.
- Confirm Smart Retries and, if you collect tax, live-mode Tax Settings and registrations. Registrations added in a sandbox do not carry over.
- Replace `src/store.js` with a database and replace the billing cookie with your authentication system.
- Allowlist [Stripe webhook IPs](https://docs.stripe.com/ips) on the webhook path.
- Use separate keys per environment, restrict each key with an access policy, and prefer passkeys or an authenticator app for Dashboard access.
- Run a live payment for a small amount, confirm `checkout.session.completed` updates your database, then refund it.

Checklist reference: [Go-live checklist](https://docs.stripe.com/get-started/checklist/go-live).

The Price IDs in `.env.example` were created in the shared test mode. New work that does not depend on those IDs should use a separate sandbox so test data stays isolated from other projects. Recreate the three Prices in that sandbox and point the env vars at them.
