import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-xl border border-slate-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-slate-900">Page not found</h2>
      <p className="mt-1 text-sm text-slate-600">This page doesn&apos;t exist or was moved.</p>
      <div className="mt-4 flex gap-4 text-sm font-medium">
        <Link href="/" className="text-green-700 hover:underline">
          Homepage
        </Link>
        <Link href="/overview" className="text-green-700 hover:underline">
          Merchant dashboard
        </Link>
      </div>
    </div>
  );
}
