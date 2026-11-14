function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function layout({title, body}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="site-header">
    <a class="brand" href="/">TD Digital Labs</a>
    <p class="brand-note">Application development · tddigitallabs.com</p>
  </header>
  <main>
    ${body}
  </main>
  <footer class="site-footer">
    <p>Payments are processed by Stripe. Access is granted from signed webhooks, not from the success page.</p>
  </footer>
</body>
</html>`;
}

function accountSection(account) {
  if (!account) {
    return `<section class="panel">
      <h2>Your access</h2>
      <p>No confirmed purchase is stored for this browser yet. After Checkout, Stripe notifies this server and the plan shows up here.</p>
    </section>`;
  }

  const subscriptionItems = account.subscriptions
    .map((subscription) => {
      const name = subscription.planKey || subscription.priceId || 'Subscription';
      const cancelNote =
        subscription.cancelAt || subscription.cancelAtPeriodEnd
          ? ' Cancels at the end of the current period.'
          : '';
      const billingNote =
        subscription.billingState === 'payment_failed'
          ? ' Last invoice payment failed. Access stays while Stripe retries the invoice.'
          : '';
      return `<li><strong>${escapeHtml(name)}</strong> — ${escapeHtml(subscription.status)}.${escapeHtml(cancelNote)}${escapeHtml(billingNote)} Access ${subscription.access ? 'on' : 'off'}.</li>`;
    })
    .join('');

  const purchaseItems = account.purchases
    .map(
      (purchase) =>
        `<li><strong>${escapeHtml(purchase.planKey || 'One-time purchase')}</strong>. Access ${purchase.access ? 'on' : 'off'}.</li>`,
    )
    .join('');

  const suspended = account.suspended
    ? `<p class="banner">Access is suspended (${escapeHtml(account.suspendReason || 'review')}).</p>`
    : '';

  return `<section class="panel">
    <h2>Your access</h2>
    ${suspended}
    <p>${account.active ? 'This browser has an active entitlement.' : 'Nothing active is stored for this customer.'} ${account.email ? `Email on file: ${escapeHtml(account.email)}.` : ''}</p>
    ${subscriptionItems ? `<ul>${subscriptionItems}</ul>` : ''}
    ${purchaseItems ? `<ul>${purchaseItems}</ul>` : ''}
  </section>`;
}

function billingForm() {
  return `<form class="inline-form" method="post" action="/billing-portal">
    <button type="submit">Manage billing</button>
  </form>`;
}

export function renderHome({plans, account, error, email}) {
  const cards = plans
    .map(
      (plan) => `<article class="plan">
        <h2>${escapeHtml(plan.name)}</h2>
        <p class="price">${escapeHtml(plan.amountLabel)}</p>
        <p>${escapeHtml(plan.blurb)}</p>
        <p class="cadence">${escapeHtml(plan.cadence)}</p>
        <button type="submit" name="plan" value="${escapeHtml(plan.key)}">${escapeHtml(plan.cta)}</button>
      </article>`,
    )
    .join('');

  const errorBlock = error ? `<p class="banner" role="alert">${escapeHtml(error)}</p>` : '';

  const body = `
    <section class="intro">
      <h1>Plans</h1>
      <p>Subscribe monthly or pay once for a project kickoff. Checkout is hosted by Stripe. This page never sends a price — the server maps each plan to a Price ID.</p>
    </section>
    ${errorBlock}
    <form class="plan-grid" method="post" action="/checkout">
      <label class="email-field">
        Work email
        <input type="email" name="email" required maxlength="254" autocomplete="email" value="${escapeHtml(email || '')}">
      </label>
      <div class="cards">${cards}</div>
    </form>
    <section class="panel actions">
      <h2>Billing</h2>
      <p>Update your payment method, switch between Basic and Pro, or cancel at the end of the period. The portal opens for the customer stored in this browser when Checkout started.</p>
      ${billingForm()}
    </section>
    ${accountSection(account)}
  `;

  return layout({title: 'Plans · TD Digital Labs', body});
}

export function renderSuccess({sessionId, account}) {
  const body = `
    <section class="intro">
      <h1>Payment submitted</h1>
      <p>Stripe is confirming the payment. This page does not unlock anything. Access appears after the webhook is verified and applied.</p>
      ${sessionId ? `<p class="meta">Checkout session <code>${escapeHtml(sessionId)}</code></p>` : ''}
      <p><a href="/">Back to plans</a></p>
      ${billingForm()}
    </section>
    ${accountSection(account)}
  `;
  return layout({title: 'Payment submitted · TD Digital Labs', body});
}

export function renderCancel() {
  const body = `
    <section class="intro">
      <h1>Checkout canceled</h1>
      <p>No payment was taken. You can return to the plans and try again.</p>
      <p><a href="/">Back to plans</a></p>
    </section>
  `;
  return layout({title: 'Checkout canceled · TD Digital Labs', body});
}

export function renderMessage({title, message, statusNote}) {
  const body = `
    <section class="intro">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      ${statusNote ? `<p class="meta">${escapeHtml(statusNote)}</p>` : ''}
      <p><a href="/">Back to plans</a></p>
    </section>
  `;
  return layout({title: `${title} · TD Digital Labs`, body});
}
