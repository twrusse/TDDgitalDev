import { assertStripeRedirect } from './checkout.js';

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Open the Stripe Customer Portal for a customer this app already knows.
 * Portal features (plan switch, cancel at period end, payment method) are
 * configured in the Dashboard, not in this request.
 */
export async function startPortalSession({stripe, customerId, appUrl}) {
  if (!customerId || !/^cus_[A-Za-z0-9]+$/.test(customerId)) {
    throw httpError(
      'No billing customer is associated with this browser yet. Start Checkout first. Production should look up the customer from the signed-in user.',
      401,
    );
  }

  const client = typeof stripe === 'function' ? stripe() : stripe;
  const session = await client.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${appUrl}/`,
  });

  assertStripeRedirect(session.url);
  return session;
}
