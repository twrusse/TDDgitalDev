/**
 * PLACEHOLDER ENTITLEMENT STORE
 *
 * TODO: Replace this in-memory map with a database before production.
 * - Persist customers, subscriptions, one-time purchases, and processed event IDs.
 * - Enforce a unique constraint on Stripe event IDs so webhook retries are idempotent
 *   across processes and deploys.
 * - Look up the customer from the authenticated user, not from this process-local map.
 * - This store is wiped on every restart and is not safe for more than one Node process.
 */

const ACCESS_STATUSES = new Set(['active', 'trialing', 'past_due']);

export function subscriptionGrantsAccess(status) {
  return ACCESS_STATUSES.has(status);
}

export function createStore() {
  const processedEventIds = new Set();
  const customers = new Map();
  const emailIndex = new Map();
  const paymentIndex = new Map();

  function blankCustomer(id, email) {
    return {
      id,
      email: email || null,
      suspended: false,
      suspendReason: null,
      subscriptions: new Map(),
      purchases: new Map(),
    };
  }

  function rememberEmail(customer) {
    if (customer.email) {
      emailIndex.set(customer.email, customer.id);
    }
  }

  function indexPayment(customerId, {paymentIntentId, chargeId}) {
    if (paymentIntentId) paymentIndex.set(`pi:${paymentIntentId}`, customerId);
    if (chargeId) paymentIndex.set(`ch:${chargeId}`, customerId);
  }

  return {
    hasProcessedEvent(eventId) {
      return processedEventIds.has(eventId);
    },

    markEventProcessed(eventId) {
      processedEventIds.add(eventId);
    },

    upsertCustomer({id, email}) {
      const normalized = email ? email.toLowerCase() : null;
      let customer = customers.get(id);
      if (!customer) {
        customer = blankCustomer(id, normalized);
        customers.set(id, customer);
      } else if (normalized) {
        customer.email = normalized;
      }
      rememberEmail(customer);
      return customer;
    },

    findCustomerByEmail(email) {
      if (!email) return null;
      const id = emailIndex.get(email.toLowerCase());
      return id ? customers.get(id) || null : null;
    },

    getCustomer(id) {
      return customers.get(id) || null;
    },

    indexPayment(customerId, refs) {
      indexPayment(customerId, refs);
    },

    customerIdForPayment({paymentIntentId, chargeId}) {
      if (paymentIntentId && paymentIndex.has(`pi:${paymentIntentId}`)) {
        return paymentIndex.get(`pi:${paymentIntentId}`);
      }
      if (chargeId && paymentIndex.has(`ch:${chargeId}`)) {
        return paymentIndex.get(`ch:${chargeId}`);
      }
      return null;
    },

    saveSubscription(customerId, subscription) {
      const customer = customers.get(customerId) || this.upsertCustomer({id: customerId});
      const access =
      Boolean(subscription.planKey) &&
      subscriptionGrantsAccess(subscription.status) &&
      !customer.suspended;
      customer.subscriptions.set(subscription.id, {
        id: subscription.id,
        status: subscription.status,
        priceId: subscription.priceId || null,
        planKey: subscription.planKey || null,
        cancelAt: subscription.cancelAt ?? null,
        cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
        billingState: subscription.billingState || 'ok',
        latestInvoiceId: subscription.latestInvoiceId || null,
        access,
      });
      return customer.subscriptions.get(subscription.id);
    },

    grantOneTime(customerId, purchase) {
      const customer = customers.get(customerId) || this.upsertCustomer({id: customerId});
      const existing = customer.purchases.get(purchase.sessionId);
      customer.purchases.set(purchase.sessionId, {
        sessionId: purchase.sessionId,
        priceId: purchase.priceId || existing?.priceId || null,
        planKey: purchase.planKey || existing?.planKey || null,
        paymentIntentId: purchase.paymentIntentId || existing?.paymentIntentId || null,
        access: purchase.access !== false && !customer.suspended,
      });
      if (purchase.paymentIntentId || purchase.chargeId) {
        indexPayment(customerId, purchase);
      }
      return customer.purchases.get(purchase.sessionId);
    },

    revokeOneTimeByPaymentIntent(paymentIntentId) {
      const customerId = this.customerIdForPayment({paymentIntentId});
      if (!customerId) return null;
      const customer = customers.get(customerId);
      if (!customer) return null;
      for (const purchase of customer.purchases.values()) {
        if (purchase.paymentIntentId === paymentIntentId) {
          purchase.access = false;
        }
      }
      return customer;
    },

    markSubscriptionBilling(customerId, subscriptionId, billingState, invoiceId) {
      const customer = customers.get(customerId);
      if (!customer) return null;
      const current = customer.subscriptions.get(subscriptionId);
      if (!current) return null;
      current.billingState = billingState;
      if (invoiceId) current.latestInvoiceId = invoiceId;
      current.access = subscriptionGrantsAccess(current.status) && !customer.suspended;
      return current;
    },

    suspendCustomer(customerId, reason) {
      const customer = customers.get(customerId);
      if (!customer) return null;
      customer.suspended = true;
      customer.suspendReason = reason;
      for (const subscription of customer.subscriptions.values()) {
        subscription.access = false;
      }
      for (const purchase of customer.purchases.values()) {
        purchase.access = false;
      }
      return customer;
    },

    accountView(customerId) {
      const customer = customers.get(customerId);
      if (!customer) return null;
      const subscriptions = [...customer.subscriptions.values()];
      const purchases = [...customer.purchases.values()];
      const active =
        !customer.suspended &&
        (subscriptions.some((item) => item.access) || purchases.some((item) => item.access));
      return {
        customerId: customer.id,
        email: customer.email,
        suspended: customer.suspended,
        suspendReason: customer.suspendReason,
        active,
        subscriptions,
        purchases,
      };
    },
  };
}
