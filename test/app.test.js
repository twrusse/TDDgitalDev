import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { signCustomerId } from '../src/cookies.js';
import { freshStore, listen, testConfig, testPlans, testSecretKey } from './helpers.js';

function stripeWithPortal() {
  const portalCalls = [];
  return {
    portalCalls,
    customers: {
      async create({email}) {
        return {id: 'cus_portal123', email};
      },
    },
    checkout: {
      sessions: {
        async create() {
          return {id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123'};
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          portalCalls.push(params);
          return {url: 'https://billing.stripe.com/p/session/test_123'};
        },
      },
    },
  };
}

test('pricing, success, and cancel pages render the catalog and billing action', async () => {
  const app = createApp({config: testConfig(), store: freshStore(), plans: testPlans()});
  const server = await listen(app);
  try {
    const home = await fetch(`${server.url}/`);
    const html = await home.text();
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(html, /Basic/);
    assert.match(html, /Pro/);
    assert.match(html, /Project start/);
    assert.match(html, /Manage billing/);
    assert.match(html, /\$10\/month/);
    assert.match(html, /\$25\/month/);
    assert.match(html, /\$49/);
    assert.equal(html.includes(testPlans().get('basic').priceId), false);

    const success = await fetch(`${server.url}/success?session_id=%3Cscript%3E`);
    const successHtml = await success.text();
    assert.match(successHtml, /does not unlock/);
    assert.match(successHtml, /&lt;script&gt;/);
    assert.equal(successHtml.includes('<script>'), false);

    const cancel = await fetch(`${server.url}/cancel`);
    assert.match(await cancel.text(), /Checkout canceled/);

    const health = await fetch(`${server.url}/health`);
    assert.deepEqual(await health.json(), {ok: true});

    const css = await fetch(`${server.url}/styles.css`);
    assert.equal(css.status, 200);
  } finally {
    await server.close();
  }
});

test('manage billing opens a portal session for the signed customer cookie', async () => {
  const stripe = stripeWithPortal();
  const config = testConfig();
  const app = createApp({config, store: freshStore(), stripe, plans: testPlans()});
  const server = await listen(app);
  try {
    const missing = await fetch(`${server.url}/billing-portal`, {method: 'POST'});
    assert.equal(missing.status, 401);

    const checkout = await fetch(`${server.url}/checkout`, {
      method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: 'plan=basic&email=ada%40example.com',
      redirect: 'manual',
    });
    assert.equal(checkout.status, 303);
    assert.equal(checkout.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_test_123');
    const cookie = checkout.headers.get('set-cookie');
    assert.match(cookie, /tddl_customer=/);
    assert.match(cookie, /HttpOnly/);

    const portal = await fetch(`${server.url}/billing-portal`, {
      method: 'POST',
      headers: {cookie, accept: 'application/json'},
    });
    assert.equal(portal.status, 200);
    assert.deepEqual(await portal.json(), {url: 'https://billing.stripe.com/p/session/test_123'});
    assert.equal(stripe.portalCalls[0].customer, 'cus_portal123');
    assert.equal(stripe.portalCalls[0].return_url, 'http://localhost:4242/');

    const forged = signCustomerId('cus_someoneelse', 'other-secret');
    const rejected = await fetch(`${server.url}/billing-portal`, {
      method: 'POST',
      headers: {
        cookie: `tddl_customer=${encodeURIComponent(forged)}`,
        accept: 'application/json',
      },
    });
    assert.equal(rejected.status, 401);
    assert.equal(signCustomerId('cus_portal123', testSecretKey()).startsWith('cus_portal123.'), true);
  } finally {
    await server.close();
  }
});

test('portal and webhooks fail clearly when Stripe is not configured', async () => {
  const app = createApp({
    config: testConfig({stripeSecretKey: ''}),
    store: freshStore(),
    plans: testPlans(),
  });
  const server = await listen(app);
  try {
    const portal = await fetch(`${server.url}/billing-portal`, {
      method: 'POST',
      headers: {accept: 'application/json'},
    });
    assert.equal(portal.status, 401);

    const unsigned = await fetch(`${server.url}/webhook`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{}',
    });
    assert.equal(unsigned.status, 400);
  } finally {
    await server.close();
  }
});

test('checkout reports a clear error when Stripe is not configured', async () => {
  const app = createApp({
    config: testConfig({stripeSecretKey: ''}),
    store: freshStore(),
    plans: testPlans(),
  });
  const server = await listen(app);
  try {
    const invalid = await fetch(`${server.url}/checkout`, {
      method: 'POST',
      headers: {'content-type': 'application/json', accept: 'application/json'},
      body: JSON.stringify({plan: 'basic', email: 'not-an-email'}),
    });
    assert.equal(invalid.status, 400);

    const response = await fetch(`${server.url}/checkout`, {
      method: 'POST',
      headers: {'content-type': 'application/json', accept: 'application/json'},
      body: JSON.stringify({plan: 'basic', email: 'ada@example.com'}),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.error, /STRIPE_SECRET_KEY/);
  } finally {
    await server.close();
  }
});
