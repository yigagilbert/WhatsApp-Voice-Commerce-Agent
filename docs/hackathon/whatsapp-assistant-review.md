# Katale AI on WhatsApp — review, capabilities and roadmap (2026-10-17)

Goal: a merchant runs commerce, inventory, payments and business intelligence from WhatsApp, with
the dashboard as the supporting view — while PayPal stays central to the hackathon story.

## 1. Current assessment

| Area                                                      | State                                                  | Notes                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Orders → PayPal checkout → webhook → paid → notification  | ✅ Works in production                                 | Text and English voice, typed CONFIRM, idempotent capture                                                                                        |
| Voice notes (English)                                     | ✅ Works                                               | Whisper; low-confidence read-back; Luganda frozen (off)                                                                                          |
| Merchant analytics in chat                                | ✅ Works                                               | Sales, top products/customers, voice vs text, outstanding, customer summaries                                                                    |
| Dashboard (AG Grid, AG Studio + AI)                       | ✅ Works                                               | Orders, payments, disputes, customers, products, analytics, activity trace                                                                       |
| Shipment tracking (`SHIP`) and PayPal disputes (`SUBMIT`) | ⚠️ Built, simulated tests pass                         | **Real PayPal Sandbox run still pending** (needs the merchant phone and Sandbox buyer; see [shipment-dispute-demo.md](shipment-dispute-demo.md)) |
| Inventory                                                 | ⚠️ Was read-only                                       | Stock never decreased on sales; no restock/adjust, alerts or history → **fixed this phase**                                                      |
| Charts in WhatsApp                                        | ❌ Missing                                             | → **added this phase**                                                                                                                           |
| WhatsApp pairing                                          | ⚠️ Terminal/log QR only; disconnect required a restart | → **dashboard page + reconnect/unlink added this phase**                                                                                         |
| Incoming calls                                            | ⚠️ Ignored (caller hears ringing)                      | → **declined with a voice-note hint this phase**                                                                                                 |
| APIMatic Context Plugin                                   | ❌ Not used                                            | Install blocked in the agent; needs the developer ([apimatic-integration.md](apimatic-integration.md))                                           |
| Dashboard password                                        | ⚠️ Temporary value                                     | Rotate on the VM (operator task)                                                                                                                 |
| Proactive daily summary                                   | ❌ Missing                                             | Recommended next (below)                                                                                                                         |

## 2. whatsapp-web.js capability review (v1.34.7, latest on npm)

Sources: the library's README feature table and TypeScript definitions in the installed package
(`whatsapp-web.js@1.34.7`), [docs.wwebjs.dev](https://docs.wwebjs.dev/), [wwebjs.dev guide](https://wwebjs.dev/guide/).

| Capability                                                           | Status                                                                                                                                                  | Katale use                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Send/receive text, replies, mentions                                 | ✅ Supported                                                                                                                                            | Core chat                                                                                    |
| Send images / documents / audio (`MessageMedia`)                     | ✅ Supported                                                                                                                                            | **Charts (PNG) — implemented**                                                               |
| Receive media incl. voice notes                                      | ✅ Supported (needed a local patch for `downloadMedia` on current WhatsApp Web, see [whatsapp-integration.md](../architecture/whatsapp-integration.md)) | Voice commerce                                                                               |
| Polls (`Poll`, `vote_update`)                                        | ✅ Supported                                                                                                                                            | Possible quick choices (e.g. "which Sarah?") — **not for approvals**, which stay typed codes |
| Reactions (`message.react`)                                          | ✅ Supported                                                                                                                                            | Optional "👀 working on it" marker                                                           |
| Typing / recording state                                             | ✅ Supported                                                                                                                                            | Already used                                                                                 |
| Location, contact cards, stickers                                    | ✅ Supported                                                                                                                                            | Low value for this product                                                                   |
| QR events, `getState`, `logout`, pairing code (`requestPairingCode`) | ✅ Supported                                                                                                                                            | **Dashboard pairing — implemented** (pairing code is a possible follow-up)                   |
| Incoming call event (`call`) + `call.reject()`                       | ✅ Supported                                                                                                                                            | **Decline + voice-note hint — implemented**                                                  |
| Call audio (answering, streaming, outgoing calls)                    | ❌ Not available                                                                                                                                        | No "talk to your data" live calls; `createCallLink` only makes a link a human joins          |
| Buttons / lists                                                      | ❌ **Deprecated** in the library (WhatsApp no longer delivers them to unofficial clients)                                                               | Use numbered text options or polls                                                           |
| Channels, groups admin                                               | ✅ Supported                                                                                                                                            | Not needed                                                                                   |
| Communities                                                          | 🔜 Planned                                                                                                                                              | —                                                                                            |

Constraints that shape every recommendation:

- **Unofficial client.** The README says WhatsApp "does not allow bots or unofficial clients" and accounts can be blocked. Keep a dedicated number, no bulk or unsolicited messaging (merchant-only, opt-in alerts), and keep the Cloud API migration path ([whatsapp-integration.md](../architecture/whatsapp-integration.md#migrating-to-the-whatsapp-cloud-api)).
- **Breakage risk.** WhatsApp Web changes have already broken message IDs and media download (patched). Pin the version and re-run the WhatsApp demo before demos.
- **Resource cost.** One Chromium per number (~300–500 MB RAM); one session per number.
- **No live voice.** Voice notes remain the voice channel.

## 3. Feature recommendations

Scored 1 (low) – 3 (high). Complexity: 1 = small.

| Feature                                                              | Merchant value | Feasibility | Complexity | Hackathon impact | Status                                                       |
| -------------------------------------------------------------------- | -------------- | ----------- | ---------- | ---------------- | ------------------------------------------------------------ |
| Stock ledger, sales reduce stock, restock/count/damage via chat      | 3              | 3           | 2          | 3                | **Done**                                                     |
| Low-stock / out-of-stock alerts (once per crossing)                  | 3              | 3           | 1          | 3                | **Done**                                                     |
| Inventory report: low stock, days of cover, reorder suggestions      | 3              | 3           | 1          | 2                | **Done**                                                     |
| Add / reprice / deactivate products by chat (typed only for prices)  | 2              | 3           | 1          | 2                | **Done**                                                     |
| Charts as WhatsApp images (revenue trend, product revenue, stock)    | 3              | 3           | 2          | 3                | **Done**                                                     |
| Period comparisons with backend-computed % change                    | 2              | 3           | 1          | 2                | **Done**                                                     |
| Dashboard WhatsApp page: status, QR, reconnect, unlink               | 2              | 3           | 2          | 3                | **Done**                                                     |
| Decline calls, suggest voice notes                                   | 1              | 3           | 1          | 1                | **Done**                                                     |
| Scheduled daily/weekly business summary (text + chart, opt-in)       | 3              | 3           | 2          | 3                | Next — needs your OK (proactive messaging)                   |
| Run the real Sandbox shipment + dispute validation                   | 2              | 3           | 1          | 3                | Next — needs the merchant phone + Sandbox buyer              |
| PayPal invoices (Invoicing v2) for customers without WhatsApp        | 3              | 3           | 2          | 3                | Recommended (client methods exist; add `CONFIRM`-bound tool) |
| Unpaid-order reminders to the merchant ("3 links unpaid for 2 days") | 3              | 3           | 1          | 2                | Recommended                                                  |
| Polls for disambiguation ("Which Sarah?")                            | 1              | 2           | 2          | 1                | Optional; never for approvals                                |
| Pairing-code login (no camera needed)                                | 1              | 2           | 1          | 1                | Optional                                                     |
| Voice-note replies (TTS)                                             | 2              | 3           | 2          | 2                | Deferred (out of scope earlier)                              |
| Live call "talk to your data"                                        | —              | ❌          | —          | —                | **Not feasible** with whatsapp-web.js (no call audio)        |
| Buttons / list menus                                                 | —              | ❌          | —          | —                | **Not feasible** (deprecated)                                |
| Official WhatsApp Cloud API adapter                                  | 3              | 2           | 3          | 2                | Architectural change — for review                            |

## 4. Roadmap

**Quick wins (done in this phase, with tests):** inventory ledger and alerts, inventory/catalog
tools, charts as images (also shown in the Agent console), period comparisons, dashboard WhatsApp
page with QR/reconnect/unlink, call handling.

**Core (next):**

1. Real Sandbox validation of `SHIP` and `SUBMIT` (no code; your phone + Sandbox buyer).
2. Opt-in scheduled business summary (e.g. 08:00 daily: yesterday's sales vs the day before, low stock, unpaid links, open disputes; Monday: weekly chart). Proactive messages go only to the merchant's own chat.
3. PayPal invoices through the confirmation flow; unpaid-link reminders.

**Advanced / for review before building:**

- WhatsApp Cloud API adapter (official, template messages, interactive buttons) — new channel adapter; the commerce core is unchanged.
- Voice-note replies (TTS) for "talk to your business data" in audio.
- Per-merchant users and multi-tenant onboarding.

## 5. What changed in this phase

| Change                                                                                                                                                                                              | Where                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `StockMovement` ledger (SALE, RESTOCK, ADJUSTMENT, RETURN, DAMAGED), `Product.reorderLevel`, alert state                                                                                            | migration `inventory_movements`                       |
| `InventoryService`: sale deduction inside the payment-completion transaction (unique per order line), merchant adjustments (no negative stock, conditional update), reorder levels, report, history | `packages/commerce/src/services/inventory.service.ts` |
| Low-stock / out-of-stock WhatsApp alert after a sale, once per crossing                                                                                                                             | `PaymentService`                                      |
| Tools: `inventory_report`, `stock_history`, `adjust_stock`, `add_product`, `update_product`, `compare_sales`, `send_chart`                                                                          | `apps/api/src/modules/agent/tools.ts`                 |
| Charts: SVG → PNG with resvg + bundled Inter font; captions written by the backend                                                                                                                  | `apps/api/src/modules/reports`                        |
| Image replies through the pipeline, worker gateway and WhatsApp (`MessageMedia`); images in the Agent console                                                                                       | shared schema, worker, console                        |
| Worker connection state, QR kept in memory (optional log printing), auto-reconnect, reconnect/unlink endpoints (internal token)                                                                     | `apps/whatsapp`                                       |
| Dashboard WhatsApp page (QR rendered server-side, behind login, no-store)                                                                                                                           | `apps/web/app/whatsapp`                               |
| Calls declined with a voice-note hint (throttled per caller)                                                                                                                                        | worker                                                |

Safety: prices can't be set from voice notes; stock can't go negative through adjustments; every
change is ledgered and audited; charts only draw backend aggregates; the QR is only visible to a
signed-in operator and never logged when `WHATSAPP_PRINT_QR=false`.

Tests: unit (charts, comparisons, stock status, gateway session/media), integration
(`tests/integration/inventory-reports.test.ts`: sale deduction once, alerts once per crossing,
restock, add/update products, voice price guard, charts as images, comparisons, session auth),
real-LLM (`tests/external/inventory-questions.test.ts`).
