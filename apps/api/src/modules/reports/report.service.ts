import {
  formatMoney,
  resolvePeriod,
  type AnalyticsService,
  type InventoryService,
  type SalesPeriod,
} from '@vca/commerce';
import type { Merchant } from '@vca/database';
import type { OutboundMedia } from '@vca/shared';
import { barChartSvg, columnChartSvg, renderPng } from './charts';

export type ChartKind = 'revenue_trend' | 'product_revenue' | 'stock_levels';

export interface ChartResult {
  media: OutboundMedia;
  caption: string;
  /** The figures drawn, so the agent can describe them without inventing any. */
  data: Record<string, unknown>;
}

const compactMoney = (value: number, currency: string) => {
  // Axis ticks can fall between cents (e.g. a quarter of $2.50), so round to whole minor units.
  const minor = Math.round(value);
  const major = minor / 100;
  const symbol = formatMoney(0, currency).replace(/[\d.,\s]/g, '');
  return major >= 1000
    ? `${symbol}${(major / 1000).toFixed(major >= 10_000 ? 0 : 1)}k`
    : formatMoney(minor, currency).replace(/\.00$/, '');
};

/** PNG business charts from trusted aggregates, sent as WhatsApp images. */
export class ReportService {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly inventory: InventoryService,
  ) {}

  async chart(
    kind: ChartKind,
    merchant: Pick<Merchant, 'id' | 'timezone' | 'businessName' | 'preferredCurrency'>,
    options: { days?: number; period?: SalesPeriod } = {},
    now = new Date(),
  ): Promise<ChartResult> {
    const generated = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: merchant.timezone,
    }).format(now);
    if (kind === 'revenue_trend') {
      const days = options.days ?? 7;
      const series = await this.analytics.dailyRevenue(merchant, days, now);
      const currency = series.currency ?? merchant.preferredCurrency;
      const total = series.days.reduce((sum, d) => sum + d.amountMinor, 0);
      const svg = columnChartSvg({
        title: `Revenue per day — last ${days} days`,
        subtitle: `${merchant.businessName} · total ${formatMoney(total, currency)} · completed PayPal payments`,
        footnote: `Generated ${generated}${series.otherCurrencies.length ? ` · other currencies not shown: ${series.otherCurrencies.join(', ')}` : ''}`,
        columns: series.days.map((d, i) => ({
          label: new Intl.DateTimeFormat('en-GB', {
            day: 'numeric',
            month: 'short',
            timeZone: 'UTC',
          }).format(new Date(`${d.date}T00:00:00Z`)),
          value: d.amountMinor,
          display: compactMoney(d.amountMinor, currency),
          highlight: i === series.days.length - 1,
        })),
        formatAxis: (v) => compactMoney(v, currency),
        // A week with no sales still gets a readable $0–$10 axis.
        minAxisMax: 1000,
      });
      return {
        media: {
          mimeType: 'image/png',
          dataBase64: renderPng(svg).toString('base64'),
          filename: 'revenue-trend.png',
        },
        caption: `📈 Revenue per day, last ${days} days: ${formatMoney(total, currency)} in total.`,
        data: {
          currency,
          total: formatMoney(total, currency),
          days: series.days.map((d) => ({
            date: d.date,
            revenue: formatMoney(d.amountMinor, currency),
          })),
        },
      };
    }
    if (kind === 'product_revenue') {
      const period = options.period ?? 'last_30_days';
      const summary = await this.analytics.salesSummary(merchant, period, now);
      const rows = summary.topProducts;
      const svg = barChartSvg({
        title: 'Revenue by product',
        subtitle: `${merchant.businessName} · ${resolvePeriod(period, now, merchant.timezone).label} · paid orders, excl. shipping`,
        footnote: `Generated ${generated}`,
        rows: rows.map((p, i) => ({
          label: p.name,
          value: p.amountMinor,
          display: `${p.formatted} · ${p.sharePercent}%`,
          tone: i === 0 ? 'accent' : 'default',
        })),
      });
      return {
        media: {
          mimeType: 'image/png',
          dataBase64: renderPng(svg).toString('base64'),
          filename: 'product-revenue.png',
        },
        caption: rows.length
          ? `🏆 Best seller ${summary.label}: ${rows[0]!.name}, ${rows[0]!.formatted} (${rows[0]!.sharePercent}% of product revenue).`
          : `No paid orders ${summary.label} yet.`,
        data: {
          period: summary.label,
          products: rows.map((p) => ({
            name: p.name,
            revenue: p.formatted,
            units: p.quantity,
            share: p.sharePercent,
          })),
        },
      };
    }
    const report = (await this.inventory.report(merchant.id, now)).filter((p) => p.stock !== null);
    const low = report.filter((p) => p.status !== 'OK');
    const svg = barChartSvg({
      title: 'Stock levels',
      subtitle: `${merchant.businessName} · ${low.length ? `${low.length} product${low.length === 1 ? '' : 's'} at or below reorder level` : 'all products above reorder level'}`,
      footnote: `Generated ${generated} · units in stock`,
      markerLabel: 'Reorder level',
      rows: report.map((p) => ({
        label: p.name,
        value: Math.max(0, p.stock ?? 0),
        display: `${p.stock} units`,
        tone: p.status === 'OUT_OF_STOCK' ? 'danger' : p.status === 'LOW' ? 'warn' : 'default',
        ...(p.reorderLevel !== null ? { marker: p.reorderLevel } : {}),
      })),
    });
    return {
      media: {
        mimeType: 'image/png',
        dataBase64: renderPng(svg).toString('base64'),
        filename: 'stock-levels.png',
      },
      caption: low.length
        ? `📦 Stock: ${low.map((p) => `${p.name} ${p.stock} (reorder at ${p.reorderLevel})`).join(', ')} need attention.`
        : '📦 Stock: everything is above its reorder level.',
      data: {
        products: report.map((p) => ({
          name: p.name,
          stock: p.stock,
          reorderLevel: p.reorderLevel,
          status: p.status,
        })),
      },
    };
  }
}
