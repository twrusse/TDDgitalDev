import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { DEFAULT_PRICE_IDS } from '../src/config.js';
import { handleStripeWebhook, subscriptionIdFromInvoice } from '../src/webhooks.js';
import {
  checkoutEvent,
  freshStore,
  listen,
  signedEvent,
  stripeForTests,
  testConfig,
  testPlans,
  testWebhookSecret,
} from './helpers.js';

function deliver(store, event, {secret = testWebhookSecret(), stripe = stripeForTests()} = {}) {
  const {payload, signature} = signedEvent(stripe, secret, event);
  return {
    payload,
    signature,
    result: handleStripeWebhook({
      rawBody: payload,
      signature,
      stripe,
      webhookSecret: secret,
      store,
      plans: testPlans(),
    }),
  };
}

test('rejects a missing or invalid webhook signature', () => {
  const stripe = stripeForTests();
  const store = freshStore();
  const event = checkoutEvent({});
  const missing = handleStripeWebhook({
    rawBody: JSON.stringify(event),
    signature: undefined,
    stripe,
    webhookSecret: testWebhookSecret(),
    store,
    plans: testPlans(),
  });
  assert.equal(missing.status, 400);

  const {payload} = signedEvent(stripe, testWebhookSecret(), event);
  const tampered = handleStripeWebhook({
    rawBody: payload.replace('paid', 'unpaid'),
    signature: signedEvent(stripe, testWebhookSecret(), event).signature,
    stripe,
    webhookSecret: testWebhookSecret(),
    store,
    plans: testPlans(),
  });
  assert.equal(tampered.status, 400);
  assert.equal(store.accountView('cus_test123'), null);
});

test('refuses to run without a webhook signing secret', () => {
  const result = handleStripeWebhook({
    rawBody: '{}',
    signature: 't=1,v1=abc',
    stripe: stripeForTests(),
    webhookSecret: '',
    store: freshStore(),
    plans: testPlans(),
  });
  assert.equal(result.status, 500);
});

test('provisions a one-time purchase only after payment and ignores duplicates', () => {
  const store = freshStore();
  const event = checkoutEvent({});
  const first = deliver(store, event);
  assert.equal(first.result.status, 200);
  assert.equal(first.result.body.duplicate, undefined);
  const account = store.accountView('cus_test123');
  assert.equal(account.active, true);
  assert.equal(account.purchases.length, 1);
  assert.equal(account.purchases[0].planKey, 'one_time');

  const second = deliver(store, event);
  assert.equal(second.result.body.duplicate, true);
  assert.equal(store.accountView('cus_test123').purchases.length, 1);
});

test('does not provision checkout.session.completed while payment_status is unpaid', () => {
  const store = freshStore();
  const result = deliver(store, checkoutEvent({paymentStatus: 'unpaid'}));
  assert.equal(result.result.status, 200);
  const account = store.accountView('cus_test123');
  assert.equal(account.active, false);
  assert.equal(account.purchases.length, 0);
});

test('provisions a subscription from a paid Checkout Session and a later async success', () => {
  const store = freshStore();
  const unpaid = deliver(store, checkoutEvent({
    id: 'evt_sub_unpaid',
    mode: 'subscription',
    paymentStatus: 'unpaid',
    priceId: DEFAULT_PRICE_IDS.basic,
    subscriptionId: 'sub_123',
    sessionId: 'cs_sub_1',
  }));
  assert.equal(unpaid.result.status, 200);
  assert.equal(store.accountView('cus_test123').active, false);

  const paid = deliver(store, checkoutEvent({
    id: 'evt_sub_async',
    type: 'checkout.session.async_payment_succeeded',
    mode: 'subscription',
    paymentStatus: 'paid',
    priceId: DEFAULT_PRICE_IDS.basic,
    subscriptionId: 'sub_123',
    sessionId: 'cs_sub_1',
  }));
  assert.equal(paid.result.status, 200);
  const account = store.accountView('cus_test123');
  assert.equal(account.active, true);
  assert.equal(account.subscriptions[0].planKey, 'basic');
  assert.equal(account.subscriptions[0].status, 'active');
});

test('ignores checkout sessions whose price is not in the catalog', () => {
  const store = freshStore();
  const result = deliver(store, checkoutEvent({priceId: 'price_from_stripe_trigger'}));
  assert.equal(result.result.status, 200);
  assert.equal(store.accountView('cus_test123').active, false);
});

test('subscription.updated switches plans and deleted revokes access', () => {
  const store = freshStore();
  deliver(store, checkoutEvent({
    mode: 'subscription',
    priceId: DEFAULT_PRICE_IDS.basic,
    subscriptionId: 'sub_123',
  }));

  const upgraded = deliver(store, {
    id: 'evt_sub_updated',
    object: 'event',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_123',
        object: 'subscription',
        customer: 'cus_test123',
        status: 'active',
        cancel_at: null,
        cancel_at_period_end: false,
        items: {data: [{price: {id: DEFAULT_PRICE_IDS.pro}}]},
      },
    },
  });
  assert.equal(upgraded.result.status, 200);
  assert.equal(store.accountView('cus_test123').subscriptions[0].planKey, 'pro');

  const scheduled = deliver(store, {
    id: 'evt_sub_cancel_scheduled',
    object: 'event',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_123',
        object: 'subscription',
        customer: 'cus_test123',
        status: 'active',
        cancel_at: 1893456000,
        cancel_at_period_end: false,
        items: {data: [{price: DEFAULT_PRICE_IDS.pro}]},
      },
    },
  });
  assert.equal(scheduled.result.status, 200);
  const scheduledAccount = store.accountView('cus_test123');
  assert.equal(scheduledAccount.active, true);
  assert.equal(scheduledAccount.subscriptions[0].cancelAtPeriodEnd, true);

  const deleted = deliver(store, {
    id: 'evt_sub_deleted',
    object: 'event',
    type: 'customer.subscription.deleted',
    data: {
      object: {
        id: 'sub_123',
        object: 'subscription',
        customer: 'cus_test123',
        status: 'canceled',
        items: {data: [{price: {id: DEFAULT_PRICE_IDS.pro}}]},
      },
    },
  });
  assert.equal(deleted.result.status, 200);
  const account = store.accountView('cus_test123');
  assert.equal(account.active, false);
  assert.equal(account.subscriptions[0].status, 'canceled');
});

test('invoice.payment_failed keeps access during retries and invoice.paid clears the failure', () => {
  const store = freshStore();
  deliver(store, {
    id: 'evt_sub_created',
    object: 'event',
    type: 'customer.subscription.created',
    data: {
      object: {
        id: 'sub_123',
        object: 'subscription',
        customer: 'cus_test123',
        status: 'active',
        items: {data: [{price: {id: DEFAULT_PRICE_IDS.basic}}]},
      },
    },
  });

  const failed = deliver(store, {
    id: 'evt_invoice_failed',
    object: 'event',
    type: 'invoice.payment_failed',
    data: {
      object: {
        id: 'in_failed',
        object: 'invoice',
        customer: 'cus_test123',
        parent: {subscription_details: {subscription: 'sub_123'}},
      },
    },
  });
  assert.equal(failed.result.status, 200);
  const pastDue = store.accountView('cus_test123');
  assert.equal(pastDue.active, true);
  assert.equal(pastDue.subscriptions[0].status, 'past_due');
  assert.equal(pastDue.subscriptions[0].billingState, 'payment_failed');

  const paid = deliver(store, {
    id: 'evt_invoice_paid',
    object: 'event',
    type: 'invoice.paid',
    data: {
      object: {
        id: 'in_paid',
        object: 'invoice',
        customer: 'cus_test123',
        parent: {type: 'subscription_details', subscription_details: {subscription: 'sub_123'}},
        lines: {data: [{pricing: {price_details: {price: DEFAULT_PRICE_IDS.basic}}}]},
      },
    },
  });
  assert.equal(paid.result.status, 200);
  const restored = store.accountView('cus_test123');
  assert.equal(restored.subscriptions[0].status, 'active');
  assert.equal(restored.subscriptions[0].billingState, 'ok');
  assert.equal(restored.active, true);
});

test('a failed first invoice does not grant access', () => {
  const store = freshStore();
  deliver(store, {
    id: 'evt_first_fail',
    object: 'event',
    type: 'invoice.payment_failed',
    data: {
      object: {
        id: 'in_first',
        object: 'invoice',
        customer: 'cus_new',
        subscription: 'sub_new',
      },
    },
  });
  assert.equal(store.accountView('cus_new').active, false);
});

test('disputes and early fraud warnings suspend access; a full refund revokes a one-time purchase', () => {
  const store = freshStore();
  deliver(store, checkoutEvent({paymentIntentId: 'pi_one'}));
  assert.equal(store.accountView('cus_test123').active, true);

  const warning = deliver(store, {
    id: 'evt_fraud',
    object: 'event',
    type: 'radar.early_fraud_warning.created',
    data: {
      object: {
        id: 'issfr_1',
        object: 'radar.early_fraud_warning',
        payment_intent: 'pi_one',
      },
    },
  });
  assert.equal(warning.result.status, 200);
  assert.equal(store.accountView('cus_test123').active, false);
  assert.equal(store.accountView('cus_test123').suspendReason, 'early_fraud_warning');

  const store2 = freshStore();
  deliver(store2, checkoutEvent({customerId: 'cus_refund', paymentIntentId: 'pi_refund', sessionId: 'cs_refund', id: 'evt_refund_checkout'}));
  deliver(store2, {
    id: 'evt_refund',
    object: 'event',
    type: 'charge.refunded',
    data: {
      object: {
        id: 'ch_refund',
        object: 'charge',
        customer: 'cus_refund',
        payment_intent: 'pi_refund',
        amount: 4900,
        amount_refunded: 4900,
        refunded: true,
      },
    },
  });
  assert.equal(store2.accountView('cus_refund').purchases[0].access, false);
  assert.equal(store2.accountView('cus_refund').active, false);

  const store3 = freshStore();
  deliver(store3, checkoutEvent({
    id: 'evt_dispute_checkout',
    mode: 'subscription',
    customerId: 'cus_dispute',
    subscriptionId: 'sub_dispute',
    priceId: DEFAULT_PRICE_IDS.basic,
    sessionId: 'cs_dispute',
  }));
  deliver(store3, {
    id: 'evt_dispute',
    object: 'event',
    type: 'charge.dispute.created',
    data: {
      object: {
        id: 'dp_1',
        object: 'dispute',
        customer: 'cus_dispute',
        charge: 'ch_dispute',
      },
    },
  });
  assert.equal(store3.accountView('cus_dispute').active, false);
  assert.equal(store3.accountView('cus_dispute').suspendReason, 'dispute_opened');
});

test('reads the subscription id from the current invoice parent shape', () => {
  assert.equal(subscriptionIdFromInvoice({
    parent: {subscription_details: {subscription: 'sub_parent'}},
  }), 'sub_parent');
  assert.equal(subscriptionIdFromInvoice({subscription: 'sub_legacy'}), 'sub_legacy');
  assert.equal(subscriptionIdFromInvoice({
    lines: {data: [{parent: {subscription_item_details: {subscription: 'sub_line'}}}]},
  }), 'sub_line');
});

test('the HTTP webhook route verifies the raw body', async () => {
  const stripe = stripeForTests();
  const store = freshStore();
  const app = createApp({
    config: testConfig(),
    store,
    stripe,
    plans: testPlans(),
  });
  const server = await listen(app);
  try {
    const event = checkoutEvent({id: 'evt_http_1', sessionId: 'cs_http'});
    const {payload, signature} = signedEvent(stripe, testWebhookSecret(), event);
    const response = await fetch(`${server.url}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      body: payload,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.received, true);
    assert.equal(store.accountView('cus_test123').active, true);

    const replay = await fetch(`${server.url}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      body: payload,
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).duplicate, true);

    const bad = await fetch(`${server.url}/webhook`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: payload,
    });
    assert.equal(bad.status, 400);
  } finally {
    await server.close();
  }
});
