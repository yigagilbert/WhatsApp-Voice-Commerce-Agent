# Devpost submission — Katale AI

Text for the [Devpost project](https://devpost.com/submit-to/31302-paypal-ai-hackathon/manage/submissions/1218747-katale-ai/project-overview)
(PayPal AI Hackathon) and the script for the demo video. Every claim here was checked against the
code on `main` and the production tests in
[2026-10-31-e2e-testing-and-submission.md](2026-10-31-e2e-testing-and-submission.md).

## Where Katale AI can be used (checked 2 Nov 2026)

The product is built and tested in Uganda for sellers across East Africa. "Every East African
country" is **not** a claim we can make today:

| Requirement               | What the product does                                                                                           | Limit                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WhatsApp numbers          | Any valid international number (`+254`, `+255`, `+250`, …); local numbers starting with `0` are read as Ugandan | Admins outside Uganda must be added in international format                                                                                                                                                                                                                                                                                                                         |
| Currency                  | Prices and PayPal links in USD (or another PayPal currency)                                                     | PayPal does not accept UGX, KES, TZS or RWF, so shops can't charge in local currency                                                                                                                                                                                                                                                                                                |
| Receiving PayPal payments | Needs a PayPal business account that can receive money                                                          | PayPal's [country feature table](https://developer.paypal.com/docs/payouts/standard/reference/country-feature/) (updated 10 Sept 2026) lists Kenya as "send, receive, and withdraw". Uganda, Tanzania, Rwanda, Burundi, South Sudan, DRC, Somalia and Ethiopia are not in it, and secondary sources disagree on receiving in Uganda and Tanzania. All our tests used PayPal Sandbox |
| Voice notes               | English (Whisper); other languages are read back for confirmation                                               | Luganda is an experimental, off-by-default mode; Swahili voice is not supported yet (Swahili "yes"/"no" words are recognised in text, to validate)                                                                                                                                                                                                                                  |

Safe wording, used below: _"Built in Uganda for small sellers across East Africa. Works with any
WhatsApp number; payments need a PayPal business account that can receive money in the seller's
country."_

## Project overview

**Project name:** Katale AI

**Elevator pitch** (200 characters max):

> Run your shop from WhatsApp: voice or text orders, PayPal payment links, tracking and disputes. The AI prepares, the backend prices, and money moves only on a typed code.

## Project details

### About the project (Markdown)

```markdown
## Inspiration

In Kampala, as across East Africa, small shops already sell in WhatsApp chats. Orders arrive as voice notes, totals are worked out by hand, and payment links, stock and bookkeeping live in the owner's head. "Katale" means _market_ in Luganda: we wanted the market stall's chat to run like a real business, without asking anyone to install a new app.

## What it does

Katale AI turns a shop's WhatsApp number into its back office and its storefront.

- **Merchants** add products and stock, create orders by text or voice note, send PayPal payment links, mark orders shipped with tracking, answer PayPal disputes and ask "how much did I sell this week?" — all in WhatsApp.
- **Customers** message the same number: browse the catalogue with photos, `add 2` to a cart, `checkout` and pay with PayPal.
- **The dashboard** (AG Grid and AG Studio) shows orders, stock, payments, disputes and a trace of every AI decision.

The rule throughout: **the AI prepares, the backend verifies, the merchant approves, PayPal executes.** Prices and totals are computed in code from the catalogue, never by the model. Every action that moves money or changes an order needs a typed one-time code bound to that exact action (`CONFIRM 4821`); a spoken or typed "yes" is not enough.

## How we built it

- **WhatsApp:** a whatsapp-web.js worker that forwards messages to a Fastify API.
- **AI:** an LLM agent with typed tools (inventory, orders, payments, shipments, disputes, analytics) for merchants, a separate, narrower customer assistant, and Whisper for voice notes.
- **PayPal (Sandbox):** Orders v2 checkout and capture, verified and idempotent webhooks, order tracking, Disputes v1 (alerts, evidence and case messages), reconciliation and refunds recorded from PayPal.
- **Data:** Postgres with Prisma; product photos on Cloudflare R2; a Next.js dashboard with AG Grid and AG Studio.

## Challenges we ran into

- **Keeping the model away from money.** The model once invented a capped cart and total for "500 baskets". Now every cart and total a customer sees is text built by the backend.
- **WhatsApp Web keeps changing.** Linked IDs instead of phone numbers locked an admin out, and a WhatsApp Web update broke every media send in our library; we fixed both with tests and a small library patch.
- **PayPal disputes.** PayPal refuses "other" evidence on an "item not received" case without proof of shipment, so Katale now posts the merchant's response as a case message instead.

We tested end to end on production with real phones, the real model and PayPal Sandbox, and fixed 15 defects in the final week. The suite has 256 unit and 215 integration tests.

## What we learned

Trust comes from structure, not prompts: typed tools, backend-computed prices, one-time approval codes and verified webhooks made the AI safe to put next to money.

## Where it works and what's next

Katale AI is built in Uganda for small sellers across East Africa. It works with any WhatsApp number; prices are in USD because PayPal doesn't accept local currencies such as UGX or KES; and payments need a PayPal business account that can receive money in the seller's country. Next: Swahili voice notes, and testing with live PayPal business accounts in more East African countries.
```

### Built with (tags)

paypal, openai, whisper, whatsapp, whatsapp-web.js, node.js, typescript, fastify, next.js, react,
prisma, postgresql, ag-grid, cloudflare-r2, docker

### "Try it out" links

- https://kataleai.space
- https://github.com/yigagilbert/WhatsApp-Voice-Commerce-Agent

### Video

YouTube, public or unlisted, under 3:00 (judges stop at 3:00). Paste the link after uploading.

## Video script (under 3:00)

Record on production after the API and WhatsApp worker redeploy. Show **PayPal Sandbox** on screen
once. Before recording, check scene 5 (product photo) on the customer phone: if the photo still
doesn't arrive, record the text details and don't mention photos.

You need: the merchant phone, a customer phone, a device signed in as the Sandbox buyer, and the
dashboard signed in (Overview, Orders, Products and Activity in tabs).

| #   | Time      | Screen                                                                                              | Voice-over                                                                                                                                            |
| --- | --------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 0:00–0:15 | Market stall photo, then the shop's WhatsApp chat                                                   | "Across East Africa, small shops already sell in WhatsApp chats. Orders come as voice notes, and totals and payments are done by hand."               |
| 2   | 0:15–0:40 | Merchant phone: 🎙️ "Create an order for Sarah for three handmade baskets and five dollars delivery" | "Katale AI understands the voice note. The backend prices it from the catalogue, never the AI."                                                       |
| 3   | 0:40–0:55 | Type `yes` → "Reply CONFIRM ####"; type the code → PayPal link                                      | "Money never moves on the AI's word: only a one-time code, bound to this order, sends the link."                                                      |
| 4   | 0:55–1:20 | Buyer device: open link → PayPal **Sandbox** → pay; merchant phone: "✅ Payment received"           | "PayPal takes the payment. A verified webhook marks it paid and the stock drops."                                                                     |
| 5   | 1:20–1:55 | Customer phone: `hi` → `1` → `2` (photo and details) → `add 2` → `checkout` → PayPal link           | "Customers shop on the same number. The product details now say how to add to the cart, and every cart and total comes from the shop, not the model." |
| 6   | 1:55–2:15 | Merchant phone: "Mark ORD-… shipped with DHL tracking 123456789" → `SHIP ####`                      | "After the sale, the same rule: the AI prepares the shipment, the merchant approves, and tracking goes to PayPal."                                    |
| 7   | 2:15–2:40 | Dashboard: Orders (the two new orders), Products (stock), Activity trace of the voice order         | "Everything is visible and traceable: the message, the AI's decision, the approval and PayPal."                                                       |
| 8   | 2:40–3:00 | Title card: "Katale AI — built in Uganda for East Africa's WhatsApp sellers" and kataleai.space     | "AI prepares, the backend verifies, the merchant approves, PayPal executes. Katale AI."                                                               |

Tips: record each scene separately and cut them together; speed up waiting (PayPal page loads,
"typing…") rather than talking over it; blur phone numbers other than the bot's.
