'use client';

import Image from 'next/image';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import logo from '@/components/katale-logo.png';
import s from '../site.module.css';
import type { ChatMessage, ChatScript } from './scripts';

/** WhatsApp formatting: *bold* only. */
function formatted(text: string): ReactNode {
  return text
    .split(/(\*[^*\n]+\*)/g)
    .map((part, i) =>
      part.startsWith('*') && part.endsWith('*') && part.length > 2 ? (
        <strong key={i}>{part.slice(1, -1)}</strong>
      ) : (
        <Fragment key={i}>{part}</Fragment>
      ),
    );
}

const WAVE = [6, 12, 18, 10, 20, 14, 8, 16, 22, 12, 6, 14, 18, 10, 16, 8, 12, 20, 10, 6, 14, 9];

/** A seven-day revenue chart, like the image Katale sends (sample figures). */
function ChartImage() {
  const days = [38, 52, 44, 71, 63, 86, 58];
  const labels = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'];
  const max = Math.max(...days);
  return (
    <svg
      viewBox="0 0 240 140"
      role="img"
      aria-label="Bar chart of revenue per day over the last 7 days"
      className="mb-1 w-60 max-w-full rounded-lg bg-white"
    >
      <text x="12" y="20" fontSize="10" fontWeight="600" fill="#1c2329">
        Revenue per day · last 7 days
      </text>
      {days.map((v, i) => {
        const h = (v / max) * 82;
        return (
          <g key={i}>
            <rect
              x={16 + i * 31}
              y={118 - h}
              width="20"
              height={h}
              rx="3"
              fill={i === 5 ? '#0a8a3a' : '#9fdc8a'}
            />
            <text x={26 + i * 31} y="132" fontSize="8" textAnchor="middle" fill="#6f7d76">
              {labels[i]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Stand-in for the product photo the shop uploaded: a woven basket. */
function ProductPhoto() {
  return (
    <svg
      viewBox="0 0 220 150"
      role="img"
      aria-label="Product photo: a handmade woven basket"
      className="mb-1 w-56 max-w-full rounded-lg"
    >
      <defs>
        <pattern id="weave" width="12" height="12" patternUnits="userSpaceOnUse">
          <rect width="12" height="12" fill="#c98a3c" />
          <path d="M0 6h12M6 0v12" stroke="#a96f2a" strokeWidth="3" />
        </pattern>
      </defs>
      <rect width="220" height="150" fill="#efe6d6" />
      <ellipse cx="110" cy="128" rx="70" ry="8" fill="#d9cbb3" />
      <path d="M48 62h124l-14 64H62z" fill="url(#weave)" />
      <ellipse cx="110" cy="62" rx="62" ry="12" fill="#b77a32" />
      <ellipse cx="110" cy="60" rx="54" ry="8" fill="#7d5121" />
    </svg>
  );
}

function Message({ m }: { m: ChatMessage }) {
  return (
    <div className={s.row} data-from={m.from}>
      <div className={s.bubble}>
        {m.kind === 'voice' ? (
          <>
            <span className={s.voice} aria-label="Voice note, 0:07">
              <span className={s.voicePlay} />
              <span className={s.wave} aria-hidden>
                {WAVE.map((h, i) => (
                  <i key={i} style={{ height: h }} />
                ))}
              </span>
              <span className="text-[0.7rem] text-[var(--ink-3)]">0:07</span>
            </span>
            <span className={s.transcript}>“{m.text}”</span>
          </>
        ) : m.kind === 'chart' ? (
          <>
            <ChartImage />
            {formatted(m.text)}
          </>
        ) : m.kind === 'photo' ? (
          <>
            <ProductPhoto />
            {formatted(m.text)}
          </>
        ) : (
          formatted(m.text)
        )}
        <span className={s.time}>{m.time}</span>
      </div>
      {m.note && <span className={s.note}>{m.note}</span>}
    </div>
  );
}

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A WhatsApp conversation that plays message by message once it scrolls into view (the bot
 * "types" first). With reduced motion it is shown complete. Replays when `script` changes.
 */
export function Conversation({
  script,
  height = 560,
  autoplay = true,
}: {
  script: ChatScript;
  height?: number;
  autoplay?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  // The first message is in the server-rendered page, so the phone is never empty.
  const [shown, setShown] = useState(1);
  const [typing, setTyping] = useState(false);
  const [run, setRun] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => entry?.isIntersecting && setVisible(true), {
      threshold: 0.35,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !autoplay) return;
    if (reducedMotion()) {
      setShown(script.messages.length);
      setTyping(false);
      return;
    }
    setShown(0);
    setTyping(false);
    const timers: number[] = [];
    // The first message appears at once, so the phone is never empty.
    let t = 0;
    script.messages.forEach((m, i) => {
      if (m.from === 'bot') {
        timers.push(window.setTimeout(() => setTyping(true), t));
        t += 900 + Math.min(900, m.text.length * 6);
      } else if (i > 0) {
        t += 650;
      }
      timers.push(
        window.setTimeout(() => {
          setTyping(false);
          setShown(i + 1);
        }, t),
      );
      t += 450;
    });
    return () => timers.forEach(clearTimeout);
  }, [script, visible, autoplay, run]);

  const done = shown >= script.messages.length;
  return (
    <div ref={root} className={s.phone} style={{ height }}>
      <div className={s.chatHeader}>
        <span className="grid size-9 place-items-center rounded-full bg-[var(--leaf-soft)]">
          <Image src={logo} alt="" unoptimized className="h-6 w-auto" />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm font-semibold">{script.title}</span>
          <span className="block truncate text-xs text-[var(--ink-3)]">
            {typing ? 'typing…' : script.subtitle}
          </span>
        </span>
        <button
          type="button"
          onClick={() => setRun((r) => r + 1)}
          disabled={!done}
          className={`${s.link} text-xs font-medium disabled:opacity-0`}
        >
          Replay
        </button>
      </div>
      <div className={s.chatBody}>
        {script.messages.slice(0, shown).map((m, i) => (
          <Message key={`${script.id}-${run}-${i}`} m={m} />
        ))}
        {typing && (
          <div className={s.typing} aria-label="Katale AI is typing">
            <i />
            <i />
            <i />
          </div>
        )}
      </div>
    </div>
  );
}
