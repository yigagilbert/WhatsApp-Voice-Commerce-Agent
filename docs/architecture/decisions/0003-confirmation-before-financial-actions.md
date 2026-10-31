# 0003 — Financial actions require explicit, bound confirmation

**Status:** Accepted · 2026-10-05

## Context

LLMs misinterpret, hallucinate and can be prompt-injected (e.g. via a customer's message or a
transcribed voice note). Creating payment requests, sending invoices, capturing or refunding
money must never be the direct result of a model output.

## Decision

- Tools are classified `read`, `write` (non-financial) or `propose`. No tool executes a payment.
- A `propose` tool creates an `ActionConfirmation` bound to **merchant + conversation + action +
  payload (SHA-256 of canonical JSON) + expiry + 4-digit code**. Only one can be pending per
  conversation; a new proposal supersedes the old one.
- Confirm/cancel replies are recognised by **deterministic code**, not the LLM. Every action needs
  its code (`CONFIRM 4821`, `SHIP 4821`, …); a bare "yes" is answered with the exact reply to type
  (since 2026-10-31 this includes payment requests, which previously accepted a bare "yes").
- Claiming is atomic (`PENDING → CONFIRMED` conditional update), so duplicates cannot double-execute.
- Before execution the executor re-loads the order, checks it still matches the confirmed
  payload, and re-runs policy checks.

## Consequences

- One extra message round-trip for the merchant — acceptable, and it is the demo's trust story.
- New sensitive actions plug into the same mechanism by adding a `ConfirmationAction` and an executor handler.
