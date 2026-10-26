import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { safeNextPath } from '@/lib/session';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; expired?: string; created?: string }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  // After a session ended at the API the cookie may still look valid: show the form, don't loop.
  const expired = params.expired === '1';
  if (!expired && (await currentUser())) redirect(next);
  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Katale AI</h1>
        <p className="mb-6 mt-1 text-sm text-slate-500">Sign in to the merchant dashboard.</p>
        {params.created === '1' && (
          <p
            role="status"
            className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
          >
            Your owner account is ready. Sign in with it; the shared setup login no longer works.
          </p>
        )}
        {expired && (
          <p role="status" className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Your session has ended. Please sign in again.
          </p>
        )}
        <LoginForm next={next} />
      </div>
    </div>
  );
}
