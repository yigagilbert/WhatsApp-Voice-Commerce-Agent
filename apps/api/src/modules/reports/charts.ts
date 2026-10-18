import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';

/**
 * Server-side charts for WhatsApp: hand-built SVG rendered to PNG with resvg (prebuilt binaries,
 * no system fonts or headless browser). Inter is bundled via @expo-google-fonts/inter (OFL).
 * The chart only draws numbers it is given; all figures come from backend aggregates.
 */
const require = createRequire(import.meta.url);
const FONT_FILES = [
  require.resolve('@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf'),
  require.resolve('@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf'),
];

const W = 1200;
const H = 760;
const C = {
  bg: '#ffffff',
  text: '#0f172a',
  muted: '#64748b',
  grid: '#e2e8f0',
  bar: '#1e293b',
  accent: '#0f766e',
  warn: '#b45309',
  danger: '#b91c1c',
};

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function frame(title: string, subtitle: string, body: string, footnote: string, h = H) {
  const H = h;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<text x="56" y="76" font-family="Inter" font-weight="600" font-size="36" fill="${C.text}">${esc(title)}</text>
<text x="56" y="116" font-family="Inter" font-size="22" fill="${C.muted}">${esc(subtitle)}</text>
${body}
<line x1="56" y1="${H - 64}" x2="${W - 56}" y2="${H - 64}" stroke="${C.grid}"/>
<text x="56" y="${H - 30}" font-family="Inter" font-size="18" fill="${C.muted}">${esc(footnote)}</text>
<text x="${W - 56}" y="${H - 30}" text-anchor="end" font-family="Inter" font-weight="600" font-size="18" fill="${C.text}">Katale AI</text>
</svg>`;
}

/** "Nice" axis maximum (1, 2, 2.5, 5 × 10^n) at or above `max`. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * exp >= max) return step * exp;
  return 10 * exp;
}

export interface ColumnChart {
  title: string;
  subtitle: string;
  footnote: string;
  columns: { label: string; value: number; display: string; highlight?: boolean }[];
  formatAxis: (value: number) => string;
  /** Smallest axis maximum, so an all-zero series doesn't get a meaningless 0–1 scale. */
  minAxisMax?: number;
}

/** Vertical columns (e.g. revenue per day). */
export function columnChartSvg(chart: ColumnChart): string {
  const left = 140;
  const right = W - 56;
  const top = 170;
  const bottom = H - 130;
  const max = niceMax(Math.max(chart.minAxisMax ?? 0, ...chart.columns.map((c) => c.value)));
  const n = Math.max(1, chart.columns.length);
  const slot = (right - left) / n;
  const barW = Math.min(64, slot * 0.62);
  const y = (v: number) => bottom - (v / max) * (bottom - top);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const showValues = n <= 14;
  const labelEvery = n <= 14 ? 1 : Math.ceil(n / 10);
  const body = [
    ...ticks.map(
      (t) =>
        `<line x1="${left}" y1="${y(t)}" x2="${right}" y2="${y(t)}" stroke="${C.grid}"/>` +
        `<text x="${left - 14}" y="${y(t) + 7}" text-anchor="end" font-family="Inter" font-size="18" fill="${C.muted}">${esc(chart.formatAxis(t))}</text>`,
    ),
    ...chart.columns.map((c, i) => {
      const cx = left + slot * i + slot / 2;
      const top = y(c.value);
      const h = Math.max(c.value > 0 ? 3 : 0, bottom - top);
      return [
        `<rect x="${cx - barW / 2}" y="${bottom - h}" width="${barW}" height="${h}" rx="4" fill="${c.highlight ? C.accent : C.bar}"/>`,
        showValues && c.value > 0
          ? `<text x="${cx}" y="${bottom - h - 10}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="17" fill="${C.text}">${esc(c.display)}</text>`
          : '',
        i % labelEvery === 0
          ? `<text x="${cx}" y="${bottom + 32}" text-anchor="middle" font-family="Inter" font-size="18" fill="${C.muted}">${esc(c.label)}</text>`
          : '',
      ].join('');
    }),
  ].join('\n');
  return frame(chart.title, chart.subtitle, body, chart.footnote);
}

export interface BarChart {
  title: string;
  subtitle: string;
  footnote: string;
  rows: {
    label: string;
    value: number;
    display: string;
    tone?: 'default' | 'warn' | 'danger' | 'accent';
    /** Draws a marker at this value (e.g. reorder level). */
    marker?: number;
  }[];
  markerLabel?: string;
}

/** Horizontal bars (e.g. revenue by product, stock vs reorder level). */
export function barChartSvg(chart: BarChart): string {
  const rows = chart.rows.slice(0, 8);
  const labelW = 300;
  const left = 56 + labelW;
  const right = W - 200;
  const top = 168;
  const rowH = 72;
  // Height follows the number of rows, so a short list isn't lost in white space.
  const height = Math.max(440, top + rowH * rows.length + 120);
  const max = niceMax(Math.max(0, ...rows.flatMap((r) => [r.value, r.marker ?? 0])));
  const x = (v: number) => left + (v / max) * (right - left);
  const tone = (t: BarChart['rows'][number]['tone']) =>
    t === 'warn' ? C.warn : t === 'danger' ? C.danger : t === 'accent' ? C.accent : C.bar;
  const body = rows
    .map((r, i) => {
      const cy = top + rowH * i + rowH / 2;
      const w = Math.max(r.value > 0 ? 3 : 0, x(r.value) - left);
      return [
        `<text x="${left - 18}" y="${cy + 7}" text-anchor="end" font-family="Inter" font-size="21" fill="${C.text}">${esc(truncate(r.label, 24))}</text>`,
        `<rect x="${left}" y="${cy - rowH * 0.3}" width="${right - left}" height="${rowH * 0.6}" rx="4" fill="#f1f5f9"/>`,
        `<rect x="${left}" y="${cy - rowH * 0.3}" width="${w}" height="${rowH * 0.6}" rx="4" fill="${tone(r.tone)}"/>`,
        r.marker !== undefined
          ? `<line x1="${x(r.marker)}" y1="${cy - rowH * 0.42}" x2="${x(r.marker)}" y2="${cy + rowH * 0.42}" stroke="${C.danger}" stroke-width="3" stroke-dasharray="6 4"/>`
          : '',
        `<text x="${right + 16}" y="${cy + 7}" font-family="Inter" font-weight="600" font-size="21" fill="${C.text}">${esc(r.display)}</text>`,
      ].join('');
    })
    .join('\n');
  const legend = chart.markerLabel
    ? `<line x1="${W - 330}" y1="108" x2="${W - 300}" y2="108" stroke="${C.danger}" stroke-width="3" stroke-dasharray="6 4"/><text x="${W - 290}" y="115" font-family="Inter" font-size="19" fill="${C.muted}">${esc(chart.markerLabel)}</text>`
    : '';
  return frame(chart.title, chart.subtitle, `${legend}\n${body}`, chart.footnote, height);
}

export function renderPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' },
    fitTo: { mode: 'width', value: W },
  });
  return resvg.render().asPng();
}
