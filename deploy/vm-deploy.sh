#!/usr/bin/env bash
# Katale AI — deploy / update / rollback on the VM (run from /opt/apps/katale-ai).
#
#   ./deployment/vm-deploy.sh                 # deploy the KATALE_TAG currently in .env
#   ./deployment/vm-deploy.sh v0.1.0-2026…    # set KATALE_TAG in .env first (update or rollback)
#
# Steps: pull images → start Postgres → back up the database → run migrations → start services.
# Stops on the first error; a failed migration leaves the running services untouched.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -ge 1 ]]; then
  sed -i "s/^KATALE_TAG=.*/KATALE_TAG=$1/" .env
fi
TAG="$(grep -E '^KATALE_TAG=' .env | cut -d= -f2-)"
echo "==> Deploying Katale AI $TAG"

docker compose pull
docker compose up -d postgres
docker compose exec -T postgres sh -c 'until pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"; do sleep 1; done'

./deployment/backup.sh pre-deploy

echo "==> Running migrations (prisma migrate deploy — never resets data)"
docker compose run --rm --no-deps api katale-migrate

docker compose up -d --remove-orphans

# Nginx Proxy Manager resolves katale-api when it loads its config; recreated containers can get new
# IPs. Reload (config unchanged) so it re-resolves — otherwise /api/paypal/* can return 502.
NPM_CONTAINER="${NPM_CONTAINER:-nginx-proxy-manager-app-1}"
if docker ps --format '{{.Names}}' | grep -qx "$NPM_CONTAINER"; then
  docker exec "$NPM_CONTAINER" nginx -t >/dev/null 2>&1 && docker exec "$NPM_CONTAINER" nginx -s reload \
    && echo "==> Reloaded $NPM_CONTAINER"
fi
docker compose ps
echo "==> Deployed $TAG"
