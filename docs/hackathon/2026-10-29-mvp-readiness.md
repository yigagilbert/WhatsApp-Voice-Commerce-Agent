# Katale AI — hackathon MVP readiness (2026-10-29)

Branch `feat/hackathon-mvp-r2-images`. Scope: dashboard review, product photos with Cloudflare R2,
readiness against the PayPal AI Hackathon criteria, demo package and submission checklist.

Sources for the hackathon rules: the official rules at
<https://paypalaihackathon.devpost.com/rules> and PayPal's announcement at
<https://developer.paypal.com/community/blog/PayPal_AI_Hackathon>. Re-read both before submitting;
this summary reflects them as of 2026-10-29.

**Labels used below.** **VERIFIED (prod)** — seen working on the production deployment.
**VERIFIED (local)** — exercised end to end on a local stack (real Postgres, real PayPal Sandbox
and LLM where stated). **TESTED** — automated tests only. **SIMULATED** — PayPal or WhatsApp
replaced by a test double. **NOT IN PROD** — implemented but not deployed or switched off.

---

## 1. Executive summary

Katale AI is a working product, not a mock: a merchant runs sales from WhatsApp by text or voice,
the backend prices every order, money only moves after a typed one-time code, PayPal (Sandbox)
takes the payment, a verified webhook closes the loop, and a dashboard (AG Grid / AG Studio) shows
the business. Phase 1 hardening is in production (`v0.1.0-202610260553`).

The biggest gaps for judging were not technical depth but **access and polish**:

| Gap                                                                      | Status on this branch                                                       |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| No open-source license (required for a public repo submission)           | **Fixed** — MIT `LICENSE` added (owner to confirm the choice)               |
| Product photos hard to find; no way to create a product in the dashboard | **Fixed** — full product editor with photo upload, preview, replace, remove |
| Photos stored only in Postgres                                           | **Fixed** — Cloudflare R2 (private bucket) with database fallback           |
| Weekly report chart images failing in production                         | **Mitigated** — worker retries as a document; needs a real-device check     |
| A new merchant has no guided path                                        | **Fixed** — "Get started" checklist on the overview                         |
| Judges cannot try it without our phones                                  | **Open — owner decision** (section 8)                                       |
| Demo video, Devpost text                                                 | **Open** — script and checklist below                                       |

---

## 2. MVP assessment

### Merchant journey

| Step                                        | Status                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Sign in to the dashboard (owner/staff)      | VERIFIED (local); prod still in setup mode until the owner creates an account              |
| Link WhatsApp by QR                         | VERIFIED (prod)                                                                            |
| Add admin numbers                           | VERIFIED (prod)                                                                            |
| Add/edit products, stock, low-stock alert   | VERIFIED (local) — new on this branch                                                      |
| Product photo upload, replace, remove       | VERIFIED (local) with database storage and with an S3-compatible server (MinIO); TESTED    |
| Voice/text order → backend-priced draft     | VERIFIED (prod)                                                                            |
| `CONFIRM` code → PayPal payment link        | VERIFIED (prod)                                                                            |
| Webhook marks paid, merchant notified       | VERIFIED (prod) with Sandbox payments                                                      |
| Sales questions answered from the database  | VERIFIED (prod)                                                                            |
| Ship with tracking (`SHIP` code)            | see PROJECT_STATUS.md (Sandbox tracking verified earlier)                                  |
| Dispute review and response (`SUBMIT` code) | see PROJECT_STATUS.md                                                                      |
| Refunds made in PayPal recorded             | TESTED (SIMULATED PAYPAL); real Sandbox refund pending a buyer approval                    |
| Weekly report with chart image              | Text VERIFIED (prod); image failing since 2026-10-19, fallback on this branch, NOT IN PROD |
| Dashboard analytics (AG Grid, AG Studio)    | VERIFIED (prod)                                                                            |

### Customer journey (shopping on WhatsApp)

| Step                                           | Status                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| Browse products, ask about one (with photo)    | VERIFIED (local, stand-in WhatsApp gateway) — photo sent before the text |
| Cart, checkout, PayPal link, paid notification | TESTED + VERIFIED (local) earlier; see customer-shopping-test.md         |
| Cancel an unpaid order                         | TESTED                                                                   |
| In production                                  | **NOT IN PROD** — `CUSTOMER_COMMERCE_ENABLED` is off                     |

---

## 3. Dashboard review

What a merchant needs first, and where it was:

| Finding                                                                                | Severity | Outcome                                                                                            |
| -------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| The photo control was a small button inside an expandable row; no way to add a product | P0       | Product editor at `/products/new` and `/products/:id`; **+ Add product**; photo is the first field |
| Grid had no photo column                                                               | P1       | Thumbnail column; a dashed "+" opens the editor when a product has no photo                        |
| No feedback before upload (type/size), no preview                                      | P1       | Instant validation, "Not saved yet" preview, Undo, Replace, Remove with confirmation               |
| Stock changes only by chat                                                             | P1       | "Units in stock" field records an ADJUSTMENT in the stock ledger                                   |
| Visibility to customers / active flags not editable                                    | P1       | Checkboxes in the editor                                                                           |
| Empty overview for a new merchant                                                      | P1       | "Get started" checklist (WhatsApp, admin, product with photo, first order, first payment)          |
| No in-dashboard reply to customer chats                                                | P2       | Not changed (deliberately out of scope)                                                            |
| Mobile: navigation is a long top list                                                  | P2       | Not changed; layouts checked at 375 px, usable                                                     |

---

## 4. Product photos and Cloudflare R2

Implementation, configuration and tests: [docs/deployment/cloudflare-r2.md](../deployment/cloudflare-r2.md).

- Upload on create and edit, preview, replace, remove; shown in the editor, the grid, and sent to
  WhatsApp customers for active, visible products.
- Validation by decoding (not by name/type), EXIF/GPS stripped, resized to ≤1600 px JPEG with a
  320 px thumbnail.
- Private R2 bucket via the S3 API (SigV4); credentials only in the API's environment; keys and
  metadata in `ProductImage`; merchant-scoped keys and queries; old objects cleaned up after a
  replace; partial failures roll back.
- Database storage remains as a fallback, so nothing breaks before R2 is configured.

**What the owner needs to provide:** Cloudflare account ID, an R2 API token (Object Read & Write,
scoped to one bucket) — access key ID and secret — and the bucket name. No domain, CORS rule or
public bucket is needed.

---

## 5. Readiness scorecard

The rules give the five criteria equal weight. Scores are our honest estimate (1–5) of where the
submission stands today, with what would raise them.

| Criterion                        | Score | Evidence                                                                                                                                                               | To raise it                                                                    |
| -------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Technological implementation** | 4.5   | Typed monorepo, 405 automated tests (218 unit/HTTP, 187 Postgres integration), verified PayPal webhooks, idempotency, confirmation codes, audit trail, CI, live deploy | Show the trace view and test counts in the video                               |
| **Design**                       | 3.5   | Clean dashboard, AG Grid/Studio, product editor, getting-started checklist; WhatsApp replies formatted for phones                                                      | Product photos on the demo catalogue; a short mobile-nav improvement           |
| **Potential impact**             | 4     | Targets chat-first small sellers (East Africa first); voice-first; no app to install for customers                                                                     | One concrete merchant story with numbers in the video and description          |
| **Quality of the idea**          | 4     | Agentic commerce with a hard safety line: AI prepares, backend verifies, merchant approves, PayPal executes                                                            | State the differentiation in the first 20 seconds                              |
| **Presentation**                 | 3     | Demo scripts exist but run ~7 minutes; no video yet                                                                                                                    | The 3-minute script below; captions; show the phone and dashboard side by side |

Sponsor and honourable-mention fit: **AG Grid** (used: Orders/Products grids, AG Studio analytics);
**APIMatic** (only claim it if the review in [apimatic-integration.md](apimatic-integration.md) is
completed); **Best Use of PayPal + AI**, **Best Use of Agentic Commerce** and **Best Demo
Delivery** are the natural targets.

---

## 6. Demo package

### Value proposition

Small businesses already sell in WhatsApp chats. Katale AI turns a voice note into a priced order,
a PayPal payment and a bookkeeping record — without the AI ever being able to move money on its own.

### Differentiation

- **Safety by construction:** the model can only _propose_; the backend prices from the catalogue,
  and a typed, single-use code approves money movement. A spoken "confirm" is refused.
- **Operations after the sale:** shipment tracking pushed to PayPal and dispute responses drafted
  from real evidence — still behind approval codes.
- **Voice-first, chat-native:** no app for merchants or customers to install.
- **Answers from the ledger, not the model:** sales questions are database queries.

### Three-minute video script

| Time      | Show                                                                          | Say                                                                                             |
| --------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 0:00–0:20 | Phone with WhatsApp, a market stall photo or the dashboard                    | "Millions of small businesses sell in chats. Totals, payment links and records are all manual." |
| 0:20–0:35 | Dashboard: Products, add a product with a photo                               | "The merchant sets up the catalogue once — photos are stored in Cloudflare R2."                 |
| 0:35–1:05 | 🎙️ voice note: order for Sarah; the draft reply with totals                   | "Katale understood the sale; the backend priced it from the catalogue."                         |
| 1:05–1:25 | Type `CONFIRM 4821`; payment link arrives                                     | "Money never moves on the AI's word: a typed, one-time code bound to this order."               |
| 1:25–1:55 | Second device: PayPal Sandbox checkout → success; WhatsApp "Payment received" | "PayPal takes the payment; a verified webhook marks it paid."                                   |
| 1:55–2:15 | Ask "How much did I sell this week?"                                          | "Answers come from the ledger."                                                                 |
| 2:15–2:40 | Dashboard overview, Orders grid, AG Studio question                           | "Operations at a glance with AG Grid; analytics by asking."                                     |
| 2:40–3:00 | Activity trace; closing line                                                  | "AI prepares, the backend verifies, the merchant approves, PayPal executes. That's Katale AI."  |

Keep it under 3:00; record the phone screen and dashboard separately and cut them together. Say
"PayPal Sandbox" on screen once.

### Demo data and accounts

- Merchant: Kampala Crafts (seeded catalogue). Before recording, add photos to the 3–4 products
  used in the demo.
- Dashboard: an owner account for us and a **separate staff account for judges** (created by the
  owner in **Account → Dashboard accounts**; share it only in the Devpost testing instructions).
- PayPal: the Sandbox business account in `.env` and a Sandbox **Personal** buyer for checkout.
- WhatsApp: the merchant's linked number; an admin number on our phone.

### Pre-recording checklist

1. Production healthy, WhatsApp client ready, dashboard owner account created.
2. Optional reset of demo orders (see final-demo-script.md).
3. Products have photos; stock is above alert levels unless a low-stock alert is part of the story.
4. Sandbox buyer logged in on the second device; phone on Do Not Disturb.
5. Dry run once end to end; check the webhook arrives within seconds.

### Fallback plan

| Problem                     | Fallback                                                              |
| --------------------------- | --------------------------------------------------------------------- |
| WhatsApp disconnected       | Same flow in the dashboard's **Agent console** (same pipeline, typed) |
| Voice note slow or misheard | Type the order; mention voice support over earlier footage            |
| Sandbox checkout fails      | Show an earlier paid order and its trace in Activity                  |
| LLM provider slow           | Pre-recorded segment for the AI scenes                                |

### Other material

- **Screenshots:** WhatsApp draft with totals; CONFIRM; PayPal success; payment received; product
  editor with photo; Orders grid; AG Studio chart; Activity trace.
- **Architecture image:** WhatsApp → worker → API (agent tools, commerce services, confirmations) →
  PayPal (orders, webhooks, tracking, disputes) and Postgres/R2 → dashboard. Use the diagram in
  [docs/architecture/system-overview.md](../architecture/system-overview.md) as the source.
- **Description:** problem, what it does, how it uses PayPal and AI, safety model, what's verified
  vs Sandbox, what's next (official WhatsApp Cloud API, multi-merchant).

---

## 7. Submission checklist

| Requirement (rules)                                                     | Status                                                                        |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Working project that uses PayPal and AI                                 | ✅ live (PayPal Sandbox)                                                      |
| Public code repository                                                  | ✅ public on GitHub                                                           |
| Open-source license visible in the repo                                 | ✅ on this branch (MIT) — **confirm choice, merge**                           |
| Demo video under 3 minutes, public on YouTube (or as the rules specify) | ❌ to record                                                                  |
| Text description of the project and how it was built                    | ❌ to write (outline above)                                                   |
| Access for judges: live URL and test credentials, or setup instructions | ⚠️ live URL exists; judge account and testing instructions to add (section 8) |
| English (or English subtitles)                                          | ✅                                                                            |
| Built/significantly updated in the submission period, explained         | ⚠️ write a short "what we built during the hackathon" note with dates         |
| Third-party tools and sponsor tech listed                               | ⚠️ list AG Grid, PayPal, the LLM provider, Cloudflare R2, whatsapp-web.js     |
| Deadline                                                                | Check the rules page; at the time of writing **2026-11-12, 12:00 PT**         |

Repository housekeeping before submission: GitHub "About" text and the live URL; README top section
pointing to the video and testing instructions; remove live server addresses and SSH commands from
public docs (for example the "Before you start" section of final-demo-script.md) and keep them in a
private runbook.

---

## 8. Decisions needed from the owner

1. **License:** MIT is on this branch. Confirm or name another OSI license.
2. **Judge access:** recommended — a staff dashboard account for judges plus a short
   "Testing Katale AI" section in the Devpost submission that walks through the **Agent console**
   (no phone needed) and the products/photo editor. Judges cannot message our WhatsApp number unless
   we add theirs as admins; we suggest the console instead.
3. **Customer shopping in production:** keep off, or enable for pilot numbers only
   (`CUSTOMER_COMMERCE_PILOT_NUMBERS`) for the demo recording.
4. **Cloudflare R2:** provide the account ID, token keys and bucket (section 4), or keep database
   storage for the hackathon — both work.
5. **Real-device checks:** a linked test phone to confirm the weekly chart image now arrives, and a
   Sandbox buyer to approve one capture and one refund.

---

## 9. Testing on this branch

Recorded in the pull request: unit and HTTP tests, Postgres integration tests (incl. 12 new product
photo tests), lint, typecheck, production build, the API Docker image built with `sharp`, browser
checks of the editor and overview (desktop and 375 px), and R2 behaviour against MinIO. No real
payments, refunds or customer messages were sent.

## 10. Recommendations (priority order)

1. **P0** Confirm the license and merge; create the dashboard owner account in production.
2. **P0** Decide judge access; write the Devpost testing instructions.
3. **P0** Record the 3-minute video from the script above.
4. **P1** Deploy this branch (after review); configure R2 or keep database storage; add photos to
   demo products.
5. **P1** Verify the weekly chart image on a real phone after deploying.
6. **P1** Move server addresses and SSH steps out of public docs.
7. **P2** Mobile navigation drawer; replying to customer chats from the dashboard.
8. **P3** Official WhatsApp Cloud API adapter; multi-merchant onboarding.
