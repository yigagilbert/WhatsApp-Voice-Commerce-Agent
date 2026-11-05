import type { AgReportState } from 'ag-studio';
import { ErrorNotice, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import type { DashboardSummary } from '@/lib/types';
import { GettingStarted } from './getting-started';
import { OverviewWorkspace } from './workspace';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const [summary, layout, client] = await Promise.all([
    apiGet<DashboardSummary>('/api/dashboard/summary'),
    apiGet<{ state: AgReportState | null }>('/api/dashboard/layout'),
    apiGet<{ aiEnabled: boolean; studioLicenseKey: string | null }>('/api/settings/client'),
  ]);
  if (!summary.ok) {
    return (
      <>
        <PageHeader title="Overview" />
        <ErrorNotice message={summary.error} />
      </>
    );
  }

  return (
    <>
      <GettingStarted summary={summary.data} />
      <OverviewWorkspace
        summary={summary.data}
        savedState={layout.ok ? layout.data.state : null}
        licenseKey={client.ok ? (client.data.studioLicenseKey ?? undefined) : undefined}
        aiEnabled={client.ok && client.data.aiEnabled}
      />
    </>
  );
}
