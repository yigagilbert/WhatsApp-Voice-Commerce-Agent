import { formatMoney } from '@vca/commerce/money';

export const money = (minor: number, currency: string) => formatMoney(minor, currency);

/**
 * Dashboard times, in the shop's timezone (one merchant per installation). Without a fixed zone,
 * server-rendered pages used the server's UTC and grids the viewer's browser, so one event showed
 * two different times.
 */
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Kampala',
});

export const formatDateTime = (value: Date | string) => dateTimeFormat.format(new Date(value));

export const dateTime = (iso: string | null) => (iso ? formatDateTime(iso) : '—');

/** "All currencies" display, e.g. "$680.00 · €20.00", or a dash when empty. */
export const amounts = (list: { formatted: string }[]) =>
  list.length ? list.map((a) => a.formatted).join(' · ') : '—';
