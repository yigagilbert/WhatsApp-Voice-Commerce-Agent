import { formatMoney, type AnalyticsService, type InventoryService } from '@vca/commerce';
import type { Database, Merchant, ReportSchedule } from '@vca/database';
import type { OutboundMedia } from '@vca/shared';
import type { DisputeService } from '../disputes/dispute.service';
import { reasonLabel } from '../disputes/dispute.service';
import type { PaymentReconciler, ReconciliationResult } from '../payments/reconciliation.service';
import type { ReportService } from './report.service';

export type ReportSections = Pick<
  ReportSchedule,
  | 'includeSales'
  | 'includeInventory'
  | 'includeUnpaid'
  | 'includeDisputes'
  | 'includeChart'
  | 'includeInsights'
>;

export interface BusinessReport {
  text: string;
  chart: { media: OutboundMedia; caption: string } | null;
  /** The numbers the report is built from (kept for tests and audit). */
  facts: {
    yesterday: { revenue: string[]; paidOrders: number; changePercent: number | null };
    week: { revenue: string[]; paidOrders: number; topProduct: string | null };
    /** Monthly reports only: the previous calendar month. */
    month?: {
      revenue: string[];
      paidOrders: number;
      changePercent: number | null;
      topProduct: string | null;
    };
    lowStock: { name: string; stock: number | null; reorderLevel: number | null; status: string }[];
    unpaid: { count: number; total: string[]; oldestDays: number | null };
    disputes: { open: number; needsResponse: number };
    /** PayPal cross-check done just before the report (null when PayPal isn't configured). */
    reconciliation: Pick<
      ReconciliationResult,
      'checked' | 'recovered' | 'expired' | 'mismatches'
    > | null;
  };
}

const DAY = 86_400_000;
const STALE_LINK_DAYS = 2;

/**
 * The proactive business report: yesterday's sales, the last 7 days, inventory alerts, unpaid
 * PayPal links, open disputes, a 7-day revenue chart and a few rule-based recommendations.
 * Every figure comes from Katale's records; the insights are deterministic rules, not AI text.
 */
export class BusinessReportBuilder {
  constructor(
    private readonly db: Database,
    private readonly analytics: AnalyticsService,
    private readonly inventory: InventoryService,
    private readonly disputes: DisputeService,
    private readonly charts: ReportService,
    private readonly reconciler?: PaymentReconciler,
  ) {}

  async build(
    merchant: Pick<Merchant, 'id' | 'businessName' | 'timezone' | 'preferredCurrency'>,
    options: {
      title: string;
      sections: ReportSections;
      timeZone?: string | null;
      /** Monthly report: last calendar month vs the month before, and a 30-day chart. */
      monthly?: boolean;
    },
    now = new Date(),
  ): Promise<BusinessReport> {
    const tz = options.timeZone ?? merchant.timezone;
    const m = { ...merchant, timezone: tz };
    const s = options.sections;
    const day = (d: Date, opts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz }).format(d);

    // Check open links with PayPal first, so payments that arrived without a webhook are
    // counted as sales (not as unpaid links) in this report.
    const check =
      s.includeUnpaid && this.reconciler ? await this.reconciler.reconcile(merchant.id, now) : null;
    const monthly = !!options.monthly;
    const [yesterday, week, stock, unpaidPayments, openDisputes, month, monthSummary] =
      await Promise.all([
        this.analytics.compareSales(m, 'yesterday', now),
        this.analytics.salesSummary(m, 'last_7_days', now),
        this.inventory.report(merchant.id, now),
        this.db.payment.findMany({
          where: {
            merchantId: merchant.id,
            status: { in: ['CREATED', 'APPROVED'] },
            order: { status: 'AWAITING_PAYMENT' },
          },
          include: { order: { select: { reference: true, customer: { select: { name: true } } } } },
          orderBy: { createdAt: 'asc' },
          take: 200,
        }),
        this.disputes.list(merchant.id, 'open'),
        monthly ? this.analytics.compareSales(m, 'last_month', now) : null,
        monthly ? this.analytics.salesSummary(m, 'last_month', now) : null,
      ]);
    const mo = month?.byCurrency ?? [];
    const monthOrders = mo.reduce((n, c) => n + c.paidOrders, 0);
    const monthChange = mo.length === 1 ? mo[0]!.changePercent : null;
    const monthTop = monthSummary?.topProducts[0] ?? null;

    const y = yesterday.byCurrency;
    const yRevenue = y.map((c) => c.revenue);
    const yOrders = y.reduce((n, c) => n + c.paidOrders, 0);
    const yChange = y.length === 1 ? y[0]!.changePercent : null;
    const weekRevenue = week.revenue.map((r) => r.formatted);
    const top = week.topProducts[0] ?? null;
    const low = stock.filter((p) => p.status === 'LOW' || p.status === 'OUT_OF_STOCK');
    const unpaidTotals = new Map<string, number>();
    for (const p of unpaidPayments)
      unpaidTotals.set(p.currency, (unpaidTotals.get(p.currency) ?? 0) + p.amountMinor);
    const ageDays = (d: Date) => Math.floor((now.getTime() - d.getTime()) / DAY);
    const stale = unpaidPayments.filter((p) => ageDays(p.createdAt) >= STALE_LINK_DAYS);
    const needsResponse = openDisputes.disputes.filter(
      (d) => d.status === 'WAITING_FOR_SELLER_RESPONSE',
    );

    const lines: string[] = [
      `*Katale AI · ${options.title}*`,
      `${merchant.businessName} · ${day(now, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`,
    ];

    if (s.includeSales && monthly && month) {
      const label = month.period.replace(/^last month \((.*)\)$/, '$1');
      lines.push(
        '',
        `*Last month (${label})*`,
        monthOrders
          ? `Revenue ${mo.map((c) => c.revenue).join(' · ')} from ${monthOrders} paid order${monthOrders === 1 ? '' : 's'}${
              monthChange === null
                ? ''
                : ` (${monthChange >= 0 ? '↑' : '↓'} ${Math.abs(monthChange)}% vs ${month.comparedWith?.replace(/^the month before \((.*)\)$/, '$1') ?? 'the month before'})`
            }`
          : 'No paid orders.',
        ...(monthTop
          ? [`Best seller: ${monthTop.name} (${monthTop.sharePercent}% of product revenue)`]
          : []),
      );
    } else if (s.includeSales) {
      const yesterdayLabel = day(new Date(now.getTime() - DAY), {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
      lines.push(
        '',
        `*Yesterday (${yesterdayLabel})*`,
        yOrders
          ? `Revenue ${yRevenue.join(' · ')} from ${yOrders} paid order${yOrders === 1 ? '' : 's'}${
              yChange === null
                ? ''
                : ` (${yChange >= 0 ? '↑' : '↓'} ${Math.abs(yChange)}% vs the day before)`
            }`
          : 'No paid orders.',
        '*Last 7 days*',
        week.paidOrders
          ? `Revenue ${weekRevenue.join(' · ')} · ${week.paidOrders} paid order${week.paidOrders === 1 ? '' : 's'}${
              top ? ` · best seller ${top.name} (${top.sharePercent}%)` : ''
            }`
          : 'No paid orders.',
      );
    }
    if (s.includeInventory) {
      lines.push('', '*Inventory*');
      if (!low.length) lines.push('All tracked products are above their reorder level.');
      for (const p of low.slice(0, 8)) {
        lines.push(
          p.status === 'OUT_OF_STOCK'
            ? `⛔ ${p.name} — out of stock`
            : `⚠️ ${p.name} — ${p.stock} left (reorder at ${p.reorderLevel})${p.daysOfCover !== null ? `, ~${p.daysOfCover} days of cover` : ''}`,
        );
      }
    }
    if (s.includeUnpaid) {
      lines.push('', '*Unpaid PayPal links*');
      if (!unpaidPayments.length) lines.push('None — every payment link has been paid.');
      else {
        lines.push(
          `${unpaidPayments.length} awaiting payment · ${[...unpaidTotals].map(([c, v]) => formatMoney(v, c)).join(' · ')}`,
        );
        for (const p of unpaidPayments.slice(0, 5)) {
          const age = ageDays(p.createdAt);
          lines.push(
            `• ${p.order.reference} — ${p.order.customer.name} — ${formatMoney(p.amountMinor, p.currency)} — ${age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'}`}`,
          );
        }
        if (unpaidPayments.length > 5) lines.push(`…and ${unpaidPayments.length - 5} more`);
      }
    }
    if (check) {
      lines.push('', '*Payment check (PayPal)*');
      if (!check.recovered.length && !check.expired.length && !check.mismatches.length)
        lines.push(
          check.checked
            ? `✅ ${check.checked} open link${check.checked === 1 ? '' : 's'} checked with PayPal — records match.`
            : '✅ Records match PayPal.',
        );
      for (const r of check.recovered)
        lines.push(`💰 ${r.reference} — ${r.amount} was paid at PayPal and is now recorded.`);
      if (check.expired.length)
        lines.push(
          `⌛ Expired link${check.expired.length === 1 ? '' : 's'}: ${check.expired.join(', ')} — a reminder sends a fresh one.`,
        );
      for (const m of check.mismatches) lines.push(`⚠️ ${m}`);
    }
    if (s.includeDisputes) {
      lines.push('', '*Open PayPal disputes*');
      if (!openDisputes.disputes.length) lines.push('None.');
      for (const d of openDisputes.disputes.slice(0, 5)) {
        const amount =
          d.amountMinor !== null && d.currency ? formatMoney(d.amountMinor, d.currency) : '';
        lines.push(
          `• ${d.paypalDisputeId}${d.order ? ` (${d.order.reference})` : ''} — ${reasonLabel(d.reason)}${amount ? `, ${amount}` : ''}${
            d.status === 'WAITING_FOR_SELLER_RESPONSE'
              ? ` — *needs your response*${d.sellerResponseDueAt ? ` by ${day(d.sellerResponseDueAt, { day: 'numeric', month: 'short' })}` : ''}`
              : ''
          }`,
        );
      }
    }
    if (s.includeInsights) {
      const insights: string[] = [];
      if (monthly && monthChange !== null && Math.abs(monthChange) >= 10)
        insights.push(
          `Last month's revenue was ${monthChange > 0 ? 'up' : 'down'} ${Math.abs(monthChange)}% on the month before.`,
        );
      if (!monthly && yChange !== null && Math.abs(yChange) >= 10)
        insights.push(
          `Yesterday's revenue was ${yChange > 0 ? 'up' : 'down'} ${Math.abs(yChange)}% on the day before.`,
        );
      for (const p of low.filter((x) => x.status === 'OUT_OF_STOCK').slice(0, 2))
        insights.push(
          `Restock ${p.name} — it is out of stock${p.suggestedReorder ? ` (≈${p.suggestedReorder} units covers 30 days of sales)` : ''}.`,
        );
      for (const p of low.filter((x) => x.status === 'LOW').slice(0, 2))
        insights.push(
          `Reorder ${p.name} soon${p.suggestedReorder ? `: about ${p.suggestedReorder} units covers the next 30 days` : ''}.`,
        );
      if (stale.length)
        insights.push(
          `${stale.length} payment link${stale.length === 1 ? ' has' : 's have'} been unpaid for ${STALE_LINK_DAYS}+ days — ask me to "remind ${stale[0]!.order.customer.name} about ${stale[0]!.order.reference}".`,
        );
      for (const d of needsResponse.slice(0, 2))
        insights.push(
          `Respond to dispute ${d.paypalDisputeId}${d.sellerResponseDueAt ? ` before ${day(d.sellerResponseDueAt, { day: 'numeric', month: 'short' })}` : ''} — ask me to "review the dispute".`,
        );
      if (!monthly && top && week.topProducts.length > 1)
        insights.push(`${top.name} led the week with ${top.sharePercent}% of product revenue.`);
      lines.push(
        '',
        '*What to do*',
        ...(insights.length
          ? insights.slice(0, 5).map((i) => `• ${i}`)
          : ['• Nothing needs your attention. 👍']),
      );
    }
    lines.push(
      '',
      `_From Katale's records (completed PayPal payments)._${s.includeChart ? ` _${monthly ? '30' : '7'}-day revenue chart below._` : ''}`,
    );

    const chart = s.includeChart
      ? await this.charts.chart('revenue_trend', m, { days: monthly ? 30 : 7 }, now)
      : null;
    return {
      text: lines.join('\n'),
      chart: chart ? { media: chart.media, caption: chart.caption } : null,
      facts: {
        yesterday: { revenue: yRevenue, paidOrders: yOrders, changePercent: yChange },
        week: { revenue: weekRevenue, paidOrders: week.paidOrders, topProduct: top?.name ?? null },
        ...(month
          ? {
              month: {
                revenue: mo.map((c) => c.revenue),
                paidOrders: monthOrders,
                changePercent: monthChange,
                topProduct: monthTop?.name ?? null,
              },
            }
          : {}),
        lowStock: low.map((p) => ({
          name: p.name,
          stock: p.stock,
          reorderLevel: p.reorderLevel,
          status: p.status,
        })),
        unpaid: {
          count: unpaidPayments.length,
          total: [...unpaidTotals].map(([c, v]) => formatMoney(v, c)),
          oldestDays: unpaidPayments[0] ? ageDays(unpaidPayments[0].createdAt) : null,
        },
        disputes: { open: openDisputes.disputes.length, needsResponse: needsResponse.length },
        reconciliation: check
          ? {
              checked: check.checked,
              recovered: check.recovered,
              expired: check.expired,
              mismatches: check.mismatches,
            }
          : null,
      },
    };
  }
}
