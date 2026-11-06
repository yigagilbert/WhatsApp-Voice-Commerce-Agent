'use client';

import type {
  AgAiHarness,
  AgDrillThroughOptions,
  AgGetContextMenuParams,
  AgReportState,
  AgStudioApi,
} from 'ag-studio';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from 'react';
import type { AnalyticsDataset, DashboardSummary } from '@/lib/types';
import { resetLayout, saveLayout } from './actions';
import { AttentionList } from './attention';
import { Pulse } from './pulse';
import type { AssistantContext } from './studio/assistant';
import { AskPanel } from './studio/ask-panel';
import { scopeDataset } from './studio/data-sources';
import { defaultReport, PAGE_LABELS } from './studio/default-report';
import { describeDrill, drillFilter, drillReport } from './studio/drill';
import { layoutSignature, NARROW_WIDTH, pageRows } from './studio/layout';
import { PROMPT_STARTERS } from './studio/prompts';

const REFRESH_MS = 60_000;
// Matches kataleLayout.rowHeight; theme.ts itself imports AG Studio, which must stay lazy-loaded.
const ROW_HEIGHT = 24;
const CANVAS_EXTRA = 16;
const COLLAPSED_TOOLS = {
  filters: { collapsed: true },
  edit: { collapsed: true },
  data: { collapsed: true },
};

function CanvasSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading your dashboard"
      className="grid gap-3 sm:grid-cols-3 motion-safe:animate-pulse"
    >
      <div className="h-24 rounded-2xl bg-slate-200/70 sm:col-span-3" />
      <div className="h-72 rounded-2xl bg-slate-200/70 sm:col-span-2" />
      <div className="h-72 rounded-2xl bg-slate-200/70" />
    </div>
  );
}

// AG Studio is a browser-only component (and a large one): load it after the page has painted.
const StudioCanvas = dynamic(() => import('./studio/canvas').then((m) => m.StudioCanvas), {
  ssr: false,
  loading: () => <CanvasSkeleton />,
});

const pagesOf = (state: AgReportState) => ({
  ids: (state.pages ?? []).map((page) => page.id),
  selected: state.selectedPageId ?? state.pages?.[0]?.id,
});

const timeLabel = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone }).format(
    new Date(iso),
  );

/**
 * The Overview: headline figures, what needs attention, the assistant and the AG Studio dashboard,
 * on one page. This component owns the page state (currency, view or customize, refreshing and
 * saving); all charts, tables and filters belong to AG Studio.
 */
export function OverviewWorkspace({
  summary,
  savedState,
  licenseKey,
  aiEnabled,
}: {
  summary: DashboardSummary;
  savedState: AgReportState | null;
  licenseKey?: string | undefined;
  aiEnabled: boolean;
}) {
  const router = useRouter();
  const currencies = summary.pulse.map((p) => p.currency);
  const preferred = summary.merchant.preferredCurrency;
  const [currency, setCurrency] = useState(
    currencies.includes(preferred) ? preferred : (currencies[0] ?? preferred),
  );
  const figures = summary.pulse.find((p) => p.currency === currency);

  const [dataset, setDataset] = useState<AnalyticsDataset | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [narrow, setNarrow] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [harness, setHarness] = useState<AgAiHarness | null>(null);
  const [saving, startSaving] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [canvasFailed, setCanvasFailed] = useState(false);
  const [report, setReport] = useState<AgReportState>(savedState ?? defaultReport);
  const [drill, setDrill] = useState<{ label: string; options: AgDrillThroughOptions } | null>(
    null,
  );
  const rows = pageRows(report, narrow);
  const pages = pagesOf(report);

  const apiRef = useRef<AgStudioApi | null>(null);
  const baseline = useRef<AgReportState>(savedState ?? defaultReport);
  const latest = useRef<AgReportState>(savedState ?? defaultReport);
  const [dirty, setDirty] = useState(false);
  const loadedVersion = useRef<string | null>(null);
  const beforeDrill = useRef<AgReportState | null>(null);
  const exploreRef = useRef<HTMLElement>(null);

  const scoped = useMemo(
    () => (dataset ? scopeDataset(dataset, currency) : null),
    [dataset, currency],
  );
  const context = useRef<AssistantContext | null>(null);
  if (scoped) context.current = { summary, figures, currency, dataset: scoped };
  const assistantContext = useCallback(() => context.current as AssistantContext, []);

  const loadDataset = useCallback(async () => {
    try {
      const response = await fetch('/overview/dataset', { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      setDataset((await response.json()) as AnalyticsDataset);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  // New rows flow into the running Studio without touching the merchant's widgets.
  useEffect(() => {
    if (loadedVersion.current === summary.dataVersion) return;
    loadedVersion.current = summary.dataVersion;
    void loadDataset();
  }, [summary.dataVersion, loadDataset]);

  // Keep the headline figures current while the page is on screen; hidden tabs don't poll.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);

  // Studio picks the phone layout from its canvas width, so the page follows the same measure.
  useEffect(() => {
    const section = exploreRef.current;
    if (!section) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width <= NARROW_WIDTH);
    });
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  const initialState = useMemo(() => {
    void revision;
    return latest.current;
  }, [revision]);

  const onReady = useCallback((api: AgStudioApi, next: AgAiHarness | null) => {
    apiRef.current = api;
    setHarness(next);
    setReport(api.getState());
  }, []);

  const onStateChange = useCallback((state: AgReportState) => {
    setReport(state);
    // The records view is temporary: it never counts as a change to the dashboard.
    if (beforeDrill.current) return;
    latest.current = state;
    setDirty(layoutSignature(state) !== layoutSignature(baseline.current));
  }, []);

  const onDrill = useCallback((params: AgGetContextMenuParams) => {
    const api = apiRef.current;
    const clicked = params.filter;
    if (!api || !clicked) return;
    beforeDrill.current = api.getState();
    api.setState(drillReport(clicked));
    setDrill({
      label: describeDrill(clicked),
      options: { filter: drillFilter(clicked, params.getActiveFiltersForWidget?.()) },
    });
  }, []);

  const closeDrill = useCallback(() => {
    const saved = beforeDrill.current;
    if (saved) apiRef.current?.setState(saved);
    beforeDrill.current = null;
    setDrill(null);
  }, []);

  const changeCurrency = (next: string) => {
    // A new currency starts a new Studio from the dashboard, not from the records view.
    beforeDrill.current = null;
    setDrill(null);
    setCurrency(next);
  };

  const onFatalState = useCallback(() => {
    // A change that broke the report (saved or AI-made) rolls back rather than blanking the page.
    const api = apiRef.current;
    if (api && latest.current !== baseline.current) {
      latest.current = baseline.current;
      api.setState(baseline.current);
      setDirty(false);
      setNotice("That change couldn't be applied, so your dashboard was left as it was.");
      return;
    }
    if (latest.current === defaultReport) {
      setCanvasFailed(true);
      return;
    }
    latest.current = defaultReport;
    baseline.current = defaultReport;
    setRevision((r) => r + 1);
    setNotice("Your saved dashboard couldn't be opened, so the standard one is showing.");
  }, []);

  const save = () =>
    startSaving(async () => {
      const state = apiRef.current?.getState() ?? latest.current;
      const result = await saveLayout(JSON.parse(JSON.stringify(state)));
      if (result.error) {
        setNotice(`Couldn't save: ${result.error}`);
        return;
      }
      baseline.current = state;
      setDirty(false);
      setMode('view');
      setNotice('Dashboard saved.');
    });

  const discard = () => {
    apiRef.current?.setState(baseline.current);
    latest.current = baseline.current;
    setDirty(false);
    setMode('view');
  };

  const restoreDefault = () => {
    if (!window.confirm('Go back to the standard dashboard? Your changes to this one are lost.'))
      return;
    startSaving(async () => {
      const result = await resetLayout();
      if (result.error) {
        setNotice(`Couldn't reset: ${result.error}`);
        return;
      }
      apiRef.current?.setState(defaultReport);
      latest.current = defaultReport;
      baseline.current = defaultReport;
      setDirty(false);
      setMode('view');
      setNotice('Back to the standard dashboard.');
    });
  };

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const askAi = (text: string) => {
    if (!text.trim()) return;
    setPendingQuestion(text);
    setAskOpen(true);
    setQuestion('');
  };
  const submitQuestion = (event: FormEvent) => {
    event.preventDefault();
    askAi(question);
  };
  const clearPending = useCallback(() => setPendingQuestion(null), []);

  // Customizing happens on the canvas: bring it, and the panels Studio opens beside it, into view.
  useEffect(() => {
    if (mode !== 'edit') return;
    document
      .getElementById('explore-heading')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Start with the canvas and the assistant; the other tools are one click away.
    const api = apiRef.current;
    if (api) api.setState({ ...api.getState(), panels: COLLAPSED_TOOLS });
  }, [mode]);

  const openPage = (id: string) => {
    const api = apiRef.current;
    if (api) api.setState({ ...api.getState(), selectedPageId: id });
  };

  const canvasHeight =
    mode === 'edit'
      ? 'calc(100vh - 7rem)'
      : `${rows === 0 ? 480 : rows * ROW_HEIGHT + CANVAS_EXTRA}px`;

  const hasOrders = summary.counts.orders > 0;

  return (
    <>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-charcoal">
            {summary.merchant.businessName}
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Live from your orders and PayPal payments · Updated{' '}
            {timeLabel(summary.generatedAt, summary.merchant.timezone)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {currencies.length > 1 && (
            <label className="flex items-center gap-2 text-xs text-slate-500">
              <span>Currency</span>
              <select
                value={currency}
                onChange={(e) => changeCurrency(e.target.value)}
                className="rounded-lg border border-mist bg-white px-2.5 py-1.5 text-sm font-medium text-charcoal"
              >
                {currencies.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            onClick={() => router.refresh()}
            className="rounded-lg border border-mist bg-white px-3 py-1.5 text-sm font-medium text-charcoal transition-colors hover:bg-slate-50"
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Pulse figures={figures} timezone={summary.merchant.timezone} />
        <AttentionList items={summary.attention} />
      </div>

      {aiEnabled && hasOrders && (
        <section
          aria-label="Ask Katale AI"
          className="mt-3 rounded-2xl border border-mist bg-white p-3"
        >
          <form onSubmit={submitQuestion} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="ml-1 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-leaf-700 text-sm text-white"
            >
              ✦
            </span>
            <label htmlFor="ask-input" className="sr-only">
              Ask Katale AI about your business
            </label>
            <input
              id="ask-input"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask about your business, or ask for a chart…"
              className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-base text-charcoal outline-none placeholder:text-slate-400 sm:text-sm"
            />
            <button
              type="submit"
              disabled={!question.trim()}
              className="rounded-lg bg-leaf-700 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-leaf-800 disabled:opacity-40"
            >
              Ask
            </button>
          </form>
          <ul className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:overflow-visible">
            {PROMPT_STARTERS.slice(0, 6).map((starter) => (
              <li key={starter.label} className="shrink-0">
                <button
                  type="button"
                  onClick={() => askAi(starter.prompt)}
                  className="rounded-full border border-mist px-2.5 py-1 text-xs text-slate-600 transition-colors hover:border-leaf-200 hover:bg-leaf-50 hover:text-leaf-800"
                >
                  {starter.label}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section ref={exploreRef} aria-labelledby="explore-heading" className="mt-6">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 id="explore-heading" className="font-display text-base font-semibold text-charcoal">
            {drill
              ? `Records for ${drill.label}`
              : mode === 'edit'
                ? 'Customize your dashboard'
                : 'Explore'}
          </h2>
          {hasOrders && !drill && mode === 'view' && pages.ids.length > 1 && (
            <div
              role="tablist"
              aria-label="Dashboard pages"
              className="order-last flex w-full gap-1 overflow-x-auto sm:order-none sm:mr-auto sm:ml-3 sm:w-auto"
            >
              {pages.ids.map((id, index) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={pages.selected === id}
                  onClick={() => openPage(id)}
                  className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    pages.selected === id
                      ? 'bg-leaf-800 text-white'
                      : 'text-slate-600 hover:bg-slate-200/70 hover:text-charcoal'
                  }`}
                >
                  {PAGE_LABELS[id] ?? `Page ${index + 1}`}
                </button>
              ))}
            </div>
          )}
          {drill && (
            <button
              type="button"
              onClick={closeDrill}
              className="rounded-lg border border-mist bg-white px-3 py-1.5 text-sm font-medium text-charcoal hover:bg-slate-50"
            >
              ← Back to dashboard
            </button>
          )}
          {hasOrders && !drill && (
            <div className="flex flex-wrap items-center gap-2">
              {mode === 'edit' && (
                <button
                  type="button"
                  onClick={restoreDefault}
                  disabled={saving}
                  className="px-2 py-1.5 text-xs font-medium text-slate-500 hover:text-charcoal"
                >
                  Reset to standard
                </button>
              )}
              {(dirty || mode === 'edit') && (
                <>
                  <button
                    type="button"
                    onClick={discard}
                    disabled={saving}
                    className="rounded-lg border border-mist bg-white px-3 py-1.5 text-sm font-medium text-charcoal hover:bg-slate-50"
                  >
                    {dirty ? 'Discard' : 'Done'}
                  </button>
                  {dirty && (
                    <button
                      type="button"
                      onClick={save}
                      disabled={saving}
                      className="rounded-lg bg-leaf-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-leaf-800 disabled:opacity-50"
                    >
                      {saving ? 'Saving…' : 'Save dashboard'}
                    </button>
                  )}
                </>
              )}
              {mode === 'view' && !narrow && (
                <button
                  type="button"
                  onClick={() => setMode('edit')}
                  className="rounded-lg border border-mist bg-white px-3 py-1.5 text-sm font-medium text-charcoal transition-colors hover:border-leaf-200 hover:bg-leaf-50"
                >
                  Customize
                </button>
              )}
            </div>
          )}
        </div>
        {hasOrders && !drill && mode === 'view' && !narrow && (
          <p className="mb-2 text-xs text-slate-500">
            Right-click any bar, slice or row to see the records behind it.
          </p>
        )}
        {notice && (
          <p role="status" className="mb-2 rounded-lg bg-leaf-50 px-3 py-2 text-sm text-leaf-800">
            {notice}
          </p>
        )}
        {dataset?.meta.truncated && (
          <p role="status" className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            This shop has more records than the explorer loads, so its charts cover the most recent
            ones. The headline figures above always cover everything.
          </p>
        )}

        {!hasOrders ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
            <p className="font-display text-lg font-semibold text-charcoal">
              Your charts start with your first order
            </p>
            <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
              Send Katale AI an order on WhatsApp or try the Agent console. Trends, top products and
              the assistant will all use your real records from then on.
            </p>
          </div>
        ) : canvasFailed ? (
          <div
            role="alert"
            className="rounded-2xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900"
          >
            The explorer couldn't open. The figures above are still correct. Reload the page to try
            again.
          </div>
        ) : loadFailed && !dataset ? (
          <div
            role="alert"
            className="rounded-2xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900"
          >
            <p>The explorer couldn't load. The figures above are still correct.</p>
            <button
              type="button"
              onClick={() => void loadDataset()}
              className="mt-3 rounded-lg bg-white px-3 py-1.5 font-medium text-charcoal ring-1 ring-amber-300"
            >
              Try again
            </button>
          </div>
        ) : !dataset ? (
          <CanvasSkeleton />
        ) : (
          <div className="w-full [&>div]:h-full" style={{ height: canvasHeight }}>
            <StudioCanvas
              // Field formats are fixed when Studio starts, so a new currency or layout means a new Studio.
              key={`${currency}-${revision}`}
              dataset={dataset}
              currency={currency}
              mode={mode}
              initialState={initialState}
              licenseKey={licenseKey}
              aiEnabled={aiEnabled}
              assistantContext={assistantContext}
              onReady={onReady}
              onStateChange={onStateChange}
              onFatalState={onFatalState}
              drillThrough={drill?.options}
              onDrill={onDrill}
            />
          </div>
        )}
      </section>

      {aiEnabled && hasOrders && (
        <AskPanel
          harness={harness}
          open={askOpen}
          pending={pendingQuestion}
          onPendingSent={clearPending}
          onClose={() => setAskOpen(false)}
        />
      )}
    </>
  );
}
