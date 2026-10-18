# Project status

_Last updated: 2026-10-07 — production runs `v0.1.0-202610071145` at https://kataleai.space: English text + voice commerce to PayPal payment (verified), AG Grid/AG Studio dashboard, and post-payment operations — PayPal shipment tracking and dispute handling (deployed; real-Sandbox runs pending, see below). Luganda frozen (experimental, off)._

## Completed

- **Monorepo:** pnpm workspaces, strict TypeScript 6 (ESM), ESLint 10 (flat config), Prettier, Vitest 5.
- **Packages:** `config` (Zod env), `shared` (errors, pino logger with redaction, correlation context,
  channel contracts), `database` (Prisma 7 schema, 2 migrations, seed), `commerce` (money,
  pricing, commands, state machines, policy, confirmations, services, analytics), `ai` (ChatModel,
  OpenAI-compatible model, ToolRegistry, agent loop), `speech` (provider interfaces, media
  validation, Ogg/Opus duration, OpenAI-compatible STT with confidence, Sunbird AI STT/translation,
  Whisper→Sunbird cascade, Luganda number normaliser, pipeline), `paypal` (REST client, webhook helpers).
- **API (`apps/api`):** Fastify 5 with correlation IDs, raw-body capture, rate limiting, Helmet,
  CORS, typed error mapping, service-token auth; inbound pipeline; 12 agent tools; confirmation
  executor; PayPal payment service; webhook service; notifications; health/readiness; dashboard routes.
- **WhatsApp worker (`apps/whatsapp`):** `whatsapp-web.js` adapter with LocalAuth + QR, pure
  message mapper (robust message IDs, unsupported types, voice gating), de-duplication, API client,
  internal outbound gateway. `pnpm operator:add` registers merchant WhatsApp IDs.
- **Dashboard login:** `/login` page, HMAC-signed HttpOnly session cookie (12 h), `proxy.ts` gate on every
  page and server action, `requireUser()` defence in depth, login throttling (5 failures / 15 min / IP).
  PayPal return/cancel/webhooks and `/api/health` stay public.
- **Voice notes (WhatsApp):** download → validate → duration ≤ 60 s → Whisper (English) or Sunbird
  (Luganda) → same inbound pipeline as text; low-confidence read-back; spoken approvals refused;
  voice never silently creates customers. See [voice commerce](docs/architecture/voice-commerce.md).
- **Branding:** user-facing copy is **Katale AI** (WhatsApp messages, dashboard, PayPal brand name, return pages).
- **Dashboard (`apps/web`):** Next.js 16 + Tailwind 4; Overview, Orders, Payments (PayPal status +
  trace link), Customers, Products, Activity (filterable by trace), Agent console (checkout button);
  AG Grid-shaped `DataTable`.
- **Real-service tooling:** `pnpm paypal:check`, `pnpm ai:check`, `pnpm paypal:smoke [capture <id>]`,
  `pnpm test:external` (opt-in; never part of `verify`).
- **Infrastructure:** Docker Compose (Postgres on 5433; `app`/`whatsapp` profiles), Dockerfiles,
  `scripts/dev-setup.sh`.
- **Docs:** README, architecture docs, 7 ADRs, local setup, real-services guide, API reference,
  hackathon demo flow and product story.

## Customer commerce — Phase 0 + 1 (2026-10-18, branch `feat/customer-commerce-phase-0-1`, off in production)

| Capability                                                                                        | Status                                                         |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Bot number → merchant; admin/customer routing; admins of other shops are customers on this number | ✅ integration tests                                           |
| Customer identity by WhatsApp ID and `@lid`; linking only via WhatsApp-verified phone             | ✅ integration tests                                           |
| Numbered menu, product lists with paging, details with photos, availability labels only           | ✅ integration tests                                           |
| Customer agent with 4 customer-only tools; injection and admin-tool attempts refused              | ✅ integration + real-LLM tests                                |
| Hand-off (configurable pause), forwarding, admin reply/resume (WhatsApp + dashboard)              | ✅ integration tests                                           |
| Dashboard: shop number + settings, customer chats, product photos/description/visibility          | ✅ checked locally                                             |
| Production                                                                                        | Not deployed; `CUSTOMER_COMMERCE_ENABLED=false` until approved |

## Reminders, payment checks, roles, monthly reports (2026-10-18, production `v0.1.0-202610181457`)

| Capability                                                                                                         | Status                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Unregistered numbers: one generic welcome per 24 h (configurable), no IDs, no data, no AI; neutral call decline    | ✅ integration tests                                                              |
| Payment reminders (agent + `REMIND <code>`, dashboard button); PayPal checked first; expired links renewed; limits | ✅ integration + real-LLM tests                                                   |
| Background PayPal re-check of open links; recovered payments; expired links and mismatches in the report           | ✅ integration tests (simulated PayPal)                                           |
| Owner / staff roles: staff can't approve payment requests or dispute responses; last owner protected               | ✅ integration tests                                                              |
| Monthly reports (1st of the month, last calendar month); `last_month` sales period                                 | ✅ unit + integration + real-LLM tests                                            |
| WhatsApp outage notice after reconnect; dashboard banner while down                                                | ✅ unit tests                                                                     |
| Customer-facing commerce (browse, cart, checkout)                                                                  | Planned: [customer-commerce-plan.md](docs/architecture/customer-commerce-plan.md) |
| Off-VM database backups                                                                                            | Not built: needs a storage destination                                            |

## Admins and proactive reports (2026-10-17, production `v0.1.0-202610171213`)

| Capability                                                                                                  | Status                                                    |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Dashboard → Admins: add / edit / activate / deactivate / remove / send test; E.164 (`libphonenumber-js`)    | ✅ integration tests (scoping, duplicates, audit masking) |
| Only active admins reach the agent; inactive admins, customers, strangers refused before the model/tools    | ✅ integration tests                                      |
| Linked IDs (`@lid`) matched by the worker-resolved phone, then remembered                                   | ✅ integration test; worker resolution not tried live     |
| Dashboard → Reports: daily/weekly schedule, time zone, sections, next run, send now, run + delivery history | ✅ API integration tests; pages typecheck/build           |
| Report: yesterday, 7 days, stock, unpaid links, open disputes, 7-day PNG chart, rule-based actions          | ✅ figures checked against seeded records                 |
| One run per slot; 6 h catch-up; per-admin text/chart tracking; retry 2/5/15 min; partial/failed states      | ✅ integration tests                                      |
| Stock and dispute alerts to every opted-in admin                                                            | ✅ integration test                                       |
| Production                                                                                                  | Deployed `v0.1.0-202610171213`                            |

## WhatsApp business assistant (2026-10-17, production `v0.1.0-202610170605`)

Review, capability research and roadmap: [whatsapp-assistant-review.md](docs/hackathon/whatsapp-assistant-review.md).

| Capability                                                                                      | Status                                                           |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Stock ledger; paid orders reduce stock once per order line; restock/count/damage/return by chat | ✅ integration + real-LLM tests                                  |
| Low-stock / out-of-stock alerts once per crossing; inventory report with reorder suggestions    | ✅ integration tests                                             |
| Add / reprice / deactivate products by chat (prices typed only), audited                        | ✅ integration tests                                             |
| Charts as WhatsApp images; period comparisons                                                   | ✅ unit + integration + real LLM; checked in the Agent console   |
| Dashboard WhatsApp page (status, QR, reconnect, unlink)                                         | ✅ gateway/API tests; page checked locally against a stub worker |
| Incoming calls declined with a voice-note hint                                                  | ✅ code; not tested with a real call                             |
| Production                                                                                      | Deployed `v0.1.0-202610170605` (migration `inventory_movements`) |

## Post-payment operations (2026-10-07)

Katale now runs the lifecycle after payment: **fulfillment/tracking** and **PayPal disputes**, under
the same rule — AI interprets and prepares, the backend verifies, the merchant approves (`SHIP` /
`SUBMIT` + code), PayPal executes, the audit trail records. Details:
[shipment](docs/architecture/shipment.md), [disputes](docs/architecture/disputes.md),
[demo](docs/hackathon/shipment-dispute-demo.md).

| Capability                                                                                                    | Status             | Evidence                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Shipment model, `fulfillmentStatus` separate from payment                                                     | ✅                 | migration `shipments_and_disputes`, integration tests                                                                                |
| PayPal Orders v2 tracking (`/track`)                                                                          | ✅ code + contract | Contract validated against PayPal's OpenAPI spec and official SDK; **SIMULATED PAYPAL** in tests; **real Sandbox run pending**       |
| `SHIP <code>`: wrong/expired/reused codes, CONFIRM/"yes" refused, single PayPal call                          | ✅                 | **SIMULATED PAYPAL** (integration)                                                                                                   |
| Dispute model, webhook → canonical fetch → link → notify once                                                 | ✅                 | **SIMULATED PAYPAL** (integration); webhook subscribed in Sandbox (`CUSTOMER.DISPUTE.*`); forged dispute webhook → 401 in production |
| Disputes v1 API access (list/details)                                                                         | ✅                 | **REAL PAYPAL SANDBOX**: scopes `disputes/read-seller`, `update-seller`; list = 200 (no disputes yet)                                |
| Evidence (facts + missing), code-drafted response, fact-check, no concessions                                 | ✅                 | integration + real-LLM tests (**MOCKED** PayPal)                                                                                     |
| `SUBMIT <code>` → provider re-check → provide-evidence once                                                   | ✅ code            | **SIMULATED PAYPAL**; **real Sandbox run pending** (needs a buyer-opened Sandbox dispute)                                            |
| Disputes page (AG Grid), order fulfillment column/detail, operations cards, AG Studio tables, activity labels | ✅                 | local browser check; production pages behind login                                                                                   |

## Architecture (key decisions)

- Modular monolith + separately runnable channel worker ([ADR 0001](docs/architecture/decisions/0001-modular-monolith.md)).
- `whatsapp-web.js` isolated in one file/process ([ADR 0002](docs/architecture/decisions/0002-whatsapp-behind-adapter.md)).
- Financial actions require bound confirmation; deterministic confirm parsing ([ADR 0003](docs/architecture/decisions/0003-confirmation-before-financial-actions.md)).
- Backend totals override AI amounts; backend-generated summaries replace model text, including policy refusals ([ADR 0004](docs/architecture/decisions/0004-backend-calculates-money.md)).
- Provider interfaces + single composition root ([ADR 0005](docs/architecture/decisions/0005-provider-abstractions.md)).
- Integer minor units for money ([ADR 0006](docs/architecture/decisions/0006-integer-minor-units.md)).
- Capture on buyer return, with the webhook as fallback; three-layer capture idempotency ([ADR 0007](docs/architecture/decisions/0007-capture-on-return-and-webhook.md)).
- One **transaction trace ID** (the correlation ID of the drafting request) carried through confirmation, PayPal request, capture and notification.

## Verified with real services (2026-10-05)

**PayPal Sandbox** (US Sandbox business account, REST app `APP-8E137271V8510680J`):

| Check                                                                             | Result                           |
| --------------------------------------------------------------------------------- | -------------------------------- |
| OAuth token (`paypal:check`, external tests)                                      | PASS                             |
| Create checkout order (`PAYER_ACTION_REQUIRED`, `payer-action` URL)               | PASS                             |
| Create idempotency (same `PayPal-Request-Id` → same order)                        | PASS                             |
| Get order                                                                         | PASS                             |
| Capture before approval → `ORDER_NOT_APPROVED`                                    | PASS                             |
| Sandbox buyer checkout → return URL → capture (ORD-CTABAZ, $140.00)               | PASS                             |
| Duplicate capture protection (2× return URL replay; extra capture with a new key) | PASS — 1 capture, 1 notification |
| Webhook signature verification API (forged event → `FAILURE` → 401)               | PASS                             |
| Webhook delivery from PayPal (needs tunnel + `PAYPAL_WEBHOOK_ID`)                 | NOT TESTED live                  |

**Real LLM** (`gpt-4.1-mini`, OpenAI): native tool calling supported; the order, partial-name,
sales, high-price and clarification prompts behaved correctly in the console and in `pnpm test:external`
(11/11, three consecutive runs). See [agent design](docs/architecture/agent-design.md#provider-behaviour-verified-with-gpt-41-mini-2026-10-05).

**End-to-end in the Agent Console:** request → real LLM → draft (backend totals) → wrong code
rejected → confirm → real PayPal order → Sandbox payment → capture → order `PAID`/payment
`COMPLETED` (PayPal status + capture ID stored) → dashboard revenue/orders/payments updated →
activity trace shows `order.drafted → confirmation.proposed → agent.intent_interpreted →
payment.requested → payment.completed` under one trace ID → reused code refused → sales
question answered from the database. No secrets or tokens appeared in the logs (checked).

## Production deployment (2026-10-06)

Built locally → pushed to Docker Hub (`yigagilbert/katale-{api,web,whatsapp}:v0.1.0-202610051458`,
linux/amd64) → pulled on the VM → Docker Compose → existing Nginx Proxy Manager → Let's Encrypt →
**https://kataleai.space**. Guide: [docs/deployment/docker-hub-vm.md](docs/deployment/docker-hub-vm.md).

| Check                                                                                                              | Result                    |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| Images: local build / rehearsal / push / VM pull                                                                   | PASS / PASS / PASS / PASS |
| No public app ports (3000/4000/4100/5432 closed); only `/api/paypal/*` + `/api/health` routed                      | PASS                      |
| Postgres + WhatsApp session persist across restart, recreate, `down`/`up`                                          | PASS                      |
| HTTPS (valid LE cert, HTTP→HTTPS 301, HTTP/2, HSTS)                                                                | PASS                      |
| Migrations (`katale-migrate`) and idempotent seed from the API image                                               | PASS                      |
| WhatsApp QR via `docker compose logs`, then no QR after restart/recreate                                           | PASS                      |
| WhatsApp order → confirm → PayPal → pay → return capture → ✅ notification                                         | PASS                      |
| Buyer never returns (webhook-only capture mode) → PayPal webhook completes payment                                 | PASS                      |
| Real PayPal webhooks: signature verified, processed; forged → 401                                                  | PASS                      |
| Duplicates (WhatsApp message, CONFIRM, return callback, webhook redelivery) → 1 order/payment/capture/notification | PASS                      |
| Backup + restore (into a scratch DB)                                                                               | PASS                      |

## Dashboard protection (production, 2026-10-06)

| Check                                                                  | Result |
| ---------------------------------------------------------------------- | ------ |
| Anonymous `/`, `/console`, `/orders` → 307 `/login?next=…`             | PASS   |
| Anonymous server-action POST → 401                                     | PASS   |
| Wrong password → error, no cookie; correct → redirect to `next`        | PASS   |
| Sign out clears the session                                            | PASS   |
| `/api/paypal/cancel`, `/api/paypal/return`, `/api/health` still public | PASS   |
| Forged PayPal webhook → 401                                            | PASS   |
| Login by the user in production                                        | PASS   |

Credentials come from `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` in the VM `.env` (never in the repo).
The current password is a temporary value chosen for the hackathon and must be changed before wider use.

## Voice commerce (production, 2026-10-06)

**English (Whisper `whisper-1`)**

| Check                                                                                  | Result                                         |
| -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 12.7 s order note → exact transcript (conf. 0.64, STT 2.4 s, voice → reply 9.0 s)      | PASS                                           |
| Draft ORD-95SRS2 $140 → typed CONFIRM → PayPal → paid → ✅ notification (once)         | PASS                                           |
| Real webhooks `CHECKOUT.ORDER.APPROVED` + `PAYMENT.CAPTURE.COMPLETED` raced return URL | PASS — one capture                             |
| One trace: `speech.transcribed → order.drafted → … → payment.completed`                | PASS                                           |
| "some baskets" (no quantity)                                                           | PASS — asked how many                          |
| 20 × $1,000                                                                            | PASS — ⛔ policy refusal                       |
| "Cancel the order"                                                                     | PASS — "I cannot cancel orders yet"            |
| Mumbled note (conf. 0.47)                                                              | PASS — read-back, typed YES required           |
| 61 s note                                                                              | PASS — rejected before download/STT            |
| Spoken "Confirm 2720"                                                                  | PASS — asked to type CONFIRM                   |
| Synthetic evaluation set (`pnpm test:voice:external`, 5 clips)                         | 5/5; STT 0.8–1.8 s; voice → decision 2.0–4.0 s |

**Luganda (Sunbird AI, experimental)** — real Luganda notes on build `v0.1.0-202610060937`:
routing to Sunbird worked for every note; a stock question was partially answered; an order drafted
10 × $12 but read shipping "dollar abiri" as **$2**; a code-switched order led to a safe clarification.
Fix: deterministic `normalizeLugandaNumbers` before the agent (A/B on the real transcript: 3/3 correct,
vs. 0/3 for glossary-only and translate-first). The fix is deployed in `v0.1.0-202610061859` and
covered by unit and integration tests, but **has not yet been re-tested with a new real Luganda voice
note on WhatsApp**. Luganda is therefore _experimental_, not supported. Details:
[Luganda results](docs/architecture/voice-commerce.md#luganda-results).

Bugs found in production and fixed: `whatsapp-web.js` 1.34.7 `downloadMedia` failing on current
WhatsApp Web (`id.$1` instead of `_serialized`, missing `mimetype`) → `pnpm patch`; WhatsApp Channels
(`@newsletter`) receiving onboarding replies → skipped.

## Verified over real WhatsApp (2026-10-05, text only)

Dedicated bot number linked via QR; a separate merchant WhatsApp account (identified as `…@lid`).

| Check                                                                                                  | Result      |
| ------------------------------------------------------------------------------------------------------ | ----------- |
| QR authentication / session persistence across restarts                                                | PASS / PASS |
| Unknown sender → generic welcome (since 2026-10-17, no ID); nothing stored                             | PASS        |
| Merchant mapping (`pnpm operator:add`)                                                                 | PASS        |
| Inbound text → real LLM → branded backend draft (ORD-4PCK8Z, $140.00)                                  | PASS        |
| Wrong / expired / reused confirmation codes                                                            | PASS        |
| `CONFIRM` → real PayPal order + tappable link in WhatsApp                                              | PASS        |
| Sandbox payment → capture → ✅ _Payment received_ on WhatsApp (once, despite replayed callbacks)       | PASS        |
| Redelivered WhatsApp messages (order, confirm) → `duplicate`, no second order/PayPal order             | PASS        |
| Sales question via `get_sales_summary`                                                                 | PASS        |
| Clarification across messages                                                                          | PASS        |
| High-value request ($20,000) → ⚠️ + ⛔ policy refusal                                                  | PASS        |
| Photo / voice note → polite replies, voice not downloaded                                              | PASS        |
| One trace ID: WhatsApp message → API → order → confirmation → PayPal → capture → WhatsApp notification | PASS        |

Bugs found and fixed during the live run: missing `id._serialized` on WhatsApp messages (all
messages rejected, and worker de-dup would have dropped every later message); missing `message`
events for an `@lid` contact (now also `message_create`); voice-note download crash while voice is
disabled (no download now); repeated "authenticated" logs; noisy group logs; the agent offering to
cancel orders it can't cancel. Details: [WhatsApp integration](docs/architecture/whatsapp-integration.md).

## Still mocked / unverified

- **Real Sandbox shipment tracking** (`SHIP` on a paid order) and a **real Sandbox dispute** (buyer-opened →
  webhook → `SUBMIT`): deployed and ready, not yet run. Steps: [shipment-dispute-demo.md](docs/hackathon/shipment-dispute-demo.md).
- Production acceptance of `v0.1.0-202610071011`/`…1145` English voice → paid → notification on WhatsApp
  (automated regressions pass; the last real run was on `v0.1.0-202610061859`).
- The provide-evidence multipart shape (`input` part) follows PayPal's documented samples; PayPal's
  OpenAPI file only lists the file part, so the first real submission is the confirmation.
- `PENDING`/`DECLINED` capture outcomes (handled in code, not reproduced in Sandbox).
- `ORDER_ALREADY_CAPTURED` sync path (Sandbox returned 200 with the existing capture instead; path covered with fakes).
- `pnpm verify` and `pnpm test:integration` deliberately use fakes for PayPal and the LLM.
- Luganda voice after the number-normaliser fix (deployed, tested with fakes and the real LLM on a real
  transcript, not with a new WhatsApp voice note).
- Text regression on `v0.1.0-202610061859` over WhatsApp (covered by `pnpm verify` + integration tests).
- Payment on a separate _phone_: production paid via the public HTTPS return/webhook path; the logged
  return requests came from a desktop Chrome on the same public IP, so a phone browser specifically wasn't evidenced.
- Pushing payment links to customers over WhatsApp (needs a customer `whatsappId`; covered by tests only).

## Not yet implemented

- Spoken replies (TTS), customer-side voice bot, Swahili; translation is implemented but off (it invented content in testing).
- PayPal invoicing tools/executor, refunds, subscriptions (client methods for invoices exist).
- Order cancellation/editing via chat (drafts and stale `AWAITING_PAYMENT` orders stay as they are).
- Per-merchant users and roles, multi-tenant onboarding (one dashboard login today).
- Live dashboard updates; background jobs; dispute document uploads, messages to the buyer,
  offers/refunds/accepting claims (deliberately excluded); delivery status (PayPal has none).

## Next recommended steps (priority order)

1. **Run the real Sandbox shipment and dispute end to end** ([steps](docs/hackathon/shipment-dispute-demo.md)) and record the results here.
2. Install APIMatic's PayPal Context Plugin and complete the review in [apimatic-integration.md](docs/hackathon/apimatic-integration.md).
3. Later: dispute evidence documents (shipping label/receipt uploads), native-speaker Luganda validation.

## Deferred infrastructure work (recorded, not addressed this phase)

- Rotate the VM `deploy` user password; move SSH to key-only and disable password login.
- Restrict Nginx Proxy Manager's admin port **81** (currently reachable from the internet).
- Broader firewall review, VPN/bastion access.
- Redundancy: single VM, single Postgres, single WhatsApp session; backups are manual (`vm-deploy.sh`).

## Known risks

| Risk                                                                                                                              | Mitigation                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Sandbox seller account misconfigured (`PAYEE_ACCOUNT_LOCKED_OR_CLOSED`) — order creation still succeeds, failure only at checkout | Use a US Sandbox business account; `paypal:smoke` link check; troubleshooting doc                |
| Stale API process keeps old credentials after `.env` changes                                                                      | Restart API; documented; readiness shows PayPal env but not app ID                               |
| LLM behaviour drifts with model changes (over-asking, history effects)                                                            | `pnpm test:external` regression prompts; deterministic confirmation layer                        |
| Return URL relies on the buyer's browser reaching `API_PUBLIC_URL`                                                                | Webhook fallback once deployed with a public URL                                                 |
| `whatsapp-web.js` breaks or the number is restricted during the demo                                                              | Dedicated number, pinned version, Agent console fallback (same pipeline)                         |
| WhatsApp Web changes break event/ID assumptions again (seen twice)                                                                | ID derivation + dual events + skip logging at info; re-run the WhatsApp demo script before demos |
| Phone payments can't reach `localhost`                                                                                            | Tunnel + webhooks (next step); laptop checkout for local demos                                   |
| UGX not supported by PayPal                                                                                                       | Policy refuses unsupported currencies; demo in USD; FX on roadmap                                |
| ASR quality for Luganda / code-switching                                                                                          | Sunbird ASR, number normaliser, read-back, no voice customer creation, typed-only approvals      |
| Sunbird latency (≈18 s cold start)                                                                                                | 2.5 s acknowledgement; text fallback                                                             |
| `whatsapp-web.js` patched locally (`patches/`)                                                                                    | Re-check the patch when upgrading; upstream fix pending                                          |
| LLM latency inside the request                                                                                                    | Fine at demo scale; move to jobs if needed                                                       |
| One shared dashboard login with a temporary password                                                                              | Change `DASHBOARD_PASSWORD`; per-merchant users later                                            |
