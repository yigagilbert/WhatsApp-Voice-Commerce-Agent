'use client';

import dynamic from 'next/dynamic';
import type { ComponentProps } from 'react';
import type { AnalyticsStudio } from './studio';

// AG Studio is a browser-only component: load it on the client, after hydration.
const Studio = dynamic(() => import('./studio').then((m) => m.AnalyticsStudio), {
  ssr: false,
  loading: () => (
    <div className="grid h-[560px] place-items-center rounded-lg border border-slate-200 bg-white text-sm text-slate-500">
      Loading analytics workspace…
    </div>
  ),
});

export function AnalyticsStudioLoader(props: ComponentProps<typeof AnalyticsStudio>) {
  return <Studio {...props} />;
}
