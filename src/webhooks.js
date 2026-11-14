/**
 * Fulfillment lives here. The success page must not grant access: customers
 * are not guaranteed to return to it, and delayed payment methods are unpaid
 * when checkout.session.completed first arrives.
 */

const PAID_STATUSES = new Set(['paid', 'no_payment_required']);

export function idOf(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
}

export function subscriptionIdFromInvoice(invoice) {
  const direct = idOf(invoice.subscription);
  if (direct) return direct;
  const fromParent = idOf(invoice.parent?.subscription_details?.subscription);
  if (fromParent) return fromParent;
  for (const line of invoice.lines?.data || []) {
    const fromLine =
      idOf(line.subscription) || idOf(line.parent?.subscription_item_details?.subscription);
    if (fromLine) return fromLine;
  }
  return null;
}

function pushPrice(ids, value) {
  const id = typeof value === 'string' ? value : idOf(value);
  if (id && id.startsWith('price_') && !ids.includes(id)) ids.push(id);
}

export function priceIdsFromInvoice(invoice) {
  const ids = [];
  for (const line of invoice.lines?.data || []) {
    pushPrice(ids, line.price);
    pushPrice(ids, line.pricing?.price_details?.price);
  }
  return ids;
}

export function priceIdsFromSession(session) {
  const ids = [];
  for (const line of session.line_items?.data || []) {
    pushPrice(ids, line.price);
  }
  // Fallback only: this metadata is written by our server when the session is
  // created, then returned on the signed event. Line-item prices win when present.
  pushPrice(ids, session.metadata?.price_id);
  return ids;
}

export function priceIdsFromSubscription(subscription) {
  const ids = [];
  for (const item of subscription.items?.data || []) {
    pushPrice(ids, item.price);
  }
  pushPrice(ids, subscription.metadata?.price_id);
  return ids;
}

function knownPlan(plans, priceIds) {
  for (const priceId of priceIds) {
    const plan = plans.forPriceId(priceId);
    if (plan) return {plan, priceId};
  }
  return {plan: null, priceId: priceIds[0] || null};
}

function customerIdFromObject(object) {
  return idOf(object.customer);
}

function ensureCustomer(store, customerId, email) {
  if (!customerId) return null;
  return store.upsertCustomer({
    id: customerId,
    email: typeof email === 'string' ? email : undefined,
  });
}

function rememberSessionPayments(store, session) {
  const customerId = customerIdFromObject(session);
  if (!customerId) return;
  store.indexPayment(customerId, {
    paymentIntentId: idOf(session.payment_intent),
    chargeId: idOf(session.charge) || idOf(session.latest_charge),
  });
}

function handleCheckoutSession(session, store, plans) {
  const customerId = customerIdFromObject(session);
  const email = session.customer_details?.email || session.customer_email;
  ensureCustomer(store, customerId, email);
  rememberSessionPayments(store, session);

  if (!PAID_STATUSES.has(session.payment_status)) {
    return;
  }
  if (!customerId) return;

  const {plan, priceId} = knownPlan(plans, priceIdsFromSession(session));

  if (session.mode === 'subscription') {
    const subscriptionId = idOf(session.subscription);
    if (!subscriptionId) return;
    const existing = store.getCustomer(customerId)?.subscriptions.get(subscriptionId);
    const preservedStatus =
      existing?.status && !['incomplete', 'incomplete_expired'].includes(existing.status)
        ? existing.status
        : 'active';
    const planKey = plan?.key || existing?.planKey || null;
    store.saveSubscription(customerId, {
      id: subscriptionId,
      status: planKey ? preservedStatus : existing?.status || 'incomplete',
      priceId: plan ? priceId : existing?.priceId || null,
      planKey,
      cancelAt: existing?.cancelAt ?? null,
      cancelAtPeriodEnd: existing?.cancelAtPeriodEnd || false,
      billingState: planKey ? 'ok' : existing?.billingState || 'ok',
    });
    return;
  }

  if (session.mode === 'payment' && session.id && plan) {
    store.grantOneTime(customerId, {
      sessionId: session.id,
      priceId,
      planKey: plan.key,
      paymentIntentId: idOf(session.payment_intent),
      chargeId: idOf(session.charge),
      access: true,
    });
  }
}

function handleCheckoutFailed(session, store) {
  const customerId = customerIdFromObject(session);
  ensureCustomer(store, customerId, session.customer_details?.email || session.customer_email);
  if (!customerId || !session.id) return;
  const customer = store.getCustomer(customerId);
  const purchase = customer?.purchases.get(session.id);
  if (purchase) purchase.access = false;
}

function handleInvoicePaid(invoice, store, plans) {
  const customerId = customerIdFromObject(invoice);
  ensureCustomer(store, customerId, invoice.customer_email);
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (!customerId || !subscriptionId) return;

  const priceIds = priceIdsFromInvoice(invoice);
  const {plan, priceId} = knownPlan(plans, priceIds);
  const existing = store.getCustomer(customerId)?.subscriptions.get(subscriptionId);
  if (!existing && !plan) return;

  let status = existing?.status || 'active';
  if (status === 'past_due' || status === 'incomplete' || status === 'unpaid') {
    status = 'active';
  }

  store.saveSubscription(customerId, {
    id: subscriptionId,
    status,
    priceId: plan ? priceId : existing?.priceId || null,
    planKey: plan?.key || (priceIds.length > 0 ? null : existing?.planKey || null),
    cancelAt: existing?.cancelAt ?? null,
    cancelAtPeriodEnd: existing?.cancelAtPeriodEnd || false,
    billingState: 'ok',
    latestInvoiceId: invoice.id || null,
  });
}

function handleInvoicePaymentFailed(invoice, store) {
  const customerId = customerIdFromObject(invoice);
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (!customerId || !subscriptionId) return;
  ensureCustomer(store, customerId, invoice.customer_email);

  const existing = store.getCustomer(customerId)?.subscriptions.get(subscriptionId);
  if (!existing) {
    // First invoice failed before access existed. Do not grant access.
    store.saveSubscription(customerId, {
      id: subscriptionId,
      status: 'incomplete',
      priceId: null,
      planKey: null,
      billingState: 'payment_failed',
      latestInvoiceId: invoice.id || null,
    });
    return;
  }

  // Renewal failure: Smart Retries keep collecting. Leave access in place
  // while the subscription status still grants it (typically past_due).
  const nextStatus = existing.status === 'active' ? 'past_due' : existing.status;
  store.saveSubscription(customerId, {
    ...existing,
    status: nextStatus,
    billingState: 'payment_failed',
    latestInvoiceId: invoice.id || existing.latestInvoiceId,
  });
}

function handleSubscription(subscription, store, plans) {
  const customerId = customerIdFromObject(subscription);
  if (!customerId || !subscription.id) return;
  ensureCustomer(store, customerId);
  const priceIds = priceIdsFromSubscription(subscription);
  const {plan, priceId} = knownPlan(plans, priceIds);
  const existing = store.getCustomer(customerId)?.subscriptions.get(subscription.id);
  store.saveSubscription(customerId, {
    id: subscription.id,
    status: subscription.status,
    priceId: plan ? priceId : priceIds.length > 0 ? null : existing?.priceId || null,
    planKey: plan?.key || (priceIds.length > 0 ? null : existing?.planKey || null),
    cancelAt: subscription.cancel_at ?? null,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end) || subscription.cancel_at != null,
    billingState: existing?.billingState || 'ok',
    latestInvoiceId: idOf(subscription.latest_invoice) || existing?.latestInvoiceId || null,
  });
}

function resolveRiskCustomerId(object, store) {
  const direct = customerIdFromObject(object);
  if (direct) return direct;
  return store.customerIdForPayment({
    paymentIntentId: idOf(object.payment_intent),
    chargeId: idOf(object.charge) || (object.object === 'charge' ? object.id : null),
  });
}

function handleDispute(dispute, store) {
  const customerId = resolveRiskCustomerId(dispute, store);
  if (!customerId) return;
  store.suspendCustomer(customerId, 'dispute_opened');
}

function handleFraudWarning(warning, store) {
  const customerId = resolveRiskCustomerId(warning, store);
  if (!customerId) return;
  store.suspendCustomer(customerId, 'early_fraud_warning');
}

function handleRefund(charge, store) {
  const fullyRefunded = charge.refunded === true || (charge.amount > 0 && charge.amount_refunded >= charge.amount);
  if (!fullyRefunded) return;
  const paymentIntentId = idOf(charge.payment_intent);
  if (paymentIntentId) {
    store.revokeOneTimeByPaymentIntent(paymentIntentId);
  }
  const customerId = resolveRiskCustomerId(charge, store);
  if (customerId && paymentIntentId) {
    store.indexPayment(customerId, {paymentIntentId, chargeId: charge.id});
  }
}

function applyEvent(event, store, plans) {
  const object = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      handleCheckoutSession(object, store, plans);
      break;
    case 'checkout.session.async_payment_failed':
      handleCheckoutFailed(object, store);
      break;
    case 'invoice.paid':
      handleInvoicePaid(object, store, plans);
      break;
    case 'invoice.payment_failed':
      handleInvoicePaymentFailed(object, store);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      handleSubscription(object, store, plans);
      break;
    case 'customer.subscription.deleted':
      handleSubscription({...object, status: 'canceled'}, store, plans);
      break;
    case 'charge.dispute.created':
      handleDispute(object, store);
      break;
    case 'charge.refunded':
      handleRefund(object, store);
      break;
    case 'radar.early_fraud_warning.created':
      handleFraudWarning(object, store);
      break;
    default:
      break;
  }
}

export function handleStripeWebhook({rawBody, signature, stripe, webhookSecret, store, plans}) {
  if (!webhookSecret) {
    return {status: 500, body: {error: 'Webhook signing secret is not configured'}};
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    console.error('[webhook] signature verification failed', error.message);
    return {status: 400, body: {error: 'Invalid webhook signature'}};
  }

  if (store.hasProcessedEvent(event.id)) {
    return {status: 200, body: {received: true, duplicate: true}};
  }

  try {
    applyEvent(event, store, plans);
    store.markEventProcessed(event.id);
  } catch (error) {
    console.error('[webhook] handler failed', event.id, event.type, error.message);
    return {status: 500, body: {error: 'Webhook handler failed'}};
  }

  console.info('[webhook] processed', event.id, event.type);
  return {status: 200, body: {received: true}};
}
