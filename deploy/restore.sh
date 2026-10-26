#!/usr/bin/env bash
# Katale AI — restore a PostgreSQL backup (run from /opt/apps/katale-ai). DESTRUCTIVE for current data.
#   ./deployment/restore.sh backups/katale-....sql.gz
#   BACKUP_AGE_IDENTITY_FILE=/path/to/key.txt ./deployment/restore.sh backups/katale-....sql.gz.age
# Takes a pre-restore backup first. Rehearse with ./deployment/restore-verify.sh <file> before
# restoring over production. Guide: docs/deployment/backups-and-monitoring.md.
set -euo pipefail
file="${1:?usage: restore.sh <backup.sql.gz | backup.sql.gz.age>}"
[[ "$file" = /* ]] || file="$PWD/$file"
cd "$(dirname "$0")/.."
[[ -r "$file" ]] || { echo "Cannot read $file" >&2; exit 1; }

if [[ "$file" == *.age ]]; then
  identity="${BACKUP_AGE_IDENTITY_FILE:?set BACKUP_AGE_IDENTITY_FILE to the age private key file to decrypt $file}"
  command -v age >/dev/null || { echo "'age' is not installed" >&2; exit 1; }
  # Fail before anything is stopped if the key does not match this file.
  age -d -i "$identity" "$file" | gzip -t || { echo "Cannot decrypt/verify $file with $identity" >&2; exit 1; }
  decompress() { age -d -i "$identity" "$file" | gunzip -c; }
else
  gzip -t "$file" || { echo "$file is not a valid gzip file" >&2; exit 1; }
  decompress() { gunzip -c "$file"; }
fi

read -r -p "Restore $file over the current database? Type RESTORE to continue: " answer
[[ "$answer" == "RESTORE" ]] || { echo "Aborted."; exit 1; }
# Local-only safety copy: the restore should not depend on the off-site storage being reachable.
BACKUP_SKIP_OFFSITE=1 ./deployment/backup.sh pre-restore
docker compose stop api web whatsapp
decompress | docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose up -d
echo "==> Restored $file"
