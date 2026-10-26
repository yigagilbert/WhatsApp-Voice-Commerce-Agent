# Sandbox end-to-end run

Full journeys against a **local** API wired to **real PayPal Sandbox** and the real LLM, with WhatsApp
simulated at the worker boundary. Never touches production; no real money moves.

```bash
pnpm --filter @vca/api build
scripts/sandbox-e2e/setup.sh                 # disposable Postgres (Docker), migrated + seeded
node scripts/sandbox-e2e/catcher.mjs &       # stand-in WhatsApp gateway + alert/heartbeat endpoints
scripts/sandbox-e2e/run-api.sh &             # API on :4011 (keys read from .env, never printed)
node scripts/sandbox-e2e/e2e.mjs             # prints PASS / FAIL / BLOCKED per check; results.json
```

Scenarios: customer order → Sandbox payment → partial/full refund; customer cancel on WhatsApp (and
paying the cancelled link takes no money); approval racing cancellation; unpaid-order expiry by the
scheduler; WhatsApp admin assistant with the real LLM; USD/UGX dashboard figures; dashboard accounts,
roles and revocation; heartbeat and operator alerts.

Buyers approve with PayPal's published Sandbox test card (`confirm-payment-source`). If the Sandbox
seller isn't enabled for card processing, PayPal refuses the capture
(`PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING`): those steps are reported **BLOCKED** and need a Sandbox
buyer to approve the link in a browser instead. Webhooks can't reach a local API, so refund webhooks
are posted by the script using the real refund resource read back from PayPal (signature
verification is skipped in development only).
