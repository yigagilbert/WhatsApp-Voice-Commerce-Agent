#!/usr/bin/env bash
# Katale AI — PostgreSQL backup (run from /opt/apps/katale-ai).
#   ./deployment/backup.sh [label]     → backups/katale-<UTC timestamp>[-label].sql.gz
# Keeps the newest 14 backups (override with KEEP=n). Restore: see docs/deployment/docker-hub-vm.md.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
chmod 700 backups
label="${1:+-$1}"
file="backups/katale-$(date -u +%Y%m%dT%H%M%SZ)${label}.sql.gz"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists' | gzip > "$file"
chmod 600 "$file"
echo "==> Backup written: $file ($(du -h "$file" | cut -f1))"
ls -1t backups/katale-*.sql.gz | tail -n +"$(( ${KEEP:-14} + 1 ))" | xargs -r rm --
