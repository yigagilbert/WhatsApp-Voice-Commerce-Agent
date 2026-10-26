import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-slate-900">Page not found</h2>
      <p className="mt-1 text-sm text-slate-600">This page doesn&apos;t exist or was moved.</p>
      <Link href="/" className="mt-4 inline-flex text-sm font-medium text-sky-700 hover:underline">
        Back to the overview →
      </Link>
    </div>
  );
}
