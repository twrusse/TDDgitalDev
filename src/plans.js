/**
 * Server-side catalog. Plan keys from the browser map to Price IDs here.
 * Amounts are display copy only; Stripe charges the Price.
 */
export function createPlans(prices) {
  const plans = [
    {
      key: 'basic',
      name: 'Basic',
      mode: 'subscription',
      priceId: prices.basic,
      amountLabel: '$10/month',
      cadence: 'Billed monthly, pay up front. No trial.',
      blurb: 'A flat monthly plan for one product in active development.',
      cta: 'Subscribe to Basic',
    },
    {
      key: 'pro',
      name: 'Pro',
      mode: 'subscription',
      priceId: prices.pro,
      amountLabel: '$25/month',
      cadence: 'Billed monthly, pay up front. No trial.',
      blurb: 'A flat monthly plan for teams with more than one active build.',
      cta: 'Subscribe to Pro',
    },
    {
      key: 'one_time',
      name: 'Project start',
      mode: 'payment',
      priceId: prices.oneTime,
      amountLabel: '$49',
      cadence: 'One-time payment.',
      blurb: 'A scoped kickoff for a new application.',
      cta: 'Buy project start',
    },
  ];

  const byKey = new Map(plans.map((plan) => [plan.key, plan]));
  const byPrice = new Map(plans.map((plan) => [plan.priceId, plan]));

  return {
    list() {
      return plans;
    },
    get(key) {
      return byKey.get(key) || null;
    },
    forPriceId(priceId) {
      return byPrice.get(priceId) || null;
    },
  };
}
