# Customer commerce over WhatsApp — feasibility and plan

_Status (2026-10-18): **Phase 0 and Phase 1 implemented**, behind `CUSTOMER_COMMERCE_ENABLED=false`
(production) and a per-number dashboard switch. Phase 2 (cart, order confirmation, PayPal checkout)
is next. Decisions confirmed: one bot number per merchant, automatic payment links (admin approval
optional), availability labels only, 12 h configurable hand-off, product photos uploaded in the
dashboard._

## 1. Summary

**Feasible with the current architecture**, without new infrastructure. One WhatsApp bot can serve
admins and customers if every inbound message is first **routed by identity** (admin → today's
admin agent; customer → a new, much smaller customer agent; nothing enabled → generic welcome).
The commerce core (catalog, orders, totals, PayPal checkout, webhooks, reminders, reconciliation)
is reused as is.

The main constraints are on the WhatsApp side, not ours:

- `whatsapp-web.js` is an **unofficial** client. Customer-facing traffic at volume raises the risk of
  the bot number being restricted. Plan for the official **WhatsApp Cloud API** as the scale path
  (our channel adapter boundary already allows it).
- **Buttons and list menus don't work** on unofficial clients. Customers navigate with numbered
  text options, free text and (optionally) polls.
- **Linked IDs (`@lid`)** hide many customers' phone numbers. Identity must work on the WhatsApp ID
  alone; phone numbers are a bonus used for linking, never required.

Recommended path: 4 small phases, each shippable and behind a flag (§10).

## 2. What we have today (relevant parts)

| Area      | Today                                                                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing   | `AdminService.authorize()` → active admin → admin agent; anyone else → generic welcome (no data, no AI)                                                                            |
| Identity  | Admin: chat ID, learned `@lid`, or worker-resolved phone. Customer: `Customer.whatsappId` (unique per merchant) and free-text `phone`, used only to _send_ payment links/reminders |
| Merchant  | One bot serves every merchant; the merchant comes from the **admin's** record. A customer message has no merchant yet                                                              |
| Agent     | One tool registry (≈35 tools, all merchant-wide) and one system prompt, for admins                                                                                                 |
| Orders    | `Order` DRAFT → AWAITING_PAYMENT → PAID; totals only from the backend; `source` field                                                                                              |
| Payments  | PayPal Orders v2 checkout links, return URL + verified webhooks, idempotent capture, reminders with link renewal, background reconciliation                                        |
| Approvals | Money-moving actions need the merchant's code (`CONFIRM`, `SHIP`, `SUBMIT`, `REMIND`); staff can't approve payments                                                                |

## 3. Platform feasibility (verified against whatsapp-web.js 1.34.7 typings in this repo)

| Capability                                                                   | Available?                                                                           | Use for customers                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Text in/out, replies, read receipts (`sendSeen`)                             | ✅                                                                                   | Whole conversation                                                                                         |
| Images with captions (`MessageMedia`)                                        | ✅ (already used for charts)                                                         | Product photos, cart summary card                                                                          |
| Polls (`Poll`, `vote_update` event)                                          | ✅                                                                                   | Optional quick choices ("Which size?"). Votes arrive as events, not messages — needs a small worker change |
| Buttons / list menus (`Buttons`, `List`)                                     | ❌ deprecated, not delivered                                                         | Use numbered options ("Reply 1, 2 or 3")                                                                   |
| Voice notes                                                                  | ✅ (our Whisper pipeline)                                                            | Questions; never approvals                                                                                 |
| Phone behind a linked ID (`getContactLidAndPhone`)                           | ⚠️ when WhatsApp exposes it                                                          | Linking to existing customer records                                                                       |
| Is a number on WhatsApp (`getNumberId`)                                      | ✅ (already used)                                                                    | Outbound to customers added by phone                                                                       |
| Profile name (`pushname` on contact)                                         | ✅, user-controlled                                                                  | Display only, never trusted                                                                                |
| WhatsApp Business catalog / cart orders (`MessageTypes.ORDER`, `getOrder()`) | ⚠️ only if the bot is a WhatsApp **Business app** account with a catalog; unofficial | Possible later: map a native WhatsApp cart into a Katale draft. Not needed for v1                          |
| Payments inside WhatsApp                                                     | ❌ not in our markets / not via this client                                          | PayPal checkout link (what we do today)                                                                    |
| Calls                                                                        | ❌ no audio (calls are declined)                                                     | Text/voice notes only                                                                                      |

**PayPal:** nothing new is needed. Customer orders use the same Orders v2 checkout (`intent
CAPTURE`), return URL, webhooks, reminders, link renewal and reconciliation. The buyer page shows
the merchant's brand. Sandbox and live behave the same. One policy decision is needed (§7).

## 4. Routing: one bot, two experiences

```
WhatsApp message
   │
   ▼
InboundRouter.resolve(channel, senderId, senderPhone, botAccount)
   ├─ active admin ───────────────► Admin agent (today, unchanged)
   ├─ deactivated admin ──────────► generic welcome (unchanged)
   ├─ customer commerce ON for ──► Customer agent (new): customer tools only, bound to
   │  this bot's merchant             merchant + this customer
   └─ otherwise ──────────────────► generic welcome (today)
```

- **Admins always win.** A number registered as an admin is never treated as a customer (an owner
  testing the shop uses a second number or the dashboard's preview).
- **Merchant for customers = the bot account.** Customers don't belong to an admin, so the bot
  number must map to one merchant. Recommendation: **one bot number per merchant** (a
  `WhatsAppAccount { botWid, merchantId, customerCommerceEnabled }` row, or simply a
  `WHATSAPP_CUSTOMER_MERCHANT_ID` setting while there is one shop). Sharing one bot between
  several shops would need store codes and is not recommended.
- The router is a small extraction of the authorization block already in `InboundMessageService`
  (≈1 file). Everything after it — de-duplication, transcripts, conversations, audit — is shared.

## 5. Customer identification (incl. LIDs)

Identity key: **(merchant, channel, WhatsApp chat ID)** — exactly what WhatsApp gives us, whether
`2567…@c.us` or `…@lid`. It is stable for that person and that bot.

| Step                       | Rule                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First message              | Find `Customer` by `whatsappId` **or** `whatsappLid` = sender. Not found → create a customer with display name from the WhatsApp profile (marked _unverified name_)                                                                              |
| Phone                      | If the worker resolves a phone (`@c.us` sender, or `getContactLidAndPhone`), store it normalised (E.164) as `whatsappPhone` — **this** phone is trusted because it came from WhatsApp, not from the chat                                         |
| Link to an existing record | Only automatically when the **WhatsApp-resolved** phone equals an existing customer's normalised phone for that merchant (e.g. the merchant created "Sarah" with her number earlier). Never by name, never by a phone/email the customer _types_ |
| Typed details              | Name, email, delivery address typed by the customer are stored as customer-provided and shown as such to the merchant                                                                                                                            |
| LID without phone          | Fully supported as a customer; just no automatic link. The merchant can **merge** two customer records from the dashboard                                                                                                                        |
| Admin ↔ customer           | Separate records. An admin number never resolves to a customer                                                                                                                                                                                   |

Schema additions: `Customer.whatsappLid String?`, `Customer.whatsappPhone String?` (E.164, from
WhatsApp), `Customer.source` (`MERCHANT` / `WHATSAPP`), `@@unique([merchantId, whatsappLid])`.
Existing `phone` stays merchant-entered.

## 6. Conversation flow (customer)

Text-first, numbered choices, short replies, always one obvious next step.

1. **Welcome** (first message or "menu"): business name + three choices — _1 Browse products_,
   _2 My cart_, _3 My orders_ — and "or just ask a question".
2. **Browse / search**: products visible to customers, price, availability ("in stock" / "low" /
   "sold out" — not exact counts), optional photo. "Show me baskets", "do you have size L?".
3. **Questions**: answered only from the catalog and a merchant-written **shop info** text (hours,
   delivery areas/fees, returns). Unknown → "I'll ask the team" (hand-off, step 8). No invention.
4. **Cart**: "add 2 baskets", "remove the wallet", "show my cart". Prices and totals from the
   database; stock checked; cart expires after e.g. 48 h.
5. **Checkout**: the backend shows the exact summary (items, delivery, total) and asks the
   customer to reply **ORDER** to place it. Name/delivery details collected if missing.
6. **Payment**: PayPal link sent immediately (or after the merchant approves — §7). Paid → thank
   you + merchant notified (existing flow, now routed to admins). Reminders and link renewal reuse
   today's services.
7. **My orders**: only this customer's own orders: payment status, shipping/tracking. Never other
   customers or business figures.
8. **Talk to a person**: "agent", "human", complaints, or anything the bot can't answer → admins
   get "Sarah needs help: …"; the bot stays quiet in that chat for N hours or until an admin
   replies from the dashboard inbox.

Admins keep their experience. New admin abilities: "show today's customer orders", "reply to
Sarah: …", "approve ORD-123".

## 7. Payments and approvals (decision needed)

Customer orders change who triggers a payment link. Two safe modes, per merchant:

| Mode                                 | How                                                                                                                                                                                                                          | When                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Auto links** (recommended default) | Customer replies ORDER → link created at once. Safe because amounts come only from the catalog (no AI or customer-typed prices), the per-order maximum policy still applies, and nothing ships until PayPal confirms payment | Fixed-price catalog shops                              |
| **Merchant approval**                | Customer replies ORDER → admins get the order and approve with `CONFIRM <code>` → link sent                                                                                                                                  | Custom quotes, delivery to be priced, high-value items |

Unchanged rules: refunds, disputes and custom prices remain admin-only; customers can never
approve anything on the merchant's behalf; payment links are idempotent per cart; stock is
deducted when payment completes (today's behaviour) — optionally reserved at checkout later.

## 8. Security model

- **Capability isolation in code, not prompts**: a separate `customerTools` registry (≈8 tools:
  `browse_products`, `product_details`, `shop_info`, `add_to_cart`, `update_cart`, `view_cart`,
  `place_order`, `my_orders`, `request_human`). The customer agent never receives the admin
  registry. Every tool's context is bound to `{merchantId, customerId}` from the router, never to
  model arguments.
- **Separate system prompt** for customers; prompt injection can at worst misuse those 8 tools on
  the customer's own cart.
- **Data minimisation**: no stock counts, revenue, other customers, admin names or internal IDs in
  customer replies. Product cost/supplier fields never exposed.
- **Abuse limits**: per-customer message rate (e.g. 20/min, 300/day), LLM token budget per customer
  per day, max open carts/unpaid orders per customer (e.g. 3), max order value (existing policy),
  cooldown after repeated cancelled orders. Exceeding → generic "the team will get back to you".
- **Money**: amounts only from the database; the customer approves their own purchase, never the
  merchant's actions; PayPal webhook verification unchanged.
- **Privacy**: customer messages stored like today (conversation history), visible to admins;
  retention policy (e.g. 12 months) and deletion on request.
- **Audit**: `customer.order_placed`, `customer.handoff`, etc. in the Activity trail.

## 9. Data model and architecture changes

| Change                                                                                                             | Size |
| ------------------------------------------------------------------------------------------------------------------ | ---- |
| `InboundRouter` extracted from `InboundMessageService` (admin / customer / welcome)                                | S    |
| `WhatsAppAccount` (bot wid → merchant, flags) or a single env setting for one shop                                 | S    |
| `Customer`: `whatsappLid`, `whatsappPhone`, `source`; merge in dashboard                                           | S    |
| Cart = `Order` in DRAFT with `placedBy: CUSTOMER` and `expiresAt` (no new cart tables)                             | S    |
| `Conversation.audience` (ADMIN / CUSTOMER), `handoffUntil`                                                         | S    |
| `Product.visibleToCustomers`, `description`, `imageUrl`                                                            | S    |
| `MerchantSettings`: customer commerce on/off, link mode (§7), shop info text, greeting, limits                     | S    |
| `CustomerAgent`: own prompt + `customerTools` registry, reusing `OrderService`, `ProductService`, `PaymentService` | M    |
| Worker: pass the bot account id; optional poll votes → inbound messages                                            | S    |
| Dashboard: customer inbox (conversations, hand-off, reply), customer settings, product photos/visibility           | M    |
| Notifications: "new customer order", "customer needs help" to admins (existing `toAdmins`)                         | S    |

No new services, queues or databases. The admin agent, approvals, reports and PayPal code are
untouched.

## 10. Phased plan

| Phase                             | Scope                                                                                                                      | Exit criteria                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Seam** (½–1 day)             | `InboundRouter`, bot account → merchant, `Customer` identity fields + LID handling, flag `CUSTOMER_COMMERCE_ENABLED=false` | Behaviour identical with the flag off (all current tests green); identity tests for `@c.us`, `@lid`, resolved phone, admin precedence |
| **1. Browse & ask** (2–3 days)    | Customer agent with read-only tools, shop info, product photos, hand-off to admins, rate limits                            | Real-LLM tests: answers only from catalog/shop info; refuses business data; injection attempts can't reach admin tools                |
| **2. Cart & checkout** (3–4 days) | Cart, ORDER, PayPal link (auto or approval mode), paid confirmation, "my orders", reminders reuse                          | Integration tests: totals from DB, idempotent links, limits, approval mode, paid → merchant notified, stock deducted once             |
| **3. Operations** (2–3 days)      | Dashboard customer inbox and reply, merge customers, settings, Activity labels                                             | Admin can take over a chat; bot stays silent during hand-off                                                                          |
| **4. Scale (optional)**           | WhatsApp Cloud API adapter (official; interactive lists/buttons, catalogs, templates for reminders)                        | Same core tests pass through the new adapter                                                                                          |

## 11. WhatsApp limitations and risks

| Risk                                       | Impact                                                                                  | Mitigation                                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Unofficial client against WhatsApp's terms | Bot number could be restricted, more likely with many customers or unsolicited messages | Dedicated number; only reply to customers who wrote first (plus reminders for their own orders); rate limits; plan Cloud API for growth |
| No buttons/lists                           | Clunkier navigation                                                                     | Numbered options, natural language, optional polls                                                                                      |
| LIDs hide phones                           | Can't auto-link some customers                                                          | WhatsApp-ID-first identity; dashboard merge                                                                                             |
| Single linked device / session drops       | Customers unanswered while down                                                         | Existing outage monitor, banner, reconnect; customers get answers after reconnect (no backlog guarantee)                                |
| WhatsApp Web changes break the library     | Downtime until patched                                                                  | Pinned + patched version (today), quick-upgrade runbook, Cloud API path                                                                 |
| LLM cost and abuse by strangers            | Spend, spam                                                                             | Per-customer budgets, rate limits, generic welcome fallback when exceeded                                                               |
| Hallucinated answers to customers          | Wrong promises                                                                          | Tools-only answers, shop info text, "I'll ask the team" fallback, real-LLM tests                                                        |
| Fake/unpaid orders                         | Noise for the merchant                                                                  | Limits on open orders; nothing ships until PayPal confirms                                                                              |
| Privacy of customer chats                  | Compliance                                                                              | Retention policy, deletion on request, no data in logs                                                                                  |

## 12. Decisions needed before Phase 0

1. One bot number per shop (recommended) — confirm.
2. Payment link mode default: **auto** (recommended) or merchant approval.
3. Show exact stock to customers or only in stock / low / sold out (recommended).
4. Hand-off: bot silent for how long (e.g. 12 h) after a customer asks for a person.
5. Product photos: upload in the dashboard (recommended) or image URLs.

## 13. What was built (Phase 0 + 1)

| Piece                                                                                                                                                            | Where                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Bot number → merchant (`WhatsAppAccount`), no takeover between shops                                                                                             | `packages/commerce/src/services/whatsapp-account.service.ts`              |
| Routing: admin of _this_ shop → admin agent; customer (both switches on) → customer flow; otherwise generic welcome                                              | `InboundMessageService.handle`                                            |
| Customer identity: WhatsApp ID / `@lid`, link only via WhatsApp-verified phone, one record per shop                                                              | `packages/commerce/src/services/customer-identity.service.ts`             |
| Customer catalog: visible + active only, In stock / Low stock / Out of stock, photos                                                                             | `apps/api/src/modules/customer/catalog.ts`                                |
| Numbered menu (1 browse, 2 ask, 3 person), numbered lists across pages, `more`, details with photo                                                               | `customer-conversation.service.ts`                                        |
| Customer agent: own prompt, 4 tools (`browse_products`, `product_details`, `shop_info`, `request_human`)                                                         | `customer-prompt.ts`, `customer-tools.ts`                                 |
| Hand-off: replies paused for `handoffHours`, admins alerted, messages forwarded; admins reply ("reply to Sarah: …") and resume from WhatsApp or the dashboard    | admin tools `customer_chats`, `reply_to_customer`, `resume_customer_chat` |
| Abuse limits: 15 messages/min, 300/day per customer                                                                                                              | `customer-conversation.service.ts`                                        |
| Dashboard: connect the shop number, customer settings, shop info, customer chats + resume (WhatsApp page); product photo, description, visibility (product page) | `apps/web/app/whatsapp`, `apps/web/app/products/[id]`                     |

**Turning it on (when approved):** set `CUSTOMER_COMMERCE_ENABLED=true` on the API and redeploy, then
in the dashboard → WhatsApp: _Use this number as this shop's number_ → tick _Let customers shop on
this number_ → add shop information. Admin numbers keep the admin assistant.

**Known limits of Phase 1:** customers can't order yet (the assistant says ordering is coming soon and
offers a person); customer voice notes get "please type"; rate limits and the welcome cooldown are in
memory (reset on restart); one WhatsApp worker session per server (several shops need several
workers — the data model already supports it).
