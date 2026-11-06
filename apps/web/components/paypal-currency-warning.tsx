import { payPalCurrencyProblem } from '@/lib/setup-checklist';

/** Shown wherever a shop's currency appears, for currencies PayPal can't take payment in. */
export function PayPalCurrencyWarning({ currency }: { currency: string | null | undefined }) {
  const problem = payPalCurrencyProblem(currency);
  if (!problem) return null;
  return (
    <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {problem}
    </p>
  );
}
