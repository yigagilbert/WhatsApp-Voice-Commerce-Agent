# Katale AI — shipment and dispute demo

Continues the [final demo](final-demo-script.md) after "✅ Payment received". PayPal Sandbox only.

## Before you start

- A **paid** order exists (e.g. from the voice demo) — note its `ORD-…` reference.
- The PayPal webhook subscribes to dispute events: `pnpm paypal:webhook list` shows
  `CUSTOMER.DISPUTE.CREATED/UPDATED/RESOLVED`.
- For the dispute part, the Sandbox **buyer** account that paid the order, on a laptop.

## Part 3 — Shipment (≈ 40 s)

| Merchant (WhatsApp)                                                        | Katale AI                                                                                                                           |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| _"Mark ORD-1042 as shipped with DHL tracking 123456789."_ (typed or voice) | **Shipment update** · Order · Customer · Amount · Carrier: DHL · Tracking: 123456789 · _Reply SHIP 8314 to update PayPal tracking…_ |
| `SHIP 8314`                                                                | 📦 **Shipment updated** · … · Status: Shipped · _Tracking has been updated with PayPal._                                            |
| _"Where is ORD-1042?"_                                                     | Shipped with DHL, tracking 123456789 (no delivery claim)                                                                            |

Say: "Same rule as payments: the AI understood the message, the backend checked the order is
paid, and nothing reached PayPal until I typed SHIP and the code."

Dashboard: **Orders** → Fulfillment "Shipped" → open the order: carrier, tracking, "Tracking registered with PayPal".

## Part 4 — Dispute (≈ 90 s)

1. Sandbox buyer: sandbox.paypal.com → **Activity** → the payment → **Report a problem** →
   "I didn't receive it". PayPal sends `CUSTOMER.DISPUTE.CREATED`.
2. Merchant phone: **⚠️ New PayPal dispute** · Order · Customer · Amount · Reason: Item not received.
3. If PayPal shows the dispute as under review (common in Sandbox), move it to the seller step:
   `pnpm paypal:dispute require-evidence <dispute-id>` → **⚠️ PayPal dispute needs your response**.
4. Merchant: _"Review Sarah's dispute."_ → Facts (order, payment, DHL tracking), Missing
   (no delivery confirmation), Suggested response.
5. Merchant: _"Prepare the response."_ → **Proposed dispute response** "Order ORD-1042 (10 ×
   Handmade Basket, total $140.00) was paid through PayPal on … shipped … with DHL, tracking number
   123456789…" · Evidence ✓ · _Reply SUBMIT 7312…_
6. Merchant: `SUBMIT 7312` → ✅ **Dispute response submitted** · Evidence sent: Order details,
   Payment confirmation, Shipment tracking.

Say: "Katale only uses facts it has — if tracking were missing it would say so. It can't offer a
refund or accept the claim, and nothing goes to PayPal without SUBMIT."

## Part 5 — Dashboard (≈ 40 s)

- **Disputes**: the dispute row (Needs response → Under review), detail with buyer message,
  evidence, missing items, the submitted response and the timeline.
- **Activity → View trace**: order → payment → tracking → dispute → response, one trace.
- **Analytics** (AG Studio): ask _"Show paid orders that haven't shipped"_ or
  _"How much revenue is currently disputed?"_.

## If something goes wrong

| Problem                                                         | Do this                                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| "…is still awaiting payment. Tracking can only be added after…" | Use a paid order                                                                                         |
| No dispute notification                                         | Dashboard **Disputes → Refresh from PayPal**; check `pnpm paypal:webhook list`                           |
| "PayPal isn't accepting evidence right now"                     | Dispute isn't in the seller step yet: `pnpm paypal:dispute show <id>`, then `require-evidence` (Sandbox) |
| Dispute not linked to an order                                  | It was opened on a payment Katale didn't create; Katale shows it unlinked                                |
