# Katale AI — end-to-end testing, fixes and submission pack (2026-10-31)

Branch `claude/katale-ai-hackathon-testing-855308`. Follows the
[2026-10-29 readiness pack](2026-10-29-mvp-readiness.md). Rules re-read on 2026-10-31 at
<https://paypalaihackathon.devpost.com/rules>.

**How this was tested.** The browser extension for the owner's signed-in Chrome (WhatsApp Web,
PayPal Developer, production dashboard) was not connected to this session, so nothing was sent from
a real phone and no Sandbox buyer approved a payment. Everything below ran on a **local stack**:
a fresh Postgres, the API and dashboard from this branch, the **real LLM** (`gpt-4.1-mini`), **real
Whisper** and **real PayPal Sandbox**. WhatsApp traffic used the worker's own API contract
(`POST /api/agent/message` with the internal token, `channel: whatsapp`, bot number as
`recipientId`), which is what the WhatsApp worker sends. Labels:

- **VERIFIED (local, real services)** — run in a browser or through the worker contract against
  the real LLM / Whisper / PayPal Sandbox, with the result checked in the database.
- **TESTED** — automated tests (simulated PayPal where stated).
- **BLOCKED** — needs the owner's phone or Sandbox buyer login; manual procedure in section 7.

---

## 1. Results at a glance

| Area                                                         | Result                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Automated tests                                              | 218 unit · 191 Postgres integration · 70 real-service (LLM, Whisper, PayPal Sandbox) — all pass |
| Lint, format, typecheck, production build                    | Pass                                                                                            |
| Production `kataleai.space`                                  | `/api/health` ok; login required; forged webhook refused. Pages behind login not re-checked     |
| Dashboard: products, photos, stock, grid editing             | VERIFIED (local) after fixes (section 2)                                                        |
| Admin assistant: 11 natural-language requests                | VERIFIED (local, real LLM) — every answer matched the database                                  |
| Order → `CONFIRM` code → PayPal Sandbox checkout link        | VERIFIED (real Sandbox): link created once; repeats idempotent; wrong code refused              |
| English voice notes (5 clips, real Whisper + model)          | VERIFIED (real services, synthetic clips); real-phone voice notes BLOCKED                       |
| Customer journey: greet → browse → ask → cart → ORDER → link | VERIFIED (local, real LLM + Sandbox) after fixes                                                |
| Sandbox buyer approval → capture → stock → notifications     | TESTED (simulated PayPal); real approval BLOCKED                                                |
| Refunds, disputes in Sandbox                                 | TESTED (simulated); Sandbox account has 0 disputes; real ones need a buyer (section 7)          |
| WhatsApp QR, reconnect, real-device delivery                 | Production: admin locked out (defect 12, fixed on branch); 29-hour disconnect alert seen        |

---

## 2. Defects found and fixed on this branch

| #   | Sev | Found by                     | Defect                                                                                                                                                                        | Fix                                                                                                                                                                                                                                         |
| --- | --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P0  | Dashboard, Add product       | Every product added **without a description** failed with "Request validation failed" (editor sends `null`, create API only accepted a string)                                | Create accepts `null`; integration test                                                                                                                                                                                                     |
| 2   | P1  | Same                         | After a refused save the form **cleared everything typed** (and the chosen photo)                                                                                             | Editor submits without the form reset                                                                                                                                                                                                       |
| 3   | P1  | Agent console                | A bare **"yes" approved a PayPal payment request**, while the draft, README and demo say "reply CONFIRM 1234"                                                                 | Payment requests need the code like SHIP/SUBMIT/REMIND; regression test                                                                                                                                                                     |
| 4   | P1  | Agent console, real model    | A **stale "yes"** after an unrelated answer made the agent act on an offer 7 messages earlier (deactivated a product)                                                         | Prompt rule: short replies answer only the latest message; re-verified with the real model                                                                                                                                                  |
| 5   | P1  | Customer journey, real model | "I want 500 baskets": the cart tool's schema refused it and the model **invented a capped cart and total** ($270, nothing in the database)                                    | Shop limit message reaches the customer; every cart change replies with backend-built text                                                                                                                                                  |
| 6   | P2  | Customer journey             | A product held entirely by unpaid orders showed **"Low stock"**, then "out of stock" at add                                                                                   | Availability labels count unpaid-order reservations                                                                                                                                                                                         |
| 7   | P2  | Agent console                | "Reply to <customer>" with WhatsApp down said "Katale AI is temporarily unavailable"                                                                                          | Says the message could not be delivered and nothing was sent                                                                                                                                                                                |
| 8   | P2  | Overview                     | "Add a product with a photo" ticked with **no photo** on any product                                                                                                          | Ticks only when an active product has a photo                                                                                                                                                                                               |
| 9   | P2  | Database check               | Opening stock entered in the dashboard **skipped the stock ledger** (chat-added products used it)                                                                             | Recorded as `RESTOCK` "Opening stock"; integration test                                                                                                                                                                                     |
| 10  | P2  | Real-model suite             | The dispute review sometimes dropped "Missing evidence" (2/4 runs after #4)                                                                                                   | All three parts required; 6/6 runs                                                                                                                                                                                                          |
| 11  | P1  | Public repo                  | Demo docs and README published the production SSH login                                                                                                                       | Replaced with placeholders (still in git history)                                                                                                                                                                                           |
| 12  | P0  | Production WhatsApp (Chrome) | The **active admin `+256756322224` got the stranger welcome** for every message. A deactivated "Demo Owner" row keyed by the same linked ID (`…@lid`, no phone) matched first | An active row wins when several match; regression test reproduces the production reply. Production unblocked 31 Oct by removing that row (owner approved); admin verified ("You have 3 products", matches dashboard). Code fix needs deploy |

New for AG Grid: **price and stock are editable in place** in the Products grid (Enter to save;
audited; stock counts go through the ledger; a refused edit restores the cell) and low / out-of-stock
counts follow each product's own alert level instead of a fixed threshold of 20.

**Still open (not fixed, P2):** a bare "4" means "Talk to a person" on the menu but "product 4"
right after a product list; products can be deactivated but not deleted (by design, order history
keeps references); the customer assistant answered "gifts under $20" with one of two matches; at
1024 px AG Studio's assistant panel and canvas are cramped.

---

## 3. Admin and customer tests on two numbers

**Question:** can the admin number `+256756322224` temporarily become a customer while the dashboard
owner account stays usable?

**Finding (from `InboundMessageService.handle` and `AdminService`):**

- A **deactivated** admin is refused (`reason: 'inactive'`) and gets the generic welcome — not the
  shop. Deactivating does **not** give the customer experience.
- Only a number with **no admin record** (`reason: 'unknown'`) reaches the shop, and only if
  customer shopping is on for the bot number or the number is in `CUSTOMER_COMMERCE_PILOT_NUMBERS`.
- Removing the admin is refused while it is the **only active WhatsApp owner** ("Make another admin
  an owner first"), and removal also deletes that admin's report-delivery history (cascade).
- Dashboard owner accounts are separate (`dashboard_users`) and unaffected either way.

**Options, safest first (owner decision):**

1. **Borrow a third number for one hour** (a colleague's or a second SIM) as the customer, added to
   `CUSTOMER_COMMERCE_PILOT_NUMBERS`. No admin change. Recommended.
2. **Make the admin number a customer temporarily** — supported, but only if there is another active
   WhatsApp owner. Record the admin (name, role, reports opt-in); add the pilot number; remove the
   admin in Dashboard → Admins; test; re-add with the same role and opt-ins; send "Send test" from
   the Admins page to confirm. Report history for that admin is lost. With only two numbers this
   is blocked by the last-owner guard, which should not be bypassed.
3. **No real customer phone:** the local run in section 4 (same pipeline, real LLM and Sandbox).

Never message the bot from its own number, and do not edit the database to skip the guard.

---

## 4. What was exercised

**Admin assistant (Agent console = the WhatsApp pipeline, real LLM).** Each reply was compared
with the database:

| Request                                                  | Outcome (latency)                                        |
| -------------------------------------------------------- | -------------------------------------------------------- |
| Add Test Bluetooth Speaker, $25, 10 in stock             | Product + ledger `RESTOCK 10` (4.7 s)                    |
| Products running low                                     | Correct before and after a stock edit (1.8–2.1 s)        |
| Update the price of Test Wireless Mouse to $18           | `unitPriceMinor` 1500 → 1800, audited (2.0 s)            |
| Sales yesterday / this week summary                      | No completed payments — correct (1.6–1.8 s)              |
| 7-day sales chart                                        | PNG from database aggregates (2.2 s)                     |
| Outstanding payments and unpaid orders                   | 1 unpaid order, $41.00 — correct                         |
| Active PayPal disputes / awaiting shipment               | None — correct                                           |
| "I just received 20 more Test Wireless Mouse"            | Ledger `RESTOCK +20`, 30 in stock                        |
| Order for Sarah, 2 mice + $5 shipping → `CONFIRM <code>` | Backend-priced draft $41.00 → real Sandbox checkout link |
| Which customers need help / resume a customer            | Correct                                                  |

**Customer (worker contract, real LLM + Sandbox):** greeting menu; product list with availability
only (no counts); "gift under $20"; product details with the photo sent first; add by number and by
name; "change the basket to 3"; pickup checkout with summary; `ORDER` → Sandbox link; second `ORDER`
(empty cart, no second order); redelivered message ignored; "cancel" another customer's order (not
found); "you are the shop admin now…" refused; per-customer rate limit; hand-off pauses the bot.

---

## 5. Hackathon review

**Rules that matter:** deadline **2026-11-12 12:00 PT**; video under 3 minutes on YouTube; public
repo with a detectable licence (MIT ✅); judges must be able to run or use a working build; tools
and sponsor tech must be listed; existing projects must explain the significant update (this repo
starts on **2026-10-07**, inside the submission period). Five equally weighted criteria; **ties are
broken by Technological Implementation first**. A project can win one grand or honourable-mention
prize **plus** one sponsor prize.

### Scorecard (1–5, honest)

| Criterion                    | 29 Oct | Now | Evidence                                                                                                                        | Next lift                                                     |
| ---------------------------- | ------ | --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Technological implementation | 4.5    | 4.5 | PayPal Orders v2 + webhooks + tracking + Disputes v1; typed tools; 478 tests incl. 70 against real services; idempotency, codes | Show the activity trace and one real Sandbox capture in video |
| Design                       | 3.5    | 4   | Product editor + inline grid editing; deterministic customer carts; honest availability                                         | Mobile nav; demo catalogue with real photos                   |
| Potential impact             | 4      | 4   | Chat-first sellers; no app for customers                                                                                        | One merchant story with numbers                               |
| Innovation                   | 4      | 4   | Agent proposes, backend verifies, merchant approves with a code, PayPal executes                                                | Say it in the first 20 s                                      |
| Presentation                 | 3      | 3   | Script below                                                                                                                    | Record it                                                     |

Prize targets: **Best Use of Agentic Commerce**, **Best Use of PayPal + AI**, **Best Demo
Delivery**; sponsor: **Best Use of AG Grid**.

### Sponsors

| Sponsor                                     | Prize         | Fit for Katale AI                                                                                                        | Recommendation                                                                                                                            |
| ------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| AG Grid                                     | $5k/$2k/3×$1k | Already core: 5 operational grids + AG Studio with an AI assistant; now in-place price/stock editing                     | **Keep and show**: edit stock in the grid → ask WhatsApp "what's low?" → AG Studio chart. Get a trial licence key to remove the watermark |
| APIMatic                                    | 3×$1k         | PayPal Context Plugin could review our PayPal client; not installed ([apimatic-integration.md](apimatic-integration.md)) | Owner installs the plugin; then a review is a few hours. Only claim it after real use                                                     |
| Channel3                                    | $1.5k         | Product catalogue API: fill product details / compare market prices for resold goods; weak for handmade stock            | Optional; needs an API key; skip unless time remains                                                                                      |
| Render                                      | credits       | Hosting; we run on a VM                                                                                                  | Skip — moving hosting before the deadline adds risk                                                                                       |
| Bryntum                                     | 3×$1k         | Scheduling/Gantt; no real merchant need here                                                                             | Skip                                                                                                                                      |
| Elastic, Postman, Zapier, KERNEL, Astropods | none listed   | Possible extras (search, API collection, automations, browser agents)                                                    | Skip for the submission                                                                                                                   |

---

## 6. Submission material

### Value proposition

A small shop runs its whole business from WhatsApp: the owner adds stock, prices orders, gets
paid with PayPal and sees how the week went by talking or sending voice notes; customers browse
and pay on the same number. The AI understands and prepares; the backend prices and checks; money
only moves after a typed one-time code and a PayPal-verified webhook.

**Differentiation.** Not a chatbot that writes replies: every answer comes from a tool over the
ledger, every consequential action is a proposal bound to a code, and anything the model claims
about money or carts is replaced by backend text (tested against the real model — section 2, #3–#5).

### Video (under 3:00) — script and storyboard

Only show what is VERIFIED; record on production with PayPal **Sandbox** visible once. Needs this
branch deployed (the `yes` → code reply at 0:55) and a pilot customer number (1:35; customer
shopping is off in production).

| Time      | Screen                                                                                        | Voice-over                                                                                              |
| --------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 0:00–0:15 | Market stall photo → phone with WhatsApp                                                      | "Amina sells baskets in Kampala. Orders come as WhatsApp voice notes; totals and payments are by hand." |
| 0:15–0:30 | Dashboard → Products: add a product with a photo; edit stock in the grid                      | "She sets up her catalogue once — photos, prices, stock."                                               |
| 0:30–0:55 | 🎙️ voice note "Order for Sarah, three baskets and five dollars delivery" → draft with totals  | "Katale understood the sale; the backend priced it from the catalogue."                                 |
| 0:55–1:10 | Type `yes` → "reply CONFIRM 4821"; type `CONFIRM 4821` → PayPal link                          | "Money never moves on the AI's word — only on a one-time code bound to this order."                     |
| 1:10–1:35 | Second phone: customer opens link → PayPal Sandbox → pays → "Payment received" on both phones | "PayPal takes the payment; a verified webhook marks it paid and stock drops."                           |
| 1:35–2:00 | Customer phone: "hi" → browse with photos → "add 2" → ORDER                                   | "Customers shop on the same number — cart and totals always come from the shop, not the model."         |
| 2:00–2:20 | Merchant: "What's running low?" → "Send me a chart of this week"                              | "Answers come from the ledger."                                                                         |
| 2:20–2:45 | Dashboard: Orders grid, AG Studio assistant builds a chart, Activity trace                    | "Every step is traceable: message, AI decision, approval, PayPal."                                      |
| 2:45–3:00 | Title card                                                                                    | "AI prepares, the backend verifies, the merchant approves, PayPal executes. Katale AI."                 |

### Demo products (set up before recording, real photos)

| Product          | Price  | Stock | Alert at | Why                               |
| ---------------- | ------ | ----- | -------- | --------------------------------- |
| Handmade Basket  | $12.00 | 40    | 10       | Hero product of the voice order   |
| Barkcloth Wallet | $18.00 | 6     | 8        | Shows a low-stock alert           |
| Coffee Gift Pack | $25.00 | 20    | 5        | Customer browse / gift question   |
| Kitenge Tote Bag | $15.00 | 0     | 3        | Shows "Out of stock" to customers |

Remove test products ("Test Wireless Mouse", "Test Bluetooth Speaker") before recording.

### Testing instructions for judges (paste into Devpost)

1. Open <https://kataleai.space> and sign in with the **judge staff account** (credentials in the
   private Devpost field only).
2. **Agent console** — the same AI pipeline as WhatsApp. Try: "Which products are running low?",
   "Create an order for Sarah for 2 handmade baskets", then `yes` (asks for the code) and
   `CONFIRM <code>` (staff can't approve payment requests: owner-only by design — the reply says so).
3. **Products** — click a stock count, change it, press Enter; ask the console "what's low?".
4. **Analytics** — ask the AG Studio assistant "Revenue by product".
5. **Activity** — open any order's trace.
6. To run it yourself: README → Local setup (Docker Compose, Sandbox keys, any OpenAI-compatible model).

PayPal Sandbox only; no real money. WhatsApp itself needs a linked phone, so judges use the console.

### Devpost description (draft)

> **Katale AI — run your shop from WhatsApp, with PayPal and an AI that can't move money on its own.**
>
> Millions of small businesses sell through chats. Katale AI turns those chats into a business:
> merchants add products and stock, create orders by text or voice note, send PayPal payment
> links, ship with tracking, answer disputes and see their sales — all in WhatsApp. Customers
> browse, fill a cart and pay with PayPal on the same number.
>
> **PayPal:** Orders v2 checkout and capture, verified and idempotent webhooks, order tracking,
> Disputes v1 (sync and evidence submission), reconciliation of open links, refunds recorded from
> PayPal. **AI:** an LLM agent with typed tools (inventory, orders, payments, shipments, disputes,
> analytics), Whisper for voice notes, a separate customer assistant, and AG Studio's assistant for
> analytics. **Safety:** the AI only proposes; prices are computed in code; every money action
> needs a typed one-time code; carts and totals shown to customers are built by the backend.
>
> Built during the hackathon (repo started 7 Oct 2026): voice commerce, admin assistant, customer
> shopping, PayPal tracking and disputes, reports, dashboard with AG Grid/AG Studio, product photos
> on Cloudflare R2, and end-to-end testing against the real model and PayPal Sandbox that found and
> fixed 11 defects in the final week.
>
> **Tools:** PayPal REST APIs (Sandbox), OpenAI-compatible LLM (`gpt-4.1-mini`), Whisper, AG Grid
> Community, AG Studio (trial), Cloudflare R2, whatsapp-web.js, Next.js, Fastify, Prisma/Postgres.

### Contingency

| Failure during recording/demo | Fallback                                                                   |
| ----------------------------- | -------------------------------------------------------------------------- |
| WhatsApp disconnected         | Agent console (same pipeline); reconnect from Dashboard → WhatsApp later   |
| Sandbox checkout slow/failing | Show an earlier paid order and its Activity trace; say "Sandbox"           |
| LLM slow                      | Pre-recorded segment; the confirmation and pricing paths are deterministic |
| Voice note misheard           | Katale reads back unclear speech; type the order instead                   |

### Public repository checklist

| Item                                                            | Status                                                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| MIT licence detected by GitHub                                  | ✅                                                                               |
| GitHub About: description still says "multilingual"; no website | ⚠️ Owner: set homepage `https://kataleai.space` and an English-first description |
| README: link to video and judge testing instructions            | ⚠️ After recording                                                               |
| No secrets or live server logins in docs                        | ✅ on this branch (SSH login removed)                                            |
| Local setup works from a clean clone                            | ✅ verified 2026-10-31 (fresh Postgres, migrations, seed)                        |

---

## 7. Manual procedures for the blocked checks

Run on production with the dashboard owner logged in. Nothing here moves real money.

1. **Real admin WhatsApp (text):** from `+256756322224` to the bot, send the 11 requests in section 4
   in order; then "Create an order for Sarah for 2 handmade baskets" → `yes` (expect "reply
   _CONFIRM ####_", no link) → `CONFIRM ####` (expect one link).
2. **Voice notes:** record "Which products are running low?", "I just received twenty baskets",
   "How much did I sell this week?". Expect the transcript-based answer within ~5 s; the stock change
   appears in Products. Then record "confirm 1234": expect a refusal (approvals are typed).
3. **WhatsApp calls:** call the bot number; expect an automatic decline and a voice-note hint. Calls
   are not supported (whatsapp-web.js cannot answer them); voice notes are.
4. **Sandbox capture:** open the checkout link from step 1 in a private window, log in with a
   Sandbox **personal** account, pay. Expect "Payment received" on WhatsApp within seconds, the order
   Paid in Orders, stock reduced once in Products, and a PayPal capture in Payments.
5. **Refunds:** in the Sandbox **business** account, refund $1 of that payment (partial), then the
   rest. Expect two refunds in the order drawer, revenue net of refunds, stock unchanged.
6. **Dispute:** in the Sandbox buyer's activity, "Report a problem" on that payment. Expect one
   WhatsApp dispute alert and the case on Disputes; ask "show my disputes"; "prepare a response" →
   `SUBMIT ####`; if PayPal requires evidence first, `pnpm paypal:dispute require-evidence <id>`
   (Sandbox only).
7. **Shipment:** "Mark ORD-… shipped with DHL tracking 123456789" → `SHIP ####`; check the tracker on
   the Sandbox transaction.
8. **Customer journey:** with a third number (section 3, option 1), run
   [customer-shopping-test.md](customer-shopping-test.md).
9. **WhatsApp page:** Dashboard → WhatsApp shows Connected; "Reconnect" recovers within a minute.
