# Controlled end-to-end test: customer shopping on WhatsApp (PayPal Sandbox)

Run this **before** switching customer shopping on for everyone. Nothing here uses live money:
production runs PayPal **Sandbox**.

## You need

- The shop's bot number paired (dashboard → WhatsApp shows **Connected**) and connected to the shop
  (_Use … as this shop's number_ — already done for Kampala Crafts).
- A **second phone** whose WhatsApp number is **not** an admin of the shop (an admin number always
  gets the admin assistant).
- A PayPal **Sandbox personal (buyer)** account from developer.paypal.com → Sandbox accounts.
  Never use a real PayPal login.

## 1. Allow only your test phone (pilot)

On the VM, add the test phone in E.164 to `/opt/apps/katale-ai/.env` and restart the API:

```bash
echo "CUSTOMER_COMMERCE_PILOT_NUMBERS=+2567XXXXXXXX" >> /opt/apps/katale-ai/.env
```

```bash
cd /opt/apps/katale-ai && docker compose up -d api
```

Everyone else keeps the generic welcome. In the dashboard → WhatsApp, set the delivery fee, pickup,
payment-link mode and shop information; add a product photo on a product page.

## 2. The journey (from the test phone)

| Step | Send                                                                             | Expect                                                                          |
| ---- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1    | `hi`                                                                             | Menu: 1 Browse · 2 My cart · 3 My orders · 4 Talk to a person                   |
| 2    | `1`                                                                              | Numbered products, price, In stock / Low stock / Out of stock                   |
| 3    | `2`                                                                              | Product details (+ photo if uploaded)                                           |
| 4    | `add 2`                                                                          | ✅ Added … cart with subtotal                                                   |
| 5    | `checkout`                                                                       | Name (if WhatsApp didn't give one), delivery or pickup, address                 |
| 6    | (answers)                                                                        | _Order summary_ with delivery fee and total — "Reply ORDER"                     |
| 7    | `ORDER`                                                                          | "Order ORD-… placed!" + PayPal Sandbox link; admins get "🛒 New WhatsApp order" |
| 8    | Open the link, log in with the **Sandbox buyer**, pay                            | PayPal return page: payment confirmed                                           |
| 9    | (wait a few seconds)                                                             | "✅ Payment received — thank you!"; admins get "Payment received"               |
| 10   | `orders`                                                                         | `ORD-… · $… · paid ✅ · being prepared`                                         |
| 11   | Admin WhatsApp: "Mark ORD-… shipped with DHL tracking 123456789" → `SHIP <code>` | Customer `orders` shows the tracking                                            |

Also try: `4` (hand-off: admins alerted, bot paused) → admin "reply to <name>: …" → admin
"resume <name>"; sending `ORDER` twice (only one order and link); `add 99 of 1` (quantity limit).

Approval mode: set _Payment links → Ask an admin to approve first_, order again; admins get
"request payment for ORD-…" → `CONFIRM <code>` → the customer receives the link.

## 3. Check the records

Dashboard → Orders (the order, placed by the customer), Payments (Sandbox capture), Activity (the
trace: placed → requested → approved → completed), Products (stock reduced once).

## 4. Switch the pilot off

```bash
sed -i '/^CUSTOMER_COMMERCE_PILOT_NUMBERS=/d' /opt/apps/katale-ai/.env
```

```bash
cd /opt/apps/katale-ai && docker compose up -d api
```

Going live for everyone (only with approval): `CUSTOMER_COMMERCE_ENABLED=true` + _Let customers shop
on this number_ in the dashboard.
