'use client';

import { useActionState, useState, useTransition } from 'react';
import {
  connectShopNumber,
  resumeCustomer,
  saveShopSettings,
  type ShopActionState,
} from './actions';

export interface ShopAccount {
  id: string;
  number: string;
  active: boolean;
  customerCommerceEnabled: boolean;
  paymentLinkMode: 'AUTO' | 'APPROVAL';
  handoffHours: number;
  shopInfo: string | null;
}

export interface ShopView {
  available: boolean;
  bot: {
    number: string;
    connectedToThisBusiness: boolean;
    connectedToAnotherBusiness: boolean;
  } | null;
  accounts: ShopAccount[];
}

export interface CustomerChat {
  customerId: string | null;
  customer: string;
  waitingForPerson: boolean;
  lastMessageAt: string;
}

function Notice({ state }: { state: ShopActionState }) {
  if (!state) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
      {state.message}
    </p>
  );
}

const field =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none';

export function ConnectShopNumber({ view }: { view: ShopView }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<ShopActionState>(null);
  if (!view.bot) return <p className="text-sm text-slate-600">Pair the bot above first.</p>;
  if (view.bot.connectedToAnotherBusiness)
    return (
      <p className="text-sm text-rose-700">
        This WhatsApp number ({view.bot.number}) is connected to another business. Each shop needs
        its own number.
      </p>
    );
  if (view.bot.connectedToThisBusiness) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => setState(await connectShopNumber()))}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? 'Connecting…' : `Use ${view.bot.number} as this shop's number`}
      </button>
      <Notice state={state} />
    </div>
  );
}

export function ShopSettingsForm({
  account,
  available,
}: {
  account: ShopAccount;
  available: boolean;
}) {
  const [state, action, pending] = useActionState<ShopActionState, FormData>(
    saveShopSettings,
    null,
  );
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={account.id} />
      <label className="flex items-start gap-2 text-sm text-slate-800">
        <input
          type="checkbox"
          name="customerCommerceEnabled"
          defaultChecked={account.customerCommerceEnabled}
          disabled={!available}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Let customers shop on this number</span>
          <span className="block text-xs text-slate-500">
            {available
              ? 'Customers can browse products, see photos and prices, ask questions and ask for a person. Admin numbers keep the admin assistant.'
              : 'Not available on this server yet (CUSTOMER_COMMERCE_ENABLED is off). Customers get the generic welcome.'}
          </span>
        </span>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">
            Payment links (ordering, coming next)
          </span>
          <select name="paymentLinkMode" defaultValue={account.paymentLinkMode} className={field}>
            <option value="AUTO">Send automatically when the customer confirms</option>
            <option value="APPROVAL">Ask an admin to approve first</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">
            Pause automated replies after a hand-off
          </span>
          <span className="flex items-center gap-2">
            <input
              type="number"
              name="handoffHours"
              min={1}
              max={168}
              defaultValue={account.handoffHours}
              className={`${field} w-24`}
            />
            <span className="text-slate-600">hours</span>
          </span>
        </label>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">
          Shop information for customers
        </span>
        <textarea
          name="shopInfo"
          rows={5}
          maxLength={2000}
          defaultValue={account.shopInfo ?? ''}
          placeholder="Opening hours, delivery areas and fees, how payment works, returns, contact…"
          className={field}
        />
        <span className="mt-1 block text-xs text-slate-500">
          Katale AI answers shop questions only from this text and your catalog.
        </span>
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        <Notice state={state} />
      </div>
    </form>
  );
}

export function CustomerChats({ chats }: { chats: CustomerChat[] }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<ShopActionState>(null);
  if (!chats.length) return <p className="text-sm text-slate-600">No customer messages yet.</p>;
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {chats.map((c) => (
          <li
            key={c.customerId ?? c.customer}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
          >
            <span>
              <span className="font-medium text-slate-900">{c.customer}</span>{' '}
              <span className="text-xs text-slate-500">
                {new Date(c.lastMessageAt).toLocaleString('en-GB')}
              </span>
            </span>
            {c.waitingForPerson && c.customerId ? (
              <span className="flex items-center gap-2">
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20">
                  Waiting for a person
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => start(async () => setState(await resumeCustomer(c.customerId!)))}
                  className="rounded-md border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  Resume bot
                </button>
              </span>
            ) : (
              <span className="text-xs text-slate-500">Bot answering</span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-500">
        Reply to a customer from your admin WhatsApp: “reply to Sarah: …”.
      </p>
      <Notice state={state} />
    </div>
  );
}
