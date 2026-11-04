import type { AgReportState } from 'ag-studio';
import { loadWebConfig } from '@vca/config';
import { ErrorNotice, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import type { DashboardSummary } from '@/lib/types';
import { GettingStarted } from './getting-started';
import { OverviewWorkspace } from './workspace';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const [summary, layout] = await Promise.all([
    apiGet<DashboardSummary>('/api/dashboard/summary'),
    apiGet<{ state: AgReportState | null }>('/api/dashboard/layout'),
  ]);
  if (!summary.ok) {
    return (
      <>
        <PageHeader title="Overview" />
        <ErrorNotice message={summary.error} />
      </>
    );
  }
  const config = loadWebConfig();

  return (
    <>
      <GettingStarted summary={summary.data} />
      <OverviewWorkspace
        summary={summary.data}
        savedState={layout.ok ? layout.data.state : null}
        licenseKey={config.AG_STUDIO_LICENSE_KEY}
        aiEnabled={!!config.AI_API_KEY}
      />
    </>
  );
}
