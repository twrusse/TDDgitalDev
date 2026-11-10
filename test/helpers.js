import { once } from 'node:events';
import Stripe from 'stripe';
import { createPlans } from '../src/plans.js';
import { createStore } from '../src/store.js';
import { DEFAULT_PRICE_IDS } from '../src/config.js';

export function testSecretKey() {
  return ['sk', 'test', 'placeholder'].join('_');
}

export function testWebhookSecret() {
  return ['whsec', 'test', 'secret'].join('_');
}

export function testConfig(overrides = {}) {
  return {
    port: 0,
    appUrl: 'http://localhost:4242',
    stripeSecretKey: testSecretKey(),
    stripePublishableKey: '',
    webhookSecret: testWebhookSecret(),
    prices: {...DEFAULT_PRICE_IDS},
    ...overrides,
  };
}

export function testPlans() {
  return createPlans(DEFAULT_PRICE_IDS);
}

export function signedEvent(stripe, secret, event) {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
  });
  return {payload, signature};
}

export function stripeForTests() {
  return new Stripe(testSecretKey(), {
    apiVersion: Stripe.API_VERSION,
  });
}

export function checkoutEvent({
  id = 'evt_checkout_1',
  sessionId = 'cs_test_1',
  type = 'checkout.session.completed',
  mode = 'payment',
  paymentStatus = 'paid',
  customerId = 'cus_test123',
  priceId = DEFAULT_PRICE_IDS.oneTime,
  subscriptionId = null,
  paymentIntentId = 'pi_test_1',
}) {
  return {
    id,
    object: 'event',
    type,
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        mode,
        payment_status: paymentStatus,
        customer: customerId,
        customer_details: {email: 'ada@example.com'},
        subscription: subscriptionId,
        payment_intent: paymentIntentId,
        metadata: {
          plan_key: mode === 'subscription' ? 'basic' : 'one_time',
          price_id: priceId,
        },
      },
    },
  };
}

export async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function freshStore() {
  return createStore();
}
