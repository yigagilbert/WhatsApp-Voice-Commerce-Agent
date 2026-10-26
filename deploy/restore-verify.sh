#!/usr/bin/env bash
# Katale AI — prove a backup restores. Never touches the production database: the dump is loaded
# into a throwaway postgres:16-alpine container on its own internal Docker network, checked, and
# removed (with its anonymous data volume) on exit.
#
#   ./deployment/restore-verify.sh                 newest local backup in backups/
#   ./deployment/restore-verify.sh <file>          a given .sql.gz or .sql.gz.age file
#   ./deployment/restore-verify.sh --offsite       newest backup in BACKUP_RCLONE_REMOTE (downloaded
#                                                  to a temp dir; proves the off-site copy restores)
#   ./deployment/restore-verify.sh --fresh         stream a new read-only pg_dump of the running
#                                                  database (for the weekly on-VM check when backups
#                                                  are encrypted to a key that is not on the VM)
#
# .age files need BACKUP_AGE_IDENTITY_FILE (age private key file). Settings are read from the
# environment, then from ./.env (BACKUP_RCLONE_REMOTE, BACKUP_AGE_IDENTITY_FILE only; never sourced).
# Works on the VM and on a workstation with Docker (bash 3.2+). Exits non-zero if the restore fails or
# a core table (VERIFY_REQUIRED_TABLES, default "merchants orders payments products") is empty.
set -euo pipefail
umask 077

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; }
fail() {
  echo "==> Restore verification FAILED: $*" >&2
  exit 1
}

mode=file
file=
case "${1:-}" in
  -h | --help) usage; exit 0 ;;
  --offsite) mode=offsite ;;
  --fresh) mode=fresh ;;
  '') mode=newest ;;
  -*) usage >&2; exit 2 ;;
  *)
    file="$1"
    [[ "$file" = /* ]] || file="$PWD/$file"
    ;;
esac

cd "$(dirname "$0")/.."

setting() {
  local key="$1" value
  if [[ -n "${!key:-}" ]]; then
    printf '%s' "${!key}"
    return
  fi
  [[ -r .env ]] || return 0
  value=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" .env | tail -n 1 | cut -d= -f2- || true)
  value="${value%$'\r'}"
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

image="${VERIFY_IMAGE:-postgres:16-alpine}"
read -r -a required_tables <<<"${VERIFY_REQUIRED_TABLES:-merchants orders payments products}"
suffix="$(date -u +%Y%m%d%H%M%S)-$$"
container="katale-restore-verify-$suffix"
network="katale-restore-verify-$suffix"
workdir=$(mktemp -d "${TMPDIR:-/tmp}/katale-restore-verify.XXXXXX")
started_at=$(date +%s)

cleanup() {
  docker rm -f -v "$container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf -- "$workdir"
}
trap cleanup EXIT

command -v docker >/dev/null || fail "docker is not installed"

# --- pick the source --------------------------------------------------------------------------
case "$mode" in
  newest)
    file=$(ls -1t backups/katale-*.sql.gz backups/katale-*.sql.gz.age 2>/dev/null | head -n 1 || true)
    [[ -n "$file" ]] || fail "no backups found in $PWD/backups"
    file="$PWD/$file"
    ;;
  offsite)
    remote=$(setting BACKUP_RCLONE_REMOTE)
    [[ -n "$remote" ]] || fail "BACKUP_RCLONE_REMOTE is not set"
    command -v rclone >/dev/null || fail "rclone is not installed"
    remote="${remote%/}"
    # lsf --format tp → "<modtime>;<name>"; ISO timestamps sort lexically.
    newest=$(rclone lsf --files-only --format tp --include 'katale-*.sql.gz*' "$remote" |
      sort -r | head -n 1 | cut -d';' -f2-)
    [[ -n "$newest" ]] || fail "no backups found in $remote"
    rclone copyto "$remote/$newest" "$workdir/$newest" || fail "download of $remote/$newest failed"
    file="$workdir/$newest"
    ;;
esac

if [[ "$mode" != fresh ]]; then
  [[ -r "$file" ]] || fail "cannot read $file"
  case "$file" in
    *.sql.gz.age)
      identity=$(setting BACKUP_AGE_IDENTITY_FILE)
      [[ -n "$identity" ]] || fail "$file is encrypted: set BACKUP_AGE_IDENTITY_FILE (or use --fresh on the VM)"
      [[ -r "$identity" ]] || fail "cannot read age identity file $identity"
      command -v age >/dev/null || fail "age is not installed"
      ;;
    *.sql.gz) ;;
    *) fail "unsupported file type: $file (expected .sql.gz or .sql.gz.age)" ;;
  esac
fi

produce_sql() {
  case "$mode" in
    fresh)
      docker compose exec -T postgres sh -c \
        'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists'
      ;;
    *)
      if [[ "$file" == *.age ]]; then
        age -d -i "$identity" "$file" | gunzip -c
      else
        gunzip -c "$file"
      fi
      ;;
  esac
}

# --- throwaway database -------------------------------------------------------------------------
docker network create --internal "$network" >/dev/null
docker run -d --name "$container" --network "$network" \
  --label katale.restore-verify=true \
  -e POSTGRES_USER=verify -e POSTGRES_DB=verify -e POSTGRES_PASSWORD="verify-$suffix" \
  "$image" >/dev/null

ready=no
for _ in $(seq 1 60); do
  # pg_isready via the unix socket succeeds briefly during initdb's temporary server; require the
  # final server (listening on TCP) before loading.
  if docker exec "$container" pg_isready -q -h 127.0.0.1 -U verify -d verify 2>/dev/null; then
    ready=yes
    break
  fi
  sleep 1
done
[[ "$ready" == yes ]] || fail "scratch postgres did not become ready (docker logs $container)"

psql_scratch() {
  docker exec -i -e PGOPTIONS='-c client_min_messages=warning' "$container" \
    psql -X -v ON_ERROR_STOP=1 -U verify -d verify "$@"
}

source_label="${file:-fresh pg_dump of the running database}"
produce_sql | psql_scratch -q >/dev/null || fail "restore of $source_label failed"

# --- sanity queries -----------------------------------------------------------------------------
query() { psql_scratch -At -c "$1"; }

report=""
empty=""
for table in "${required_tables[@]}"; do
  [[ "$table" =~ ^[a-z_]+$ ]] || fail "invalid table name in VERIFY_REQUIRED_TABLES: $table"
  count=$(query "SELECT count(*) FROM \"$table\"") || fail "table $table is missing"
  report+=$(printf '\n  %-22s %s' "$table" "$count")
  [[ "$count" != 0 ]] || empty+=" $table"
done
latest_order=$(query 'SELECT coalesce(max("createdAt")::text, '\''-'\'') FROM orders' || echo '?')
migrations=$(query 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' || echo '?')
latest_migration=$(query 'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1' || echo '?')
db_size=$(query "SELECT pg_size_pretty(pg_database_size('verify'))" || echo '?')

cat <<EOF
==> Restore verification report
  source                 $source_label
  restored into          $container ($image, network $network — removed on exit)
  database size          $db_size
  applied migrations     $migrations (latest: $latest_migration)
  latest order createdAt $latest_order
  row counts:$report
  duration               $(($(date +%s) - started_at))s
EOF

[[ -z "$empty" ]] || fail "core table(s) empty:$empty"
echo "==> Restore verification OK"
