#!/usr/bin/env bash
# Katale AI — restore a PostgreSQL backup (run from /opt/apps/katale-ai). DESTRUCTIVE for current data.
#   ./deployment/restore.sh backups/katale-....sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."
file="${1:?usage: restore.sh <backup.sql.gz>}"
read -r -p "Restore $file over the current database? Type RESTORE to continue: " answer
[[ "$answer" == "RESTORE" ]] || { echo "Aborted."; exit 1; }
./deployment/backup.sh pre-restore
docker compose stop api web whatsapp
gunzip -c "$file" | docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose up -d
echo "==> Restored $file"
