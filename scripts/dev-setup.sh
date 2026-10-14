#!/usr/bin/env bash
# One-shot local setup: .env with fresh service tokens, Postgres, migrations, seed data.
# Safe to re-run. Usage: ./scripts/dev-setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  cp .env.example .env
  gen() { node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; }
  # Replace placeholder tokens with random values (macOS and GNU sed compatible).
  sed -i.bak "s/^API_AUTH_TOKEN=.*/API_AUTH_TOKEN=$(gen)/; s/^INTERNAL_SERVICE_TOKEN=.*/INTERNAL_SERVICE_TOKEN=$(gen)/" .env
  rm -f .env.bak
  echo "✔ Created .env with generated service tokens"
else
  echo "• .env already exists — leaving it untouched"
fi

pnpm install

if docker info >/dev/null 2>&1; then
  docker compose up -d --wait postgres
  echo "✔ Postgres running on localhost:5433"
else
  echo "! Docker is not running. Start Docker, or point DATABASE_URL at your own Postgres, then re-run."
  exit 1
fi

pnpm db:deploy
pnpm db:seed
echo
echo "Done. Next:"
echo "  pnpm dev             # API on :4000 + dashboard on :3000"
echo "  pnpm dev:whatsapp    # WhatsApp worker (scan the QR code)"
