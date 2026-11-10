/** Documented test-mode Price IDs. Overridable via the environment. */
export const DEFAULT_PRICE_IDS = {
  basic: 'price_1Ua1iTRclY2Jm8PTvaQc59H7',
  pro: 'price_1Ua1iaRclY2Jm8PTE7WRRG23',
  oneTime: 'price_1Ua1icRclY2Jm8PTr7vkKGqe',
};

/**
 * API version shipped as `Stripe.API_VERSION` in stripe@23.1.0.
 * Passed explicitly on the client so requests stay on that version.
 */
export const STRIPE_API_VERSION = '2026-10-28.endive';

export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 4242);
  const appUrl = String(env.APP_URL || `http://localhost:${port}`).replace(/\/$/, '');

  return {
    port: Number.isFinite(port) && port > 0 ? port : 4242,
    appUrl,
    stripeSecretKey: env.STRIPE_SECRET_KEY || '',
    stripePublishableKey: env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    prices: {
      basic: env.STRIPE_PRICE_BASIC || DEFAULT_PRICE_IDS.basic,
      pro: env.STRIPE_PRICE_PRO || DEFAULT_PRICE_IDS.pro,
      oneTime: env.STRIPE_PRICE_ONE_TIME || DEFAULT_PRICE_IDS.oneTime,
    },
  };
}
