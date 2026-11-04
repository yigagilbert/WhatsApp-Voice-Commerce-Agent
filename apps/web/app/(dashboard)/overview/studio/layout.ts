import type { AgReportState } from 'ag-studio';

/** At or below this canvas width the dashboard stacks into one column. */
export const NARROW_WIDTH = 720;

const COLUMNS = 24;
const HALF = COLUMNS / 2;
const SMALL_SPAN = 4;
const SMALL_ROWS = 5;

interface Box {
  xTrack: number;
  yTrack: number;
  xSpan: number;
  ySpan: number;
}

/**
 * The phone layout for a set of desktop positions, in the same order as given: one column in reading
 * order, with the smallest KPIs in pairs. Studio computes this at render, so saved layouts always
 * hold the desktop positions.
 */
export function stackBoxes(boxes: readonly Box[]): Box[] {
  const reading = boxes
    .map((box, index) => ({ box, index }))
    .sort((a, b) => a.box.yTrack - b.box.yTrack || a.box.xTrack - b.box.xTrack);
  const stacked: Box[] = [...boxes];
  let y = 0;
  let openPair = false;
  for (const { box, index } of reading) {
    if (box.xSpan <= SMALL_SPAN) {
      stacked[index] = { xTrack: openPair ? HALF : 0, yTrack: y, xSpan: HALF, ySpan: SMALL_ROWS };
      if (openPair) y += SMALL_ROWS;
      openPair = !openPair;
      continue;
    }
    if (openPair) y += SMALL_ROWS;
    openPair = false;
    stacked[index] = { xTrack: 0, yTrack: y, xSpan: COLUMNS, ySpan: box.ySpan };
    y += box.ySpan;
  }
  return stacked;
}

export const RESPONSIVE_BREAKPOINTS = [
  {
    maxWidth: NARROW_WIDTH,
    layout: (candidates: { layout: Box }[]) => stackBoxes(candidates.map((c) => c.layout)),
  },
];

/** Rows used by the selected page, to size the canvas so the page scrolls rather than the widget. */
export function pageRows(state: AgReportState, narrow = false): number {
  const page = state.pages?.find((p) => p.id === state.selectedPageId) ?? state.pages?.[0];
  const boxes = Object.values((page?.widgetLayout ?? {}) as Record<string, Box>);
  return (narrow ? stackBoxes(boxes) : boxes).reduce(
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
