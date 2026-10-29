# Katale AI — System Audit, Test Results and Development Roadmap

**Date:** 2026-10-25 · **Commit audited:** `580667a` (`main`, after PR #2) · **Scope:** whole repository, local test runs, public production endpoints (read-only)

**How to read this report.** Every finding is tagged:

- **[Verified]** — confirmed by reading the code at the cited location and/or by running it.
- **[Observed]** — seen from outside (public HTTP responses, git/GitHub metadata).
- **[Claimed]** — stated in project docs (mainly `PROJECT_STATUS.md`) and not re-verified here.
- **[Inference]** — a conclusion drawn from the above; reasoning given.
- **Recommendation** — what to do about it.

No production data was modified, nothing was deployed or merged, and no real or Sandbox payments,
refunds or disputes were initiated. External (real LLM / PayPal Sandbox) suites were not run with
credentials.

---

## 1. Executive summary

**Overall health: strong engineering foundation, demo-ready for one merchant, not yet ready to be
sold as a multi-merchant commercial product.**

What is genuinely good:

- **Code quality and safety design are well above typical hackathon level.** Strict TypeScript,
  a clean modular monolith (`apps/api`, `apps/web`, `apps/whatsapp`, `packages/*`), integer
  minor-unit money, backend-computed totals, typed confirmation codes for every financial action,
  three-layer idempotent PayPal capture, verified webhooks, a stock ledger, an audit trail with
  one trace ID per transaction, and strict separation of customer and admin AI tools.
- **The pipeline is green.** All seven CI gates pass locally on a fresh Postgres: lint, format,
  typecheck, **190/190 unit tests**, **126/126 integration tests**, migrations, production build
  ([section 8](#8-testing-results)).
- **Production is up.** `https://kataleai.space/api/health` → 200, dashboard redirects to login,
  internal API paths return 404 publicly **[Observed 2026-10-25 20:19 UTC]**.

What blocks real commercial use (details in the roadmap):

1. **The order lifecycle has no end for unpaid orders.** Nothing ever cancels or expires an order
   awaiting payment. Customer orders reserve stock forever, and a customer with three abandoned
   payment links is permanently locked out of shopping. Merchants cannot cancel orders at all
   ([P0-1](#p0-1-unpaid-orders-never-expire-stock-lock-and-customer-lock-out)).
2. **Refunds and reversals are only half-recorded.** The payment flips to `REFUNDED`; the order
   stays `PAID`, stock is not returned, nobody is told, and best-seller stats keep counting it
   ([P0-2](#p0-2-refunds-and-reversals-leave-orders-paid)).
3. **Production edge security is hackathon-grade.** One shared dashboard password (documented as a
   temporary hackathon value), a login throttle that can be bypassed by spoofing
   `X-Forwarded-For`, no clickjacking/CSP headers, and infrastructure items the project itself
   deferred (NPM admin port 81 public, password SSH) ([P0-3](#p0-3-production-edge-security)).
4. **No off-site or scheduled backups, single VM, no alerting** ([P0-4](#p0-4-backups-monitoring-and-recovery)).
5. **The dashboard shows UGX (and other zero-decimal) amounts 100× too small** and counts open
   customer carts as orders ([section 5](#5-dashboard-assessment), D1–D2). This is harmless today
   because the demo runs in USD, but it is wrong for the home market.
6. **It is single-tenant by construction.** The API serves "the first merchant in the database",
   there is one dashboard login, one WhatsApp session per deployment, and **all PayPal money lands
   in the platform's own PayPal account** — there is no per-merchant payee or onboarding
   ([P1-1](#p1-1-decide-and-build-the-tenancy-and-money-flow-model)).

**Readiness verdict**

| Use                                                        | Ready?                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Hackathon demo (one merchant, merchant-side flows)         | **Yes** — verified flows, good fallbacks (Agent console).                       |
| Controlled pilot with one real merchant, customers **off** | **Nearly** — after P0-2/P0-3/P0-4.                                              |
| Public customer shopping on WhatsApp                       | **No** — P0-1 must be fixed first; Phase 2 is not evidenced in production.      |
| Multi-merchant SaaS                                        | **No** — needs tenancy, per-merchant payments and an official WhatsApp channel. |

---

## 2. Architecture overview

```
WhatsApp user ──► whatsapp-web.js (Chromium) ──► apps/whatsapp worker
                                                   │  POST /api/agent/message (x-internal-token, sync, 120 s timeout)
                                                   ▼
Dashboard (Next.js, apps/web) ──Bearer API_AUTH_TOKEN──► apps/api (Fastify 5)
   │  server actions only; token never in browser         ├─ InboundMessageService (admin path)
   │                                                      │    authorize → dedupe → STT → confirmation parser → runAgent (32 tools)
   └─ /studio-ai (LLM proxy for AG Studio)                ├─ CustomerConversationService (customer path)
                                                          │    deterministic menu/cart/checkout + runAgent (9 tools)
PayPal ──webhooks / return URL──► /api/paypal/* (public) ├─ PaymentService / Reconciler / Reminders / Shipments / Disputes
                                                          ├─ ReportScheduler + WhatsAppConnectionMonitor (setInterval, in-process)
                                                          └─ NotificationService ──► worker gateway :4100 /internal/send
                                                                      │
                                                              PostgreSQL 16 (Prisma 7, 13 migrations)
```

| Component        | Location                          | Notes                                                                                                          |
| ---------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Composition root | `apps/api/src/container.ts`       | All providers wired in one place; tests inject fakes. Good.                                                    |
| Admin agent      | `apps/api/src/modules/agent/*`    | 32 tools, ~17 KB of tool specs + ~6 KB system prompt per LLM call **[Verified by measurement]**.               |
| Customer agent   | `apps/api/src/modules/customer/*` | 9 tools, ~2.9 KB specs + ~2.3 KB prompt. Deterministic regex router handles most turns before the LLM.         |
| Commerce domain  | `packages/commerce`               | Money, pricing, state machines, policy, confirmations, services, analytics.                                    |
| AI runtime       | `packages/ai`                     | Minimal tool loop (`agent.ts`), OpenAI-compatible client, Zod-validated tool registry.                         |
| Speech           | `packages/speech`                 | Whisper (English), Sunbird (Luganda, frozen), optional ffmpeg normaliser.                                      |
| PayPal           | `packages/paypal`                 | Orders v2, tracking, disputes, webhooks verification, invoicing client methods (unused).                       |
| WhatsApp worker  | `apps/whatsapp`                   | One `LocalAuth` session; gateway for outbound sends and QR/reconnect/unlink. Patched `whatsapp-web.js@1.34.7`. |
| Dashboard        | `apps/web`                        | Next.js 16 App Router, AG Grid / AG Studio, HMAC cookie session.                                               |
| Deployment       | `docker/Dockerfile`, `deploy/*`   | Prebuilt images from Docker Hub → one VM → Docker Compose → Nginx Proxy Manager → Let's Encrypt.               |

**Simplification notes**

- The architecture is appropriate for the stage. The main structural debt is that background
  work (reports, reconciliation, connection monitor) runs as `setInterval` inside the single API
  process (`apps/api/src/index.ts:46-52`) and all inbound processing is synchronous inside an HTTP
  request. Both are fine for one merchant and become the first scaling limits.
- `apps/api/src/modules/agent/tools.ts` (1,061 lines, 32 tools) is the largest single file and is
  sent to the model in full on every call. Splitting tools by intent (see [P2-3](#p2-3-ai-cost-latency-and-reliability))
  is both a cost and an accuracy win.
- Luganda/Sunbird code paths (cascade STT, translator, number normaliser, Luganda prompt guide) are
  frozen but still wired into the composition root. Keep them behind the flag, but do not invest
  further this phase.

---

## 3. Feature status matrix

Legend: ✅ Complete & verified · 🟡 Implemented, unverified (or only with fakes) · 🟠 Partial ·
🎭 Simulated/mocked · ❌ Not implemented · 🔴 Broken / needs improvement.
"Prod" = evidence that it runs in production (from `PROJECT_STATUS.md` unless marked Observed).

### Merchant / admin

| Feature                                                  | Status | Local evidence                                                                                  | Prod                                   |
| -------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------- | -------------------------------------- |
| Order drafting by chat → typed CONFIRM → PayPal link     | ✅     | `demo-flow.test.ts`, `merchant-experience.test.ts`                                              | Verified 2026-10-05/06 [Claimed]       |
| Capture on return + webhook fallback, idempotent         | ✅     | `payment.service.ts:209-316`, integration tests                                                 | Verified incl. real webhooks [Claimed] |
| English voice notes (Whisper), low-confidence read-back  | ✅     | `voice-flow.test.ts`, `inbound.service.ts:282-326`                                              | Verified 2026-10-06 [Claimed]          |
| Luganda voice                                            | 🟠     | Frozen, flag off (`container.ts:79-111`)                                                        | Off                                    |
| Multiple admins, owner/staff roles                       | ✅     | `admins-reports.test.ts`; `confirmation.ts:24-33`                                               | Deployed 2026-10-17/18 [Claimed]       |
| Admin `@lid` matching                                    | 🟡     | Integration test; worker resolution "not tried live" (`PROJECT_STATUS.md:82`)                   | Unverified                             |
| Products: add / reprice / deactivate by chat             | ✅     | `tools.ts:920-1008`; voice may not set prices                                                   | Deployed                               |
| Stock ledger, sales decrement once, adjust by chat       | ✅     | `inventory.service.ts:61-110`, `inventory-reports.test.ts`                                      | Deployed                               |
| Low/out-of-stock alerts                                  | ✅     | Once per crossing; integration tests                                                            | Deployed                               |
| Charts as PNG (WhatsApp images)                          | ✅     | `charts.test.ts`, `send_chart` tool                                                             | Deployed                               |
| Daily / weekly / monthly reports with retries            | ✅     | `report-scheduler.ts`, `admins-reports.test.ts`                                                 | Deployed                               |
| Payment reminders (merchant-initiated `REMIND <code>`)   | ✅     | `reminder.service.ts`, `payment-reminders.test.ts`                                              | Deployed                               |
| Automatic (unprompted) reminders / abandoned-cart nudges | ❌     | Reminders only on merchant request                                                              | —                                      |
| Background payment reconciliation                        | ✅🎭   | `reconciliation.service.ts`; tests use simulated PayPal                                         | Deployed                               |
| Shipment tracking to PayPal (`SHIP <code>`)              | 🎭     | Simulated PayPal only; **real Sandbox run pending** (`PROJECT_STATUS.md:254`)                   | Deployed, never exercised              |
| Disputes: sync, evidence, drafted response, `SUBMIT`     | 🎭     | Simulated; list/details real Sandbox; submit never run                                          | Deployed, never exercised              |
| Cancel / edit orders                                     | ❌     | No `AWAITING_PAYMENT → CANCELLED` caller anywhere; prompt says "cannot" (`system-prompt.ts:39`) | —                                      |
| Refunds (initiate)                                       | ❌     | Deliberately excluded                                                                           | —                                      |
| Refunds (record when done in PayPal)                     | 🔴     | Payment only; order/stock untouched ([P0-2](#p0-2-refunds-and-reversals-leave-orders-paid))     | —                                      |
| PayPal invoicing                                         | ❌     | Client methods exist (`client.ts:337-382`), no tool/executor                                    | —                                      |
| WhatsApp QR / reconnect / unlink from dashboard          | ✅     | Gateway tests; page checked against stub [Claimed]                                              | Deployed                               |
| Outage notice after reconnect                            | ✅     | `connection-monitor.test.ts`                                                                    | Deployed                               |
| Incoming calls declined                                  | 🟡     | Code only, "not tested with a real call"                                                        | Deployed                               |

### Customer

| Feature                                            | Status | Local evidence                                                                                                                | Prod                                                       |
| -------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Bot number → merchant routing; admins vs customers | ✅     | `inbound.service.ts:122-150`, `customer-commerce.test.ts`                                                                     | Deployed, **flag off** (`CUSTOMER_COMMERCE_ENABLED=false`) |
| Identity by WhatsApp ID and `@lid`                 | ✅     | `customer-identity.service.ts`, integration tests                                                                             | Off                                                        |
| Menu, product lists, details with photos           | ✅     | `catalog.ts`, integration tests                                                                                               | Off                                                        |
| Natural-language product questions (LLM, 9 tools)  | ✅     | Real-LLM suite exists (`tests/external/customer-questions.test.ts`)                                                           | Off                                                        |
| Cart, checkout, delivery/pickup, ORDER             | ✅     | `customer-checkout.test.ts` (16 tests)                                                                                        | **Merged (PR #2, 2026-10-18); no deployment record**       |
| Automatic PayPal link / owner-approval mode        | ✅     | Integration tests                                                                                                             | Not evidenced                                              |
| Payment confirmation to customer + admins          | ✅     | `payment.service.ts:400-437`                                                                                                  | Not evidenced                                              |
| "My orders" / tracking number                      | ✅     | `shop-order.service.ts:751-792`                                                                                               | Not evidenced                                              |
| Hand-off to a person, admin reply/resume           | 🟠     | Works via WhatsApp agent tools; **dashboard can only resume, not reply** (no route calls `replyAsTeam` except `tools.ts:652`) | Off                                                        |
| Customer voice notes                               | ❌     | "I can only read text messages" (`customer-conversation.service.ts:157-162`)                                                  | —                                                          |
| Unpaid order expiry / customer cancel              | 🔴     | Missing ([P0-1](#p0-1-unpaid-orders-never-expire-stock-lock-and-customer-lock-out))                                           | —                                                          |
| End-to-end on a real phone + Sandbox buyer         | ❌     | Runbook only (`docs/hackathon/customer-shopping-test.md`)                                                                     | —                                                          |

### Platform

| Feature                                       | Status | Evidence                                                                                   |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| Dashboard login (single account)              | ✅🔴   | Works; throttle bypassable, shared password ([P0-3](#p0-3-production-edge-security))       |
| Per-merchant users / tenancy                  | ❌     | `merchant-scope.ts:22-27` falls back to the first merchant                                 |
| Merchant onboarding / signup                  | ❌     | Seed + `scripts/operator-add.ts`; production runs the seeded merchant (`prisma/seed.ts`)   |
| Per-merchant PayPal payee                     | ❌     | No payee in `createCheckoutOrder`; `Merchant` has no PayPal fields (`schema.prisma:25-56`) |
| CI (lint/format/types/unit/integration/build) | ✅     | `.github/workflows/ci.yml`; all green locally                                              |
| CD                                            | ❌     | Manual `scripts/release-images.sh` + `deploy/vm-deploy.sh`                                 |
| Backups                                       | 🟠     | Manual/pre-deploy, same VM only (`deploy/backup.sh`; `PROJECT_STATUS.md:74`)               |
| Monitoring / alerting                         | ❌     | JSON logs + `/api/health/ready`; no external uptime or error alerting                      |

**Local vs main vs production.** There is no unmerged work: both feature branches were merged
(PR #1 and PR #2 on 2026-10-18) and `main` = `580667a` **[Observed]**. The last production tag
recorded in `PROJECT_STATUS.md` is `v0.1.0-202610181605` (Phase 0+1, customer commerce off). There
is **no record that Phase 2 (cart/checkout) was deployed**, and the status file's header still says
"Last updated: 2026-10-07" although it contains sections up to 2026-10-18. The deployed image tag
cannot be read from outside. **Treat Phase 2 as "merged, not evidenced in production".**

---

## 4. WhatsApp bot assessment

### 4.1 Merchant / administrator experience

**Strengths [Verified]**

- Authorization happens before anything else: only active admins of the receiving bot's merchant
  reach the agent; everyone else gets one generic welcome per cooldown and nothing is stored
  (`inbound.service.ts:114-171`).
- De-duplication is enforced by the database (`Message @@unique([channel, externalMessageId])`,
  `inbound.service.ts:190-215`) with a cheap in-memory pre-filter in the worker (`dedupe.ts`).
- Financial approvals are deterministic and typed: spoken "confirm 1234" is refused
  (`inbound.service.ts:288-301`), staff cannot approve owner-only actions even if the role changes
  mid-flight (`inbound.service.ts:424-431`), and backend summaries replace model text whenever a
  proposal exists (`inbound.service.ts:543-549`).
- Voice: duration/size pre-checks in the worker, re-validated in the API, low-confidence and
  unsupported-language read-back.

**Issues**

| #   | Issue                                                                                                                                                                                                                                                                                                            | Evidence                                                                 | Severity       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------- |
| W1  | **No durable inbound queue.** The worker forwards each message synchronously (120 s timeout). If the API is down, slow or restarting, the message is lost (user gets "something went wrong"). If the API finishes after the worker timed out, the user's retry is de-duplicated and returns **no reply at all**. | `api-client.ts:31`, `index.ts:129-141,143-158`, `inbound.service.ts:213` | P1             |
| W2  | **No outbox for proactive messages.** "Payment received", stock alerts, hand-off forwards and customer replies are sent once; on gateway failure they are logged/audited and dropped. Only report deliveries retry.                                                                                              | `notification.service.ts:23-62,64-112,139-…`                             | P1             |
| W3  | Messages from one chat are processed concurrently (no per-conversation lock), so two quick messages can interleave agent runs and history.                                                                                                                                                                       | `index.ts:143` (handler per event), no lock in `inbound.service.ts`      | P2             |
| W4  | Messages received while the worker is offline are not replayed or caught up.                                                                                                                                                                                                                                     | [Inference] no history sync in `whatsapp-adapter.ts`                     | P2             |
| W5  | One WhatsApp session per deployment (`WHATSAPP_CLIENT_ID`), although `WhatsAppAccount` models many bot numbers.                                                                                                                                                                                                  | `index.ts:35-42`, `schema.prisma:76-99`                                  | P1 (SaaS)      |
| W6  | Unofficial client (`whatsapp-web.js`) with a local patch; already broke twice on WhatsApp Web changes; account-ban risk for business numbers.                                                                                                                                                                    | `patches/whatsapp-web.js@1.34.7.patch`, `PROJECT_STATUS.md:246-250,301`  | P1 (strategic) |
| W7  | An admin phone can belong to only one merchant (`@@unique([channel, phone])`, `@@unique([channel, externalId])`).                                                                                                                                                                                                | `schema.prisma:127-128`                                                  | P2             |
| W8  | Merchants cannot cancel or edit an order, mark it delivered, or record a refund by chat; the assistant must say "I cannot".                                                                                                                                                                                      | `system-prompt.ts:39`                                                    | P1             |
| W9  | Staff can reprice/deactivate products and adjust stock (only payment requests and dispute submissions are owner-only).                                                                                                                                                                                           | `confirmation.ts:24-33`; `tools.ts:874-1008` (no role check)             | P2             |

### 4.2 Customer experience

**Strengths [Verified]:** strictly separate prompt and 9 customer-only tools; prices, totals and
availability always from the database; quote fingerprint so the customer confirms exactly what they
saw (`shop-order.service.ts:473-522,559-582`); per-merchant advisory lock prevents overselling and
duplicate ORDERs (`shop-order.service.ts:542`); availability labels instead of stock counts; per-
customer rate limit (15/min, 300/day); hand-off pauses automation and forwards to admins.

**Issues**

| #   | Issue                                                                                                                                                                                                                                                   | Evidence                                                           | Severity |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------- |
| C1  | **Unpaid orders never expire** → permanent stock reservation and lock-out after 3 unpaid orders ([P0-1](#p0-1-unpaid-orders-never-expire-stock-lock-and-customer-lock-out)).                                                                            | `shop-order.service.ts:60-66,129-133,160-163,592-596`              | P0       |
| C2  | **Hand-off false positives.** `HUMAN` matches "someone", "agent", "staff", "owner", "manager", "a person" anywhere in a message, e.g. "Is someone delivering today?" or "Do you sell staff uniforms?" pauses the bot for `handoffHours` (default 12 h). | `customer-conversation.service.ts:27-28,170-171`                   | P1       |
| C3  | During a hand-off every customer message is broadcast to **all** alert-enabled admins; no assignment, no "claimed by".                                                                                                                                  | `customer-conversation.service.ts:150-156`                         | P2       |
| C4  | Customer cannot cancel a placed order or change address after ORDER; only "talk to a person".                                                                                                                                                           | `shop-order.service.ts` (no cancel for placed orders)              | P1       |
| C5  | Text only: voice notes from customers are refused even though the merchant side has a working pipeline.                                                                                                                                                 | `customer-conversation.service.ts:157-162`                         | P2       |
| C6  | Rate-limit and welcome-cooldown state are in-memory (lost on restart, not shared across instances).                                                                                                                                                     | `customer-conversation.service.ts:77-78`, `inbound.service.ts:100` | P3       |
| C7  | In APPROVAL mode the merchant has no "decline order" action; the order sits reserved until paid.                                                                                                                                                        | `shop-order.service.ts:633-641`                                    | P1       |

---

## 5. Dashboard assessment

Reviewed page by page from source (no browser click-through). Nav (`components/nav.tsx:6-19`)
matches the 12 pages; no broken links, and every endpoint the web app calls exists in the API
**[Verified]**. The dashboard is a solid **read-mostly reporting view**. It is not yet an
operations console: most merchant actions still happen only over WhatsApp.

### 5.1 Cross-cutting defects

| #   | Defect                                                                                                                                                                                                                                                                     | Evidence                                                                                                                                                                                | Severity                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| D1  | **Zero-decimal currencies are shown 100× too small.** The UI and the analytics dataset always divide minor units by 100, but the backend stores UGX/JPY/RWF… with no minor unit. UGX 50,000 shows as UGX 500 in every grid, CSV export and AG Studio chart. **[Verified]** | `components/grid/commerce-grid.tsx:217`; `analytics.service.ts:369`; vs `packages/commerce/src/money.ts:10-22`; also `orders-grid.tsx:40`, `payments-grid.tsx:79`, `lib/activity.ts:32` | P0 for any non-USD merchant (P1 while USD-only) |
| D2  | **Open customer carts are counted as orders.** `NOT_OPEN_CART` is applied in `OrderService` but not in the overview status counts, "Recent orders", per-customer counts or the analytics dataset. **[Verified]**                                                           | `order.service.ts:22-25` vs `analytics.service.ts:459-472,271,340`                                                                                                                      | P1                                              |
| D3  | Times are shown in server/browser time, never `merchant.timezone`.                                                                                                                                                                                                         | `lib/format.ts:7`, `commerce-grid.tsx:219`                                                                                                                                              | P2                                              |
| D4  | Lists are silently capped: orders/payments 500, disputes 100, activity 150, customer chats 50, report runs 20, analytics facts 10,000. Search and filters are client-side only.                                                                                            | `order.service.ts:83`, `payment.service.ts:67`, `dispute.service.ts:291`, `activity/page.tsx:34`                                                                                        | P2                                              |
| D5  | Agent-console test orders count in revenue and in "Sales by source", and the console (labelled "for development and demos") sits in the merchant nav while creating real orders and links.                                                                                 | `console/page.tsx:9`, `console/actions.ts:24`, `analytics.service.ts:375`                                                                                                               | P2                                              |
| D6  | Some actions swallow errors (dispute refresh, WhatsApp reconnect/logout). No `loading.tsx`/`error.tsx` anywhere. Developer text reaches merchants ("Is it running (pnpm dev:api)?", "run `pnpm db:seed`").                                                                 | `disputes/actions.ts:10`, `whatsapp/actions.ts:10,17`, `lib/api.ts:44`, `console/actions.ts:37`                                                                                         | P2                                              |
| D7  | Grid summary rows add every status together, including drafts, cancelled, failed and refunded.                                                                                                                                                                             | `orders-grid.tsx:149-156`, `payments-grid.tsx:202-209`                                                                                                                                  | P2                                              |
| D8  | Accessibility/mobile: no `aria-current` on the active link; the 12 links become one horizontal scroll strip on phones; errors are reported with `window.alert`.                                                                                                            | `nav.tsx:24-36`, `payments-grid.tsx:41`                                                                                                                                                 | P2                                              |

### 5.2 Page by page

| Page                  | State     | Main gaps                                                                                                                                                                                                                                                                                                      |
| --------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview `/`          | Partial   | D1/D2/D5 affect its numbers. "Shipped" includes refunded orders (`analytics.service.ts:511`). No date range.                                                                                                                                                                                                   |
| Orders                | Read-only | No mutation routes (`orders.routes.ts`). **The drawer never shows the delivery address, delivery method, notes or customer phone**, so a merchant cannot fulfil from it. No "Refunded" filter. Ship/track only via "tell Katale AI" (`orders-grid.tsx:319`).                                                   |
| Payments              | Working   | The reminder action is wired with a confirm. No Refunded/Cancelled filter. Totals include failed payments.                                                                                                                                                                                                     |
| Disputes              | Partial   | Responding is possible only via WhatsApp `SUBMIT`. No evidence upload. A failed refresh looks like success.                                                                                                                                                                                                    |
| Customers             | Partial   | No detail page, order history or conversation view. Revenue counts only one currency per customer (`analytics.service.ts:285-288`). No add/edit, although `POST /api/customers` exists.                                                                                                                        |
| Products / detail     | Partial   | PATCH accepts only description and visibility (`customer.routes.ts:18-21,130-145`). **Name, price, stock and active state cannot be changed, and there is no "New product"** (although `POST /api/products` exists). The detail page fetches the whole catalog and the full image bytes to render one product. |
| Analytics (AG Studio) | Working   | D1, D2. The whole dataset (up to 10k orders) is sent to the browser in one payload.                                                                                                                                                                                                                            |
| Activity              | Working   | Fixed at 150 events. No date or type filter.                                                                                                                                                                                                                                                                   |
| Agent console         | Demo-only | Hide it from merchants, or label it as a sandbox and exclude its orders from stats (D5).                                                                                                                                                                                                                       |
| Reports               | Working   | Timezone is free text (`schedule-form.tsx:95`).                                                                                                                                                                                                                                                                |
| Admins                | Working   | Deactivate has no confirm (`admin-form.tsx:177`).                                                                                                                                                                                                                                                              |
| WhatsApp              | Partial   | Customer chats can only be resumed: no reading or replying, although `GET /api/dashboard/messages` exists and is unused. No queue for APPROVAL-mode orders.                                                                                                                                                    |

### 5.3 Toward a real operations console

1. Fix D1 (use the shared `formatMoney`/`toMajor` from `@vca/commerce` everywhere) and D2.
2. Order detail page with fulfilment data and actions (cancel, decline, mark ready/delivered, add
   tracking, record refund), plus an "Attention" queue (unpaid > N h, paid not shipped, APPROVAL
   orders, open hand-offs, disputes awaiting response).
3. Catalog management: create, edit name, price, stock and active state, stock adjustments with reasons
   (reusing `InventoryService.adjust`).
4. Customer page with orders and the conversation thread, with a reply box (reusing `replyAsTeam`).
5. Server-side pagination, date ranges and merchant-timezone rendering. Move the Agent console
   under a "Developer" toggle.

---

## 6. PayPal and commerce review

### 6.1 Lifecycle trace

| Stage                 | What happens                                                                                                                       | Works? | Failure handling                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery             | Numbered lists, search, details + photo; LLM for free text                                                                         | ✅     | No LLM → falls back to search (`customer-conversation.service.ts`, `runAgent` branch)                                                  |
| Cart                  | `Order` in `DRAFT`, 48 h TTL, line/quantity limits, stock check vs reservations                                                    | ✅     | Expired carts cancelled lazily on next access                                                                                          |
| Order confirmation    | Name → method → address → summary + quote hash → `ORDER` under advisory lock                                                       | ✅     | Price change → re-confirm; sold out → refused; duplicate ORDER → same order/link                                                       |
| PayPal checkout       | `createCheckout` with DB amounts, `PayPal-Request-Id` = attempt key, order → `AWAITING_PAYMENT`                                    | ✅     | PayPal down → `paypal_failed`, retry; stuck attempt reclaimed after 2 min (`shop-order.service.ts:651-677`)                            |
| Verified payment      | Return URL capture (primary) + `CHECKOUT.ORDER.APPROVED` / `PAYMENT.CAPTURE.COMPLETED` webhooks; signature verified via PayPal API | ✅     | Three-layer idempotency; reconciler re-checks open links every 6 h                                                                     |
| Inventory update      | `recordSale` in the same transaction as `PAID`, once per (order, product)                                                          | ✅     | Stock may go negative for merchant-drafted orders (no floor, `inventory.service.ts:86`) — acceptable, but alerts should say "oversold" |
| Fulfilment            | `SHIP <code>` → PayPal `/track`                                                                                                    | 🎭     | Never run against real Sandbox                                                                                                         |
| Customer notification | "Payment received" to customer + admins                                                                                            | ✅     | **Lost on gateway failure** (no outbox, W2)                                                                                            |
| Unpaid / expired      | Merchant-initiated reminders (max 3, 1/day), renewed links                                                                         | 🟠     | **No expiry/cancel** (P0-1)                                                                                                            |
| Refunds / reversals   | Webhook sets payment `REFUNDED`                                                                                                    | 🔴     | Order stays `PAID`, no restock, no notice (P0-2)                                                                                       |
| Disputes              | Webhook → canonical re-read → link → notify; drafted factual response; `SUBMIT`                                                    | 🎭     | Submit path unproven against real PayPal                                                                                               |

### 6.2 Specific findings

- **Webhook authenticity [Verified]:** `PayPalWebhookService.verify` (`webhook.service.ts:76-106`)
  calls PayPal's verify-signature API; skip-verification is honoured only in `development`
  (`container.ts:203-205`). Good.
- **Webhook idempotency gap [Verified]:** an event row is inserted as `RECEIVED`, then processed.
  Only `FAILED` rows are retried on redelivery (`webhook.service.ts:110-139`, check at `:125`). If
  the process dies between claim and status update, the row stays `RECEIVED` and **every
  redelivery is treated as a duplicate forever**. Payments are rescued by the reconciler; disputes
  and refunds are not. Fix: treat `RECEIVED` older than N minutes as retryable.
- **Captured amount not cross-checked [Verified]:** `markCompleted` trusts that the capture
  matches `payment.amountMinor` (`payment.service.ts:275-316`). The PayPal order is created from DB
  amounts so tampering is unlikely, but reconciliation should compare `amount`/`currency` and flag
  mismatches (cheap defence in depth).
- **Late capture on a superseded link [Inference]:** `renewCheckout` cancels the old payment
  locally (`payment.service.ts:103`) but not at PayPal. A buyer completing the old link would be
  ignored by `markCompleted` (status `CANCELLED`), i.e. money captured but not recorded. Rare,
  but the reconciler should also look at recently cancelled payments.
- **Duplicate orders [Verified]:** prevented for customer ORDER (advisory lock + conditional
  update + attempt rows) and for merchant CONFIRM (confirmation claim + idempotency key).
- **Customer/merchant isolation [Verified]:** every customer-side query is scoped by
  `merchantId` + `customerId` (`shop-order.service.ts:88-113,432-440,543-545,751-766`).
- **Money flow [Verified]:** all checkouts are created with the platform's credentials and no
  `payee` (`packages/paypal/src/client.ts:193-…`). In a multi-merchant setting the platform would
  collect every merchant's money. See [P1-1](#p1-1-decide-and-build-the-tenancy-and-money-flow-model).
- **Currency fit [Inference]:** the default merchant timezone is `Africa/Kampala`, but PayPal does
  not support UGX (`PROJECT_STATUS.md:303`) and demos run in USD. For Ugandan small businesses,
  mobile money is the dominant payment rail; PayPal-only checkout limits real adoption
  ([P2-6](#p2-6-local-payment-rails)).

---

## 7. AI system assessment

| Area                         | Finding                                                                                                                                                                      | Evidence                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Routing                      | Admin: every message goes to one agent with **all 32 tools**. Customer: deterministic regex router first, LLM only for free text. The customer design is the better pattern. | `tools.ts`; `customer-conversation.service.ts:164-258`              |
| Admin/customer separation    | Strong: separate prompts, separate registries, customer path never touches admin tools; tests and real-LLM injection tests exist.                                            | `container.ts:258-283`; `tests/external/customer-questions.test.ts` |
| Grounding                    | Good: tools return DB facts; financial replies are replaced by backend text; policy refusals deterministic.                                                                  | `inbound.service.ts:543-549`                                        |
| Prompt injection             | Good containment by design (the model can only propose; approvals are typed codes parsed by code). Customer profile names are kept out of system rules.                      | `customer-prompt.ts:12`; ADR 0003                                   |
| Multi-turn context           | 12 turns / 6 h of plain text only; tool results are not replayed, so follow-ups re-query tools (safer, costlier).                                                            | `inbound.service.ts:34-36,476-492`                                  |
| Write tools without approval | `adjust_stock`, `add_product`, `update_product` execute immediately (prices typed-only). Reasonable, but voice-originated stock changes also execute immediately.            | `tools.ts:874-1008`                                                 |
| Errors / retries             | Tool errors are returned to the model as data (good). **No retry/backoff** on LLM 429/5xx; one failure → "assistant unavailable".                                            | `openai-compatible.ts:83-101`; `inbound.service.ts:364-368`         |
| Latency                      | Up to 6 sequential LLM calls × 30 s timeout inside a synchronous HTTP request; measured voice → reply 9 s in production [Claimed].                                           | `agent.ts:38`; `config/schemas.ts:34`                               |
| Cost visibility              | The client parses `usage` but **nobody records it**; no per-merchant token budget or cost dashboard.                                                                         | `openai-compatible.ts:121-128`; `agent.ts` ignores `usage`          |
| Token footprint              | ~23 KB (≈6k tokens) of fixed admin prompt + tool specs per call, repeated per tool step.                                                                                     | Measured with a throwaway script                                    |
| Evaluation                   | 7 real-LLM/Sandbox suites (70 tests) exist and skip cleanly without credentials; not in CI; last recorded full pass 2026-10-05..18 [Claimed].                                | `tests/external/*`                                                  |

---

## 8. Testing results

All commands were run on 2026-10-25 against a disposable `postgres:16-alpine` container
(`localhost:55499`), with the same env as CI (`.github/workflows/ci.yml`).

| Command                 | Result                                                       | Time   |
| ----------------------- | ------------------------------------------------------------ | ------ |
| `pnpm db:deploy`        | ✅ 13 migrations applied                                     | 1.6 s  |
| `pnpm lint`             | ✅ no findings                                               | 2.3 s  |
| `pnpm format:check`     | ✅                                                           | 2.2 s  |
| `pnpm typecheck`        | ✅ all packages + root                                       | 7.1 s  |
| `pnpm test`             | ✅ **27 files, 190 tests passed**                            | 2.8 s  |
| `pnpm test:integration` | ✅ **9 files, 126 tests passed**                             | 7.7 s  |
| `pnpm build`            | ✅ api, whatsapp, web (Next standalone)                      | 13.8 s |
| `pnpm test:external`    | ⏭️ 7 files, 70 tests **skipped** (no credentials, by design) | 1.1 s  |

**What the green suite does _not_ prove**

- PayPal and the LLM are fakes in unit/integration runs (`tests/support/fakes.ts`). Real Sandbox
  shipment tracking and dispute submission have **never** been executed.
- No test exercises: `PAYMENT.CAPTURE.REFUNDED/REVERSED` handling, a crash between webhook claim
  and processing, order expiry/cancellation (because it does not exist), the WhatsApp worker's
  `handle()` loop (`apps/whatsapp/src/index.ts`), the `/studio-ai` route, the login throttle, or any
  dashboard page rendering (only helper functions in `apps/web/lib/*.test.ts`).
- No end-to-end browser tests for the dashboard, no load/soak test for the single advisory lock,
  no restore drill in CI, no migration rollback test.
- Customer Phase 2 has not been run on a real phone with a Sandbox buyer
  (`docs/hackathon/customer-shopping-test.md` is a runbook only).

**Critical scenarios to add (in priority order):** order expiry releases stock; refund webhook
updates order/stock/analytics; stuck `RECEIVED` webhook is retried; notification outbox retries;
worker → API timeout produces exactly one reply; dashboard smoke test (Playwright) for login + each
page; real-Sandbox `SHIP` and dispute runs recorded in `PROJECT_STATUS.md`.

---

## 9. Security and production readiness

| Area                     | State                                                                                                                                                                     | Evidence                                                                 | Rating                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------- |
| Dashboard auth           | One shared username/password from `.env`; HMAC cookie (12 h), `HttpOnly`, `SameSite=Lax`, `Secure` in prod; no MFA, no per-user accounts, no revocation.                  | `lib/session.ts`, `login/actions.ts:44-50`                               | 🔴                     |
| Login throttle           | In-memory, keyed on the **first** `X-Forwarded-For` value, which the client controls behind Nginx (`$proxy_add_x_forwarded_for` appends) → bypass by rotating the header. | `login/actions.ts:15-21`; `deploy/npm-advanced.conf:12`                  | 🔴                     |
| API rate limit           | `trustProxy: true` → same spoofable client IP for `/api/paypal/*`.                                                                                                        | `app.ts:29`; `docker-compose.prod.yml` `TRUST_PROXY: 'true'`             | 🟠                     |
| Security headers (web)   | HSTS present; **no CSP, no `X-Frame-Options`/`frame-ancestors`, no `X-Content-Type-Options`** on `/login`.                                                                | [Observed] `curl -I https://kataleai.space/login`                        | 🟠                     |
| Service auth             | Constant-time token checks; internal gateway not exposed; only `/api/paypal/*` and `/api/health` public.                                                                  | `http/auth.ts`; `npm-advanced.conf`; [Observed] `/api/orders` → 404      | ✅                     |
| Tenant isolation         | Customer side well scoped. Dashboard/API single-tenant: first merchant, or any merchant via `x-merchant-id` for the token holder.                                         | `merchant-scope.ts:22-27`                                                | 🟠                     |
| Secrets                  | `.env` git-ignored and docker-ignored; Zod-validated, min-length tokens; pino redaction.                                                                                  | `.gitignore`, `.dockerignore`, `config/schemas.ts:143-146`               | ✅                     |
| Uploads                  | JPEG/PNG magic-byte check, 2 MB body limit, stored in Postgres (`ProductImage.data`).                                                                                     | `customer.routes.ts:11-40,147-168`                                       | ✅/🟠 (DB bloat later) |
| Infra (self-reported)    | NPM admin port 81 internet-reachable; SSH password login; single VM.                                                                                                      | `PROJECT_STATUS.md:285-290`                                              | 🔴                     |
| Backups                  | `pg_dump` to the same VM, run manually and before deploys; 14 kept; restore tested once.                                                                                  | `deploy/backup.sh`, `deploy/vm-deploy.sh:24`, `PROJECT_STATUS.md:74,178` | 🔴                     |
| Monitoring               | Docker healthchecks and JSON logs only; no uptime check, error tracking, or alert on webhook failures / WhatsApp down (the API reports outages only _after_ reconnect).   | `docker/Dockerfile` HEALTHCHECKs; `connection-monitor.ts`                | 🔴                     |
| CI/CD                    | CI good; no dependency/secret scanning, no image build in CI, manual releases from a laptop.                                                                              | `.github/workflows/ci.yml`; `scripts/release-images.sh`                  | 🟠                     |
| Data retention / privacy | Full customer chat text, addresses and transcripts kept indefinitely; no deletion/export flow.                                                                            | `Message`, `Order.deliveryAddress` in `schema.prisma`                    | 🟠                     |

---

## 10. Prioritized development roadmap

Effort: **S** ≤ 2 days · **M** 3–7 days · **L** 2–4 weeks · **XL** > 1 month (one engineer).

### P0 — Critical (before any real customer traffic or wider pilot)

#### P0-1 Unpaid orders never expire (stock lock and customer lock-out)

- **Problem.** Placed customer orders (`DRAFT` + `customerConfirmedAt`, or `AWAITING_PAYMENT`)
  reserve stock with no end date. No code ever moves `AWAITING_PAYMENT → CANCELLED`, although the
  state machine allows it. After three unpaid orders a customer can never start a new cart.
  Merchants cannot cancel orders from chat or dashboard.
- **Evidence.** `shop-order.service.ts:60-66` (`RESERVING`), `:129-133` (`unpaidOrders`),
  `:160-163` and `:592-596` (lock-out), `state.ts:7` (transition unused), `system-prompt.ts:39`;
  the integration test asserts the lock-out (`tests/integration/customer-checkout.test.ts:347-367`).
  Abuse: one phone number can hold 3 × 15 lines × 20 units = 900 units of stock.
- **Solution.** (1) `Order.paymentDueAt` set at ORDER (configurable, e.g. 24–72 h); (2) a sweep in
  the existing scheduler cancels overdue orders, cancels open PayPal payments locally (reconciler
  re-check first so a just-paid order is never cancelled), releases reservations, notifies
  customer and admins; (3) merchant `cancel ORD-XXXX` (typed confirmation) and a dashboard Cancel
  action; (4) customer "cancel ORD-XXXX" for unpaid orders; (5) APPROVAL-mode "decline".
- **Components.** `ShopOrderService`, `OrderService`, `PaymentReconciler`, `ReportScheduler`
  tick, agent tools, dashboard Orders page, migration.
- **Effort.** M. **Dependencies.** none.
- **Acceptance.** Overdue unpaid orders are cancelled within one scheduler minute after the due
  time; a payment captured before cancellation is never cancelled; reservations drop to zero;
  customer can shop again; merchant and customer get one message each; integration tests cover
  each path including a race between capture and expiry.

#### P0-2 Refunds and reversals leave orders `PAID`

- **Problem.** `PAYMENT.CAPTURE.REFUNDED/REVERSED` only change the payment. The order stays
  `PAID` (merchant may still ship), stock is not returned, no one is notified, partial refunds are
  treated as full, and `productStats` keeps counting the sale while revenue does not.
- **Evidence.** `webhook.service.ts:171-181`; no caller of `PAID → REFUNDED` (`state.ts:8`);
  `analytics.service.ts:312` (order `PAID`) vs `:49,96,128` (payment `COMPLETED`);
  `shop-order.service.ts:784` displays a status that is never set; no test for refund events.
- **Solution.** Record refunds as their own rows (amount, full/partial, source); full refund →
  order `REFUNDED`, fulfilment hold, optional restock movement `RETURN` (merchant decides); notify
  admins (and customer for customer orders); use one revenue definition (net of refunds) across
  analytics, reports and dashboard.
- **Effort.** M. **Dependencies.** none.
- **Acceptance.** Sandbox refund (full and partial) updates order, analytics and reports
  consistently; webhook redelivery is idempotent; unit + integration tests.

#### P0-3 Production edge security

- **Problem.** Shared temporary dashboard password; spoofable login throttle; no clickjacking/CSP
  headers; NPM admin port 81 public; password SSH; spoofable API client IP.
- **Evidence.** [section 9](#9-security-and-production-readiness).
- **Solution.** Rotate `DASHBOARD_PASSWORD` now (long random); key the throttle on the proxy-set
  `X-Real-IP` (or the right-most untrusted XFF hop) **plus** a per-account lockout with backoff;
  add `Content-Security-Policy` (`frame-ancestors 'none'`), `X-Content-Type-Options`, `Referrer-
Policy` in `next.config.ts` headers; restrict port 81 to VPN/IP allow-list; SSH key-only; set
  Fastify `trustProxy` to the proxy's address instead of `true`.
- **Effort.** S. **Dependencies.** VM access.
- **Acceptance.** Six wrong passwords from rotating `X-Forwarded-For` values are blocked;
  `curl -I` shows the new headers; port 81 and SSH-password probes fail from the internet.

#### P0-4 Backups, monitoring and recovery

- **Problem.** Backups live on the same VM and run only manually/pre-deploy; no alerting; a
  WhatsApp outage is only reported after it ends.
- **Evidence.** `deploy/backup.sh`; `PROJECT_STATUS.md:74,290`; `connection-monitor.ts`.
- **Solution.** Nightly cron `backup.sh` + encrypted upload to off-site object storage with
  retention; monthly automated restore check; external uptime check on `/api/health/ready` and on
  WhatsApp `ready` state; error tracking (e.g. Sentry) for api/web/worker; alert on webhook
  `FAILED`, report delivery failures and WhatsApp `disconnected` > 5 min (via email/SMS, since
  WhatsApp itself may be the thing that is down).
- **Effort.** S–M. **Acceptance.** A restore from yesterday's off-site backup into a scratch DB
  succeeds; killing the worker triggers an alert within 5 minutes.

#### P0-5 Dashboard money and order counts are wrong for real data

- **Problem.** Zero-decimal currencies render 100× too small (D1), and open carts inflate order
  counts (D2).
- **Evidence.** `commerce-grid.tsx:217`, `analytics.service.ts:369` vs `money.ts:10-22`;
  `analytics.service.ts:271,340,459-472`.
- **Solution.** One shared formatter from `@vca/commerce`, used everywhere, including the AG Studio
  dataset. Apply `NOT_OPEN_CART` in all analytics queries. Add unit tests with UGX fixtures.
- **Effort.** S. **Acceptance.** A UGX 50,000 order shows as UGX 50,000 in every grid, CSV and
  chart. Overview counts exclude unconfirmed carts.

### P1 — Core functionality

#### P1-1 Decide and build the tenancy and money-flow model

- **Problem.** The product is single-tenant: first-merchant scoping (`merchant-scope.ts:22-27`),
  one login, one WhatsApp session, one platform PayPal account receiving all funds, no onboarding.
- **Solution.** Write an ADR choosing between (a) **single-tenant per merchant** (one stack per
  merchant — fastest path for pilots; fix only per-user logins) or (b) **multi-tenant SaaS**:
  `User`/`Membership` tables with roles, session → merchant scope (drop the `x-merchant-id`
  fallback), self-serve onboarding, per-merchant payment credentials via **PayPal Multiparty /
  Partner Referrals** (payee = merchant) or a merchant-owned payment account, one channel
  connection per merchant (see P3-1).
- **Effort.** (a) M, (b) XL. **Acceptance.** For (b): two merchants in one deployment cannot see or
  affect each other's data through any dashboard route (automated cross-tenant tests); each
  merchant's buyers pay that merchant's PayPal account.

#### P1-2 Durable messaging (inbound queue + outbound outbox)

- **Problem.** W1/W2: lost inbound messages on API trouble, silent duplicates after timeouts, lost
  payment/alert notifications.
- **Solution.** Worker acknowledges after persisting to an `inbound_messages` table (or the API
  accepts and returns 202), a DB-backed job runner (e.g. `pg-boss` or `graphile-worker` on the
  existing Postgres) processes them; all outbound messages go through an `outbox` table with
  retries/backoff and delivery status; on duplicate, return the stored replies instead of nothing.
- **Effort.** M–L. **Acceptance.** Killing the API for 2 minutes loses no message; every
  "payment received" is delivered once after the gateway recovers; a resent message gets the
  original reply.

#### P1-3 Complete the order operations surface

- Merchant cancel / edit (before payment), mark ready / delivered (Katale-side status, since
  PayPal has none), record refund, decline APPROVAL-mode orders, from chat **and** dashboard.
- **Effort.** M. **Depends on** P0-1/P0-2. **Acceptance.** Every order state reachable from the
  Orders page with confirmations and audit events.

#### P1-4 Prove what is "built but unproven"

- Deploy Phase 2 behind the pilot-number flag and run `docs/hackathon/customer-shopping-test.md`
  end to end on a real phone; run the real-Sandbox `SHIP` and dispute `SUBMIT` flows
  (`docs/hackathon/shipment-dispute-demo.md`); record results and the deployed tag in
  `PROJECT_STATUS.md` (and fix its header date).
- **Effort.** S. **Acceptance.** Each row in the status matrix marked 🎭/🟡 above has a dated real-run result.

#### P1-5 Customer conversation fixes

- Narrow hand-off detection (whole-phrase intents such as "talk to a person", or let the LLM call
  `request_human`) and confirm before pausing ("Do you want to talk to the team? Reply YES");
  assignment/claim for hand-offs; dashboard reply to customers (route exists only via WhatsApp
  tool today); customer cancel of unpaid orders.
- **Effort.** S–M. **Acceptance.** A fixture set of 30 ordinary product questions triggers zero
  hand-offs; explicit requests still hand off.

#### P1-6 Webhook robustness

- Retry `RECEIVED` events older than N minutes; compare captured amount/currency in
  `markCompleted`; reconciler also checks recently cancelled (superseded) payments; tests for each.
- **Effort.** S.

### P2 — Product improvements

#### P2-1 Dashboard into an operations console

See [section 5](#5-dashboard-assessment): order detail with actions, product create/edit/stock in
the dashboard, customer conversation view with reply, merchant settings (name, currency,
timezone), pagination/search, mobile layout. **Effort** M–L.

#### P2-2 Proactive automation that merchants value most

- Automatic payment nudges to customers at configurable times (with merchant opt-in), cancellation
  notice at expiry (P0-1), "back in stock" notifications for customers who asked, end-of-day
  "what needs your attention" (unpaid, unshipped paid orders, low stock, open hand-offs).
- **Effort** M. **Value** high (directly recovers revenue).

#### P2-3 AI cost, latency and reliability

- Record `usage` (input/output tokens, model, latency) per agent run in `AuditEvent` and show
  cost per merchant/day; retry 429/5xx with jittered backoff; pre-route admin messages by intent
  (sales/inventory/orders/disputes/customers) and send only that tool group (~4–8 tools instead
  of 32); deterministic fast paths for frequent commands ("stock", "today's sales", "unpaid");
  keep the static prefix stable for provider prompt caching (move "Today is …" to a late
  message); add the external suites to a scheduled CI job with secrets.
- **Effort** M. **Acceptance.** Median tokens per admin message down ≥ 50 % with the external
  suites still passing.

#### P2-4 Business intelligence that drives action

- Repeat-customer rate, average order value, conversion from cart → order → paid, abandoned carts,
  sell-through and days-of-cover per product, and a weekly "3 things to do" generated from those
  numbers (rule-based first, LLM wording second). **Effort** M.

#### P2-5 Permissions granularity

- Make reprice/deactivate and large stock adjustments owner-only or confirm-required for staff;
  voice-originated stock adjustments read back before saving. **Effort** S.

#### P2-6 Local payment rails

- For Ugandan/East African merchants, add a mobile-money provider behind the existing provider
  abstraction (ADR 0005) and keep PayPal for international buyers. Validate merchant demand and
  provider terms first. **Effort** L. **Value** likely the single biggest adoption lever
  [Inference — needs market validation].

#### P2-7 Customer experience

- Customer voice notes (reuse the English pipeline), product search by photo description, reorder
  ("same as last time"), order-status push on shipment. **Effort** M.

### P3 — Future enhancements

| ID   | Item                                                                                                                                                                                                                                                                                              | Effort |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P3-1 | **Official WhatsApp Business Cloud API** behind the existing `ChannelSender`/adapter boundary (ADR 0002): per-merchant numbers, templates for out-of-window messages (payment reminders, reports), webhooks instead of Chromium. Plan for the 24 h customer-service window and template approval. | L      |
| P3-2 | Move scheduler/reconciler/report jobs to a job runner; allow multiple API replicas (requires P1-2 and shared rate-limit state).                                                                                                                                                                   | M      |
| P3-3 | Product images to object storage + CDN instead of `ProductImage.data` in Postgres.                                                                                                                                                                                                                | S      |
| P3-4 | PayPal invoicing, partial refunds initiated from Katale (with owner confirmation), dispute evidence uploads.                                                                                                                                                                                      | L      |
| P3-5 | CD pipeline: build/sign images in CI, deploy by tag, automatic pre-deploy backup and rollback.                                                                                                                                                                                                    | M      |
| P3-6 | Data retention and customer data export/deletion; privacy notice in the customer welcome.                                                                                                                                                                                                         | M      |
| P3-7 | Luganda/Swahili revisit with native-speaker evaluation (currently frozen — keep frozen this phase).                                                                                                                                                                                               | L      |

---

## 11. Top 5 immediate actions

1. **Close the order lifecycle and fix the numbers (P0-1, P0-2, P0-5).** Expiry and cancellation
   for unpaid orders. Merchant and customer cancel. Refund handling that updates the order, stock
   and analytics. Correct zero-decimal money and cart counts in the dashboard. Together these are
   what stand between Phase 2 and a safe customer pilot.
2. **Harden the production edge this week (P0-3).** Rotate the dashboard password, fix the
   throttle key, add security headers, close port 81, SSH key-only. Mostly configuration; small
   code change.
3. **Off-site nightly backups + alerting (P0-4).** Cron + object storage + uptime/error alerts,
   then one timed restore drill.
4. **Prove and record what's live (P1-4).** Deploy Phase 2 to pilot numbers, run the real-phone
   shopping runbook and the real-Sandbox ship/dispute flows; update `PROJECT_STATUS.md` with tags
   and dates.
5. **Make the tenancy/money decision (P1-1 ADR), then build durable messaging (P1-2).** Whether
   Katale is "one stack per merchant" or a SaaS decides the shape of auth, payments and the
   WhatsApp channel; durable inbound/outbound messaging is needed in both cases.

---

## Appendix A — Commands used

```bash
docker run -d --rm --name katale-audit-pg -e POSTGRES_USER=vca -e POSTGRES_PASSWORD=vca -e POSTGRES_DB=vca -p 127.0.0.1:55499:5432 postgres:16-alpine
export DATABASE_URL='postgresql://vca:vca@localhost:55499/vca?schema=public' NODE_ENV=test API_BASE_URL=http://localhost:4000 API_AUTH_TOKEN=ci-dashboard-token-123456 INTERNAL_SERVICE_TOKEN=ci-internal-token-123456
pnpm db:deploy && pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build
pnpm test:external   # without credentials: all suites skip
curl -s https://kataleai.space/api/health; curl -I https://kataleai.space/login
```

## Appendix B — Assumptions and limits of this audit

- Production configuration (`.env` on the VM), the deployed image tag and production data were not
  inspected; statements about production come from public responses or `PROJECT_STATUS.md`.
- The dashboard was reviewed from source (page by page) rather than clicked through in a browser.
- Real-LLM and PayPal Sandbox behaviour was not re-measured; figures quoted from earlier runs are
  marked [Claimed].
