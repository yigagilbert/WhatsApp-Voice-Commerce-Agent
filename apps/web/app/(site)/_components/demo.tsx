'use client';

import { useId, useRef, useState, type KeyboardEvent } from 'react';
import s from '../site.module.css';
import { Conversation } from './conversation';
import { demoScripts } from './scripts';

/** Tabs of example conversations; choosing one plays it. Arrow keys move between tabs. */
export function Demo() {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (active + step + demoScripts.length) % demoScripts.length;
    setActive(next);
    tabs.current[next]?.focus();
  };
  const script = demoScripts[active]!;
  return (
    <div>
      <div
        role="tablist"
        aria-label="Example conversations"
        onKeyDown={onKey}
        className="mx-auto flex w-fit max-w-full flex-wrap justify-center gap-1 rounded-2xl border sm:rounded-full border-[var(--line)] bg-[var(--surface)] p-1"
      >
        {demoScripts.map((d, i) => (
          <button
            key={d.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${d.id}`}
            aria-selected={i === active}
            aria-controls={`${id}-panel`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            className={s.tab}
          >
            {d.label}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${script.id}`}
        className="mx-auto mt-8 max-w-md"
      >
        <Conversation key={script.id} script={script} height={620} />
      </div>
    </div>
  );
}
