'use client';

import type { AgAiChatMessage, AgAiChatSession, AgAiHarness } from 'ag-studio';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { PROMPT_STARTERS, toolLabel } from './prompts';

/**
 * The conversation, available on the everyday view. AG Studio only offers its own AI panel in edit
 * mode, which is more than most merchants want and doesn't fit a phone, so this renders the same
 * harness session in a sheet. It holds no conversation state and adds no AI logic of its own.
 */
export function AskPanel({
  harness,
  open,
  pending,
  onPendingSent,
  onClose,
}: {
  harness: AgAiHarness | null;
  open: boolean;
  /** A question typed in the bar on the page, to send once the panel has a session. */
  pending: string | null;
  onPendingSent: () => void;
  onClose: () => void;
}) {
  const [session, setSession] = useState<AgAiChatSession | null>(null);
  const [messages, setMessages] = useState<readonly AgAiChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const sessionRef = useRef<AgAiChatSession | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const ask = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || !harness) return;
      setFailed(false);
      let live = sessionRef.current;
      if (!live) {
        const agentId = harness.agents[0]?.id;
        if (!agentId) return;
        live = await harness.createThread({ agentId });
        const current = live;
        sessionRef.current = current;
        setSession(current);
        current.addEventListener('changed', () => {
          setMessages(current.messages);
          setRunning(current.status === 'running');
          setFailed(current.status === 'error');
        });
      }
      setRunning(true);
      live.sendMessage(question);
    },
    [harness],
  );

  useEffect(() => {
    if (!pending || !harness) return;
    onPendingSent();
    void ask(pending);
  }, [pending, harness, ask, onPendingSent]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, running]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask(draft);
    setDraft('');
  };

  return (
    <aside
      aria-label="Ask Katale AI"
      aria-hidden={!open}
      inert={!open}
      className={`fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-mist bg-white transition-transform duration-200 ease-out sm:w-[420px] ${
        open ? 'translate-x-0 shadow-2xl' : 'invisible translate-x-full'
      }`}
    >
      <header className="flex items-center justify-between border-b border-mist px-5 py-4">
        <div>
          <h2 className="font-display text-base font-semibold text-charcoal">Ask Katale AI</h2>
          <p className="text-xs text-slate-500">Answers from your records. It can't move money.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-9 w-9 place-items-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-900"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4" aria-live="polite">
        {!session && (
          <div>
            <p className="text-sm text-slate-600">Try one of these, or ask your own question.</p>
            <ul className="mt-3 space-y-2">
              {PROMPT_STARTERS.map((starter) => (
                <li key={starter.label}>
                  <button
                    type="button"
                    onClick={() => void ask(starter.prompt)}
                    className="w-full rounded-lg border border-mist px-3 py-2 text-left text-sm text-charcoal transition-colors hover:border-leaf-200 hover:bg-leaf-50"
                  >
                    {starter.prompt}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className={message.role === 'user' ? 'flex justify-end' : ''}>
            {message.role === 'user' ? (
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-leaf-800 px-3.5 py-2 text-sm text-white">
                {message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}
              </p>
            ) : (
              <div className="space-y-2">
                {message.parts.map((part, index) => {
                  if (part.type === 'text' && part.text.trim())
                    return (
                      <p
                        key={index}
                        className="whitespace-pre-wrap text-sm leading-6 text-charcoal"
                      >
                        {part.text.replace(/\*\*/g, '')}
                      </p>
                    );
                  if (part.type === 'tool_call')
                    return (
                      <p key={index} className="flex items-center gap-2 text-xs text-slate-500">
                        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-leaf-500" />
                        {toolLabel(part.toolCall.name, part.toolCall.status)}
                      </p>
                    );
                  if (part.type === 'error')
                    return (
                      <p key={index} role="alert" className="text-sm text-amber-800">
                        The assistant couldn't finish that. Please try again.
                      </p>
                    );
                  return null;
                })}
              </div>
            )}
          </div>
        ))}

        {running && (
          <p className="flex items-center gap-2 text-xs text-slate-500">
            <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-lime" />
            Working on it…
          </p>
        )}
        {failed && (
          <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            The assistant is unavailable right now. Your dashboard figures are unaffected.
          </p>
        )}
        <div ref={endRef} />
      </div>

      <form onSubmit={submit} className="flex gap-2 border-t border-mist p-3">
        <label htmlFor="ask-followup" className="sr-only">
          Ask a question
        </label>
        <input
          id="ask-followup"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={session ? 'Ask a follow-up…' : 'Ask about your business…'}
          className="min-w-0 flex-1 rounded-full border border-mist px-4 py-2.5 text-base outline-none focus:border-leaf-500 focus:ring-2 focus:ring-leaf-100 sm:text-sm"
        />
        <button
          type="submit"
          disabled={!draft.trim() || running}
          className="rounded-full bg-leaf-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-leaf-800 disabled:opacity-40"
        >
          Ask
        </button>
      </form>
    </aside>
  );
}
