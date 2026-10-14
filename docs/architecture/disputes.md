# PayPal disputes

Katale AI watches PayPal disputes, links them to the order, payment and shipment they concern,
gathers the evidence Katale actually holds, drafts a factual response, and submits it to PayPal
**only** after the merchant replies `SUBMIT <code>`.

```text
PayPal: CUSTOMER.DISPUTE.CREATED / UPDATED / RESOLVED
   → webhook signature verified → event stored once (provider + event ID)
   → GET /v1/customer/disputes/{id}   (the webhook body is only a trigger)
   → link: disputed seller_transaction_id = Katale Payment.captureId → payment → order
   → store/update Dispute → audit dispute.opened / updated / resolved
   → WhatsApp: "⚠️ New PayPal dispute" (only for new / needs response / resolved; once each)

Merchant: "Review Sarah's dispute"           → get_dispute: facts, missing evidence, suggested response
Merchant: "Prepare a response"               → prepare_dispute_response (draft only)
   → backend drafts from verified records (or fact-checks the merchant's wording)
   → "Proposed dispute response … Reply SUBMIT 7312 to send this response to PayPal."
Merchant: SUBMIT 7312
   → re-read the dispute at PayPal: still WAITING_FOR_SELLER_RESPONSE (or provide_evidence link)?
   → POST /v1/customer/disputes/{id}/provide-evidence → DisputeResponse SUBMITTED → audit
   → "✅ Dispute response submitted … Evidence sent: Order details, Shipment tracking"
```

## PayPal API (validated against PayPal's official OpenAPI spec)

Source: `paypal/paypal-rest-api-specifications` → `openapi/customer_disputes_v1.json`; dispute testing
guide (developer.paypal.com/disputes/test-go-live). The official TypeScript server SDK does not
cover disputes, so Katale's REST client implements the calls.

| Endpoint                                                                                        | Use in Katale                                                                                                           |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/customer/disputes`                                                                     | Refresh / reconciliation (dashboard "Refresh from PayPal", `refresh_disputes` tool, `pnpm paypal:dispute list`)         |
| `GET /v1/customer/disputes/{id}`                                                                | Canonical details on every webhook and before every submission                                                          |
| `POST /v1/customer/disputes/{id}/provide-evidence`                                              | Merchant-approved response (multipart: `input` JSON part with `evidences[]`)                                            |
| `POST /v1/customer/disputes/{id}/require-evidence`                                              | **Sandbox only**, test tooling: `UNDER_REVIEW` → `WAITING_FOR_SELLER_RESPONSE` (`pnpm paypal:dispute require-evidence`) |
| accept-claim, make-offer, accept-offer, send-message, appeal, escalate, acknowledge-return-item | **Not used** (refunds, offers, concessions are out of scope)                                                            |

Enums stored as PayPal sends them:

| Field                      | Values                                                                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                   | `OPEN`, `WAITING_FOR_BUYER_RESPONSE`, `WAITING_FOR_SELLER_RESPONSE`, `UNDER_REVIEW`, `RESOLVED`, `OTHER`                                                                                                                                                          |
| `reason`                   | `MERCHANDISE_OR_SERVICE_NOT_RECEIVED`, `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED`, `UNAUTHORISED`, `CREDIT_NOT_PROCESSED`, `DUPLICATE_TRANSACTION`, `INCORRECT_AMOUNT`, `PAYMENT_BY_OTHER_MEANS`, `CANCELED_RECURRING_BILLING`, `PROBLEM_WITH_REMITTANCE`, `OTHER` |
| `dispute_life_cycle_stage` | `INQUIRY`, `CHARGEBACK`, `PRE_ARBITRATION`, `ARBITRATION`                                                                                                                                                                                                         |

Display labels only (no new statuses): `WAITING_FOR_SELLER_RESPONSE` → "Needs your response",
`MERCHANDISE_OR_SERVICE_NOT_RECEIVED` → "Item not received", etc.

Evidence sent: with tracking, one `PROOF_OF_FULFILLMENT` evidence with
`evidence_info.tracking_info[{carrier_name, tracking_number}]` and the approved text as `notes`;
without tracking, one `OTHER` evidence with the text. No files are uploaded. `notes` ≤ 2000 characters.

## Webhook events

| Event                       | Why                                         | Handler               | Side effects                                                             |
| --------------------------- | ------------------------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `CUSTOMER.DISPUTE.CREATED`  | New dispute                                 | `DisputeService.sync` | Store, link, audit `dispute.opened`, one WhatsApp notice                 |
| `CUSTOMER.DISPUTE.UPDATED`  | Evidence requests, status changes, messages | `DisputeService.sync` | Update, audit status changes, notify only when it now needs the merchant |
| `CUSTOMER.DISPUTE.RESOLVED` | Outcome                                     | `DisputeService.sync` | Update, audit `dispute.resolved`, one notice                             |

Subscribed with `pnpm paypal:webhook sync https://kataleai.space/api/paypal/webhooks` (adds exactly
these three to the existing payment events). Redelivered events are ignored by event ID.

## Data model

- `Dispute`: PayPal dispute ID (unique), reason, status, stage, outcome, amount, currency, disputed
  capture ID, buyer message, response deadline, timestamps, `notifiedStatus` (no repeated WhatsApp
  messages), canonical `providerData` (kept, not shown). `orderId`/`paymentId` are optional: a
  dispute that doesn't match a Katale payment is stored unlinked and said so.
- `DisputeResponse`: one per SUBMIT confirmation (unique), exact text, evidence list, status
  (`PENDING` → `SUBMITTED` / `FAILED`), submission time.

## Evidence policy

`DisputeService.evidenceFor` reads only Katale's records — order, line items, PayPal capture,
shipment/tracking — and lists what is **missing** for the dispute reason (e.g. no tracking for
"item not received", no delivery confirmation because PayPal tracking has no delivered status,
no photos for "not as described"). The AI summarises these facts; it does not add any.

The response is drafted by code from the same facts (`suggestResponse`). If the merchant wants
different wording, the agent may pass its own text, which the backend rejects when it:

- mentions a tracking number, ID or reference that is not in Katale's records, or
- offers a refund, settlement or compensation, or accepts the claim/liability.

## Confirmation boundary

| The AI may                           | The AI may not (without SUBMIT)                  |
| ------------------------------------ | ------------------------------------------------ |
| list, review, summarise disputes     | submit evidence or any response                  |
| gather evidence, flag what's missing | make an offer, accept the claim, refund, concede |
| draft a response                     | — (these are not implemented at all)             |

`SUBMIT` needs the code; `CONFIRM`, "yes", spoken approvals, wrong or expired codes submit
nothing. Before submitting, Katale re-reads the dispute at PayPal and refuses if PayPal is not
accepting seller evidence. A repeated `SUBMIT` reports "already submitted" without calling PayPal.

## Testing — real vs simulated

| What                                                                                           | How                                                                                                                                                                                         | Label                                            |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| API access (scopes `disputes/read-seller`, `update-seller`; list = 200)                        | Sandbox REST app                                                                                                                                                                            | REAL PAYPAL SANDBOX                              |
| Webhook → sync → link → notify once; evidence; draft; SUBMIT; duplicates; provider-state check | `tests/integration/operations.test.ts` with `FakePayPal` mirroring Disputes v1                                                                                                              | SIMULATED PAYPAL                                 |
| Tool choice and fact-only drafting                                                             | `tests/external/operations-questions.test.ts` (real LLM, canned tool data)                                                                                                                  | MOCKED PayPal, real LLM                          |
| A real Sandbox dispute end to end                                                              | Sandbox buyer opens a dispute on a paid order (sandbox.paypal.com → Activity → payment → Report a problem), `pnpm paypal:dispute require-evidence <id>`, then review and SUBMIT on WhatsApp | See [PROJECT_STATUS.md](../../PROJECT_STATUS.md) |
