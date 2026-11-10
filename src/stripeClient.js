import Stripe from 'stripe';
import { STRIPE_API_VERSION } from './config.js';

/**
 * Instantiate a client. The Node SDK class is `Stripe` (it constructs the
 * internal client). Do not set a global API key.
 */
export function createStripeClient(secretKey) {
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }
  if (STRIPE_API_VERSION !== Stripe.API_VERSION) {
    throw new Error(
      `Stripe SDK default API version is ${Stripe.API_VERSION}, but this app pins ${STRIPE_API_VERSION}. Update the pin together with the stripe package.`,
    );
  }

  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    appInfo: {
      name: 'TD Digital Labs',
      version: '1.0.0',
      url: 'https://tddigitallabs.com',
    },
  });
}

/**
 * Stable labels for Dashboard checkout comparisons.
 * Each label ends with 8 random letters, per Stripe's integration_identifier guidance.
 */
export const INTEGRATION_IDENTIFIERS = {
  payment: 'tddl_hosted_checkout_payment_kqmzrwbn',
  subscription: 'tddl_hosted_checkout_subscription_vxplntdh',
};
