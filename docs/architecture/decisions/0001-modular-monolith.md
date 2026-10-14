# 0001 — Modular monolith with separately runnable apps

**Status:** Accepted · 2026-10-05

## Context

A small hackathon team must build and demo a reliable end-to-end flow quickly, while keeping
the option to scale parts independently later.

## Decision

One pnpm monorepo. Business logic lives in workspace **packages** (`commerce`, `ai`, `speech`,
`paypal`, `database`, `shared`, `config`). Three **apps** compose them:

- `apps/api` — the only process that owns business logic and the database.
- `apps/whatsapp` — a channel gateway process (holds the WhatsApp Web browser session).
- `apps/web` — the dashboard (talks to the API only).

The WhatsApp worker is a separate process not for "microservices" reasons but because a
headless Chromium session is heavy, stateful and crash-prone; it must not take the API down.

No queues, Redis or Kafka until there is a measured need.

## Consequences

- One deployable for core logic, one database, simple local dev.
- Package boundaries enforce separation of concerns; extracting a service later is a move, not a rewrite.
- Long-running work (ASR, LLM) currently runs inside the request; if latency becomes a problem,
  introduce a job queue then.
