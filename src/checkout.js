import { INTEGRATION_IDENTIFIERS } from './stripeClient.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 254) return null;
  if (!EMAIL_PATTERN.test(normalized)) return null;
  return normalized;
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const STRIPE_REDIRECT_HOSTS = new Set(['checkout.stripe.com', 'billing.stripe.com']);

export function assertStripeRedirect(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.protocol !== 'https:' || !STRIPE_REDIRECT_HOSTS.has(parsed.hostname)) {
    throw httpError('Stripe returned an unexpected redirect URL.', 502);
  }
  return url;
}

function assertAppUrl(appUrl) {
  let parsed;
  try {
    parsed = new URL(appUrl);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw httpError('APP_URL must be an absolute http(s) URL', 500);
  }
}

/**
 * Create a Stripe Customer (or reuse the one we already stored for this email)
 * and a hosted Checkout Session. Prices come from the server catalog only.
 */
export async function startCheckout({stripe, store, plans, email, planKey, appUrl, now = Date.now()}) {
  const plan = plans.get(planKey);
  if (!plan) {
    throw httpError('Unknown plan. Choose Basic, Pro, or the one-time project start.', 400);
  }
  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw httpError('Enter a valid email address.', 400);
  }
  assertAppUrl(appUrl);

  const client = typeof stripe === 'function' ? stripe() : stripe;

  let customer = store.findCustomerByEmail(normalized);
  if (!customer) {
    const created = await client.customers.create({
      email: normalized,
      metadata: {source: 'td_digital_labs'},
    });
    customer = store.upsertCustomer({id: created.id, email: normalized});
  }

  const params = {
    mode: plan.mode,
    customer: customer.id,
    client_reference_id: customer.id,
    line_items: [{price: plan.priceId, quantity: 1}],
    success_url: `${appUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/cancel`,
    integration_identifier:
      plan.mode === 'subscription'
        ? INTEGRATION_IDENTIFIERS.subscription
        : INTEGRATION_IDENTIFIERS.payment,
    metadata: {
      plan_key: plan.key,
      price_id: plan.priceId,
    },
  };

  if (plan.mode === 'subscription') {
    // Flexible billing is supported on Checkout via subscription_data.billing_mode
    // (API 2025-06-30.basil and later; default for 2025-09-30.clover and later).
    // No trial: the first invoice is collected at Checkout.
    params.subscription_data = {
      billing_mode: {type: 'flexible'},
      metadata: {
        plan_key: plan.key,
        price_id: plan.priceId,
      },
    };
  }

  // automatic_tax is intentionally omitted. Stripe collects no tax until this
  // account has an active registration, and enabling the flag without one
  // looks like tax is on while collecting nothing.

  const bucket = Math.floor(now / 15000);
  const idempotencyKey = `tddl_checkout_${customer.id}_${plan.key}_${bucket}`;
  const session = await client.checkout.sessions.create(params, {idempotencyKey});

  assertStripeRedirect(session.url);

  return {session, customer, plan};
}
