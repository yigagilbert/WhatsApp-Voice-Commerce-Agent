'use client'; // Error boundaries must be Client Components

import { useEffect } from 'react';

/** Unexpected page error: a plain explanation and a retry, never a stack trace. */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-6">
      <h2 className="text-lg font-semibold text-rose-900">This page couldn&apos;t load</h2>
      <p className="mt-1 text-sm text-rose-800">
        Something went wrong while loading your data. Nothing was changed. Please try again; if it
        keeps happening, check that the Katale services are running.
        {error.digest ? ` (Reference: ${error.digest})` : ''}
      </p>
      <button
        type="button"
        onClick={() => retry()}
        className="mt-4 rounded-md bg-rose-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-800"
      >
        Try again
      </button>
    </div>
  );
}
