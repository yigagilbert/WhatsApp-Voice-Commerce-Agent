# 0007 — Capture on buyer return, with the webhook as a fallback

**Status:** Accepted · 2026-10-05

## Context

With PayPal Orders v2 (`intent: CAPTURE`) the buyer approves on PayPal, then the **merchant
must capture** the order. PayPal tells us about approval in two ways: the browser redirect to
`return_url` (`?token=<order id>&PayerID=…`) and the `CHECKOUT.ORDER.APPROVED` webhook. Local
development usually has no public URL, so webhooks can't reach the API.

## Decision

- **Primary (local demo and production):** `GET /api/paypal/return` captures server-side. It
  trusts only PayPal's own order state — never amounts in the query string.
- **Fallback (deployed):** the `CHECKOUT.ORDER.APPROVED` webhook calls the same
  `PaymentService.captureApproved`. If the buyer closes the tab before the redirect, the
  webhook still completes the payment.
- **Confirmation of money movement:** a capture result of `COMPLETED`, or the
  `PAYMENT.CAPTURE.COMPLETED` webhook. A `PENDING` capture leaves the payment `APPROVED` until the webhook arrives.

Capture is idempotent in three layers:

1. Only `CREATED`/`APPROVED` payments are captured locally.
2. `PayPal-Request-Id: capture-<paymentId>` — PayPal replays the original result for repeats.
3. `ORDER_ALREADY_CAPTURED` → re-read the order (`GET /v2/checkout/orders/{id}`) and sync.

`markCompleted` uses a conditional update (`status IN (CREATED, APPROVED)`), so exactly one
caller transitions the payment, marks the order `PAID`, audits it and notifies the merchant.

## Consequences

- The local Sandbox demo works without a tunnel.
- The return page shows the real outcome (paid / processing / declined).
- Webhooks remain necessary for production robustness and for refunds and reversals.
