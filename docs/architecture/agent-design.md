# Agent design

The LLM is an **interpretation and reasoning layer**. It is not the database, the calculator or
the payment system. It reads trusted data and proposes actions through typed tools.

## Loop

`runAgent` (`packages/ai/src/agent.ts`) is a minimal tool-calling loop:

1. Send system prompt + recent conversation (12 messages) + user text + tool specs.
2. For each tool call: validate arguments with the tool's Zod schema, execute, return
   `{ ok, data }` or `{ ok: false, code, error }` to the model.
3. Repeat until the model answers in text, or 6 steps are exhausted.

Expected business errors (validation, not found, policy) are fed back to the model so it can ask
the merchant a clarifying question. Unexpected errors propagate (they are bugs).

## Tools

Defined in `apps/api/src/modules/agent/tools.ts` with `defineTool({ name, kind, description, input, execute })`.

| Tool                             | Kind    | Purpose                                                                                                                                                  |
| -------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find_customer`                  | read    | Search customers                                                                                                                                         |
| `create_customer`                | write   | Add a customer                                                                                                                                           |
| `list_products`                  | read    | Catalog with prices and stock                                                                                                                            |
| `find_product`                   | read    | Fuzzy product lookup                                                                                                                                     |
| `check_inventory`                | read    | Stock for a product                                                                                                                                      |
| `calculate_order_total`          | read    | Quote without creating anything                                                                                                                          |
| `create_draft_order`             | propose | Draft order + propose a PayPal payment request                                                                                                           |
| `request_payment`                | propose | Propose payment for an existing draft                                                                                                                    |
| `get_order`                      | read    | Order detail                                                                                                                                             |
| `get_payment_status`             | read    | Payment status of an order                                                                                                                               |
| `inventory_report`               | read    | Stock, reorder level, status, units sold (30 d), days of cover, suggested reorder                                                                        |
| `stock_history`                  | read    | Stock ledger entries                                                                                                                                     |
| `adjust_stock`                   | write   | Restock / count / damage / return (sales are automatic); never below zero                                                                                |
| `add_product` / `update_product` | write   | Catalog changes, audited; prices refused from voice notes                                                                                                |
| `compare_sales`                  | read    | Period vs same span before, % change computed in code                                                                                                    |
| `send_chart`                     | read    | PNG chart (revenue trend, product revenue, stock levels) attached to the reply                                                                           |
| `find_orders`                    | read    | Orders by status / period / customer / voice-or-text, with a database count and total                                                                    |
| `list_payments`                  | read    | Newest PayPal payments, by status ("what was my last payment?")                                                                                          |
| `get_customer_summary`           | read    | A customer's orders, total paid, outstanding, last order                                                                                                 |
| `get_sales_summary`              | read    | Revenue, paid orders, average order value, top products (revenue share), top customers, revenue by source (WhatsApp voice / text / console), outstanding |

The model may interpret, ask, choose tools and explain results. It may not calculate totals,
invent customers, products or payment state, or approve anything: every figure it quotes comes
pre-formatted from a tool, and payment status only from `get_payment_status` / `list_payments` /
`find_orders`. Voice requests are stricter: unknown customers and near-miss product names
("buckets" for Handmade Basket) return "Did you mean …?" instead of being created or priced.

**Adding a tool:** add a `defineTool(...)` to the registry. The JSON schema sent to the model is
generated from the Zod schema (`z.toJSONSchema`), so validation and documentation never drift.

## Structured commerce commands

The `create_draft_order` input _is_ the structured command (`draftOrderCommandSchema` in
`packages/commerce/src/commands.ts`):

```json
{
  "customer": { "name": "Sarah" },
  "items": [{ "name": "handmade basket", "quantity": 50, "unit_price": 12 }],
  "currency": "USD",
  "shipping": 80,
  "claimed_total": 680
}
```

The backend then: resolves the customer (exact → single partial → ask if ambiguous → create if
unknown), matches products deterministically, converts to integer minor units, computes totals,
flags discrepancies, persists a DRAFT order and proposes a confirmation.

## Replies

- Normal turns: the model's text is the reply.
- When a `propose` tool ran, the reply is replaced by the **backend-generated summary and
  confirmation prompt**, so amounts shown to the merchant never come from the model.
- Confirm/cancel replies bypass the model entirely (see [financial-safety.md](financial-safety.md)).

## Multilingual design

- Voice notes go through `SpeechPipeline`: ASR → (language ID) → (translation to the working language).
- `Message` stores `transcription` (original), `detectedLanguage` and `normalizedText` (what the agent saw) separately.
- The system prompt asks the model to answer in the merchant's language; the confirmation
  vocabulary includes starter Luganda/Swahili words (to be validated with native speakers).
- Luganda-specific providers (e.g. Sunbird AI ASR/translation) plug into the `SpeechToTextProvider`
  / `TranslationProvider` interfaces.

## Provider behaviour (verified with `gpt-4.1-mini`, 2026-10-05)

- Native tool calling works through the OpenAI-compatible endpoint (`pnpm ai:check`); no
  compatibility layer was needed. Endpoints without native tool calling are detected by
  `ai:check` and are not supported. The agent requires `tools`.
- All 12 Zod-generated tool schemas were accepted by the API.
- Observed with real prompts (console + `pnpm test:external`, 3 consecutive green runs):

  | Prompt                                                           | Behaviour                                                                       |
  | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
  | "Create an order for Sarah for 10 handmade baskets at $12 each." | `create_draft_order` {Sarah, qty 10, unit_price 12}                             |
  | "Sarah wants 20 baskets. Add $25 shipping."                      | `create_draft_order` {qty 20, shipping 25, no unit_price → catalog}             |
  | "How much have I sold this week?"                                | `get_sales_summary(this_week)`, answers with backend-formatted totals           |
  | "… 10 baskets at $1000 each"                                     | Passes $1000 through; backend flags the catalog mismatch and enforces the limit |
  | "Create an order for Sarah for some baskets."                    | Asks for the quantity; no tool call                                             |

- Prompt tuning needed: before it, the model asked for Sarah's _full name_ and whether to use the
  catalog price instead of drafting. The system prompt now says names may be partial (the backend
  resolves them), unstated prices mean "use the catalog", and drafting is safe because confirmation
  is enforced.
- With conversation history the model sometimes asks "should I proceed?" before drafting a repeated
  order. A bare "yes"/"no" is therefore only treated as a deterministic confirmation when the
  conversation has a pending action (or the reply quotes a code); otherwise it goes to the agent.
  Nothing financial can execute either way: a pending action still needs its code, and "no"
  discards it.
- A bare "yes" that reaches the agent answers only the agent's most recent message. In end-to-end
  testing (2026-10-31) the model acted on an offer made seven messages earlier ("deactivate it
  instead?") after an unrelated answer; the system prompt now forbids acting on earlier offers.
- Policy refusals (e.g. above `MAX_PAYMENT_REQUEST_AMOUNT`) reply with a backend-generated summary
  and reason, like proposals, so the model never restates amounts for financial actions.

## Providers

`ChatModel` is provider-neutral. `OpenAICompatibleChatModel` works with any `/chat/completions`
endpoint (OpenAI, OpenRouter, Groq, Together, vLLM, Ollama). Adding Anthropic or Gemini means one
class implementing `complete()` and mapping tool calls.

## Audit

Each agent turn records `agent.intent_interpreted` with the model ID, tools called (name, ok,
duration) and any confirmation IDs proposed. Tool arguments that create orders are captured on
`order.drafted` / `confirmation.proposed` events.
