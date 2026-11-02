'use client';

import { useActionState, useState, useTransition } from 'react';
import {
  addAdmin,
  removeAdmin,
  setAdminActive,
  testAdmin,
  updateAdmin,
  type ActionState,
} from './actions';

export interface AdminView {
  id: string;
  name: string;
  phone: string | null;
  legacyId: string | null;
  linked: boolean;
  active: boolean;
  receiveReports: boolean;
  receiveAlerts: boolean;
  role: string;
  lastMessageAt: string | null;
}

const input =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-slate-500 focus:outline-none';
const button =
  'rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50';

function Notice({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
      {state.message}
    </p>
  );
}

function Fields({ admin }: { admin?: AdminView }) {
  return (
    <>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">Name</span>
        <input name="name" required maxLength={80} defaultValue={admin?.name} className={input} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">WhatsApp number</span>
        <input
          name="phone"
          required
          inputMode="tel"
          placeholder="+256 700 000000"
          defaultValue={admin?.phone ?? ''}
          className={input}
        />
      </label>
      <label className="block text-sm sm:col-span-2">
        <span className="mb-1 block font-medium text-slate-700">Role</span>
        <select name="role" defaultValue={admin?.role ?? 'STAFF'} className={input}>
          <option value="STAFF">Staff — orders, stock, tracking, reminders, reports</option>
          <option value="OWNER">
            Owner — also approves payment requests and dispute responses
          </option>
        </select>
      </label>
      <div className="flex flex-wrap gap-4 text-sm text-slate-700 sm:col-span-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="receiveReports"
            defaultChecked={admin?.receiveReports ?? true}
          />
          Business reports
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="receiveAlerts"
            defaultChecked={admin?.receiveAlerts ?? true}
          />
          Stock &amp; dispute alerts
        </label>
      </div>
    </>
  );
}

export function AddAdminForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(addAdmin, null);
  return (
    <form
      action={action}
      className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2"
    >
      <Fields key={state?.ok ? Math.random() : 'form'} />
      <div className="flex items-center gap-3 sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {pending ? 'Adding…' : 'Add admin'}
        </button>
        <Notice state={state} />
      </div>
    </form>
  );
}

export function AdminRow({ admin }: { admin: AdminView }) {
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<ActionState>(null);
  const [state, action, saving] = useActionState<ActionState, FormData>(async (prev, form) => {
    const result = await updateAdmin(prev, form);
    if (result?.ok) setEditing(false);
    return result;
  }, null);
  const run = (fn: () => Promise<ActionState>) => start(async () => setNotice(await fn()));

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-900">{admin.name}</span>
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                admin.active
                  ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
                  : 'bg-slate-100 text-slate-600 ring-slate-500/20'
              }`}
            >
              {admin.active ? 'Active' : 'Deactivated'}
            </span>
            <span className="text-xs text-slate-500">
              {admin.role === 'OWNER' ? 'Owner' : 'Staff'}
            </span>
          </div>
          <p className="mt-1 font-mono text-sm text-slate-700">
            {admin.phone ?? (
              <span className="text-slate-500">{admin.legacyId} (add a phone number)</span>
            )}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {[admin.receiveReports ? 'Reports' : null, admin.receiveAlerts ? 'Alerts' : null]
              .filter(Boolean)
              .join(' · ') || 'No notifications'}
            {' · '}
            {admin.lastMessageAt
              ? `Last message ${new Date(admin.lastMessageAt).toLocaleString('en-GB')}`
              : 'Has not messaged yet'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={button}
            disabled={pending}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? 'Cancel' : 'Edit'}
          </button>
          <button
            type="button"
            className={button}
            disabled={pending || !admin.active}
            onClick={() => run(() => testAdmin(admin.id))}
          >
            Send test
          </button>
          <button
            type="button"
            className={button}
            disabled={pending}
            onClick={() => run(() => setAdminActive(admin.id, !admin.active))}
          >
            {admin.active ? 'Deactivate' : 'Activate'}
          </button>
          <button
            type="button"
            disabled={pending}
            className="rounded-md border border-rose-200 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
            onClick={() => {
              if (
                window.confirm(
                  `Remove ${admin.name}? This number will no longer be able to use Katale AI.`,
                )
              )
                run(() => removeAdmin(admin.id));
            }}
          >
            Remove
          </button>
        </div>
      </div>
      {pending && <p className="mt-2 text-sm text-slate-500">Working…</p>}
      {!pending && (
        <div className="mt-2">
          <Notice state={notice} />
        </div>
      )}
      {editing && (
        <form
          action={action}
          className="mt-3 grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2"
        >
          <input type="hidden" name="id" value={admin.id} />
          <Fields admin={admin} />
          <div className="flex items-center gap-3 sm:col-span-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <Notice state={state} />
          </div>
        </form>
      )}
    </li>
  );
}
