# 0006 — Money as integer minor units

**Status:** Accepted · 2026-10-05

## Decision

All amounts are stored and computed as integers in the currency's minor unit (`*Minor` columns)
with an ISO-4217 `currency`. Conversions (`toMinorUnits`, `toMajorString`) are string-based and
reject excess precision instead of rounding. PayPal receives decimal strings produced from integers.

## Consequences

- No floating-point drift; equality checks on amounts are exact.
- `Int` columns cap a single amount at ~21 million USD — far beyond the hackathon's needs; switch to
  `BigInt` if large zero-decimal currencies need it.
- Zero-decimal currencies (JPY, UGX, ...) are handled by an exponent table.
