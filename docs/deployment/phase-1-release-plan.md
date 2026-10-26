# Phase 1 release plan (PR #3) — for approval

**Status:** prepared, **not executed**. Nothing in production has been changed. Every step below that
touches the VM, DNS, PayPal or storage needs the owner's explicit go-ahead.

Release contents: unpaid-order expiry/cancellation, refunds, late-payment handling, dashboard
accounts and sign-in hardening, security headers, operator alerts/heartbeat, two additive migrations.
The WhatsApp worker code is unchanged (`apps/whatsapp` has no diff), so its image is a rebuild of the
same code.

## 0. Decisions to make before the window

| Decision                               | Recommended                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `UNPAID_ORDER_EXPIRY_HOURS`            | `72`. Existing unpaid orders get a full window from the first scheduler pass, not cancelled at once  |
| Who becomes the first and second owner | Two people, so one lost password never locks the business out                                        |
| Alerts endpoint (`ALERT_WEBHOOK_URL`)  | An ntfy.sh topic with a long random name (free), on the owner's phone                                |
| Heartbeat (`HEARTBEAT_URL`)            | A free healthchecks.io check, period 5 min, grace 10 min                                             |
| Off-site backups                       | Backblaze B2 or Cloudflare R2 free tier via rclone; age key pair with the private key **off** the VM |
| Maintenance window                     | Low-traffic hour; no customer checkouts in progress (deploy is ~2–3 minutes of API restart)          |

## 1. Credentials and configuration (names only — values stay in the password manager / VM `.env`)

Already in production `.env` (unchanged): `POSTGRES_*`, `DATABASE_URL`, `API_AUTH_TOKEN`,
`INTERNAL_SERVICE_TOKEN`, `PAYPAL_ENV`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
`PAYPAL_WEBHOOK_ID` (must be set: production verifies webhook signatures), `AI_*`, `STT_*`,
`DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD`, `KATALE_IMAGE_NAMESPACE`, `KATALE_TAG`.

New (all optional, safe defaults):

| Variable                                                                   | Default      | Set in production to                                      |
| -------------------------------------------------------------------------- | ------------ | --------------------------------------------------------- |
| `UNPAID_ORDER_EXPIRY_HOURS`                                                | `72`         | the decided value (`0` disables expiry)                   |
| `DASHBOARD_CLIENT_IP_HEADER`                                               | `x-real-ip`  | leave (NPM sets `X-Real-IP`; verified in step 4)          |
| `ALERT_WEBHOOK_URL`                                                        | unset        | `https://ntfy.sh/<NTFY_TOPIC>` (after approval)           |
| `HEARTBEAT_URL`                                                            | unset        | the healthchecks.io ping URL (after approval)             |
| `TRUST_PROXY`                                                              | from compose | compose now sets `loopback,uniquelocal` (do not override) |
| `BACKUP_AGE_RECIPIENT`, `BACKUP_RCLONE_REMOTE`, `BACKUP_OFFSITE_KEEP_DAYS` | unset        | after the backup step is approved                         |

Do not change `API_AUTH_TOKEN` in this release: it also signs dashboard sessions.

## 2. Pre-flight (day before)

1. Merge PR #3 only after approval; build from `main`:
   ```bash
   KATALE_IMAGE_NAMESPACE=yigagilbert ./scripts/release-images.sh   # runs pnpm verify, pushes immutable tag
   ```
   Note the printed tag `v0.1.0-<timestamp>` and the **current production tag** (`grep KATALE_TAG .env` on the VM) for rollback.
2. Optional but recommended: rehearse on a scratch VM/compose project with a copy of last night's
   backup (`docs/deployment/docker-hub-vm.md` → Local rehearsal): migrations apply, dashboard
   setup login → owner account works, API logs show real client IPs.
3. Confirm someone can reach the VM console from the cloud provider (in case SSH misbehaves).

## 3. Deploy (≈10 minutes)

On the VM, in `/opt/apps/katale-ai`, keeping a second SSH session open:

```bash
cp docker-compose.yml docker-compose.yml.pre-phase1          # rollback copy
# copy the new deploy/docker-compose.prod.yml → docker-compose.yml, and deploy/*.sh → deployment/
grep -n TRUST_PROXY docker-compose.yml                         # expect: loopback,uniquelocal
echo 'UNPAID_ORDER_EXPIRY_HOURS=72' >> .env                    # or the decided value
./deployment/vm-deploy.sh <new-tag>                            # pull → backup → migrate → up -d → NPM reload
```

`vm-deploy.sh` takes a `pre-deploy` backup, runs `katale-migrate` (two additive migrations: new
columns with defaults, `refunds` and `dashboard_users` tables) and only then recreates the services.
A failed migration leaves the running services untouched.

**WhatsApp session:** the LocalAuth session lives in `./data/whatsapp` (a host volume), so recreating
the worker container keeps the pairing — no QR scan expected. If a QR appears anyway, scan it from
the dashboard → WhatsApp.

**Payments during the restart:** PayPal retries failed webhooks for up to 3 days, a buyer returning
during the restart gets an error page but the payment is recovered by the webhook or the
reconciliation sweep (every open link is re-checked; captures on recently cancelled links too).

## 4. Post-deploy validation (≈20 minutes)

| #   | Check                                                                                                                          | Expected                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 1   | `curl -s https://kataleai.space/api/health`; `docker compose ps`                                                               | `ok`; all services healthy                                                             |
| 2   | `docker compose logs --tail=50 api \| grep -E "providers\|report scheduler started"`                                           | paypal `sandbox`/`live` as before, scheduler started                                   |
| 3   | Migrations: `docker compose exec -T postgres psql … -c "select count(*) from dashboard_users"`                                 | `0`                                                                                    |
| 4   | Sign in with the **shared** login → lands on "Create your owner account" → create owner 1                                      | Signed out; shared login now refused; owner 1 signs in                                 |
| 5   | Owner 1 → Account → add owner 2 (and staff); owner 2 signs in in a private window                                              | Both work; staff can't open Admins changes / Account management                        |
| 6   | Rotate `DASHBOARD_PASSWORD` to a new random value in `.env`; `docker compose up -d web`                                        | Inert while accounts exist; stored as recovery                                         |
| 7   | `docker compose logs api \| grep -m3 remoteAddress` after a few `/api/paypal/*` or `/api/health` hits                          | Real public client IPs, not `172.x` (TRUST_PROXY / X-Real-IP correct)                  |
| 8   | `curl -sI https://kataleai.space/login`                                                                                        | `content-security-policy` with `frame-ancestors 'none'`, `x-frame-options: DENY`       |
| 9   | WhatsApp: message the bot from an admin number ("How much have I sold this week?")                                             | Correct answer; no re-pairing needed                                                   |
| 10  | Orders page: open an unpaid order                                                                                              | "Payment due by …" shown; Cancel button present                                        |
| 11  | `select count(*) from orders where status='AWAITING_PAYMENT' and "paymentDueAt" is null` (after 2 min)                         | `0` (existing unpaid orders received a full window)                                    |
| 12  | One Sandbox order end to end from a test phone (pay with a Sandbox buyer), then a partial refund in the Sandbox seller account | Paid notification once; refund recorded (Payments → Refunded column), order stays paid |
| 13  | If alerts are configured: stop the worker for 6 min (`docker compose stop whatsapp`), then start it                            | "WhatsApp bot is offline" then "connected again" on ntfy; admins get the outage notice |

## 5. Rollback

| Situation                   | Action                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App misbehaves after deploy | `cp docker-compose.yml.pre-phase1 docker-compose.yml && ./deployment/vm-deploy.sh <previous-tag>`. The older compose sets `TRUST_PROXY: 'true'`, which older images require             |
| Migrations                  | Do **not** roll back: they are additive and older images ignore the new columns/tables                                                                                                  |
| Dashboard lock-out          | Another owner resets the password; or re-enable the setup login: `docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DELETE FROM dashboard_users;"'` |
| Unwanted expiries           | Set `UNPAID_ORDER_EXPIRY_HOURS=0` and `docker compose up -d api` (cancelled orders stay cancelled; a late payment is still recorded and flagged)                                        |
| Data damage (unlikely)      | `./deployment/restore.sh backups/katale-<timestamp>-pre-deploy.sql.gz` (asks for confirmation; takes a safety backup first)                                                             |
| WhatsApp asks for a new QR  | Dashboard → WhatsApp → scan; messages sent meanwhile may be missing (admins are told)                                                                                                   |

## 6. Infrastructure — separate approvals (runbooks ready)

| Item                                      | Today                                           | Runbook                                                                                                                |
| ----------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Encrypted off-site backups + cron         | **Not operational** (manual, on-VM only)        | [backups-and-monitoring.md](backups-and-monitoring.md) — script tested locally (age, rclone, retention, failure paths) |
| Weekly restore check                      | Not operational                                 | same; `restore-verify.sh --fresh`                                                                                      |
| Uptime / heartbeat / alerts               | Not operational (code ready after this release) | same; ntfy + healthchecks.io, optional Uptime Kuma                                                                     |
| NPM admin port 81                         | Needs restricting (see private operator notes)  | [server-hardening.md](server-hardening.md) §3 (bind to 127.0.0.1 + SSH tunnel; brief NPM restart affects all sites)    |
| SSH password authentication               | To be disabled (see private operator notes)     | server-hardening.md §2 (keys first, test in a new session, then disable)                                               |
| Firewall / fail2ban / unattended-upgrades | Unknown (not inspected)                         | server-hardening.md §4–6                                                                                               |
| App ports 3000/4000/4100/5432             | Not published (compose has no host ports)       | —                                                                                                                      |

Recommended order after the release: alerts + heartbeat (minutes, no risk) → off-site backups →
SSH keys-only → port 81 → firewall/fail2ban.
