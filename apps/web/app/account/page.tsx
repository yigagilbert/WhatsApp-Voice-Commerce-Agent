import { ErrorNotice, PageHeader, Section } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { BOOTSTRAP_USER_ID } from '@/lib/session';
import {
  AccountRow,
  ChangePasswordForm,
  CreateAccountForm,
  type AccountView,
} from './account-forms';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const user = await requireUser();
  const bootstrap = user.id === BOOTSTRAP_USER_ID;

  if (bootstrap) {
    return (
      <>
        <PageHeader
          title="Create your owner account"
          description="You signed in with the shared setup login. Create your personal owner account now: once it exists, the shared login stops working and everyone signs in with their own account."
        />
        <div className="max-w-2xl">
          <Section title="Your owner account">
            <CreateAccountForm firstOwner />
            <p className="mt-3 text-xs text-slate-500">
              After creating it you are signed out; sign in again with the new username and
              password. Add staff accounts afterwards from this page.
            </p>
          </Section>
        </div>
      </>
    );
  }

  const accounts =
    user.role === 'OWNER' ? await apiGet<AccountView[]>('/api/dashboard-users') : null;
  return (
    <>
      <PageHeader
        title="Account"
        description={`Signed in as ${user.name} (${user.username}) · ${user.role === 'OWNER' ? 'owner' : 'staff'}.`}
      />
      <div className="max-w-3xl space-y-6">
        <Section title="Change your password">
          <ChangePasswordForm />
        </Section>
        {accounts &&
          (!accounts.ok ? (
            <ErrorNotice message={accounts.error} />
          ) : (
            <>
              <Section
                title={`Dashboard accounts (${accounts.data.filter((a) => a.active).length} active)`}
              >
                <ul className="space-y-3">
                  {accounts.data.map((a) => (
                    <AccountRow key={a.id} account={a} self={a.id === user.id} />
                  ))}
                </ul>
                <p className="mt-2 text-xs text-slate-500">
                  Staff can work with orders, payments, products and customers. Owners can also
                  manage accounts, WhatsApp admins, report schedules and the WhatsApp connection.
                </p>
              </Section>
              <Section title="Add an account">
                <CreateAccountForm firstOwner={false} />
              </Section>
            </>
          ))}
      </div>
    </>
  );
}
