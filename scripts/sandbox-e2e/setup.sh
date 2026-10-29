#!/usr/bin/env bash
# Disposable database for the Sandbox E2E run: migrate, seed, shop number, admin, UGX fixture.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/../.."
pg="${E2E_PG_CONTAINER:-katale-e2e-pg}"
docker rm -f "$pg" >/dev/null 2>&1 || true
docker run -d --rm --name "$pg" -e POSTGRES_USER=vca -e POSTGRES_PASSWORD=vca -e POSTGRES_DB=vca \
  -p 127.0.0.1:55496:5432 postgres:16-alpine >/dev/null
until docker exec "$pg" pg_isready -q -U vca; do sleep 1; done
export DATABASE_URL='postgresql://vca:vca@localhost:55496/vca?schema=public'
pnpm -s db:deploy >/dev/null
pnpm -s db:seed >/dev/null
docker exec -i "$pg" psql -q -U vca -d vca -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO whatsapp_accounts (id, "merchantId", wid, "customerCommerceEnabled", "deliveryEnabled", "pickupEnabled", "pickupInfo", "updatedAt")
VALUES ('wa_e2e', 'seed_merchant_kampala_crafts', '256700000999@c.us', true, false, true, 'Shop 4, Kampala Road', now());
INSERT INTO merchant_operators (id, "merchantId", name, channel, "externalId", phone, role, "updatedAt")
VALUES ('op_e2e', 'seed_merchant_kampala_crafts', 'Owner E2E', 'whatsapp', '256711000001@c.us', '+256711000001', 'OWNER', now());
INSERT INTO merchants (id, "businessName", "ownerName", "preferredCurrency", "updatedAt") VALUES ('ugx_e2e', 'Kampala UGX Shop', 'Kato', 'UGX', now());
INSERT INTO customers (id, "merchantId", name, "updatedAt") VALUES ('ugx_c', 'ugx_e2e', 'Nakato', now());
INSERT INTO orders (id, reference, "merchantId", "customerId", status, currency, "subtotalMinor", "totalMinor", source, "updatedAt")
VALUES ('ugx_o', 'ORD-UGX001', 'ugx_e2e', 'ugx_c', 'PAID', 'UGX', 50000, 50000, 'whatsapp', now());
INSERT INTO payments (id, "merchantId", "orderId", provider, kind, status, "amountMinor", currency, "idempotencyKey", "updatedAt", "completedAt")
VALUES ('ugx_p', 'ugx_e2e', 'ugx_o', 'PAYPAL', 'CHECKOUT_ORDER', 'COMPLETED', 50000, 'UGX', 'ugx-k', now(), now());
SQL
rm -f "$here/events.jsonl" "$here/results.json"
echo "E2E database ready ($pg on 127.0.0.1:55496)"
