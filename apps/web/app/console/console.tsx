'use client';

import { useState, useTransition } from 'react';
import { sendConsoleMessage } from './actions';
import { MessageText } from './message-text';

interface Line {
  id: number;
  from: 'you' | 'agent' | 'error';
  text: string;
  /** Chart image (data URL) sent with the reply. */
  image?: string;
}

const EXAMPLES = [
  'Create an order for Sarah for 10 handmade baskets at $12 each and $20 shipping.',
  'How much have I sold this week?',
  'Which products are running low?',
  'Send me a chart of revenue for the last 7 days.',
];

/** Text console for the same agent pipeline WhatsApp uses (channel "web"). */
export function Console() {
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, startTransition] = useTransition();
  const [pendingLabel, setPendingLabel] = useState('Agent is thinking…');

  const send = (text: string) => {
    if (!text.trim() || pending) return;
    setLines((l) => [...l, { id: Date.now(), from: 'you', text }]);
    setDraft('');
    setPendingLabel(
      /^\s*(confirm|yes|ok)\b/i.test(text) ? 'Creating payment request…' : 'Agent is thinking…',
    );
    startTransition(async () => {
      const result = await sendConsoleMessage(text);
      setLines((l) => [
        ...l,
        ...(result.ok
          ? result.replies.map((r, i) => ({
              id: Date.now() + i + 1,
              from: 'agent' as const,
              text: r.text,
              ...(r.image ? { image: r.image } : {}),
            }))
          : [{ id: Date.now() + 1, from: 'error' as const, text: result.error }]),
      ]);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="min-h-64 space-y-3 rounded-lg border border-slate-200 bg-white p-4">
        {lines.length === 0 && (
          <p className="text-sm text-slate-500">
            Try one of the examples below, or type “confirm 1234” to approve a pending request.
          </p>
        )}
        {lines.map((line) => (
          <div
            key={line.id}
            className={line.from === 'you' ? 'flex justify-end' : 'flex justify-start'}
          >
            <p
              className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                line.from === 'you'
                  ? 'bg-slate-900 text-white'
                  : line.from === 'error'
                    ? 'bg-amber-50 text-amber-900'
                    : 'bg-slate-100 text-slate-900'
              }`}
            >
              {line.image && (
                // eslint-disable-next-line @next/next/no-img-element -- inline data URL chart, not optimisable
                <img
                  src={line.image}
                  alt={line.text}
                  className="mb-2 w-full max-w-md rounded border border-slate-200"
                />
              )}
              {line.from === 'agent' ? <MessageText text={line.text} /> : line.text}
            </p>
          </div>
        ))}
        {pending && <p className="text-sm text-slate-400">{pendingLabel}</p>}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <label htmlFor="console-input" className="sr-only">
          Message
        </label>
        <input
          id="console-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message the commerce agent…"
          className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
        <button
          disabled={pending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Send
        </button>
      </form>
      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => send(example)}
            className="rounded-full border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-100"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}
