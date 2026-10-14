import { formatMoney } from '@vca/commerce/money';

export const money = (minor: number, currency: string) => formatMoney(minor, currency);

export const dateTime = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(iso),
      )
    : '—';

/** "All currencies" display, e.g. "$680.00 · €20.00", or a dash when empty. */
export const amounts = (list: { formatted: string }[]) =>
  list.length ? list.map((a) => a.formatted).join(' · ') : '—';
