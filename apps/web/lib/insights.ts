import type { DashboardSummary } from './types';

/**
 * Plain-language highlights built by code from backend aggregates. Every number is quoted
 * from the API's pre-formatted figures — nothing is estimated, added up here, or written by AI.
 */
export function buildInsights(s: DashboardSummary): string[] {
  const insights: string[] = [];
  const one = <T extends { formatted: string }>(list: T[]) =>
    list.length === 1 ? list[0] : undefined;

  const revenue = one(s.revenue);
  if (revenue) {
    const week = one(s.revenueThisWeek);
    insights.push(
      `${s.counts.paidOrders} paid order${s.counts.paidOrders === 1 ? '' : 's'} so far, ${revenue.formatted} received${week ? ` (${week.formatted} this week)` : ''}.`,
    );
  }
  const top = s.topProducts[0];
  if (top && s.topProducts.length > 1) {
    insights.push(
      `${top.name} is your best seller: ${top.sharePercent}% of product revenue (${top.formatted}).`,
    );
  } else if (top) {
    insights.push(`${top.name} accounts for all product revenue so far (${top.formatted}).`);
  }
  const voice = s.bySource.filter((x) => x.name.endsWith('voice'));
  if (voice.length === 1 && voice[0]) {
    insights.push(
      `Voice notes brought in ${voice[0].formatted} across ${voice[0].orders} paid order${voice[0].orders === 1 ? '' : 's'}.`,
    );
  }
  const customer = s.topCustomers[0];
  if (customer) insights.push(`${customer.name} is your top customer (${customer.formatted}).`);
  const outstanding = one(s.outstanding);
  if (outstanding && s.counts.awaitingPayment > 0) {
    insights.push(
      `${outstanding.formatted} is still outstanding across ${s.counts.awaitingPayment} order${s.counts.awaitingPayment === 1 ? '' : 's'} awaiting payment.`,
    );
  }
  if (s.operations.awaitingShipment > 0) {
    insights.push(
      `${s.operations.awaitingShipment} paid order${s.operations.awaitingShipment === 1 ? ' is' : 's are'} waiting for shipping and tracking.`,
    );
  }
  if (s.operations.needsResponse > 0) {
    insights.push(
      `${s.operations.needsResponse} PayPal dispute${s.operations.needsResponse === 1 ? ' needs' : 's need'} your response.`,
    );
  }
  return insights;
}
