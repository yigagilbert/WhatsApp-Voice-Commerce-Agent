import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { safeNextPath } from '@/lib/session';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);
  if (await currentUser()) redirect(next);
  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Katale AI</h1>
        <p className="mb-6 mt-1 text-sm text-slate-500">Sign in to the merchant dashboard.</p>
        <LoginForm next={next} />
      </div>
    </div>
  );
}
