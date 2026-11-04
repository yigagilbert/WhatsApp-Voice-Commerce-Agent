# Public storefront with WhatsApp checkout

_Status: built on `claude/katale-public-storefront-d03d24`. Not merged or deployed._

A customer browses at `/shop/<merchant>`, builds a cart without an account, and taps **Checkout on
WhatsApp**. The ordering conversation, bargaining and PayPal payment stay with the WhatsApp agent.
The website makes discovery easier; it does not become a second checkout.

## 1. What the review found

| Area              | What exists                                                              | Consequence                                                              |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Catalogue         | `CustomerCatalog` loads up to 500 products into memory and filters there | Fine for chat, not for 1,000+ products. The web needs SQL pagination     |
| Categories        | None. `Product` has no category                                          | New nullable `Product.category`                                          |
| Search            | In-memory token matching                                                 | Reused the tokeniser; matching runs in SQL per word                      |
| Stock             | Stock minus unpaid orders, shown only as labels                          | Same rule and labels on the web (`RESERVING`, `availability`)            |
| Variations        | None in the schema                                                       | Not built. Product pages show the single product                         |
| Cart              | A cart is a `DRAFT` `Order`, which requires a `customerId`               | A web visitor has no customer yet, so a web cart can't be an `Order`     |
| Checkout          | `nextStep` → `ORDER` → `place` with quote check, advisory lock, PayPal   | Reused unchanged. Web carts enter this flow as an ordinary cart          |
| Pricing           | `automaticUnitPrice`, `bundleQualifies`, accepted bargains on the order  | Web quotes use the same pure functions. Bargains stay WhatsApp-only      |
| PayPal            | Links, return capture, webhooks, reminders, reconciliation               | Untouched                                                                |
| Images            | Private R2 bucket or Postgres, served through the API                    | Public route for visible products only, plus a 640 px grid size          |
| Merchant/number   | `WhatsAppAccount` per bot number; one worker links one number            | Checkout uses the merchant's own account, checked against the linked bot |
| Public site       | `(site)` homepage; `proxy.ts` treats everything else as dashboard        | `/shop/*` added to the public paths; robots and sitemap updated          |
| Customer identity | The sender's WhatsApp ID, only known when a message arrives              | The cart is bound to a customer at that moment, never before             |
| Rate limiting     | Global 120 requests per minute per IP                                    | The web server forwards the visitor's address; images have their own cap |

**Existing limits this feature doesn't change:** the dashboard Products grid shows at most 1,000
products, and the WhatsApp catalogue (`CustomerCatalog.visible`) sees the first 500 by name. On a
larger shop, the assistant can't find a product past that point by name, though the website can.

## 2. Design

```
Browser (localStorage: product IDs + quantities only)
   │  every view → POST /cart → priced by the backend
   │  Checkout    → POST /checkout (items, quote)
   ▼
StorefrontService ── creates CartTransfer { tokenHash, items, expiresAt: +60 min }
   │  returns wa.me/<merchant's number>?text=…Cart reference: KC-XXXXXXXXXXXXXXXXXXXXXXXX
   ▼
Customer sends the message on WhatsApp
   ▼
CustomerConversationService.receiveCart → StorefrontService.claim
   │  one transaction: OPEN → CLAIMED, bound to this customer → ShopOrderService.importLines
   ▼
The customer's ordinary cart (DRAFT Order, source "storefront")
   ▼
Existing flow: name → delivery → summary → ORDER → PayPal → webhook/return → stock
```

### Data model

Two small tables and one column, all in migration `20261104100000_public_storefront`:

- `Product.category`: free text, indexed per merchant. Edited in the product editor and the grid.
- `Storefront` (one per merchant): `slug`, `enabled`, `tagline`, `about`, logo. A separate table so
  logo bytes are never loaded with `Merchant`, which is read on every inbound message.
- `CartTransfer`: exists only from "Checkout" until used or expired. It is not a second cart.

Which products appear is the existing `visibleToCustomers` flag, so a product shows or hides on
WhatsApp and the web together, with no second switch to keep in sync.

### Handoff security

| Requirement                       | How it's met                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| No trusted prices or data in link | The link holds only the reference. The customer's identity isn't known or asked for on the website                |
| Can't be guessed                  | 120 random bits from `crypto.randomBytes`, plus a limit of 20 checkouts a minute per visitor                      |
| Can't be read from the database   | Only the SHA-256 hash is stored                                                                                   |
| Short-lived                       | 60 minutes. Expired rows are deleted 7 days later by the scheduler                                                |
| Bound to merchant                 | Looked up with the receiving bot's merchant. Another shop's reference looks like one that never existed           |
| Bound to customer, single use     | A conditional update (`status = OPEN`) in the claim transaction: of two racing messages exactly one wins          |
| Duplicate WhatsApp delivery       | The existing unique message ID returns `duplicate` before any of this runs                                        |
| Reuse by the same customer        | "You've already sent me that cart": no change to the cart, no second order                                        |
| Older links of a changed cart     | A new checkout from the same browser cart marks older references `SUPERSEDED`                                     |
| Prices and stock revalidated      | At web checkout (quote compare), when claimed (each line, with notes on changes), and at `ORDER` (existing check) |
| Opening the link isn't a checkout | The status only changes on claim. The website keeps the cart until then                                           |
| Merchant's own number             | From `WhatsAppAccount`, with customer shopping on. Refused if the worker is linked to a different number          |
| Refusals don't lose the cart      | Too many unpaid orders rolls the claim back, so the same reference works after the customer pays one              |

Publishing a storefront makes the shop's WhatsApp number public, because every checkout link
contains it. That's different from the homepage's separate `listedOnHomepage` opt-in.

### Choices worth a second look

- **A cart joining an existing WhatsApp cart merges.** A product already in the cart takes the
  website's quantity and other lines stay, so accepted bargains on that cart keep applying.
- **A cart arriving during a hand-off to a person turns automated replies back on** and tells the
  team. Otherwise the customer's checkout would stall in silence.
- **Admin numbers can't check out.** They get a message saying to test from another phone, because
  later replies would go to the admin agent.
- **Negotiated prices appear only on WhatsApp.** The website shows quantity and bundle discounts
  and says when a price is open to offers.

## 3. WhatsApp assistant

The WhatsApp-only flow is unchanged. When the shop is published and `WEB_PUBLIC_URL` is set:

- "Show me all your products", "catalogue" and "website" get the link without an AI call.
- The menu and multi-page product lists include the link, alongside the numbered options.
- New tool `catalogue_link` returns shop, product or category links from the backend. The model is
  told to share only links the tool returned.

## 4. Dashboard

**Storefront** page: publish switch, address, tagline, description, logo, link, preview of an
unpublished shop, QR code with download, WhatsApp share for the shop and each category, product
counts, and a warning when checkout can't work yet with the reason. Products grid: edit category
and Shown/Hidden in place. Product page: view on storefront and share on WhatsApp.

Preview works for the signed-in owner only: the dashboard server presents its service token and the
user's session, and the API checks that user belongs to that shop.

## 5. Visual design

The storefront is white first and always renders in light mode, so a merchant's shop looks the same
for every customer. Tokens live at the top of `apps/web/app/shop/[slug]/shop.module.css`:

| Token      | Value     | Used for                                                   |
| ---------- | --------- | ---------------------------------------------------------- |
| Background | `#FFFFFF` | Page, header, cards                                        |
| Surface    | `#F8FAFC` | Photo tiles, search field, order summary, footer           |
| Text       | `#111827` | Headings, prices, Add to cart                              |
| Muted text | `#64748B` | Descriptions, categories, secondary information            |
| Green      | `#15803D` | Checkout on WhatsApp, active category, savings, focus ring |
| Border     | `#E5E7EB` | Structure                                                  |

Green marks the step that continues on WhatsApp, so **Add to cart** is charcoal and **Checkout on
WhatsApp** is the only large green button. Geist is the only typeface, which also keeps page weight
down.

Page changes run as React transitions, with a progress line and result placeholders. A route-level
`loading.tsx` isn't used because it would turn every missing shop or product into a `200` response.

`pnpm storefront:demo` draws simple placeholder illustrations. They aren't photographs, so upload
real photos for a merchant's shop and for the demo video.

## 6. Configuration and deployment

- Run the migration.
- Set `WEB_PUBLIC_URL` for the API as well as the web app. Without it, the assistant sends no links.
- Needs `CUSTOMER_COMMERCE_ENABLED=true` and customer shopping on for the number, as today.
- `pnpm storefront:demo 120` fills the seeded demo shop with generated products and images. It
  touches only the demo merchant and refuses to run with `PAYPAL_ENV=live`.

## 7. Test results

Automated, against real Postgres with simulated PayPal (`pnpm test:integration`):
[`tests/integration/storefront.test.ts`](../../tests/integration/storefront.test.ts) has 39 tests,
and the full suite passes.

| Requirement                                      | Result                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 10, 100, 500 and 1,050 products                  | Every page served, each product once. Each request under 1 second in the test      |
| Search, categories, sorting, in-stock filter     | Pass, including plural/singular and stock held by unpaid orders                    |
| Images through the object store                  | Pass with an in-memory store. Hidden products and other shops' products return 404 |
| Cart pricing, forged prices, malformed carts     | Pass. Client-sent prices are ignored                                               |
| Deep link                                        | Merchant's number, reference only, no prices or item names                         |
| Whole journey to paid order and stock deduction  | Pass with simulated PayPal                                                         |
| Invalid, expired, replaced and reused references | Pass                                                                               |
| Duplicate messages, racing customers             | Pass: one cart, one order, one PayPal link                                         |
| Merchant isolation                               | Pass                                                                               |
| Stock, price or visibility change before claim   | Pass, with a note to the customer                                                  |
| Bargaining after the handoff                     | Pass: price from the backend, at or above the minimum                              |
| WhatsApp-only shopping                           | Pass, with no change to the existing customer test flows                           |

In the browser, against the running web app and API on a local database with 1,053 products:

| Check                               | Result                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------- |
| Desktop 1280 px, mobile 375 px      | No horizontal scroll at 375 px. Light and dark both render                 |
| Cart, drawer, quantity, persistence | Pass, including across reloads                                             |
| Load more                           | 24 per page, no duplicates, no broken images                               |
| Price changed before checkout       | Cart updates and asks the customer to check it. No reference created       |
| Handoff panel                       | Shows the message and reference, then updates to "has your cart" on claim  |
| Publish, unpublish, preview         | Pass. An unpublished shop returns 404 without the owner's session          |
| SEO                                 | Titles, canonical, Open Graph, Product JSON-LD, robots, sitemap, real 404s |
| Response times, 1,053 products      | API about 6–11 ms. Full page about 80–90 ms from the Next.js dev server    |

Screenshots: [`docs/hackathon/storefront/`](../hackathon/storefront/). Their products use generated
placeholder illustrations, not real photography.

### Not yet tested

These need real accounts or devices, and should be done before the demo:

- **A real WhatsApp message.** The journey was driven through `POST /api/agent/message`, the same
  endpoint the WhatsApp worker calls. The worker, a phone and opening `wa.me` were not exercised.
- **Real PayPal Sandbox.** The journey used the simulated PayPal. Payment code is unchanged, but a
  sandbox order hasn't been created or paid through this flow.
- **Real Cloudflare R2.** Tested with an in-memory store implementing the same interface.
- **Opening WhatsApp in a new tab on real phones.** The test browser pane doesn't open new tabs; the
  **Open WhatsApp** button is the fallback if a browser blocks it.
- **Production build behind Nginx**, including client IP forwarding for rate limits.
- **A screen reader pass.** Text contrast was calculated (at least 4.55:1) and the keyboard path
  through the header and cart was checked, but no assistive technology or axe audit was run.
- **Slow networks and real phones.** Page weight was measured locally (about 141 KB of scripts and
  98 KB of images on first view), but nothing was throttled or tried on a real device.

## 8. Not built

Product variations and multiple photos per product (neither is in the schema), advanced filters, wishlists, customer accounts,
recommendations and storefront theming. Search is word matching rather than typo-tolerant. Fuzzy
matching would be the first thing to add.
