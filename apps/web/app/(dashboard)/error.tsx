'use client'; // Error boundaries must be Client Components

import Link from 'next/link';
import { useEffect } from 'react';
import { SESSION_ENDED_MESSAGE, loginAfterSessionEnded, pagePath } from '@/lib/session-ended';

/**
 * A failed page or action inside the dashboard. It sits inside the dashboard layout, so the
 * navigation stays and people can move on.
 */
export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const sessionEnded = error.message === SESSION_ENDED_MESSAGE;
  useEffect(() => {
    if (sessionEnded) {
      // proxy.ts normally redirects by itself; this covers a response that didn't get that far.
      const { pathname, search } = window.location;
      window.location.replace(loginAfterSessionEnded(pagePath(pathname, search)));
    } else console.error(error);
  }, [error, sessionEnded]);

  if (sessionEnded)
    return (
      <p role="status" className="text-sm text-slate-600">
        Your session has ended. Taking you to sign in…
      </p>
    );
  return (
    <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-6">
      <h2 className="text-lg font-semibold text-rose-900">That didn&apos;t work</h2>
      <p className="mt-1 text-sm text-rose-800">
        Something went wrong while loading this page or saving your change. If you were saving,
        check whether it went through before trying again.
        {error.digest ? ` (Reference: ${error.digest})` : ''}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => retry()}
          className="rounded-md bg-rose-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-800"
        >
          Try again
        </button>
        <Link href="/overview" className="text-sm font-medium text-rose-900 underline">
          Go to Overview
        </Link>
      </div>
    </div>
  );
}
