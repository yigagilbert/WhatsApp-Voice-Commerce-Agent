'use client';

import {
  AgStudioAiModule,
  type AgAiHarness,
  type AgDrillThroughOptions,
  type AgGetContextMenuParams,
  type AgPanelConfig,
  type AgReportState,
  type AgStudioApi,
} from 'ag-studio';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { useCallback, useMemo, useRef } from 'react';
import type { AnalyticsDataset } from '@/lib/types';
import { buildAssistant, type AssistantContext } from './assistant';
import { buildDataSources, scopeDataset } from './data-sources';
import { RESPONSIVE_BREAKPOINTS } from './layout';
import { TOOL_LABELS } from './prompts';
import { kataleLayout, kataleTheme } from './theme';

// Stable references: the provider and Studio rebuild themselves when these change identity.
const AI_MODULES = [AgStudioAiModule];
const NO_MODULES: [] = [];
const PANELS: AgPanelConfig = {
  // The everyday view is just the dashboard; customizing brings out all of Studio's tools.
  view: { left: [], right: [] },
  edit: { left: ['filters'], right: ['ai', 'edit', 'data'] },
};
const TOOL_DISPLAY = Object.fromEntries(
  Object.entries(TOOL_LABELS).map(([name, text]) => [name, { label: () => ({ text }) }]),
);
const FILL = { height: '100%', width: '100%' };

/**
 * AG Studio itself. Everything visual on the canvas is Studio: this component only hands it one
 * currency's records, the theme, the assistant and the report to start from. Loaded on the client
 * only (see workspace.tsx), since Studio needs the browser.
 */
export function StudioCanvas({
  dataset,
  currency,
  mode,
  initialState,
  licenseKey,
  aiEnabled,
  assistantContext,
  onReady,
  onStateChange,
  onFatalState,
  drillThrough,
  onDrill,
}: {
  dataset: AnalyticsDataset;
  currency: string;
  mode: 'view' | 'edit';
  initialState: AgReportState;
  licenseKey?: string | undefined;
  aiEnabled: boolean;
  assistantContext: () => AssistantContext;
  onReady: (api: AgStudioApi, harness: AgAiHarness | null) => void;
  onStateChange: (state: AgReportState) => void;
  onFatalState: () => void;
  drillThrough: AgDrillThroughOptions | undefined;
  onDrill: (params: AgGetContextMenuParams) => void;
}) {
  // Only row data may change after first render: Studio ignores other changes to `data`.
  const data = useMemo(
    () => buildDataSources(scopeDataset(dataset, currency), currency),
    [dataset, currency],
  );
  const harnessRef = useRef<AgAiHarness | null>(null);
  // Studio only asks for the harness when its own AI panel opens (edit mode). The Ask panel needs it
  // in view mode too, so both share one harness and one set of conversations.
  const harnessFor = useCallback(
    (api: AgStudioApi) => {
      harnessRef.current ??= buildAssistant(api, assistantContext);
      return harnessRef.current;
    },
    [assistantContext],
  );
  // The harness hook types `api` as Studio's core API; at runtime it is the full API.
  const ai = useCallback(
    ({ api }: { api: unknown }) => harnessFor(api as AgStudioApi),
    [harnessFor],
  );

  const getContextMenuItems = useCallback(
    (params: AgGetContextMenuParams) =>
      params.filter && mode === 'view' && !drillThrough
        ? [{ name: 'See the records behind this', action: () => onDrill(params) }]
        : [],
    [mode, drillThrough, onDrill],
  );

  return (
    <AgStudioProvider
      modules={aiEnabled ? AI_MODULES : NO_MODULES}
      {...(licenseKey ? { licenseKey } : {})}
    >
      <AgStudio
        style={FILL}
        data={data}
        mode={mode}
        theme={kataleTheme}
        layout={kataleLayout}
        initialState={initialState}
        panels={PANELS}
        responsiveLayoutBreakpoints={RESPONSIVE_BREAKPOINTS}
        getContextMenuItems={getContextMenuItems}
        {...(drillThrough ? { drillThrough } : {})}
        onStudioReady={({ api }) => onReady(api, aiEnabled ? harnessFor(api) : null)}
        onStateUpdated={({ state }) => onStateChange(state)}
        onErrorRaised={({ fatal, errorDetails }) => {
          console.warn('AG Studio state error', errorDetails);
          if (fatal) onFatalState();
        }}
        {...(aiEnabled ? { ai, aiToolDisplay: TOOL_DISPLAY } : {})}
      />
    </AgStudioProvider>
  );
}
