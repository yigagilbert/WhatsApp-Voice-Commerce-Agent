/**
 * The few pages a buyer sees after PayPal: success, still processing, declined, cancelled.
 * Server-rendered, no scripts, no tracking. They show only what the buyer needs (merchant,
 * order reference, amount, status) — never PayPal payloads, capture IDs or trace IDs.
 */

export type BuyerPageTone = 'success' | 'pending' | 'error' | 'neutral';

export interface BuyerPageDetails {
  merchant?: string | undefined;
  reference?: string | undefined;
  amount?: string | undefined;
}

export interface BuyerPage {
  tone: BuyerPageTone;
  title: string;
  message: string;
  details?: BuyerPageDetails | undefined;
  /** Optional call to action, e.g. back to the PayPal checkout after a cancel. */
  action?: { label: string; href: string } | undefined;
  footnote?: string | undefined;
  sandbox?: boolean;
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

const ICONS: Record<BuyerPageTone, string> = {
  success: '<path d="M5 12.5l4.5 4.5L19 7.5" />',
  pending: '<path d="M12 7v5l3 2" /><circle cx="12" cy="12" r="8.5" />',
  error: '<path d="M7 7l10 10M17 7L7 17" />',
  neutral: '<path d="M12 8v5" /><path d="M12 16.5v.01" />',
};

const STYLES = `
:root{--bg:#f6f7f9;--card:#fff;--text:#0f172a;--muted:#64748b;--line:#e2e8f0;--accent:#0f172a;
--success:#047857;--success-bg:#ecfdf5;--pending:#b45309;--pending-bg:#fffbeb;--error:#b91c1c;--error-bg:#fef2f2;--neutral:#334155;--neutral-bg:#f1f5f9}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#111827;--text:#f1f5f9;--muted:#94a3b8;--line:#1f2937;--accent:#f1f5f9;
--success:#34d399;--success-bg:#064e3b55;--pending:#fbbf24;--pending-bg:#78350f55;--error:#f87171;--error-bg:#7f1d1d55;--neutral:#cbd5e1;--neutral-bg:#1e293b}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);
font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px 28px}
.icon{width:48px;height:48px;border-radius:999px;display:grid;place-items:center;margin-bottom:20px}
.icon svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.success{color:var(--success);background:var(--success-bg)}.pending{color:var(--pending);background:var(--pending-bg)}
.error{color:var(--error);background:var(--error-bg)}.neutral{color:var(--neutral);background:var(--neutral-bg)}
h1{font-size:22px;line-height:1.25;margin:0 0 8px;letter-spacing:-.01em}p{margin:0;color:var(--muted)}
dl{margin:24px 0 0;border-top:1px solid var(--line)}dl div{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--line)}
dt{color:var(--muted)}dd{margin:0;font-weight:600;text-align:right;font-variant-numeric:tabular-nums}
a.button{display:block;margin-top:24px;padding:12px 16px;border-radius:10px;background:var(--accent);color:var(--card);text-align:center;font-weight:600;text-decoration:none}
.foot{margin-top:24px;font-size:13px}.brand{margin-top:28px;display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted)}
.brand strong{color:var(--text);font-weight:600}.badge{border:1px solid var(--line);border-radius:999px;padding:2px 8px}
`;

export function renderBuyerPage(page: BuyerPage): string {
  const d = page.details ?? {};
  const rows = [
    ['Merchant', d.merchant],
    ['Order', d.reference],
    ['Amount', d.amount],
  ].filter((row): row is [string, string] => !!row[1]);
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(page.title)} · Katale AI</title><style>${STYLES}</style></head><body><main>`,
    `<div class="icon ${page.tone}" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[page.tone]}</svg></div>`,
    `<h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.message)}</p>`,
    rows.length
      ? `<dl>${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>`
      : '',
    page.action
      ? `<a class="button" href="${escapeHtml(page.action.href)}">${escapeHtml(page.action.label)}</a>`
      : '',
    page.footnote ? `<p class="foot">${escapeHtml(page.footnote)}</p>` : '',
    `<div class="brand"><span>Payments by PayPal · <strong>Katale AI</strong></span>${page.sandbox ? '<span class="badge">PayPal Sandbox · test payment</span>' : ''}</div>`,
    '</main></body></html>',
  ].join('');
}
