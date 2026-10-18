import { describe, expect, it } from 'vitest';
import { barChartSvg, columnChartSvg, niceMax, renderPng } from './charts';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('charts', () => {
  it('rounds axis maxima to readable steps', () => {
    expect([0, 7, 140, 260, 999, 1001].map(niceMax)).toEqual([1, 10, 200, 500, 1000, 2000]);
  });

  it('renders a column chart to PNG with the given values and escaped labels', () => {
    const svg = columnChartSvg({
      title: 'Revenue <per> day',
      subtitle: 'Kampala Crafts',
      footnote: 'test',
      columns: [
        { label: '1 Oct', value: 14_000, display: '$140' },
        { label: '2 Oct', value: 0, display: '$0' },
        { label: '3 Oct', value: 3_600, display: '$36', highlight: true },
      ],
      formatAxis: (v) => `$${v / 100}`,
    });
    expect(svg).toContain('Revenue &lt;per&gt; day');
    expect(svg).toContain('>$140<');
    // Zero bars carry no value label (only the axis shows $0).
    expect(svg).not.toMatch(/font-size="17" fill="#0f172a">\$0</);
    const png = renderPng(svg);
    expect(png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    expect(png.length).toBeGreaterThan(5_000);
    expect(png.length).toBeLessThan(1_000_000);
  });

  it('gives an all-zero series a readable minimum axis', () => {
    const ticks: number[] = [];
    columnChartSvg({
      title: 'Revenue per day',
      subtitle: '',
      footnote: '',
      columns: [0, 0, 0].map((value, i) => ({ label: `${i}`, value, display: '$0' })),
      formatAxis: (v) => (ticks.push(v), `$${v / 100}`),
      minAxisMax: 1000,
    });
    expect(ticks).toEqual([0, 250, 500, 750, 1000]);
  });

  it('marks reorder levels and colours low stock on the bar chart', () => {
    const svg = barChartSvg({
      title: 'Stock levels',
      subtitle: '1 product low',
      footnote: 'test',
      markerLabel: 'Reorder level',
      rows: [
        { label: 'Handmade Basket', value: 18, display: '18 units', tone: 'warn', marker: 30 },
        { label: 'Barkcloth Wallet', value: 80, display: '80 units', marker: 15 },
      ],
    });
    expect(svg).toContain('#b45309'); // warn tone
    expect(svg.match(/stroke-dasharray/g)?.length).toBe(3); // two markers + legend
    expect(renderPng(svg).subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  });
});
