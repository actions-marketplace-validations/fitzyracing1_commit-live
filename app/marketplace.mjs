// GitHub Marketplace plan events. commit-live light has one free plan, so nothing is gated: log and acknowledge.
export const MARKETPLACE_ACTIONS = ['purchased', 'changed', 'cancelled', 'pending_change', 'pending_change_cancelled'];

export function marketplaceEvent(payload) {
  const p = payload?.marketplace_purchase ?? {};
  const account = p.account ?? {};
  const plan = p.plan ?? {};
  const known = MARKETPLACE_ACTIONS.includes(payload?.action);
  return {
    known,
    action: payload?.action ?? null,
    account: account.login ?? null,
    accountType: account.type ?? null,
    accountId: account.id ?? null,
    plan: plan.name ?? null,
    planId: plan.id ?? null,
    priceModel: plan.price_model ?? null,
    effectiveDate: payload?.effective_date ?? null,
    previousPlan: payload?.previous_marketplace_purchase?.plan?.name ?? null,
  };
}

export function marketplaceLogLine(m) {
  const from = m.previousPlan && m.previousPlan !== m.plan ? ` (was ${m.previousPlan})` : '';
  return `marketplace_purchase.${m.action}${m.known ? '' : ' (unknown action)'}: ${m.accountType ?? 'account'} ${m.account} (${m.accountId}) plan ${m.plan} (${m.planId}, ${m.priceModel})${from} effective ${m.effectiveDate}`;
}
