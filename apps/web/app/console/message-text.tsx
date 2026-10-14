import { Fragment, type ReactNode } from 'react';

/** Only PayPal checkout links become buttons — never arbitrary URLs from model output. */
function paypalCheckoutUrl(text: string): URL | null {
  try {
    const url = new URL(text.trim());
    const host = url.hostname;
    return url.protocol === 'https:' && (host === 'paypal.com' || host.endsWith('.paypal.com'))
      ? url
      : null;
  } catch {
    return null;
  }
}

/** Renders WhatsApp-style *bold* without using dangerouslySetInnerHTML. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*[^*\n]+\*|\b_[^_\n]+_\b)/g).map((part, i) => {
    if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
      return <strong key={i}>{part.slice(1, -1)}</strong>;
    }
    if (part.length > 2 && part.startsWith('_') && part.endsWith('_')) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/**
 * Agent reply formatting for the console: bold/italic text, and a PayPal checkout URL line rendered as
 * a checkout button. The text itself is produced by the backend (ConfirmationExecutor).
 */
export function MessageText({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => {
        // A PayPal URL on its own line (optionally "Payment link: <url>") becomes a button.
        const match = /^(?:Payment link:\s*)?(https:\/\/\S+)$/.exec(line.trim());
        const url = match?.[1] ? paypalCheckoutUrl(match[1]) : null;
        if (url) {
          const sandbox = url.hostname.includes('sandbox');
          return (
            <span key={i} className="my-2 block">
              <a
                href={url.toString()}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center rounded-md bg-[#0070ba] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#005ea6]"
              >
                Open PayPal {sandbox ? 'Sandbox ' : ''}Checkout ↗
              </a>
            </span>
          );
        }
        return (
          <Fragment key={i}>
            {inline(line)}
            {'\n'}
          </Fragment>
        );
      })}
    </>
  );
}
