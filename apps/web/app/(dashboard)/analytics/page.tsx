import { loadWebConfig } from '@vca/config';
import { ErrorNotice, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import type { AnalyticsDataset } from '@/lib/types';
import { AnalyticsStudioLoader } from './studio-loader';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const result = await apiGet<AnalyticsDataset>('/api/dashboard/dataset');
  const config = loadWebConfig();
  return (
    <>
      <PageHeader
        title="Analytics"
        description="Build your own views of orders, payments, products and customers with AG Studio — drag fields onto the canvas or ask the assistant. Data comes from Katale's records; revenue counts completed PayPal payments."
      />
      {result.ok ? (
        <AnalyticsStudioLoader
          dataset={result.data}
          licenseKey={config.AG_STUDIO_LICENSE_KEY}
          aiEnabled={!!config.AI_API_KEY}
        />
      ) : (
        <ErrorNotice message={result.error} />
      )}
    </>
  );
}
