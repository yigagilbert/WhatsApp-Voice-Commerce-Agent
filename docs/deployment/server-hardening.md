# Server hardening runbook (production VM)

Runbook for audit item P0-3 ([audit](../audits/2026-10-25-katale-ai-system-audit.md#p0-3-production-edge-security)).
**Not executed yet.** Every step keeps a way back in: do them in order, in a maintenance window,
with a second person reachable, and stop at the first surprise.

Placeholders: `<VM_HOST>`, `<DEPLOY_USER>`, `<DOMAIN>`, `<ADMIN_IP>`, `<NPM_DIR>`. **(laptop)** marks commands
run on the operator's machine; everything else runs on the VM.

| #   | Change                                   | Risk if done wrong                | Recovery path                             |
| --- | ---------------------------------------- | --------------------------------- | ----------------------------------------- |
| 0   | Pre-checks                               | —                                 | —                                         |
| 1   | Rotate the `<DEPLOY_USER>` password      | console/sudo lock-out             | provider console + root/rescue mode       |
| 2   | SSH keys, then key-only SSH              | SSH lock-out                      | kept session, provider console            |
| 3   | NPM admin port 81 → localhost + tunnel   | NPM admin unreachable; sites blip | restore NPM compose file                  |
| 4   | ufw baseline                             | SSH lock-out                      | kept session, console: `ufw disable`      |
| 5   | fail2ban for sshd                        | own IP banned                     | other IP / console: `unbanip`             |
| 6   | unattended-upgrades                      | unexpected package change         | `apt` history; disable timer              |
| 7   | Dashboard password / first owner account | dashboard lock-out                | second owner, SQL reset, release rollback |
| 8   | Secrets hygiene and rotation             | services fail to authenticate     | previous values kept until verified       |
| 9   | `TRUST_PROXY=1`                          | wrong client IPs in rate limits   | set back to `true`                        |

## 0. Pre-checks (all must be true before step 1)

- [ ] **Out-of-band access works:** log in through the cloud provider's web console / VNC as
      `<DEPLOY_USER>` (password login on the console is unaffected by SSH settings). Know where the
      provider's rescue/recovery mode is.
- [ ] **A second SSH session stays open for the whole runbook** (`ssh <DEPLOY_USER>@<VM_HOST>`, then
      `sudo -v`). Open new sessions to test; never close the kept one until a new one has worked.
- [ ] `<DEPLOY_USER>` has sudo: `sudo -l` lists `(ALL : ALL) ALL` (or equivalent).
- [ ] Fresh backup: `cd /opt/apps/katale-ai && ./deployment/backup.sh pre-hardening`.
- [ ] Record the current state (keep the output with the change log):

```bash
lsb_release -ds; ssh -V
sudo ss -tlnp
docker ps --format 'table {{.Names}}\t{{.Ports}}'
sudo ufw status verbose || true
sudo sshd -T | grep -Ei '^(port|passwordauthentication|kbdinteractiveauthentication|permitrootlogin|maxauthtries|pubkeyauthentication) '
grep -n '^Include' /etc/ssh/sshd_config; ls -l /etc/ssh/sshd_config.d/
```

## 1. Rotate the deploy user's password

The password stays the break-glass credential for the provider console and for `sudo`, so it is
rotated, not removed.

```bash
passwd          # long random value, e.g. from the password manager generator
sudo -k && sudo -v   # confirm sudo accepts the new password
```

Store it in the password manager. Rollback: `passwd` again (the old one is gone; keep the new one safe).

## 2. SSH keys, then key-only SSH

### 2.1 Keys (each operator gets their own)

```bash
# (laptop)
ssh-keygen -t ed25519 -C "<name>@katale-ops" -f ~/.ssh/katale_ed25519     # with a passphrase
ssh-copy-id -i ~/.ssh/katale_ed25519.pub <DEPLOY_USER>@<VM_HOST>
```

```bash
# (laptop) ~/.ssh/config — IdentitiesOnly avoids "Too many authentication failures" with MaxAuthTries 3
Host katale-vm
  HostName <VM_HOST>
  User <DEPLOY_USER>
  IdentityFile ~/.ssh/katale_ed25519
  IdentitiesOnly yes
```

On the VM: `chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`. Add a second operator's public
key too, so one lost laptop does not mean lost access.

**Test in a NEW terminal**, forcing key auth (must log in without a password prompt):

```bash
# (laptop)
ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no katale-vm 'whoami && sudo -v && echo KEY-OK'
```

Do not continue until this prints `KEY-OK` for every operator.

### 2.2 Disable password login (drop-in)

`sshd` uses the **first** value it reads for each option, and Ubuntu includes
`/etc/ssh/sshd_config.d/*.conf` at the top of `sshd_config` in lexical order. Cloud images often ship
`50-cloud-init.conf` with `PasswordAuthentication yes`, so the drop-in is named `00-…` to win.
(If `grep '^Include' /etc/ssh/sshd_config` printed nothing, add the same lines at the **top** of
`sshd_config` instead.)

```bash
sudo cp -a /etc/ssh/sshd_config /etc/ssh/sshd_config.bak-$(date +%F)
sudo tee /etc/ssh/sshd_config.d/00-katale-hardening.conf >/dev/null <<'EOF'
# Katale AI hardening — docs/deployment/server-hardening.md
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
MaxAuthTries 3
EOF
sudo chmod 644 /etc/ssh/sshd_config.d/00-katale-hardening.conf
sudo sshd -t && echo CONFIG-OK          # must print CONFIG-OK; otherwise stop and remove the file
sudo sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|maxauthtries|pubkeyauthentication) '
```

Expected: `passwordauthentication no`, `kbdinteractiveauthentication no`, `permitrootlogin no`,
`maxauthtries 3`, `pubkeyauthentication yes`. Then reload (existing sessions survive a reload):

```bash
sudo systemctl reload ssh
```

Verify from **new** terminals on the laptop:

```bash
ssh katale-vm 'echo KEY-STILL-OK'                                                  # works
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password katale-vm      # "Permission denied (publickey)"
ssh -o PubkeyAuthentication=no root@<VM_HOST>                                      # refused
```

**Rollback** (from the kept session or the provider console):

```bash
sudo rm /etc/ssh/sshd_config.d/00-katale-hardening.conf
sudo sshd -t && sudo systemctl reload ssh
```

## 3. Nginx Proxy Manager admin port 81

**Why the firewall alone does not work:** Docker publishes container ports with its own iptables
NAT rules. Traffic to a published port is DNAT-ed in `PREROUTING` and passes the `FORWARD` chain
(Docker's chains), never ufw's `INPUT` rules — so `ufw deny 81` changes nothing while NPM publishes
`81:81`. Two safe options:

1. **Recommended: publish 81 on loopback only and reach it through an SSH tunnel.** One-line
   change, survives Docker restarts and reboots, no iptables knowledge needed.
2. `DOCKER-USER` chain allow-list (e.g. `iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport 81 ! -s <ADMIN_IP> -j DROP`).
   Works, but needs separate IPv6 rules, its own persistence (rules vanish on reboot unless saved
   and restored after Docker starts), and breaks when the admin IP changes. Not recommended here.

(If the cloud provider offers a network firewall / security group, allowing only 22, 80 and 443
there is also effective, because it filters before traffic reaches the VM. Use it in addition.)

### 3.1 Apply option 1

Find NPM's compose project and confirm its data lives in bind mounts or named volumes (recreating
the container must not lose certificates or the NPM database):

```bash
NPM=nginx-proxy-manager-app-1
docker inspect "$NPM" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'   # → <NPM_DIR>
docker inspect "$NPM" --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{println}}{{end}}'
cd <NPM_DIR> && ls
sudo tar -C <NPM_DIR> -czf ~/npm-backup-$(date +%F).tgz .        # data + letsencrypt + compose file
cp -a docker-compose.yml docker-compose.yml.bak-$(date +%F)       # file name may be compose.yaml
```

Edit the `ports` of the NPM service:

```diff
     ports:
       - '80:80'
       - '443:443'
-      - '81:81'
+      - '127.0.0.1:81:81'
```

```bash
docker compose config --quiet && docker compose up -d     # recreates NPM: all its sites blip for a few seconds
docker ps --filter name=nginx-proxy-manager --format '{{.Names}}\t{{.Ports}}'   # shows 127.0.0.1:81->81/tcp
```

Verify:

```bash
# (laptop)
nc -vz -w 5 <VM_HOST> 81            # must fail (timeout / refused)
curl -sSI https://<DOMAIN>/api/health | head -1    # every NPM site still answers
ssh -N -L 8181:127.0.0.1:81 katale-vm              # then open http://localhost:8181 → NPM login
```

Because port 81 was public, **change the NPM admin password** (and e-mail) once logged in through
the tunnel. Update the deployment guide's "NPM (`http://<vm>:81`)" step to the tunnel.

**Rollback:**

```bash
cd <NPM_DIR> && cp -a docker-compose.yml.bak-<date> docker-compose.yml && docker compose up -d
```

## 4. ufw baseline

Protects host services (SSH and anything that is not a Docker-published port). It does **not**
filter Docker-published ports (see step 3); NPM's 80/443 keep working regardless.

```bash
sudo ufw status verbose                 # note the current state
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'ssh'     # adjust if sshd listens on another port (see pre-checks)
sudo ufw allow 80/tcp comment 'http (NPM)'
sudo ufw allow 443/tcp comment 'https (NPM)'
sudo ufw show added                     # CONFIRM "ufw allow 22/tcp" is listed before enabling
sudo ufw enable
sudo ufw status numbered
```

Test a new SSH session from the laptop immediately. Optional: `sudo ufw limit 22/tcp` (rate limit)
instead of `allow` once fail2ban is in place. **Rollback:** `sudo ufw disable` (from the kept
session or the console).

## 5. fail2ban for sshd

```bash
sudo apt-get update && sudo apt-get install -y fail2ban
sudo tee /etc/fail2ban/jail.d/sshd.local >/dev/null <<'EOF'
[sshd]
enabled  = true
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
ignoreip = 127.0.0.1/8 ::1 <ADMIN_IP>
EOF
sudo systemctl enable --now fail2ban && sudo systemctl restart fail2ban
sudo fail2ban-client status sshd
```

Unban an address: `sudo fail2ban-client set sshd unbanip <IP>`. **Rollback:**
`sudo systemctl disable --now fail2ban` (optionally `sudo apt-get remove fail2ban`).

## 6. unattended-upgrades (security updates)

```bash
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades      # answer Yes
cat /etc/apt/apt.conf.d/20auto-upgrades              # both lines "1"
sudo unattended-upgrade --dry-run --debug | tail -20
```

Defaults install Ubuntu **security** updates only (Docker's own apt repository is not included, so
the engine is not restarted unexpectedly) and never reboot automatically. Check
`/var/run/reboot-required` monthly and reboot in a window (`restart: unless-stopped` brings the
stack back; run `docker compose ps` afterwards). **Rollback:** set both values in
`20auto-upgrades` to `"0"`, or `sudo apt-get remove unattended-upgrades`.

## 7. Dashboard login: first owner account, then rotate the bootstrap password

This release adds per-user dashboard accounts. `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` in
`.env` become a **setup login that only works while no dashboard account exists**. Order matters:

1. Deploy the release (migration `dashboard_users` runs in `vm-deploy.sh`).
2. Sign in with the existing shared login. You land on **Account → Create your owner account**.
   Create your personal owner account (12+ character password, stored in the password manager).
   You are signed out; the shared login stops working from this moment.
3. Sign in with the new account. On **Account**, add an owner account for a second person (so one
   lost password never locks the business out) and staff accounts as needed.
4. Rotate the setup password anyway: set `DASHBOARD_PASSWORD` to a new long random value
   (`openssl rand -base64 32`), store it in the password manager, and `docker compose up -d web`.
   It is inert while accounts exist, but becomes the login again if every account is removed or the
   release is rolled back.
5. Check the client IP header: the login throttle uses `X-Real-IP` (`DASHBOARD_CLIENT_IP_HEADER`).
   Nginx Proxy Manager's default proxy config sets `X-Real-IP $remote_addr`; confirm with
   `docker exec <NPM_CONTAINER> grep -r "X-Real-IP" /etc/nginx/conf.d/include/` (if it's missing,
   add `proxy_set_header X-Real-IP $remote_addr;` to the dashboard host's Advanced config).

**Lock-out recovery (no CLI needed):**

- One account locked after wrong passwords: it unlocks by itself after 15 minutes, or another
  owner sets a new password on **Account**.
- Every owner lost: from the VM, re-enable the setup login by removing the accounts, then repeat
  step 2 (sessions of the removed accounts end immediately):

  ```bash
  docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DELETE FROM dashboard_users;"'
  ```

- Rolling back `KATALE_TAG` to an image without accounts returns to the shared env login.

## 8. Secrets checklist

```bash
cd /opt/apps/katale-ai
sudo chown <DEPLOY_USER>:<DEPLOY_USER> .env && chmod 600 .env && ls -l .env    # -rw------- <DEPLOY_USER>
chmod 700 backups data/whatsapp 2>/dev/null; ls -ld backups data/*
```

- [ ] `.env` is `600`, owned by `<DEPLOY_USER>`; a copy is in the password manager (needed for
      disaster recovery — backups contain the database only).
- [ ] `~/.config/rclone/rclone.conf` is `600`; the age **private** key is not on the VM.
- [ ] No secrets in shell history: `history | grep -Ei 'secret|token|password|key='`; clear entries
      with `history -d <n>`.
- [ ] Remove unused keys from `~/.ssh/authorized_keys` (one line per known operator).

Rotation (generate with `openssl rand -hex 32`; keep the old value until the new one is verified;
`docker compose up -d` recreates all services from the one `.env`, so both sides of each shared
token change together):

| Secret                               | Effect of rotation                                                                                  | Steps / verify                                                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `API_AUTH_TOKEN`                     | Dashboard → API auth, **and the dashboard session signing key**: every dashboard user is logged out | Edit `.env` → `docker compose up -d` → log in again; dashboard pages load                                                                                          |
| `INTERNAL_SERVICE_TOKEN`             | API ↔ WhatsApp worker; messages fail for the seconds between container restarts                     | Edit `.env` → `docker compose up -d` → send the bot a message; `docker compose logs --tail=50 whatsapp api` shows no 401                                           |
| `PAYPAL_CLIENT_SECRET`               | Payment links and captures                                                                          | Create a new secret for the REST app in the PayPal developer dashboard → `.env` → `docker compose up -d api` → create a test payment link → disable the old secret |
| `AI_API_KEY`, `STT_API_KEY` (OpenAI) | Chat replies / voice-note transcription                                                             | Create a new key in the provider console → `.env` → `docker compose up -d` → text and voice test message → revoke the old key                                      |
| `SUNBIRD_API_KEY`                    | Luganda speech cascade                                                                              | Same pattern                                                                                                                                                       |
| `POSTGRES_PASSWORD`                  | Only read at first database init; changing `.env` alone breaks the API                              | `ALTER USER` in Postgres **and** update `POSTGRES_PASSWORD`/`DATABASE_URL` together; rarely worth it while Postgres is on the internal network only                |

Recommended order after any suspected exposure: PayPal secret → AI/STT keys → `INTERNAL_SERVICE_TOKEN`
→ `API_AUTH_TOKEN` (last, because it logs everyone out) → dashboard bootstrap password.

## 9. `TRUST_PROXY`

This release changes the API to accept a **hop count** for `TRUST_PROXY`. Production has exactly
one proxy hop (NPM's nginx), so it uses `1` instead of `true`: with `true` the API trusts the
whole client-supplied `X-Forwarded-For` chain and rate limits can be bypassed by rotating the
header ([audit section 9](../audits/2026-10-25-katale-ai-system-audit.md#9-security-and-production-readiness)).

`deploy/docker-compose.prod.yml` in this release already sets `TRUST_PROXY: '1'` (older images
read `1` as `true`, so the file is safe with either image). Copy it to the VM with the release and
run `./deployment/vm-deploy.sh <tag>`. Verify: requests in the API log show real client IPs, not
NPM's container IP. **Rollback:** `'true'` and `docker compose up -d api`.

## Approval needed

| Change                               | Downtime                             | Approver decides                                    |
| ------------------------------------ | ------------------------------------ | --------------------------------------------------- |
| 1–2 password rotation + key-only SSH | none                                 | who holds keys; who has console access              |
| 3 NPM port 81 → loopback             | a few seconds for **all** NPM sites  | maintenance window; tunnel vs. DOCKER-USER          |
| 4 ufw                                | none expected                        | SSH port; whether to add a provider firewall too    |
| 5 fail2ban                           | none                                 | `<ADMIN_IP>` allow-list                             |
| 6 unattended-upgrades                | none (manual reboots)                | reboot cadence                                      |
| 7 dashboard owners + password        | none                                 | who the owners are                                  |
| 8 secret rotation                    | dashboard logout; seconds of bot gap | whether to rotate now (yes if anything was exposed) |
| 9 `TRUST_PROXY=1`                    | API restart                          | ship with the hop-count release                     |
