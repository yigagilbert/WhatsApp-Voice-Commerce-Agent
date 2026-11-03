# Bargaining and smart pricing

Customers can ask for a better price on WhatsApp, the way they would at Owino or Nakasero market.
Katale AI negotiates politely, inside rules the merchant sets per product, and every price is
decided and re-checked by the backend. The AI chooses _when_ to bargain and _how to say it_; it
never chooses a number.

## 1. Assessment (why build it)

**Fit with how our merchants sell.** Across East and West Africa, haggling is the default for
informal and social commerce, and WhatsApp sellers already negotiate in chat (often by voice
note). Storefront e-commerce removed that, and sellers cite it as a reason customers prefer
WhatsApp ([BusinessDay][bd1], [BusinessDay][bd2]). A survey of negotiation practitioners also
names WhatsApp as the dominant negotiation channel on the continent, though its African sample is
small ([FIRE 2025][fire]). Automating that conversation, without giving up margin, is a real gap.

**Comparable systems.** Nibble (Shopify/BigCommerce) runs a bargaining chatbot with a merchant
floor and short-lived deals: discount codes expiring after 48 h ([Coresight][nibble1],
[Fortune][nibble2]). Its reported conversion gains are vendor-sourced, so we treat them as
directional, not proven. Pactum negotiates for enterprise procurement (B2B), not consumer retail.

**Risks the research is clear about.** LLM sellers whose floor exists only in the prompt get talked
below it under sustained pressure, while programmatically constrained sellers do not
([Persuadable Agents, NeurIPS 2026][persuade]; [Negotiating with LLMs][hacks]). This is the central
design constraint: **the floor lives in code and in the database, never in the prompt.**

**Hackathon value.** This feature shows the agentic loop the judges look for: understand intent →
act within business rules → agree → order → PayPal checkout. It is visibly different from
"chatbot answers questions", and it rests on the money-safety architecture Katale already has
(integer minor units, backend totals, explicit customer ORDER, verified PayPal webhooks).

**Limitations to be honest about.** Bargaining can teach customers to always ask; discounts cost
margin; non-English haggling (Luganda, Swahili) is out of scope for now. The defaults are
conservative: bargaining is **off** per product until the merchant turns it on, there are at most
three concessions, and the merchant's minimum is never reached unless rounding lands there.

## 2. Design

```mermaid
flowchart LR
  C[Customer: "can you do $25?"] --> AI[Customer assistant<br/>(LLM)]
  AI -->|negotiate_price<br/>offer_price=25| B[BargainingService]
  B --> N["negotiate()<br/>@vca/commerce<br/>pure integer maths"]
  B --> DB[(price_offers)]
  B -->|agreed| S[ShopOrderService<br/>cart pricing]
  S --> CO[Checkout summary<br/>ORDER]
  CO --> PP[PayPal checkout<br/>backend amounts only]
  AI -.reply.-> G{Price guard}
  G -->|amounts ⊆ backend amounts<br/>and shop offer stated| C
  G -->|otherwise| F[backend wording]
```

### Merchant settings (per product, dashboard → Products)

| Setting                           | Meaning                                                          |
| --------------------------------- | ---------------------------------------------------------------- |
| Selling price                     | The advertised price (unchanged).                                |
| Customers can bargain on WhatsApp | Off by default = fixed price.                                    |
| Lowest price you accept           | Required to bargain. **Never** shown or hinted to customers.     |
| Quantity discounts                | Up to 3 rows: "buy N or more → X% off each". Shown to customers. |

Per shop (dashboard → Bargaining): **bundle discount**, "N or more different bargainable products
together → X% off each". The editor previews the offer ladder Katale would use
(e.g. `$30 → $29 → $27 → $25`), so a merchant understands the rule without reading a formula.

### Pricing rules (`packages/commerce/src/bargaining.ts`)

- **Automatic price** for a line: the regular price, or the single best quantity or bundle
  discount it qualifies for. **Discounts never stack**; prices round up in the merchant's favour and
  never go below the minimum.
- **Bargaining ladder**: from the automatic price toward the minimum, conceding 30 % → 60 % → 85 %
  of the room, rounded to natural steps ($1 on a $30 bag, UGX 5,000 on UGX 120,000). At most
  **3 counter-offers per product per customer in 24 h** (declined offers still count, so "no deal"
  and asking again doesn't reset the ladder).
- A customer's own price is **agreed** when it is at or above the shop's next step; if they offer
  more than the standing offer, they get the standing offer (never overcharged).
- An exhaustive unit test sweeps bases, floors, rounds and customer prices to prove every result is
  within `[minimum, automatic price]`.

### Offer lifecycle (`price_offers`)

`OPEN` (60 min) → `ACCEPTED` (bound to the customer's cart, held 24 h) / `REJECTED` / `SUPERSEDED`.

- "deal" (or the `accept_offer` tool) claims the offer with a conditional update, so a duplicated or
  concurrent "deal" accepts once. Bargaining moves are serialised per customer with a Postgres
  advisory lock, so two quick messages can't both take a round.
- An accepted offer applies only to **that customer's open cart**, only for that product, only while
  the line quantity is at least the agreed quantity, and only while it is still ≥ the merchant's
  _current_ minimum. A new cart, another customer, or an expired deal gets regular pricing.

### Cart, checkout and PayPal

`ShopOrderService` reprices the open cart on every change, on checkout and inside the ORDER lock:
each line gets `min(automatic price, valid agreed price)`. Order lines store `unitPriceMinor` (what
the customer pays), `listUnitPriceMinor` (the regular price at the time), `pricing`
(`LIST | QUANTITY | BUNDLE | NEGOTIATED`) and `priceOfferId`. Totals still come only from
`calculateOrderTotals`. The checkout summary is fingerprinted, so an expired deal or a price change
between summary and ORDER shows the customer the new summary instead of charging it.

PayPal receives the agreed unit prices as line items and the backend totals; item amounts always
sum to the item total. After placement the order is frozen: later catalog changes don't touch it,
so order history keeps the agreed price and the regular price it was compared with. Payment
verification, webhooks, refunds, reminders, stock reservation and expiry are unchanged.

### The AI layer

Three customer tools, all scoped server-side to this merchant and customer:

- `negotiate_price(product?, offer_price?, price_is_for?, quantity?)`: only when the customer
  asks for a discount or names a price. Returns the decision (`counter`, `final`, `agreed`,
  `fixed_price`, `best_price`) and a `suggested_reply`; never the minimum.
- `accept_offer(product?)`, `decline_offer(product?)`.

"deal" / "no deal" also work without the AI (deterministic shortcuts).

**Price guard** (`price-guard.ts`): before any AI reply is sent, every money amount in it must
appear in this turn's tool results or the shop's earlier messages, and after a bargaining step the
reply must state the shop's actual offer. Otherwise the backend's own wording is sent and a
`customer.price_guard` audit event is recorded. When an offer is agreed, the cart is always shown
in the backend's words.

## 3. Security and reliability checklist

| Threat                                   | Control                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Customer talks the AI below the minimum  | Floor enforced in `negotiate()` and again in cart pricing; prompt never sees it                |
| AI invents or "agrees" a price           | Price guard replaces the reply; cart prices come only from accepted `price_offers`             |
| Minimum leaks                            | Not in tool results, catalog, customer replies or audit data ("minimum changed" only)          |
| Replay / duplicate "deal"                | Conditional `OPEN → ACCEPTED` claim; per-customer advisory lock for bargaining moves           |
| Deal reused in another cart / by another | Bound to `orderId` + `customerId` + `merchantId`; repriced on every change                     |
| Expired deal at checkout                 | Repriced inside the ORDER lock; quote fingerprint forces a re-confirm                          |
| Merchant lowers the minimum after a deal | Deal must still be ≥ current minimum to apply                                                  |
| API manipulation                         | Products: zod + `validatePricingRules` (min ≤ price, tiers increasing, bargaining needs a min) |
| Cross-merchant access                    | All queries scoped by `merchantId`; the catalog only resolves this merchant's products         |
| Stacked promotions                       | One price per line: max(quantity %, bundle %) or the agreed price, whichever is lowest         |

## 4. Tests

- `packages/commerce/src/bargaining.test.ts`: rules validation, tiers, bundles, rounding, ladder,
  exhaustive floor/ceiling sweep.
- `tests/integration/bargaining.test.ts` (Postgres, scripted LLM, simulated PayPal): fixed price,
  counter-offers, agreed price in cart and summary, PayPal line amounts, paid order history after a
  price change, no reuse in a new cart, 3-concession limit, "no deal" doesn't reset, concurrent
  "deal" and concurrent asks, expired offers and deals, quantity drop, quantity and bundle
  discounts without stacking, mixed carts, invented-price and injected-price replies blocked,
  isolation between merchants and customers, dashboard validation and statistics.
- `tests/external/bargaining-conversations.test.ts` (real LLM, real Postgres): realistic
  conversations and five prompt-injection attempts; asserts the floor holds in offers, carts and
  PayPal and is never revealed. Prints the transcript.

## 5. Deployment

1. `pnpm db:deploy` applies `20261103085247_bargaining_smart_pricing` (additive: new columns with
   defaults, a new table; no backfill needed, existing products stay fixed-price).
2. Ship the API and dashboard images together (the dashboard reads the new fields).
3. Turn bargaining on for chosen products in the dashboard; optionally set a bundle discount.

## 6. Not in scope (yet)

Dynamic or demand-based pricing, per-customer pricing, AI-chosen discounts, voice-note bargaining
in local languages, merchant-approved counter-offers ("ask the owner"), cart-level price offers
("$50 for everything").

[bd1]: https://businessday.ng/?p=939070
[bd2]: https://businessday.ng/?p=595509
[fire]: https://www.atlantis-press.com/proceedings/research-on-fire-25/126025028
[nibble1]: https://coresight.com/research/innovator-profile-nibble-facilitates-one-to-one-price-negotiation
[nibble2]: https://www.fortune.com/2024/07/16/negotiating-chatbot-nibble-ai-ecommerce
[persuade]: https://neurips.cc/virtual/2026/176559
[hacks]: https://arxiv.org/abs/2312.03720v1
