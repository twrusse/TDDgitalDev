import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createPlans } from './plans.js';
import { createStore } from './store.js';
import { createStripeClient } from './stripeClient.js';
import { startCheckout } from './checkout.js';
import { startPortalSession } from './portal.js';
import { handleStripeWebhook } from './webhooks.js';
import { customerIdFromRequest, setCustomerCookie } from './cookies.js';
import { renderCancel, renderHome, renderMessage, renderSuccess } from './pages.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "script-src 'self' https://*.stripe.com",
  "style-src 'self'",
  "img-src 'self' data: https://*.stripe.com",
  "font-src 'self'",
  "connect-src 'self' https://api.stripe.com https://*.stripe.com",
  "frame-src https://*.stripe.com https://*.js.stripe.com",
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
].join('; ');

function wantsJson(req) {
  return req.get('accept')?.includes('application/json') || req.get('x-requested-with') === 'fetch';
}

function sendPage(res, status, html) {
  res.status(status).type('html').send(html);
}

export function createApp(options = {}) {
  const config = options.config ?? loadConfig();
  const store = options.store ?? createStore();
  const plans = options.plans ?? createPlans(config.prices);
  let stripeClient = options.stripe ?? null;

  function getStripe() {
    if (stripeClient) return stripeClient;
    if (!config.stripeSecretKey) {
      const error = new Error('Stripe is not configured. Set STRIPE_SECRET_KEY to a restricted key.');
      error.status = 503;
      throw error;
    }
    stripeClient = createStripeClient(config.stripeSecretKey);
    return stripeClient;
  }

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.get('/health', (req, res) => {
    res.json({ok: true});
  });

  // Raw body must be preserved for signature verification. Register this
  // route before the JSON parser so the parser cannot rewrite the payload.
  app.post('/webhook', express.raw({type: 'application/json', limit: '1mb'}), (req, res) => {
    let stripe;
    try {
      // Signature checks do not call the Stripe API. When no key is configured
      // yet, use a non-network client so unsigned requests still fail closed.
      stripe = stripeClient || config.stripeSecretKey
        ? getStripe()
        : createStripeClient(['rk', 'test', 'webhookonly'].join('_'));
    } catch (error) {
      res.status(error.status || 500).json({error: error.message});
      return;
    }
    const result = handleStripeWebhook({
      rawBody: req.body,
      signature: req.get('stripe-signature'),
      stripe,
      webhookSecret: config.webhookSecret,
      store,
      plans,
    });
    res.status(result.status).json(result.body);
  });

  app.use(express.json({limit: '100kb'}));
  app.use(express.urlencoded({extended: false, limit: '100kb'}));
  app.use(express.static(publicDir));

  function currentAccount(req) {
    const customerId = customerIdFromRequest(req, config.stripeSecretKey);
    if (!customerId) return null;
    return store.accountView(customerId);
  }

  app.get('/', (req, res) => {
    sendPage(res, 200, renderHome({
      plans: plans.list(),
      account: currentAccount(req),
      error: null,
      email: null,
    }));
  });

  app.get('/success', (req, res) => {
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : '';
    sendPage(res, 200, renderSuccess({
      sessionId,
      account: currentAccount(req),
    }));
  });

  app.get('/cancel', (req, res) => {
    sendPage(res, 200, renderCancel());
  });

  app.get('/api/account', (req, res) => {
    const customerId = customerIdFromRequest(req, config.stripeSecretKey);
    if (!customerId) {
      res.status(401).json({error: 'No billing customer for this browser'});
      return;
    }
    res.json({account: store.accountView(customerId)});
  });

  app.post('/checkout', async (req, res, next) => {
    try {
      const result = await startCheckout({
        stripe: () => getStripe(),
        store,
        plans,
        email: req.body?.email,
        planKey: req.body?.plan,
        appUrl: config.appUrl,
      });
      setCustomerCookie(res, result.customer.id, config);
      if (wantsJson(req)) {
        res.json({url: result.session.url, id: result.session.id});
        return;
      }
      res.redirect(303, result.session.url);
    } catch (error) {
      if (wantsJson(req) || !error.status || error.status >= 500) {
        next(error);
        return;
      }
      sendPage(res, error.status, renderHome({
        plans: plans.list(),
        account: currentAccount(req),
        error: error.message,
        email: typeof req.body?.email === 'string' ? req.body.email : '',
      }));
    }
  });

  app.post('/billing-portal', async (req, res, next) => {
    try {
      const customerId = customerIdFromRequest(req, config.stripeSecretKey);
      const session = await startPortalSession({
        stripe: () => getStripe(),
        customerId,
        appUrl: config.appUrl,
      });
      if (wantsJson(req)) {
        res.json({url: session.url});
        return;
      }
      res.redirect(303, session.url);
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res) => {
    if (wantsJson(req)) {
      res.status(404).json({error: 'Not found'});
      return;
    }
    sendPage(res, 404, renderMessage({title: 'Not found', message: 'That page is not part of this app.'}));
  });

  app.use((error, req, res, next) => {
    const status = error.status || 500;
    const message = status >= 500 && !error.status
      ? 'Something went wrong.'
      : error.message || 'Request failed';
    if (status >= 500) {
      console.error('[http]', error.message);
    }
    if (wantsJson(req)) {
      res.status(status).json({error: message});
      return;
    }
    sendPage(res, status, renderMessage({
      title: status === 401 ? 'No billing customer' : 'Request failed',
      message,
      statusNote: status === 503 ? 'Add STRIPE_SECRET_KEY and restart the server.' : '',
    }));
  });

  return app;
}
