# Katale AI — demo video kit

Everything for the PayPal AI Hackathon video: the script with voice-over and on-screen captions,
the shot checklist, the graphics and the YouTube text. Target length **2:50** (judges stop at
3:00). Replaces the shorter script in [../devpost-submission.md](../devpost-submission.md).

The one idea the video must land in the first 15 seconds: **a voice note became a priced PayPal
order, and the AI never touched the money.**

## Files

| File                                                                                               | Use                                                                               |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [graphics/title-card.png](graphics/title-card.png)                                                 | Overlay at the end of the cold open (0:08–0:12)                                   |
| [graphics/architecture.png](graphics/architecture.png)                                             | Scene 8 (2:32–2:45)                                                               |
| [graphics/closing-card.png](graphics/closing-card.png)                                             | Scene 9 (2:45–2:52)                                                               |
| [graphics/thumbnail-youtube.png](graphics/thumbnail-youtube.png)                                   | YouTube custom thumbnail (1280×720)                                               |
| [graphics/thumbnail-devpost.png](graphics/thumbnail-devpost.png)                                   | Devpost project thumbnail (3:2, 1200×800)                                         |
| [graphics/logo-full.png](graphics/logo-full.png), [graphics/logo-icon.png](graphics/logo-icon.png) | Logo with a transparent background (light backgrounds only: the wordmark is dark) |
| [voice-over.srt](voice-over.srt)                                                                   | Subtitles of the voice-over; re-time after the edit                               |
| `graphics/*.html` + [graphics/render.sh](graphics/render.sh)                                       | Sources; edit the HTML and run the script to re-render                            |

## Script

Record the screen first, scene by scene; record the voice-over afterwards against the edit.
Captions are short on-screen labels (burned in), separate from the subtitles.

| #   | Time      | Screen                                                                                                                                                                                                                    | Voice-over                                                                                                                                                                                                                    | Caption                                                                    |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | 0:00–0:12 | **Cold open.** Merchant phone: send the voice note from scene 3 → the priced draft → (jump cut) the PayPal link. All at 4–8×. Title card fades in at 0:08                                                                 | "This is a voice note to a shop's WhatsApp. Seconds later it's a priced order with a PayPal link, and the AI never touched the money."                                                                                        | Voice note → priced order → PayPal link                                    |
| 2   | 0:12–0:27 | Real footage: a stall or shop, hands on a phone; then a busy chat of orders                                                                                                                                               | "Across East Africa, small shops already sell in WhatsApp chats. Orders come as voice notes, and totals, payment links and stock are worked out by hand. Katale AI turns that chat into the shop's back office."              | —                                                                          |
| 3   | 0:27–1:00 | Merchant phone: 🎙️ _"Create an order for Sarah for three handmade baskets and five dollars delivery."_ → draft with lines and total → type `yes` → "Reply CONFIRM ####" → type the code → PayPal link. Zoom on the totals | "The merchant just talks. The AI understands the request, but every price and total comes from the shop's catalogue, computed by the backend. And yes isn't enough: money only moves on a one-time code bound to this order." | Totals from the catalogue, not the AI / One-time code, bound to this order |
| 4   | 1:00–1:20 | Buyer device: open the link → PayPal **Sandbox** (keep the word on screen) → pay. Merchant phone: "✅ Payment received". Cut to Products: basket stock down by 3                                                          | "The customer pays on PayPal, here in Sandbox. A verified webhook marks the order paid, tells the merchant, and the stock drops."                                                                                             | PayPal Sandbox · verified webhook                                          |
| 5   | 1:20–1:50 | Customer phone: `hi` → `1` → `2` (**photo**, then details) → `add 2` → _"I want 500 baskets"_ → the shop's limit reply → `checkout` → PayPal link                                                                         | "Customers shop on the same number: browse with photos, add to a cart and check out with PayPal. Ask for five hundred baskets, and the shop's rules answer, not the model. Every cart and total is built by the backend."     | The shop's rules answer, not the model                                     |
| 6   | 1:50–2:08 | Merchant phone: _"Mark ORD-… shipped with DHL tracking 123456789"_ → "Reply SHIP ####" → the code → shipped                                                                                                               | "After the sale, the same rule. The AI prepares the shipment, the merchant approves with a code, and the tracking number goes to PayPal. Disputes work the same way."                                                         | Tracking sent to PayPal                                                    |
| 7   | 2:08–2:32 | Dashboard: Products, edit a stock count in the grid → Analytics, ask AG Studio _"Revenue by product"_ → Orders → the voice order → Activity trace                                                                         | "The dashboard runs on AG Grid. Edit stock right in the grid, ask AG Studio for a chart, and open the trace of any order: the voice note, the AI's decision, the approval and PayPal."                                        | AG Grid · AG Studio · full trace                                           |
| 8   | 2:32–2:45 | [architecture.png](graphics/architecture.png); slow push-in                                                                                                                                                               | "Under the hood: a WhatsApp worker, an AI agent with typed tools, a backend that checks every number, and PayPal orders, webhooks, tracking and disputes. Four hundred and seventy-one automated tests."                      | —                                                                          |
| 9   | 2:45–2:52 | [closing-card.png](graphics/closing-card.png)                                                                                                                                                                             | "AI prepares. The backend verifies. The merchant approves. PayPal executes. Katale AI, built in Uganda for sellers across East Africa."                                                                                       | —                                                                          |

About 300 words of voice-over: calm pace, with the screen carrying the pauses.

Wording rules: say "PayPal Sandbox" once; don't say "every East African country"; no statistics
we can't cite. The test count (256 unit + 215 integration = 471) is from the 2 Nov run; update it
if the suite changes.

## Before the shoot

**Production**

- [ ] Dashboard → WhatsApp shows **Connected**.
- [ ] Products: _Handmade Basket_ $12.00 with a photo, stock ≥ 40; _Barkcloth Wallet_ with a photo
      and stock under its alert level; two or three more products with real photos. Customer
      catalogue shows the products you'll use in scene 5 as numbers 1–3.
- [ ] _Sarah_ exists as a customer (the voice order looks her up).
- [ ] The customer phone has **fewer than 3 unpaid orders**. A fourth checkout is refused ("You
      have 3 unpaid orders"), and rehearsals create them. Pay or cancel old ones first.
- [ ] Rehearse scene 5's _"I want 500 baskets"_ once and keep whatever the shop replies only if it
      is the limit message; the reply goes through the AI, so check it before filming.
- [ ] Optional clean slate (deletes demo orders and payments; your call, not reversible):
      `docker compose run --rm -e DEMO_RESET_ALLOWED=true api node dist/demo-reset.js --confirm kampala-crafts`

**Devices**

- [ ] Merchant phone (admin number) and customer phone: Do Not Disturb on, charged, clean status
      bar, old chats archived, largest readable font that still fits a draft on screen.
- [ ] Buyer device signed in to the **PayPal Sandbox personal** account.
- [ ] Dashboard signed in, tabs: Products, Analytics, Orders, Activity. Browser zoom 125%, no
      bookmarks bar, no other tabs.
- [ ] Phone mirroring on the Mac: iPhone Mirroring or QuickTime (File → New Movie Recording → the
      iPhone) for iPhone; `scrcpy` for Android.
- [ ] Recorder: Screen Studio (auto-zoom) or OBS, 1920×1080, 30 fps.

## Filming

- Record each scene separately, at least two takes; nothing has to work in one run.
- Leave 2 s before and after each action so the edit has room.
- Film the cold open last, from your best scene 3 take, or simply reuse that take sped up.
- Scene 2 needs 10–15 s of real footage: a stall, a shop counter, hands with a phone. Hold the
  phone steady, landscape, daylight.

## Editing

- Layout: phone recording large on the left, caption or dashboard on the right; plain light
  background (#f6faf3 matches the graphics).
- Speed up every wait (PayPal loading, "typing…") 4–8×; never talk over a spinner.
- Zoom in on the line that matters: totals, the CONFIRM request, "✅ Payment received", the photo.
- Blur every phone number except the bot's, and the Sandbox buyer's email.
- Music: optional, quiet (about −25 dB under the voice), royalty-free.
- Export 1920×1080, H.264, under 3:00. Upload to YouTube as **Public** or **Unlisted**, then add
  the link to Devpost and the README.

## YouTube upload text

**Title:** Katale AI — run your shop from WhatsApp with AI and PayPal (PayPal AI Hackathon)

**Description:**

```text
Katale AI turns a small shop's WhatsApp number into its back office and storefront. Merchants create orders by voice note, send PayPal payment links, ship with tracking and answer disputes; customers browse with photos, fill a cart and pay with PayPal.

The AI prepares, the backend verifies, the merchant approves with a one-time code, PayPal executes. Built in Uganda for sellers across East Africa. Payments in this video use PayPal Sandbox.

Demo: https://kataleai.space
Code: https://github.com/yigagilbert/WhatsApp-Voice-Commerce-Agent

0:00 Voice note to PayPal order
0:12 The problem
0:27 Merchant order by voice
1:00 PayPal payment
1:20 Customers shop on WhatsApp
1:50 Shipping with tracking
2:08 AG Grid dashboard and trace
2:32 How it's built
```

Re-time the chapters to the final edit (YouTube needs the first at 0:00 and each at least 10 s).
