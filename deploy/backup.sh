#!/usr/bin/env bash
# Katale AI — PostgreSQL backup (run from /opt/apps/katale-ai).
#   ./deployment/backup.sh [label]     → backups/katale-<UTC timestamp>[-label].sql.gz[.age]
#
# Keeps the newest 14 local backups (override with KEEP=n). Restore: ./deployment/restore.sh,
# verify: ./deployment/restore-verify.sh. Guide: docs/deployment/backups-and-monitoring.md.
#
# Optional settings — read from the environment first, then from ./.env (only these keys are read;
# .env is never sourced):
#   BACKUP_AGE_RECIPIENT            age public key(s) (age1…; several separated by spaces or commas).
#                                   Set → the dump is encrypted to *.sql.gz.age and the plaintext removed.
#   BACKUP_RCLONE_REMOTE            rclone destination, e.g. b2:katale-backups or r2:katale-backups/prod.
#                                   Set → the backup is uploaded after it is written.
#   BACKUP_ALLOW_PLAINTEXT_OFFSITE  1 = allow uploading an unencrypted backup (default: refuse).
#   BACKUP_OFFSITE_KEEP_DAYS        delete off-site backups older than n days (default 30; 0 = never
#                                   delete, e.g. when the bucket has its own lifecycle rule).
#   BACKUP_SKIP_OFFSITE             1 = local backup only for this run (e.g. an urgent deploy while the
#                                   storage provider is down).
#   KEEP                            local backups to keep (default 14).
#
# Prints one summary line on success. Exits non-zero if any step fails (dump, encryption, upload or
# pruning); a failed run never leaves a partial backup file behind.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

started_at=$(date +%s)
backup_dir=backups

fail() {
  echo "==> Backup FAILED: $*" >&2
  exit 1
}

# Reads KEY from the environment, else from .env (last assignment wins; surrounding quotes and a
# trailing CR are stripped). Never evaluates the file.
setting() {
  local key="$1" default="${2:-}" value
  if [[ -n "${!key:-}" ]]; then
    printf '%s' "${!key}"
    return
  fi
  if [[ -r .env ]]; then
    value=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" .env | tail -n 1 | cut -d= -f2- || true)
    value="${value%$'\r'}"
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return
    fi
  fi
  printf '%s' "$default"
}

is_non_negative_int() { [[ "$1" =~ ^[0-9]+$ ]]; }

age_recipient=$(setting BACKUP_AGE_RECIPIENT)
rclone_remote=$(setting BACKUP_RCLONE_REMOTE)
allow_plaintext_offsite=$(setting BACKUP_ALLOW_PLAINTEXT_OFFSITE 0)
offsite_keep_days=$(setting BACKUP_OFFSITE_KEEP_DAYS 30)
skip_offsite=$(setting BACKUP_SKIP_OFFSITE 0)
keep="${KEEP:-14}"

is_non_negative_int "$keep" && ((keep >= 1)) || fail "KEEP must be a positive integer (got '$keep')"
is_non_negative_int "$offsite_keep_days" ||
  fail "BACKUP_OFFSITE_KEEP_DAYS must be a non-negative integer (got '$offsite_keep_days')"
[[ -z "$age_recipient" ]] || command -v age >/dev/null || fail "BACKUP_AGE_RECIPIENT is set but 'age' is not installed"
if [[ -n "$rclone_remote" && "$skip_offsite" != 1 ]]; then
  command -v rclone >/dev/null || fail "BACKUP_RCLONE_REMOTE is set but 'rclone' is not installed"
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

# One backup at a time (nightly cron vs. a deploy's pre-deploy backup).
if command -v flock >/dev/null; then
  exec 9>"$backup_dir/.backup.lock"
  flock -w 900 9 || fail "another backup is still running (lock: $backup_dir/.backup.lock)"
fi

label="${1:+-$1}"
file="$backup_dir/katale-$(date -u +%Y%m%dT%H%M%SZ)${label}.sql.gz"
partial="$file.partial"
encrypted_partial="$file.age.partial"
cleanup() { rm -f -- "$partial" "$encrypted_partial"; }
trap cleanup EXIT

# 1. Dump (gzip -t catches a truncated stream before the file is accepted).
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists' |
  gzip >"$partial" || fail "pg_dump failed"
gzip -t "$partial" || fail "gzip integrity check failed"
mv -- "$partial" "$file"
chmod 600 "$file"

# 2. Encrypt (optional).
encrypted=no
if [[ -n "$age_recipient" ]]; then
  read -r -a recipients <<<"${age_recipient//,/ }"
  age_args=()
  for recipient in "${recipients[@]}"; do
    age_args+=(-r "$recipient")
  done
  age "${age_args[@]}" -o "$encrypted_partial" "$file" || fail "age encryption failed (plaintext kept: $file)"
  mv -- "$encrypted_partial" "$file.age"
  chmod 600 "$file.age"
  rm -f -- "$file"
  file="$file.age"
  encrypted=yes
fi
size=$(du -h "$file" | cut -f1)

# 3. Upload + off-site retention (optional).
offsite=none
if [[ -n "$rclone_remote" && "$skip_offsite" == 1 ]]; then
  offsite=skipped
elif [[ -n "$rclone_remote" ]]; then
  if [[ "$encrypted" != yes && "$allow_plaintext_offsite" != 1 ]]; then
    fail "refusing to upload an unencrypted backup to $rclone_remote (set BACKUP_AGE_RECIPIENT, or BACKUP_ALLOW_PLAINTEXT_OFFSITE=1); local copy kept: $file"
  fi
  remote="${rclone_remote%/}"
  rclone copy --no-traverse --retries 3 --low-level-retries 10 "$file" "$remote/" ||
    fail "upload to $remote failed (local copy kept: $file)"
  offsite="$remote"
  if ((offsite_keep_days > 0)); then
    rclone delete --min-age "${offsite_keep_days}d" --include 'katale-*.sql.gz*' "$remote" ||
      fail "off-site pruning on $remote failed (backup itself was uploaded)"
    offsite="$remote (kept ${offsite_keep_days}d)"
  fi
fi

# 4. Local retention: newest $keep backups (plain and encrypted together).
shopt -s nullglob
existing=("$backup_dir"/katale-*.sql.gz "$backup_dir"/katale-*.sql.gz.age)
shopt -u nullglob
old_backups=()
if ((${#existing[@]} > keep)); then
  while IFS= read -r old; do old_backups+=("$old"); done < <(ls -1t -- "${existing[@]}" | tail -n +"$((keep + 1))")
fi
if ((${#old_backups[@]} > 0)); then
  rm -f -- "${old_backups[@]}"
fi

echo "==> Backup written: $file ($size) encrypted=$encrypted offsite=$offsite local_pruned=${#old_backups[@]} keep=$keep duration=$(($(date +%s) - started_at))s"
