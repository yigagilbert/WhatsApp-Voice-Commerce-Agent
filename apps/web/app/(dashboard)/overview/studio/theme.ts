import { studioTheme } from 'ag-studio';

/** Katale's leaf greens with neutral companions; distinct enough for donut slices side by side. */
export const katalePalette = ['#0a8a3a', '#6ccf1a', '#0b3d20', '#3fa7a0', '#e0a526', '#8b9a8e'];

/** Same as the dashboard's page background, so the canvas reads as part of the page. */
const PAGE_BACKGROUND = '#f8fafc';

export const kataleTheme = studioTheme.withParams({
  accentColor: '#0a8a3a',
  foregroundColor: '#1c2329',
  textColor: '#1c2329',
  subtleTextColor: '#64748b',
  borderColor: '#e4ebe2',
  borderRadius: 10,
  fontFamily: 'var(--font-geist), ui-sans-serif, system-ui, sans-serif',
  rowHoverColor: '#eef8ef',
  chartAccentColor: '#0a8a3a',
  chartGridLineColor: '#eef2ec',
  chartPaletteFills1Color: katalePalette[0],
  chartPaletteFills2Color: katalePalette[1],
  chartPaletteFills3Color: katalePalette[2],
  chartPaletteFills4Color: katalePalette[3],
  chartPaletteFills5Color: katalePalette[4],
  chartPaletteFills6Color: katalePalette[5],
  chartPaletteStrokes1Color: katalePalette[0],
  chartPaletteStrokes2Color: katalePalette[1],
  chartPaletteStrokes3Color: katalePalette[2],
  chartPaletteStrokes4Color: katalePalette[3],
  chartPaletteStrokes5Color: katalePalette[4],
  chartPaletteStrokes6Color: katalePalette[5],
  // The page handles narrow screens by stacking widgets; don't force a 600px minimum on phones.
  studioMinWidth: 0,
  studioMinHeight: 0,
  studioWrapperBackgroundColor: PAGE_BACKGROUND,
  studioWrapperBorder: false,
});

export const kataleLayout = {
  columns: 24,
  rowHeight: 24,
  minWidth: 280,
  pagePadding: 0,
  backgroundColor: PAGE_BACKGROUND,
  widgetPadding: 6,
  widgetBackgroundColor: '#ffffff',
  widgetBorderEnabled: true,
  widgetBorderColor: '#e4ebe2',
  widgetBorderWidth: 1,
  widgetBorderRadius: 14,
};
