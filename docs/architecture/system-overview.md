# System overview

A voice-first conversational commerce agent. Merchants talk (or type) to an assistant on
WhatsApp or the web dashboard; the system turns that into validated orders and PayPal payment
requests, then tracks payment to completion.

## Components

```mermaid
flowchart LR
  subgraph Channels
    WA[WhatsApp user] <--> WW[apps/whatsapp<br/>whatsapp-web.js worker]
    DB_UI[Merchant browser] <--> WEB[apps/web<br/>Next.js dashboard]
  end

  WW -- "POST /api/agent/message<br/>(x-internal-token)" --> API
  API -- "POST /internal/send<br/>(proactive messages)" --> WW
  WEB -- "server-side fetch<br/>(Bearer token)" --> API

  subgraph API[apps/api — Fastify modular monolith]
    IN[Inbound pipeline] --> SP[Speech pipeline]
    IN --> CONF[Confirmation service]
    IN --> AG[Commerce agent<br/>tool registry]
    AG --> COM[Commerce services]
    CONF --> EX[Confirmation executor]
    EX --> PAY[Payment service]
    WH[PayPal webhooks] --> PAY
    PAY --> NOTIF[Notifications]
  end

  SP --> ASR[(ASR provider)]
  AG --> LLM[(LLM provider)]
  PAY --> PP[(PayPal REST API)]
  PP -- webhooks --> WH
  COM & PAY & CONF --> PG[(PostgreSQL)]
```

| Layer       | Lives in                               | Responsibility                                                             |
| ----------- | -------------------------------------- | -------------------------------------------------------------------------- |
| Channel     | `apps/whatsapp`, `apps/web`            | Native I/O only; normalise to `InboundChannelMessage`                      |
| API / HTTP  | `apps/api/src/http`, `modules/*`       | Auth, validation, routing, composition root                                |
| AI          | `packages/ai`                          | Provider-neutral chat model + tool registry + agent loop                   |
| Speech      | `packages/speech`                      | Media validation, normalisation, ASR, language ID, translation             |
| Commerce    | `packages/commerce`                    | Money, pricing, commands, state machines, policy, confirmations, analytics |
| Payments    | `packages/paypal` + `modules/payments` | PayPal REST client; trusted payment orchestration                          |
| Persistence | `packages/database`                    | Prisma schema, migrations, client, seed — **source of truth**              |
| Shared      | `packages/shared`, `packages/config`   | Errors, logging, correlation context, channel contracts, env validation    |

Dependency direction: `apps → packages`, and inside packages `commerce → database, shared`;
`ai`, `speech`, `paypal` depend only on `shared`. `commerce` never imports `paypal` or `ai` —
the API wires them together.

## Inbound message lifecycle

```mermaid
sequenceDiagram
  autonumber
  participant M as Merchant (WhatsApp)
  participant W as WhatsApp worker
  participant A as API inbound pipeline
  participant S as Speech
  participant C as Confirmations
  participant G as Agent + tools
  participant DB as Postgres

  M->>W: voice note / text
  W->>W: map + skip groups/status + local dedupe
  W->>A: POST /api/agent/message (correlation ID)
  A->>DB: operator allowed? conversation upsert
  A->>DB: insert message (unique channel+messageId → duplicate?)
  opt audio
    A->>S: decode (allow-list, size, magic bytes) → ASR → language → translate
    A->>DB: store transcript, language, normalized text
  end
  alt short confirm/cancel reply
    A->>C: claim pending confirmation (atomic)
    C-->>A: execute via trusted executor
  else anything else
    A->>G: run agent (tools read DB, propose actions)
  end
  A->>DB: store reply, audit events
  A-->>W: replies
  W-->>M: reply text
```

## Observability

- Every request gets a **correlation ID** (`x-correlation-id`, reused if supplied by the worker).
  It is stored in an `AsyncLocalStorage` context and automatically added to every log line
  (pino `mixin`), every `Message`, `AuditEvent` and `ActionConfirmation` row.
- Trace a demo end-to-end: WhatsApp message → `Message.correlationId` → `AuditEvent`s
  (`speech.transcribed`, `agent.intent_interpreted`, `order.drafted`, `confirmation.*`,
  `payment.*`) → the dashboard Activity page.
- Logs redact authorization headers, tokens, API keys and base64 media (`REDACT_PATHS`).

## Security summary

See [financial-safety.md](financial-safety.md) for the money path. In addition:

- Service-to-service auth with constant-time token comparison; the dashboard token never reaches the browser.
- Only allow-listed `MerchantOperator` identities can drive a merchant; unknown senders are ignored.
- Zod validation on every input; typed `AppError`s map to stable HTTP errors (no stack traces leaked).
- Rate limiting (`@fastify/rate-limit`), Helmet headers, CORS allow-list, body limits.
- Media: MIME allow-list, size check before decode, strict base64, magic bytes; processed in memory.
- PayPal webhooks: signature verification + idempotent event store.
