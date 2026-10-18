import { ErrorNotice, PageHeader, Section } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { AddAdminForm, AdminRow, type AdminView } from './admin-form';

export const dynamic = 'force-dynamic';

export default async function AdminsPage() {
  const result = await apiGet<AdminView[]>('/api/admins');
  return (
    <>
      <PageHeader
        title="Admins"
        description="WhatsApp numbers that can operate Katale AI. Only active admins can send commands or receive business information, reports and alerts; everyone else gets a generic welcome. Owners can also approve payment requests and dispute responses."
      />
      {!result.ok ? (
        <ErrorNotice message={result.error} />
      ) : (
        <div className="max-w-3xl space-y-6">
          <Section title={`Admin numbers (${result.data.filter((a) => a.active).length} active)`}>
            {result.data.length ? (
              <ul className="space-y-3">
                {result.data.map((admin) => (
                  <AdminRow key={admin.id} admin={admin} />
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">
                No admins yet. Add your own WhatsApp number below, then message the bot.
              </p>
            )}
          </Section>
          <Section title="Add an admin">
            <AddAdminForm />
            <p className="mt-2 text-xs text-slate-500">
              Use international format (+256…). Local numbers starting with 0 are read as Ugandan. A
              number can be an admin for one business only.
            </p>
          </Section>
        </div>
      )}
    </>
  );
}
