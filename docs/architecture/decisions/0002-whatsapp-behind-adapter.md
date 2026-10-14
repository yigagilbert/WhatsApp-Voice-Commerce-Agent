# 0002 — Isolate `whatsapp-web.js` behind an adapter in its own process

**Status:** Accepted · 2026-10-05

## Context

`whatsapp-web.js` automates WhatsApp Web through Puppeteer. It is unofficial, can break when
WhatsApp changes, and may violate WhatsApp's terms for some uses. The product must eventually
run on the official WhatsApp Cloud API and on other channels (web chat, Telegram, mobile).

## Decision

- Only `apps/whatsapp/src/whatsapp-adapter.ts` imports `whatsapp-web.js`. It exposes a tiny
  `WhatsAppTransport` interface (`start`, `onMessage`, `sendText`, `isReady`).
- The worker maps native messages to the channel-agnostic `InboundChannelMessage`
  (`@vca/shared`) and forwards them to `POST /api/agent/message`. It contains no business logic.
- Outbound proactive messages go API → worker via an internal, token-protected HTTP gateway.
- Event handlers never call PayPal, the database or the LLM.

## Consequences

- Swapping to the Cloud API means: a webhook route that produces the same `InboundChannelMessage`,
  and a `ChannelSender` that calls Graph API. The core is untouched.
- Adding a channel = one adapter + one `ChannelSender`.
- There is one extra network hop, which is negligible compared to ASR/LLM latency.
