#!/usr/bin/env bash
# Local API for the Sandbox E2E run: PayPal Sandbox + LLM keys read from E2E_ENV_FILE (default: the
# repo's .env; the file is never sourced or printed), everything else local and disposable.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
env_file="${E2E_ENV_FILE:-$repo/.env}"
cd "$repo"
for key in PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET AI_API_KEY AI_BASE_URL AI_MODEL; do
  value=$(grep -E "^${key}=" "$env_file" | tail -n 1 | cut -d= -f2- || true)
  export "${key}=${value}"
done
export DATABASE_URL="${E2E_DATABASE_URL:-postgresql://vca:vca@localhost:55496/vca?schema=public}"
export NODE_ENV=development LOG_LEVEL=info API_PORT=4011 API_PUBLIC_URL=http://localhost:4011
export API_AUTH_TOKEN=e2e-dashboard-token-1234567 INTERNAL_SERVICE_TOKEN=e2e-internal-token-1234567
export CORS_ORIGINS=http://localhost:3011 TRUST_PROXY=false
# Locally PayPal can't reach us: webhook bodies are posted by the script (signature check off, dev only).
export PAYPAL_ENV=sandbox PAYPAL_WEBHOOK_SKIP_VERIFICATION=true PAYPAL_WEBHOOK_ID=
export REPORT_SCHEDULER_ENABLED=true PAYMENT_RECONCILIATION_ENABLED=true UNPAID_ORDER_EXPIRY_HOURS=72
export CUSTOMER_COMMERCE_ENABLED=true CUSTOMER_MESSAGES_PER_MINUTE=1000
export WHATSAPP_GATEWAY_URL=http://127.0.0.1:4998 VOICE_NOTES_ENABLED=false
export ALERT_WEBHOOK_URL=http://127.0.0.1:4999/alerts HEARTBEAT_URL=http://127.0.0.1:4999/heartbeat
exec node apps/api/dist/index.js
