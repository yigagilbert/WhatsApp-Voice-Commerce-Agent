'use client';

import { useActionState, useState, useTransition } from 'react';
import { changePassword, createAccount, updateAccount, type AccountState } from './actions';

export interface AccountView {
  id: string;
  username: string;
  name: string;
  role: 'OWNER' | 'STAFF';
  active: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
}

const input =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-slate-500 focus:outline-none';
const button =
  'rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50';

function Notice({ state }: { state: AccountState }) {
  if (!state) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
      {state.message}
    </p>
  );
}

function Field({
  label,
  name,
  type = 'text',
  autoComplete,
  hint,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  hint?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{label}</span>
      <input
        name={name}
        type={type}
        required
        autoComplete={autoComplete}
        minLength={type === 'password' && autoComplete === 'new-password' ? 12 : undefined}
        className={input}
      />
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState(changePassword, null);
  return (
    <form action={action} className="grid max-w-md gap-3">
      <Field
        label="Current password"
        name="current"
        type="password"
        autoComplete="current-password"
      />
      <Field
        label="New password"
        name="next"
        type="password"
        autoComplete="new-password"
        hint="At least 12 characters. A short sentence is easy to remember and hard to guess."
      />
      <Field
        label="Repeat the new password"
        name="confirm"
        type="password"
        autoComplete="new-password"
      />
      <div className="flex items-center gap-3">
        <button disabled={pending} className={button}>
          {pending ? 'Saving…' : 'Change password'}
        </button>
        <Notice state={state} />
      </div>
    </form>
  );
}

export function CreateAccountForm({ firstOwner }: { firstOwner: boolean }) {
  const [state, action, pending] = useActionState(createAccount, null);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <Field label="Name" name="name" autoComplete="off" />
      <Field label="Username" name="username" autoComplete="off" hint="Used to sign in." />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        hint="At least 12 characters."
      />
      <Field
        label="Repeat the password"
        name="confirm"
        type="password"
        autoComplete="new-password"
      />
      {!firstOwner && (
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block font-medium text-slate-700">Role</span>
          <select name="role" defaultValue="STAFF" className={input}>
            <option value="STAFF">Staff — day-to-day work (orders, payments, products)</option>
            <option value="OWNER">Owner — also manages accounts, admins and WhatsApp</option>
          </select>
        </label>
      )}
      <div className="flex items-center gap-3 sm:col-span-2">
        <button disabled={pending} className={button}>
          {pending ? 'Creating…' : firstOwner ? 'Create my owner account' : 'Create account'}
        </button>
        <Notice state={state} />
      </div>
    </form>
  );
}

export function AccountRow({ account, self }: { account: AccountView; self: boolean }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<AccountState>(null);
  const run = (change: Parameters<typeof updateAccount>[1], confirmText: string) => {
    if (!window.confirm(confirmText)) return;
    start(async () => setState(await updateAccount(account.id, change)));
  };
  const locked = account.lockedUntil && new Date(account.lockedUntil) > new Date();
  return (
    <li className="rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-slate-900">
            {account.name} <span className="text-slate-500">· {account.username}</span>
            {self && <span className="text-slate-500"> (you)</span>}
          </p>
          <p className="text-xs text-slate-500">
            {account.role === 'OWNER' ? 'Owner' : 'Staff'}
            {account.active ? '' : ' · deactivated'}
            {locked ? ' · locked after wrong passwords' : ''}
            {account.lastLoginAt
              ? ` · last sign-in ${new Date(account.lastLoginAt).toLocaleString('en-GB')}`
              : ' · never signed in'}
          </p>
        </div>
        {!self && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              className={button}
              onClick={() =>
                run(
                  { active: !account.active },
                  account.active
                    ? `Deactivate ${account.name}? They are signed out and can't sign in.`
                    : `Reactivate ${account.name}?`,
                )
              }
            >
              {account.active ? 'Deactivate' : 'Reactivate'}
            </button>
            <button
              type="button"
              disabled={pending}
              className={button}
              onClick={() =>
                run(
                  { role: account.role === 'OWNER' ? 'STAFF' : 'OWNER' },
                  account.role === 'OWNER'
                    ? `Make ${account.name} staff?`
                    : `Make ${account.name} an owner? Owners manage accounts, admins and WhatsApp.`,
                )
              }
            >
              {account.role === 'OWNER' ? 'Make staff' : 'Make owner'}
            </button>
            <button
              type="button"
              disabled={pending}
              className={button}
              onClick={() => {
                const password = window.prompt(
                  `New password for ${account.name} (at least 12 characters). They are signed out everywhere.`,
                );
                if (password)
                  start(async () => setState(await updateAccount(account.id, { password })));
              }}
            >
              Set password
            </button>
          </div>
        )}
      </div>
      <Notice state={state} />
    </li>
  );
}
