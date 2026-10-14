# Shipment tracking

After a payment completes, the merchant tells Katale AI how the order shipped; Katale attaches
the tracking number to the PayPal transaction once the merchant approves it with `SHIP <code>`.

```text
"Mark ORD-1042 as shipped with DHL tracking 123456789."   (text or voice)
   → AI: add_shipment_tracking {order_reference, carrier, tracking_number}
   → backend: order exists, belongs to the merchant, is PAID, PayPal capture COMPLETED,
              tracking number well-formed, not already attached, carrier mapped to PayPal's code
   → "Shipment update … Reply SHIP 4821 to update PayPal tracking."
   → merchant types SHIP 4821  (CONFIRM, "yes" or a spoken SHIP do nothing)
   → PayPal: POST /v2/checkout/orders/{id}/track  → tracker confirmed in the response
   → Shipment row + order fulfillmentStatus SHIPPED + audit shipment.tracking_added
   → "📦 Shipment updated … Tracking has been updated with PayPal."
```

## PayPal API (validated against PayPal's official OpenAPI spec)

Source: `paypal/paypal-rest-api-specifications` → `openapi/checkout_orders_v2.json` (Orders v2), and
the official `@paypal/paypal-server-sdk` 2.5.0 (`OrdersController.createOrderTracking`).

| Item           | Contract                                                                                                                       | Katale                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint       | `POST /v2/checkout/orders/{id}/track`                                                                                          | `PayPalClient.addTracking`                                                                                                                                                                    |
| Required       | `capture_id` (≤ 50, alphanumeric), `tracking_number` (≤ 64), `carrier`                                                         | Payment `captureId`, cleaned tracking number                                                                                                                                                  |
| Carrier        | `shipment_carrier` enum (1,413 codes) or `OTHER` + `carrier_name_other`                                                        | Common carriers mapped to verified codes (DHL, UPS, FEDEX, USPS, ARAMEX, TNT, DPD, GLS, EMS, ROYAL_MAIL, PARCELFORCE); anything else → `OTHER` with the merchant's name (e.g. "Posta Uganda") |
| `notify_payer` | Optional, default false                                                                                                        | `false` (Katale doesn't email the buyer)                                                                                                                                                      |
| Idempotency    | On `capture_id` + `tracking_number`: a repeat returns `200` with the existing tracker (`201` when new). No `PayPal-Request-Id` | Local unique `(orderId, trackingNumber)`; reused SHIP codes never call PayPal                                                                                                                 |
| Response       | The order, with `purchase_units[].shipping.trackers[]`, tracker `id` = `<captureId>-<trackingNumber>`                          | The tracker must be present (re-read the order if not) before anything is stored                                                                                                              |
| Statuses       | Tracker `SHIPPED` or `CANCELLED`                                                                                               | `ShipmentStatus` mirrors them; **no "delivered"** (PayPal has none, so Katale doesn't invent one)                                                                                             |
| Errors         | `422 CAPTURE_STATUS_NOT_VALID` (capture not COMPLETED)                                                                         | Unpaid orders are refused before PayPal is called; provider errors → "I couldn't update tracking… The order is unchanged."                                                                    |
| Webhooks       | None for tracking                                                                                                              | —                                                                                                                                                                                             |

## Data model

- `Order.fulfillmentStatus`: `NOT_SHIPPED` | `SHIPPED` — a separate dimension from the order's payment status
  (`PAID` + `NOT_SHIPPED` = waiting to ship). Payment transitions are unchanged.
- `Shipment`: order, payment, PayPal carrier code (+ name for `OTHER`), tracking number, status,
  `providerTrackerId`, `providerSyncedAt`, `shippedAt`. Created only after PayPal confirmed the tracker.

## Tools

| Tool                                 | Kind    | Purpose                                                                             |
| ------------------------------------ | ------- | ----------------------------------------------------------------------------------- |
| `get_shipping_status`                | read    | "Where is ORD-1042?", "What's the tracking number?"                                 |
| `list_shipments`                     | read    | Recent shipments                                                                    |
| `find_orders` (`fulfillment` filter) | read    | "Which paid orders still need shipping?" (`status=PAID`, `fulfillment=NOT_SHIPPED`) |
| `add_shipment_tracking`              | propose | Validates and proposes; only `SHIP <code>` executes                                 |

## Safety and idempotency

| Case                                      | Result                                                            |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Unpaid / draft order                      | Refused before any PayPal call                                    |
| Unknown order or another merchant's       | Not found                                                         |
| `CONFIRM <code>`, "yes", wrong code       | No change ("reply SHIP 4821")                                     |
| Expired code                              | No change                                                         |
| `SHIP <code>` twice / WhatsApp redelivery | One PayPal call, one shipment ("That tracking was already added") |
| Same tracking number again                | Refused ("already has tracking …")                                |
| Second, different tracking number         | Allowed with a warning (split shipment)                           |
| PayPal rejects                            | Order unchanged, no shipment row, confirmation marked failed      |

The whole sequence is filed under the order's transaction trace (payment correlation ID), so the
Activity trace runs from the first message to the tracking update.

## Tests

- `tests/integration/operations.test.ts` (SIMULATED PAYPAL — `FakePayPal` mirrors the contract above):
  proposal, verb/code/expiry checks, single PayPal call, verified tracker, unpaid/unknown orders,
  provider failure, dashboard data.
- `tests/external/operations-questions.test.ts` (real LLM): shipping requests pass carrier and
  tracking exactly; a missing tracking number is asked for; tracking questions; shipping backlog.
- Real PayPal Sandbox: see [PROJECT_STATUS.md](../../PROJECT_STATUS.md).
