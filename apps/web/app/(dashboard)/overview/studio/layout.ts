import type { AgReportState } from 'ag-studio';

/** Below this canvas width the dashboard stacks into one column (AG Studio 3.0 keeps the desktop grid). */
export const NARROW_WIDTH = 720;

const COLUMNS = 24;
const HALF = COLUMNS / 2;
const KPI_ROWS = 5;

interface Box {
  xTrack: number;
  yTrack: number;
  xSpan: number;
  ySpan: number;
}

/** The report in one column, in reading order, with KPIs in pairs. Saved layouts are untouched. */
export function stackedLayout(state: AgReportState): AgReportState {
  return {
    ...state,
    pages: state.pages?.map((page) => {
      const widgets = (page.widgets ?? {}) as Record<string, { type?: string }>;
      const boxes = Object.entries((page.widgetLayout ?? {}) as Record<string, Box>).sort(
        ([, a], [, b]) => a.yTrack - b.yTrack || a.xTrack - b.xTrack,
      );
      const widgetLayout: Record<string, Box> = {};
      let y = 0;
      let openPair = false;
      for (const [id, box] of boxes) {
        if (widgets[id]?.type === 'value') {
          widgetLayout[id] = {
            xTrack: openPair ? HALF : 0,
            yTrack: y,
            xSpan: HALF,
            ySpan: KPI_ROWS,
          };
          if (openPair) y += KPI_ROWS;
          openPair = !openPair;
          continue;
        }
        if (openPair) y += KPI_ROWS;
        openPair = false;
        widgetLayout[id] = { xTrack: 0, yTrack: y, xSpan: COLUMNS, ySpan: box.ySpan };
        y += box.ySpan;
      }
      return { ...page, widgetLayout };
    }),
  } as AgReportState;
}

export const isStacked = (state: AgReportState) =>
  JSON.stringify(stackedLayout(state).pages?.map((p) => p.widgetLayout)) ===
  JSON.stringify(state.pages?.map((p) => p.widgetLayout));

/** Rows used by the selected page, to size the canvas so the page scrolls rather than the widget. */
export function pageRows(state: AgReportState): number {
  const page = state.pages?.find((p) => p.id === state.selectedPageId) ?? state.pages?.[0];
  return Object.values((page?.widgetLayout ?? {}) as Record<string, Box>).reduce(
    (rows, box) => Math.max(rows, box.yTrack + box.ySpan),
    0,
  );
}

/**
 * What the merchant built, ignoring view state (selection, panels) and filter values, so changing a
 * date range doesn't offer to save a "changed" dashboard.
 */
export const layoutSignature = (state: AgReportState) =>
  JSON.stringify((state.pages ?? []).map((page) => [page.id, page.widgets, page.widgetLayout]));
