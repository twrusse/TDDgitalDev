import assert from 'node:assert/strict';
import test from 'node:test';
import { startCheckout } from '../src/checkout.js';
import { createStripeClient, INTEGRATION_IDENTIFIERS } from '../src/stripeClient.js';
import { STRIPE_API_VERSION } from '../src/config.js';
import Stripe from 'stripe';
import { createApp } from '../src/app.js';
import { DEFAULT_PRICE_IDS } from '../src/config.js';
import { freshStore, listen, testConfig, testPlans, testSecretKey } from './helpers.js';

function mockStripe(sessionUrl = 'https://checkout.stripe.com/c/pay/cs_test_123') {
  const calls = [];
  return {
    calls,
    customers: {
      async create({email}) {
        return {id: 'cus_created123', email};
      },
    },
    checkout: {
      sessions: {
        async create(params, options) {
          calls.push({params, options});
          return {id: 'cs_test_123', url: sessionUrl};
        },
      },
    },
  };
}

test('the pinned API version is the SDK default', () => {
  assert.equal(STRIPE_API_VERSION, Stripe.API_VERSION);
  assert.equal(STRIPE_API_VERSION, '2026-10-28.endive');
  const client = createStripeClient(testSecretKey());
  assert.equal(client.getApiField('version'), STRIPE_API_VERSION);
});

test('subscription checkout uses the server price, flexible billing, and no trial', async () => {
  const stripe = mockStripe();
  const store = freshStore();
  const result = await startCheckout({
    stripe,
    store,
    plans: testPlans(),
    email: 'Ada@Example.com',
    planKey: 'basic',
    appUrl: 'http://localhost:4242',
    now: 1_700_000_000_000,
  });

  assert.equal(result.customer.id, 'cus_created123');
  assert.equal(stripe.calls.length, 1);
  const {params, options} = stripe.calls[0];
  assert.equal(params.mode, 'subscription');
  assert.equal(params.line_items[0].price, DEFAULT_PRICE_IDS.basic);
  assert.equal(params.line_items[0].quantity, 1);
  assert.equal(params.payment_method_types, undefined);
  assert.equal(params.subscription_data.trial_period_days, undefined);
  assert.equal(params.subscription_data.trial_end, undefined);
  assert.deepEqual(params.subscription_data.billing_mode, {type: 'flexible'});
  assert.equal(params.integration_identifier, INTEGRATION_IDENTIFIERS.subscription);
  assert.match(params.integration_identifier, /[a-z]{8}$/);
  assert.equal(params.automatic_tax, undefined);
  assert.equal(options.idempotencyKey, 'tddl_checkout_cus_created123_basic_113333333');
  assert.equal(result.session.url, 'https://checkout.stripe.com/c/pay/cs_test_123');
});

test('one-time checkout does not send subscription billing mode', async () => {
  const stripe = mockStripe();
  await startCheckout({
    stripe,
    store: freshStore(),
    plans: testPlans(),
    email: 'ada@example.com',
    planKey: 'one_time',
    appUrl: 'http://localhost:4242',
  });
  const {params} = stripe.calls[0];
  assert.equal(params.mode, 'payment');
  assert.equal(params.line_items[0].price, DEFAULT_PRICE_IDS.oneTime);
  assert.equal(params.subscription_data, undefined);
  assert.equal(params.integration_identifier, INTEGRATION_IDENTIFIERS.payment);
  assert.equal(params.payment_method_types, undefined);
});

test('a client-supplied price is ignored by the HTTP checkout route', async () => {
  const stripe = mockStripe();
  const app = createApp({
    config: testConfig(),
    store: freshStore(),
    stripe,
    plans: testPlans(),
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.url}/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        plan: 'pro',
        email: 'buyer@example.com',
        price: 'price_sent_by_the_browser',
        amount: 1,
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.url, 'https://checkout.stripe.com/c/pay/cs_test_123');
    assert.equal(stripe.calls[0].params.line_items[0].price, DEFAULT_PRICE_IDS.pro);
    assert.equal(JSON.stringify(stripe.calls[0].params).includes('price_sent_by_the_browser'), false);
  } finally {
    await server.close();
  }
});

test('unknown plans and unexpected Stripe URLs are rejected', async () => {
  const store = freshStore();
  await assert.rejects(
    () => startCheckout({
      stripe: mockStripe(),
      store,
      plans: testPlans(),
      email: 'ada@example.com',
      planKey: 'enterprise',
      appUrl: 'http://localhost:4242',
    }),
    (error) => error.status === 400,
  );

  await assert.rejects(
    () => startCheckout({
      stripe: mockStripe('https://evil.example/phish'),
      store: freshStore(),
      plans: testPlans(),
      email: 'ada@example.com',
      planKey: 'basic',
      appUrl: 'http://localhost:4242',
    }),
    (error) => error.status === 502,
  );
});
