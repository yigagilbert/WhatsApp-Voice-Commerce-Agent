# Running against real services (PayPal Sandbox + real LLM)

This guide runs the core vertical slice end to end:

```
Agent Console → real LLM → tool calls → draft order (backend totals) → confirmation
  → real PayPal Sandbox order → Sandbox buyer pays → capture → dashboard + audit trail
```

WhatsApp and voice are **not** needed for this slice.

## 1. PayPal Sandbox setup

1. Sign in at <https://developer.paypal.com/> with any PayPal account. This creates a developer account.
2. **Apps & Credentials → Sandbox → Create App**
   - Type: _Merchant_. It is linked to an auto-created Sandbox **business** account (the seller).
   - Copy **Client ID** → `PAYPAL_CLIENT_ID` and **Secret** → `PAYPAL_CLIENT_SECRET` in the root `.env`.
   - Keep `PAYPAL_ENV=sandbox`. Sandbox and Live credentials are different.
3. **Test buyer:** _Testing Tools → Sandbox Accounts_ lists an auto-created **Personal** account.
   Use its email address and password (_⋯ → View/Edit account_) to pay checkout links.
   Never use a real PayPal login on `sandbox.paypal.com`.
4. Check:

   ```bash
   pnpm paypal:check
   ```

   Expected: `PayPal Sandbox authentication: OK`.

### Local callback URLs

| Purpose      | URL                                     | Needs to be public?                |
| ------------ | --------------------------------------- | ---------------------------------- |
| Buyer return | `${API_PUBLIC_URL}/api/paypal/return`   | No — the buyer's browser opens it  |
| Buyer cancel | `${API_PUBLIC_URL}/api/paypal/cancel`   | No                                 |
| Webhooks     | `${API_PUBLIC_URL}/api/paypal/webhooks` | **Yes** — PayPal's servers call it |

With `API_PUBLIC_URL=http://localhost:4000`, the buyer's return to localhost captures the
payment when you pay **on the same machine** ([ADR 0007](../architecture/decisions/0007-capture-on-return-and-webhook.md)).

### Webhooks (optional locally, required when deployed)

1. Start a tunnel to the API:

   ```bash
   cloudflared tunnel --url http://localhost:4000
   ```

   or `ngrok http 4000`.

2. Set `API_PUBLIC_URL=https://<tunnel-host>` in `.env` and restart the API. Return and cancel URLs then use the tunnel too.
3. In your Sandbox app → **Webhooks → Add Webhook** → URL `https://<tunnel-host>/api/paypal/webhooks`, events:
   `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`,
   `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`.
4. Copy the **Webhook ID** → `PAYPAL_WEBHOOK_ID`, then restart the API.
5. Complete a payment and check _Webhooks → Webhook events_ in the dashboard, plus the API logs (`paypal webhook`).

> The developer dashboard's **Webhook simulator** sends mock events that PayPal's
> `verify-webhook-signature` API does **not** accept, so they are rejected with 401 by design.
> Test webhooks with real Sandbox payments. Free tunnel URLs change on restart, so update the webhook URL each time.

## 2. LLM setup

| Variable      | Example                     | Notes                                         |
| ------------- | --------------------------- | --------------------------------------------- |
| `AI_PROVIDER` | `openai-compatible`         | `openai_compatible` also accepted             |
| `AI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible `/chat/completions` API |
| `AI_API_KEY`  | —                           | Never logged                                  |
| `AI_MODEL`    | `gpt-4.1-mini`              | Must support native **tool calling**          |

```bash
pnpm ai:check
```

Expected: `AI authentication: OK` and `Tool calling: SUPPORTED`.

The agent sends OpenAI-format `tools` (JSON Schema generated from Zod), `tool_choice: "auto"` and
temperature 0.1, and runs at most **6 model steps** per message. Invalid tool arguments are
returned to the model as validation errors so it can correct itself. A model that answers in text
instead of calling tools cannot create orders; `ai:check` detects this.

## 3. Database

```bash
pnpm db:up
```

```bash
pnpm db:deploy
```

```bash
pnpm db:seed
```

This uses Docker Postgres on port 5433, or any Postgres set in `DATABASE_URL`.

## 4. Demo run (reproducible)

```bash
pnpm dev
```

Open <http://localhost:3000/console> and send:

1. `Create an order for Sarah for 10 handmade baskets at $12 each and $20 shipping.`
   → draft summary, **Total $140.00**, `Reply confirm NNNN`.
2. `confirm NNNN` → "PayPal payment request created" with **Open PayPal Sandbox Checkout**.
3. Click the button and log in with the Sandbox **personal** buyer. Pay.
4. PayPal redirects to `/api/paypal/return` → "Thank you! Your payment was received."
5. Dashboard: **Overview** (revenue $140.00), **Orders** (`PAID`), **Payments** (`COMPLETED`, PayPal status `COMPLETED`).
   Click the **Trace** ID to see the whole transaction on **Activity**.
6. Console: `How much have I sold this week?`

Safety checks to try in the console:

| Message                                                   | Expected                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `confirm 0000` (wrong code)                               | "That code doesn't match…"                                                           |
| the same `confirm NNNN` again                             | "There is nothing waiting for your confirmation…"                                    |
| `Create an order for Sarah for some baskets.`             | Agent asks how many                                                                  |
| `Create an order for Sarah for 10 baskets at $1000 each.` | Price-override warning; requires confirmation; limit is `MAX_PAYMENT_REQUEST_AMOUNT` |

## 5. Opt-in external tests

These are never part of `pnpm test` or `pnpm verify`. They use Sandbox only and USD 1.00 orders,
and skip automatically when credentials are missing.

```bash
pnpm test:external
```

```bash
pnpm paypal:smoke
```

`test:external` covers PayPal OAuth, create, idempotent create, get, capture-before-approval
rejection, and real-LLM tool selection for the demo prompts. `paypal:smoke` creates an order and
prints its approval link. After approving it as the Sandbox buyer, run:

```bash
pnpm paypal:smoke capture <PAYPAL_ORDER_ID>
```

That captures the order, replays the capture (idempotent), and checks that a second capture is
rejected with `ORDER_ALREADY_CAPTURED`.

## 6. Tracing one transaction

The **trace ID** is the correlation ID of the request that drafted the order. The confirmation
executor, the PayPal request, the capture (return URL or webhook) and the notification all run
under it.

- Dashboard: **Payments → Trace**, or `/activity?trace=<id>`
- API: `GET /api/dashboard/activity?correlationId=<id>`
- Logs: search for the ID. HTTP request logs also carry their own `reqId`; a
  `continuing transaction trace` line links the two.
- SQL: `select type, "createdAt" from audit_events where "correlationId" = '<id>' order by "createdAt";`

Never logged: PayPal client secret, OAuth tokens, AI API key, `Authorization` headers.

## 7. Troubleshooting (seen during validation)

| Symptom                                                                                                            | Cause                                                                                       | Fix                                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm paypal:check` → `invalid_client: Client Authentication failed`                                               | Wrong or Live credentials, or ID and secret from different apps                             | Re-copy both from the **Sandbox** tab of the same app                                   |
| Checkout page: "The merchant isn't able to accept PayPal payments at this time" (`PAYEE_ACCOUNT_LOCKED_OR_CLOSED`) | The Sandbox **seller** account linked to the app is locked/closed or can't receive payments | Create a **US** Sandbox Business account and a new REST app linked to it; update `.env` |
| Checkout login pre-filled with `…@business.example.com`                                                            | That's the seller account; it can't pay itself                                              | Click **Change** and log in with the **Personal** Sandbox account                       |
| `RESOURCE_NOT_FOUND` for an order the API just created                                                             | The API process is still using old credentials (orders are app-scoped)                      | Restart the API after editing `.env`; check `lsof -iTCP:4000` for stale processes       |
| Return page says "Payment processing"                                                                              | PayPal returned a `PENDING` capture                                                         | Completion arrives via the `PAYMENT.CAPTURE.COMPLETED` webhook (needs a tunnel)         |
| Agent asks for full names / prices instead of drafting                                                             | Model over-caution                                                                          | Covered by the system prompt; re-run `pnpm test:external` after changing models         |
