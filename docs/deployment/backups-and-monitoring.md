# Backups, restore drills and monitoring

Runbook for audit item P0-4 ([audit](../audits/2026-10-25-katale-ai-system-audit.md#p0-4-backups-monitoring-and-recovery)).
Nothing here has been applied to production yet: every production change is listed in
[Approval needed](#approval-needed-production-changes-and-rollback) with its rollback.

Placeholders: `<VM_HOST>`, `<DEPLOY_USER>`, `<DOMAIN>`, `<BUCKET>`, `<NTFY_TOPIC>`,
`<HEALTHCHECKS_PING_URL_*>`. Commands run in `/opt/apps/katale-ai` on the VM unless marked
**(laptop)**.

## Summary

| Need                  | Choice                                                                                          | Cost                               |
| --------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------- |
| Scheduled backups     | `cron` → [`deploy/backup.sh`](../../deploy/backup.sh) nightly at 02:30                          | free                               |
| Encryption            | [`age`](https://age-encryption.org) to a public key; private key **off the VM**                 | free                               |
| Off-site copy         | [`rclone`](https://rclone.org) to Backblaze B2, Cloudflare R2, or an existing Google Drive      | free tier (a nightly dump is ~MBs) |
| Retention             | 14 local dumps (`KEEP`), 30 days off-site (`BACKUP_OFFSITE_KEEP_DAYS`)                          | —                                  |
| Restore proof         | [`deploy/restore-verify.sh`](../../deploy/restore-verify.sh) weekly (cron) + monthly drill      | free                               |
| External uptime       | Hosted checker on `https://<DOMAIN>/api/health`                                                 | free tier                          |
| Internal checks       | Optional Uptime Kuma ([`deploy/uptime-kuma.compose.yml`](../../deploy/uptime-kuma.compose.yml)) | free (self-hosted)                 |
| App alerts / dead-man | API `ALERT_WEBHOOK_URL` → ntfy; `HEARTBEAT_URL` → healthchecks.io                               | free                               |
| Cron job dead-man     | healthchecks.io pings from the cron lines                                                       | free                               |

### Why age + rclone

- **No new paid service and no agent on the VM.** Both are single static binaries in Ubuntu's
  package archive. `rclone` speaks to almost any storage, so the provider can change later without
  touching the scripts (only `BACKUP_RCLONE_REMOTE` changes).
- **Provider options (check current free-tier limits before choosing):** Backblaze B2 (10 GB free,
  supports application keys without delete rights and lifecycle rules), Cloudflare R2 (10 GB/month
  free, no egress fees, lifecycle rules), or a Google Drive the business already has (no new
  account; OAuth token on the VM).
- **age, not GPG:** one recipient line, no keyring, no expiry surprises. Backups are encrypted to a
  **public** key; the matching private key is kept in the team password manager (plus an offline
  copy). A compromised VM — or a leaked storage key — cannot read the off-site backups. The VM
  holds the live database anyway, so the key protects the _history_ held elsewhere.
- **Trade-off:** the VM cannot decrypt its own backups, so the weekly on-VM check restores a fresh
  dump (`restore-verify.sh --fresh`, same `pg_dump` command as the backup), and the encrypted
  off-site files are proven by the [monthly drill](#monthly-restore-drill) on a trusted machine.

## Setup

### 1. Keys (laptop, once)

```bash
# (laptop) macOS: brew install age · Ubuntu: sudo apt install age
age-keygen -o katale-backup-age.key        # prints "Public key: age1…"
```

- Save the **whole file** (`AGE-SECRET-KEY-1…` line) in the password manager as a secure note
  named _Katale backup age key_; keep a second offline copy (encrypted USB or printed, in a safe).
  Then delete the local file (`rm -P` on macOS, `shred -u` on Linux) or keep it only on an encrypted disk.
- The **public key** (`age1…`) is not secret; it goes into the VM `.env` as `BACKUP_AGE_RECIPIENT`.
- Optional second recipient (a second person's key) for key-loss resilience:
  `BACKUP_AGE_RECIPIENT="age1aaa… age1bbb…"`. Either private key then decrypts.
- Also store a copy of the production **`.env`** in the password manager. Backups contain the
  database only; without `.env` (PayPal, OpenAI, tokens) a rebuilt VM cannot start.

### 2. Storage bucket and a scoped credential

Create a **private** bucket `<BUCKET>` and a credential limited to it.

| Provider      | Recommended credential                                                                                  | Retention                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Backblaze B2  | Application key restricted to `<BUCKET>` with `listFiles, readFiles, writeFiles` (**no `deleteFiles`**) | Bucket lifecycle rule: hide after 30 days, delete 1 day after hiding; set `BACKUP_OFFSITE_KEEP_DAYS=0`       |
| Cloudflare R2 | API token "Object Read & Write" scoped to `<BUCKET>` (R2 tokens cannot exclude delete)                  | Either `BACKUP_OFFSITE_KEEP_DAYS=30` (rclone prunes) or an R2 lifecycle rule "delete after 30 days" and `=0` |
| Google Drive  | rclone OAuth (`scope = drive.file`, a dedicated folder)                                                 | `BACKUP_OFFSITE_KEEP_DAYS=30` (rclone prunes; Drive keeps deleted files in its trash for 30 days)            |

**Prefer the no-delete key + lifecycle rule (B2).** If the VM is compromised, the attacker holds
the storage credential; without delete rights they cannot wipe the history (B2 keeps earlier
versions until the lifecycle rule removes them). With a delete-capable key, `backup.sh` prunes via
`rclone delete --min-age 30d`, which only removes files matching `katale-*.sql.gz*`.

### 3. VM packages and rclone remote

```bash
sudo apt-get update && sudo apt-get install -y age rclone
rclone version        # R2 needs the "Cloudflare" S3 provider: rclone ≥ 1.59
```

If the archive's rclone is too old, install the `.deb` from rclone.org after verifying its
`SHA256SUMS`. Create `~/.config/rclone/rclone.conf` for `<DEPLOY_USER>` (`chmod 600`), with only
the section you use:

```ini
[b2]
type = b2
account = <B2_KEY_ID>
key = <B2_APPLICATION_KEY>
hard_delete = false

[r2]
type = s3
provider = Cloudflare
access_key_id = <R2_ACCESS_KEY_ID>
secret_access_key = <R2_SECRET_ACCESS_KEY>
endpoint = https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
```

Google Drive: run `rclone authorize "drive"` **(laptop, has a browser)** and paste the token into
`rclone config` on the VM (`scope = drive.file`, `root_folder_id = <FOLDER_ID>`).

Test (no backup is written): `rclone lsf b2:<BUCKET>` and `echo ok | rclone rcat b2:<BUCKET>/rclone-test.txt`
(then remove it in the provider console if the key has no delete right).

### 4. Backup settings in `.env`

`backup.sh` reads only these keys from `.env` with `grep` (it never `source`s the file); real
environment variables win.

```dotenv
BACKUP_AGE_RECIPIENT=age1<public key>
BACKUP_RCLONE_REMOTE=b2:<BUCKET>/prod
BACKUP_OFFSITE_KEEP_DAYS=0          # 0 = bucket lifecycle rule handles retention; 30 = rclone prunes
# BACKUP_ALLOW_PLAINTEXT_OFFSITE=1  # never set this in production
```

| Variable                         | Default | Effect                                                                                       |
| -------------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `BACKUP_AGE_RECIPIENT`           | unset   | Encrypt to `*.sql.gz.age` and delete the plaintext dump                                      |
| `BACKUP_RCLONE_REMOTE`           | unset   | Upload each backup; unset = local only (previous behaviour)                                  |
| `BACKUP_ALLOW_PLAINTEXT_OFFSITE` | `0`     | Without encryption, the upload is **refused** and the run fails (the local copy is kept)     |
| `BACKUP_OFFSITE_KEEP_DAYS`       | `30`    | `rclone delete --min-age <n>d` on the remote after each upload; `0` disables                 |
| `BACKUP_SKIP_OFFSITE`            | `0`     | `1` = local only for this run, e.g. `BACKUP_SKIP_OFFSITE=1 ./deployment/vm-deploy.sh <tag>`  |
| `KEEP`                           | `14`    | Local dumps kept (plain and encrypted counted together; includes `pre-deploy`/`pre-restore`) |

Behaviour: one summary line per run
(`==> Backup written: backups/katale-…-nightly.sql.gz.age (1.2M) encrypted=yes offsite=b2:… local_pruned=1 …`);
exit status non-zero on any failure (dump, gzip check, encryption, upload, pruning); no partial
files are left behind; a lock prevents the nightly run and a deploy's backup overlapping.

> `vm-deploy.sh` calls `backup.sh pre-deploy`, so once `BACKUP_RCLONE_REMOTE` is set **each deploy
> also uploads**, and a failed upload stops the deploy _before_ migrations. In an emergency, deploy
> with `BACKUP_SKIP_OFFSITE=1`. `restore.sh` always takes its safety backup local-only.

### 5. Scripts, cron and log rotation

```bash
# (laptop) copy the scripts — same layout as the other deployment files
scp deploy/backup.sh deploy/restore.sh deploy/restore-verify.sh <DEPLOY_USER>@<VM_HOST>:/opt/apps/katale-ai/deployment/
scp -r deploy/cron <DEPLOY_USER>@<VM_HOST>:/opt/apps/katale-ai/deployment/
```

```bash
# VM: dry run first, then install the cron file
./deployment/backup.sh manual && ls -l backups | tail -3 && rclone lsl b2:<BUCKET>/prod
./deployment/restore-verify.sh --fresh
sudoedit /opt/apps/katale-ai/deployment/cron/katale-ai.cron   # replace <DEPLOY_USER> and ping URLs
sudo install -o root -g root -m 644 deployment/cron/katale-ai.cron /etc/cron.d/katale-ai
sudo install -o <DEPLOY_USER> -g <DEPLOY_USER> -m 640 /dev/null /var/log/katale-backup.log
```

The cron file ([`deploy/cron/katale-ai.cron`](../../deploy/cron/katale-ai.cron)) runs the nightly
backup at **02:30** VM time and `restore-verify.sh --fresh` on **Sundays at 04:15**, appends to
`/var/log/katale-backup.log`, and pings healthchecks.io on success or `/fail` on failure. File
names in `/etc/cron.d` must not contain a dot, hence `katale-ai`. Log rotation:

```bash
sudo tee /etc/logrotate.d/katale-backup >/dev/null <<'EOF'
/var/log/katale-backup.log {
  monthly
  rotate 12
  compress
  missingok
  notifempty
  create 640 <DEPLOY_USER> <DEPLOY_USER>
}
EOF
```

## Restore

All restores take [`restore.sh`](../../deploy/restore.sh)'s safety path: confirm by typing
`RESTORE`, a local `pre-restore` backup, stop `api web whatsapp`, load with `ON_ERROR_STOP`, start.
If the load fails, the script stops with the app services **stopped**; restore the `pre-restore`
file the same way.

### A. Prove a backup restores (non-destructive)

```bash
./deployment/restore-verify.sh                   # newest local backup
./deployment/restore-verify.sh backups/<file>    # a given file
./deployment/restore-verify.sh --fresh           # fresh dump of the running database
# (laptop, with Docker, rclone config and the age key):
BACKUP_RCLONE_REMOTE=b2:<BUCKET>/prod BACKUP_AGE_IDENTITY_FILE=~/katale-backup-age.key \
  ./deploy/restore-verify.sh --offsite
```

The scratch database is a `postgres:16-alpine` container on its own `--internal` Docker network;
the production database is never written. The report shows row counts for `merchants`, `orders`,
`payments`, `products`, the latest order `createdAt`, and the applied Prisma migrations. Exit
non-zero if the restore fails or a core table is empty (`VERIFY_REQUIRED_TABLES` overrides the list).

### B. Restore into production (data mistake, bad migration)

1. Announce downtime; note the current `KATALE_TAG` (`grep KATALE_TAG .env`).
2. Pick the backup: the newest before the incident (`ls -lt backups`), or `pre-deploy` for a
   failed release.
3. **Rehearse it:** `./deployment/restore-verify.sh backups/<file>` (or with the key on the laptop
   for an `.age` file) and check the latest order date is what you expect.
4. Schema match: the dump recreates the tables it contains but does not drop tables added by later
   migrations. Restore with the image tag the backup was taken with (roll back `KATALE_TAG` first
   with `./deployment/vm-deploy.sh <tag>`), or, after step 5's safety backup, empty the schema:
   `docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"'`.
5. Restore:
   - Plain file: `./deployment/restore.sh backups/<file>.sql.gz`
   - Encrypted file — **keep the private key off the VM**: decrypt on the laptop and copy the
     plaintext over SSH, then remove it after the restore:

     ```bash
     # (laptop)
     rclone copy b2:<BUCKET>/prod/<file>.sql.gz.age .     # or scp it from the VM's backups/
     age -d -i ~/katale-backup-age.key -o <file>.sql.gz <file>.sql.gz.age
     scp <file>.sql.gz <DEPLOY_USER>@<VM_HOST>:/opt/apps/katale-ai/backups/
     # VM
     ./deployment/restore.sh backups/<file>.sql.gz && rm backups/<file>.sql.gz
     ```

     (`restore.sh` also accepts `.age` with `BACKUP_AGE_IDENTITY_FILE=…` for use on a trusted machine.)

6. Check: `docker compose ps`, dashboard login, `/api/health`, latest orders; then
   `./deployment/backup.sh post-restore`.
7. PayPal: payments captured after the backup time exist at PayPal but not in the database.
   Reconcile from the PayPal dashboard (the 6-hourly reconciler only re-checks payments it knows).

### C. Disaster recovery (VM lost)

1. New Ubuntu VM: Docker, then [server hardening](server-hardening.md) before exposing it.
2. Follow [First-time setup](docker-hub-vm.md#first-time-setup) with the `.env` from the password
   manager and the same `KATALE_TAG` as the backup; `vm-deploy.sh` creates an empty schema.
3. Get the newest off-site backup on the laptop, rehearse it with `restore-verify.sh`, decrypt,
   copy, and run `restore.sh` as in B.5.
4. Re-link WhatsApp (sessions are not backed up: dashboard → WhatsApp → scan QR), recreate the NPM
   proxy host and certificate, point DNS at the new VM, and re-register the PayPal webhook if the
   URL changed.

## Monthly restore drill

First working day of the month, from a trusted laptop (≈15 minutes). Record the result in the ops log.

- [ ] Off-site listing shows one backup per night for the retention window: `rclone lsl b2:<BUCKET>/prod`
- [ ] Newest off-site backup is < 26 h old
- [ ] `restore-verify.sh --offsite` with the age key from the password manager succeeds
- [ ] Row counts and latest order date are plausible (compare with the dashboard)
- [ ] `/var/log/katale-backup.log` shows no failures; the weekly verify ran (`grep restore-verify`)
- [ ] healthchecks.io: backup, verify and API heartbeat checks are green; a test alert reached ntfy
- [ ] Local disk: `df -h /opt/apps` has room for 14 dumps plus growth
- [ ] Both age key copies (password manager + offline) are still accessible to two people
- [ ] Remove the downloaded files and any decrypted copy from the laptop

## Monitoring design

Alerts must not go through WhatsApp: WhatsApp may be the thing that is down. ntfy (push to
phones) and email are the channels.

```text
(a) external uptime  ──► https://<DOMAIN>/api/health ─────────────────────► email + ntfy
(b) Uptime Kuma (opt) ─► api:4000/api/health/ready, whatsapp:4100/health ─► ntfy
(c) API alerts ────────► ALERT_WEBHOOK_URL (POST) ───────────────────────► ntfy
    API scheduler ─────► HEARTBEAT_URL (≤ every 5 min) ─► healthchecks.io ► email + ntfy if missed
    cron jobs ─────────► healthchecks.io ping / fail ──────────────────────► email + ntfy
```

### (a) External uptime

Use a hosted checker with a free tier, e.g. UptimeRobot or Better Stack (healthchecks.io only
receives pings; it does not probe URLs). Notify by email and ntfy.

| Monitor           | URL                           | Check                                       | Interval |
| ----------------- | ----------------------------- | ------------------------------------------- | -------- |
| API public health | `https://<DOMAIN>/api/health` | HTTP 200                                    | 5 min    |
| Dashboard         | `https://<DOMAIN>/login`      | HTTP 200                                    | 5 min    |
| TLS certificate   | `https://<DOMAIN>`            | expiry alert at 14 days (NPM renews at ~30) | daily    |

Only `/api/health` and `/api/paypal/*` are routed to the API by NPM; `/api/health/ready` is
internal, hence (b).

### (b) Uptime Kuma internal checks (optional)

Run it from [`deploy/uptime-kuma.compose.yml`](../../deploy/uptime-kuma.compose.yml) (pinned
`louislam/uptime-kuma:1.23.16`, no host ports, persistent volume, joined to `katale-ai-internal`
and the NPM network):

```bash
sudo mkdir -p /opt/apps/uptime-kuma && sudo chown <DEPLOY_USER>: /opt/apps/uptime-kuma
cp deployment/uptime-kuma.compose.yml /opt/apps/uptime-kuma/docker-compose.yml
cd /opt/apps/uptime-kuma && docker compose up -d
```

NPM: create an **Access List** (username/password, optionally an IP allow-list), then a proxy host
`<STATUS_DOMAIN>` → `uptime-kuma:3001`, _Websockets Support_ on, Let's Encrypt with _Force SSL_,
the access list attached. Open it immediately and create the Kuma admin account (the first visitor
gets to create it). Monitors:

| Name             | Type              | URL                                | Settings                                                                |
| ---------------- | ----------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| Public health    | HTTP(s)           | `https://<DOMAIN>/api/health`      | 60 s, retries 2                                                         |
| API ready        | HTTP(s)           | `http://api:4000/api/health/ready` | 60 s, retries 2 (checks DB + config)                                    |
| WhatsApp session | HTTP(s) - Keyword | `http://whatsapp:4100/health`      | Keyword `"whatsapp":"ready"` (case-sensitive), 60 s, retries 5 (≈5 min) |

Notification: _Settings → Notifications → ntfy_, server `https://ntfy.sh`, topic `<NTFY_TOPIC>`,
priority 4; apply to all monitors. Kuma's own downtime is caught by (a) and the heartbeat in (c)
only indirectly, so it complements, not replaces, the external checker.

### (c) Application alerts and heartbeat

The API (this release) reads two optional env vars:

| Variable            | Behaviour                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALERT_WEBHOOK_URL` | `POST` with a plain-text body. Built for ntfy topics (`https://ntfy.sh/<NTFY_TOPIC>`); works with any webhook that accepts a plain-text POST body |
| `HEARTBEAT_URL`     | healthchecks.io-style ping, sent by the API's scheduler at most every 5 minutes. A missed heartbeat = API down **or** scheduler stuck             |

Alerts sent to `ALERT_WEBHOOK_URL`:

- PayPal webhook processing failures
- Payment-link creation failures
- Scheduled report delivery failures
- WhatsApp disconnected for more than 5 minutes (sent while the outage is still happening)
- Unpaid-order expiry sweep failures

healthchecks.io (free tier): create checks _katale-api-heartbeat_ (period 5 min, grace 10 min),
_katale-backup_ (period 1 day, grace 2 h) and _katale-restore-verify_ (period 7 days, grace 6 h).
Use the check URLs as `HEARTBEAT_URL` and the cron `<HEALTHCHECKS_PING_URL_*>` placeholders. Add
email and the ntfy integration as notification channels.

### ntfy setup

1. Pick a random topic — **the topic name is the secret** (anyone who knows it can read and post):
   `echo "katale-$(openssl rand -hex 16)"`. Store it in the password manager.
2. Install the ntfy app (Android/iOS) on the on-call phones and subscribe to the topic on
   `https://ntfy.sh`; enable notifications for it. Desktop: the web app at ntfy.sh.
3. Test: `curl -fsS -H "Title: Katale test" -d "ntfy works" https://ntfy.sh/<NTFY_TOPIC>`.
4. Set `ALERT_WEBHOOK_URL=https://ntfy.sh/<NTFY_TOPIC>` in `.env` and `docker compose up -d api`.

Messages on ntfy.sh pass through a third-party service: alerts should carry order/payment IDs and
error types, not customer names, phone numbers or addresses. For stricter control, self-host ntfy
(`binwiederhier/ntfy` behind NPM, `auth-default-access: deny-all`, a user with write access to one
topic). Because the API sends a plain POST to a URL, the credential has to travel in the URL
(ntfy accepts an `auth` query parameter; see the ntfy docs for its encoding). Self-hosting adds one
more service to keep patched.

## Approval needed: production changes and rollback

Each item is a separate change; apply in order, verify, then move on.

| #   | Change                                                                         | Verify                                                                         | Rollback                                                                                        |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 1   | Generate the age key pair; store private key in password manager + offline     | Decrypt a test file on a second machine                                        | n/a (no production change)                                                                      |
| 2   | Create bucket + scoped key (+ lifecycle rule)                                  | `rclone lsf` from the laptop                                                   | Delete the key and bucket in the provider console                                               |
| 3   | `apt-get install age rclone` on the VM; `rclone.conf` (600)                    | `rclone lsf <remote>` on the VM                                                | `sudo apt-get remove age rclone`; `rm ~/.config/rclone/rclone.conf`                             |
| 4   | Replace `deployment/backup.sh`, `restore.sh`; add `restore-verify.sh`, `cron/` | `./deployment/backup.sh manual` (local only until 5)                           | Keep `deployment/*.sh.bak` copies taken before the copy; move them back                         |
| 5   | Add `BACKUP_*` keys to `.env`                                                  | Manual backup shows `encrypted=yes offsite=…`; object visible in bucket        | Remove the keys: `backup.sh` reverts to local-only plaintext dumps                              |
| 6   | Install `/etc/cron.d/katale-ai` + logrotate                                    | Next morning: log line + healthchecks green                                    | `sudo rm /etc/cron.d/katale-ai /etc/logrotate.d/katale-backup`                                  |
| 7   | External uptime monitors + healthchecks.io checks + ntfy topic                 | Pause the API briefly in a maintenance window, or use the checker's test alert | Delete the monitors/checks                                                                      |
| 8   | `ALERT_WEBHOOK_URL`, `HEARTBEAT_URL` in `.env`; `docker compose up -d api`     | ntfy test alert from the API; heartbeat check turns green within 5 min         | Remove both lines; `docker compose up -d api`                                                   |
| 9   | (optional) Uptime Kuma stack + NPM proxy host + access list                    | All three monitors green; stopping `whatsapp` alerts within ~5 min             | `cd /opt/apps/uptime-kuma && docker compose down -v`; delete the NPM proxy host and access list |
| 10  | First monthly drill                                                            | Checklist complete                                                             | n/a                                                                                             |

Production hardening (SSH, NPM port 81, firewall, `TRUST_PROXY`, password rotation) has its own
approval list in [server-hardening.md](server-hardening.md).
