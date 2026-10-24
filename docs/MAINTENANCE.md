# Running Chitthi in production

How the production deployment is built, run and repaired. This file grows with Phase 7: each
piece adds its section when it lands (host setup, deploy and rollback, backups and restore,
alerts, secret rotation, updates, disk growth, adding the second app, budget, incidents).

## Layout

- **VM:** Azure B2ats v2 (2 vCPU, 1 GiB), Ubuntu 24.04, Central India.
- **`deploy/edge`:** the shared Caddy (compose project `edge`, host network, ports 80 and 443).
  - `Caddyfile` holds the global options and a loopback-only liveness site on 127.0.0.1:2080.
  - `sites/<app>.caddy` holds one file per app.
  - **Ownership:**
    - [`deploy/host/edge.sh`](../deploy/host/edge.sh) (host infrastructure) owns the main `Caddyfile`, the edge's `compose.yaml` and its `.env`.
    - Each app's deploy owns exactly one file, `sites/<app>.caddy`, and never writes anything else there.
    - Every change is validated against the whole configuration before Caddy reloads, so a broken file can't take another app's site down.
- **`deploy/chitthi`:** Chitthi's stack (compose project `chitthi`).
  - **db:** Postgres 18, on an internal network only.
  - **migrate:** a one-off job.
  - **api:** on 127.0.0.1:8082.
  - **web:** on 127.0.0.1:5175.
  - Data lives under `/data/chitthi` on the data disk.
- **`deploy/azure`:** what you run from Azure Cloud Shell: `setup.sh` (the Azure resources), `run-on-vm.sh` (the host scripts, through Run Command) and `compact_media.py` (the monthly media compaction).
- **Secrets:** each container reads only its own env file (`db.env`, `migrate.env`, `api.env`).
  - The API never sees the database owner's password.
  - The compose `.env` holds only image digests and paths, so `docker compose config` is safe to print.
- **`deploy/smoke/smoke.sh`:** brings up both stacks exactly as committed, with throwaway secrets and Caddy's internal CA, then:
  - checks the edge and the production refusals;
  - runs `deploy/smoke/workload.mjs` through TLS;
  - prints the memory table.

  CI runs it on every push (the `images` job).

## Azure setup

[`deploy/azure/setup.sh`](../deploy/azure/setup.sh) creates everything in Azure. You run it in
Azure Cloud Shell (Bash), signed in as yourself, with Owner on the subscription. It's
re-runnable: each run creates what's missing, brings settings back to what the script says, and
ends with the same read-only verification as `setup.sh check`. It never deletes anything and never
replaces a stored secret.

**What it builds:**

| Resource group | What | Settings |
|---|---|---|
| `apps-host` (shared by both apps) | VM `apps-vm` | B2ats v2, Ubuntu 24.04 (the newest image at least 14 days old), Trusted Launch, system identity. Azure requires an admin login, so it gets a key whose private half is deleted on the spot: there is no SSH, by design. Boot diagnostics are on, for the Serial Console. |
| | Network | `apps-vm-nsg` allows TCP 80 and 443 from the Internet, nothing else. `apps-vm-ip` is a static Standard IPv4. No IPv6. |
| | Disks | OS and data disk `apps-vm-data` are 64 GiB Premium SSD (P6). The data disk sits at LUN 0, with a delete lock. |
| | Alerts | Action group `ops-email` sends to your address. Metric alerts: the VM unavailable, under 100 MiB available memory for 15 minutes, CPU credits under 30. Activity log alerts: the VM's resource health, and any role assignment written in the subscription. |
| | Budget | `apps-host`, monthly, for the whole subscription. Default ₹700 (pass `budget=` if the billing currency isn't INR). Email at 50, 80 and 100 % actual, and at 100 % forecast. |
| `chitthi` | Storage `chitthibk<6 hex>` | StorageV2 LRS. Entra sign-in only (shared keys off), no public blobs, TLS 1.2. Container `backups`. Lifecycle deletes `db/`, `manifests/` and `selftest/` 35 days after creation. Blob and container soft delete keep things 14 days. No versioning, no container WORM: append-only comes from the VM's role. Delete lock. |
| | Key Vault `chitthi-kv-<6 hex>` | Standard, RBAC, purge protection, 90-day soft delete, delete lock. |
| | Identity `chitthi-deploy` | What GitHub Actions signs in as (OIDC, no stored secret). It trusts only `repo:DhruvGoyal404/chitthi:environment:production`. |

The `<6 hex>` suffix comes from the subscription id, so every run finds the same names.

**Who may do what:**

| Identity | Role | Scope |
|---|---|---|
| The VM | `Blob create-only writer` (custom: `blobs/read` and `blobs/add/action`, no `write` or `delete`) | the `backups` container |
| The VM | Key Vault Secrets User | the vault |
| `chitthi-deploy` | `VM Run Command operator` (custom: `virtualMachines/read` and `runCommand/action`) | the VM |
| You | Key Vault Secrets Officer | the vault |
| You | Storage Blob Data Contributor, for the monthly compaction | the `backups` container |

`setup.sh check` fails if any of these identities holds anything more.

### Going live, in order

1. **Infrastructure:**
   ```
   git clone https://github.com/DhruvGoyal404/chitthi && cd chitthi
   bash deploy/azure/setup.sh infra alert_email=<you@…>
   ```
   Confirm the alert group's email (Azure sends one) and check it didn't land in spam.
2. **DNS:** an A record `chitthi.dhruvgoyal.tech` pointing to the IP it prints. No AAAA record.
3. **OAuth apps,** each with its callback on the public origin:
   - **Google:** `https://chitthi.dhruvgoyal.tech/api/auth/google/callback`.
   - **GitHub:** an OAuth app with homepage `https://chitthi.dhruvgoyal.tech` and callback `https://chitthi.dhruvgoyal.tech/api/auth/github/callback`.
4. **Cloudflare R2:**
   - **Bucket:** `chitthi-backups`, location hint Asia-Pacific.
   - **Bucket lock rule:** the whole bucket (no prefix), 30 days.
   - **Lifecycle rules:** delete objects under `db/`, `manifests/` and `selftest/` 35 days after upload.
   - **API token:** "Object Read & Write", applied to this bucket only. Keep its access key id, secret and S3 endpoint for step 6.
5. **healthchecks.io,** both checks emailing you:
   - **`chitthi-backup`:** period 1 day, grace 2 hours (the 26-hour freshness window).
   - **`chitthi-drill`:** cron `0 23 1 * *` UTC, grace 6 hours.
6. **Secrets:** `bash deploy/azure/setup.sh secrets`.
   - **Generated, if missing:** both database passwords and the backup keypair. The keypair is made in Python ([`age_keypair.py`](../deploy/azure/age_keypair.py)), because Cloud Shell has no age; CI checks it against the real age.
   - **Asked for, with input hidden and the format checked:** the OAuth, R2 and healthchecks values.
   - **Then keep a copy of the backup private key outside Azure,** in a password manager (the script prints the command that shows it). Without it, no backup can be read.
7. **The host:** `bash deploy/azure/run-on-vm.sh deploy/host/bootstrap.sh`.
8. **The edge,** once DNS resolves: `bash deploy/azure/run-on-vm.sh deploy/host/edge.sh sha=<commit> acme_email=<you@…>`. To test certificate issuance first without using up Let's Encrypt's limits, add `acme_ca=staging`. Re-run without it before the first deploy: the deploy's smoke test needs a trusted certificate.
9. **GitHub:**
   - Create the environment `production`, with deployments allowed from `main` only.
   - Set the variables `setup.sh infra` printed: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `VM_RG`, `VM_NAME`, `KEY_VAULT`, `BACKUP_ACCOUNT`, `BACKUP_CONTAINER`, `R2_BUCKET`.
   - None of these are secrets. With OIDC there is no stored credential.
10. **The first deploy,** from the deploy workflow.
11. **Prove the backups are append-only** with the VM's real credentials: `bash deploy/azure/run-on-vm.sh deploy/host/backup.sh selftest`. It must pass every line.
12. **Go-live gate:**
    - an alert email arrives;
    - the first nightly backup succeeds (healthchecks shows it green);
    - a restore drill passes (`bash deploy/azure/run-on-vm.sh deploy/host/backup.sh drill`);
    - a deliberately broken deploy rolls itself back.

**Things only the real run can prove,** because CI has no Azure account:
- the deploy identity's Run Command role is enough for `az vm run-command invoke`;
- budgets work on this subscription type (the script fails loudly if they don't);
- B2ats v2 is offered in Central India to this subscription.

`setup.sh check` and the selftest are the evidence.

### Running scripts on the VM

[`deploy/azure/run-on-vm.sh`](../deploy/azure/run-on-vm.sh) `<script> [arguments…]` runs one of
this repo's host scripts as root through Run Command. It prints the output and exits with the
script's exit code. Plain `az vm run-command invoke` reports success whatever the script returned,
and on Linux it may pass `name=value` parameters as environment variables rather than arguments,
so the wrapper carries the arguments itself. Arguments are limited to `[A-Za-z0-9@._:/=+-]`.
Run Command keeps only the last 4096 bytes of output.

### What it costs

Monthly list prices, approximate; Cost Management has the real figures a day after anything changes:

| Item | Cost |
|---|---|
| VM (B2ats v2) and two P6 disks | Inside Azure's 12-month free-services allowance (750 VM hours, two P6 disks) if the subscription has it. Otherwise roughly ₹600 for the VM and ₹800 per P6. After 12 months, move the disks to Standard SSD. |
| Static public IPv4 | About ₹300 (USD 0.005 an hour). |
| Key Vault | Standard tier: USD 0.03 per 10,000 secret operations, and secrets cost nothing to store. A deploy reads 6 secrets and a nightly backup 5, so roughly 300 operations a month: effectively zero. |
| Backup storage | A few GB of LRS blobs plus transactions: a few rupees. |
| Alerts | Three metric alerts at about USD 0.10 each. Activity log alerts and the budget are free. |
| Outbound traffic | The first 100 GB a month are free. |

**Azure for Students** stops the subscription when the credit runs out, and the site goes down
with it. The budget alerts are the early warning.

**Tearing down** needs the delete locks removed first (`az lock delete`). After deletion, Key Vault's
purge protection holds the vault's name for 90 days.

## Host setup

[`deploy/host/bootstrap.sh`](../deploy/host/bootstrap.sh) turns a fresh Ubuntu 24.04 VM into the host.

**Running it.** Use Run Command; there is no SSH:

```
bash deploy/azure/run-on-vm.sh deploy/host/bootstrap.sh
```

**Idempotent.** Re-run it after any change to the file. Every run ends by re-verifying the whole
host and fails loudly if any check fails. CI runs it twice on an Ubuntu 24.04 runner, with a loop
file standing in for the data disk, before the production smoke test, so the stack is tested on a
host set up this way.

**What it sets up:**

| Area | State |
|---|---|
| Docker | From Ubuntu's archive (`docker.io`, `docker-compose-v2`), so its security fixes arrive with everything else. `daemon.json`: capped `local` logs, `live-restore` (containers survive a daemon upgrade), no `docker-proxy`, `no-new-privileges` by default. |
| Users | One per container uid, no login shell. edge 10002; chitthi 10010 (API, migrations); chitthi-db 10011 (Postgres). The second app takes 10020 and 10021. |
| Data disk | `/data`, ext4, mounted by UUID with `nofail`. Only a device with no signature at all is ever formatted. Anything that isn't ext4 is refused. |
| Directories | `/srv/chitthi`: root only (env files). `/data/chitthi/pg`: 10011, 0700. `/data/chitthi/media`: 10010, 0700. `/data/edge/caddy`: 10002, 0700. |
| Swap | `/swapfile`, 2 GiB, `vm.swappiness=10`. |
| Firewall | UFW: 80 and 443 in, nothing else. SSH is disabled and not listening; the network security group agrees. |
| Metadata guard | `metadata-guard.service` (iptables, re-applied whenever Docker starts). Only root reaches the instance metadata service (identity tokens for Key Vault and backups) and the wireserver; containers and other users get "connection refused". DNS on 168.63.129.16:53 stays open. |
| Trimmed | snapd purged; multipathd and ssh disabled (RAM). |
| Logs | journald capped at 200 MB / one month. Container logs capped at 3 × 10 MB each. |
| Updates | unattended-upgrades for security updates. When one needs a reboot, it happens at 21:30 UTC (03:00 IST). |

**When it fails,** the last lines name the check, for example
`FAIL containers can't reach the metadata service`. Fix the cause and re-run it.
`free -m` at the end is the real baseline for the memory budget's "OS" row.

## Deploy and rollback

[`deploy/host/deploy.sh`](../deploy/host/deploy.sh) runs as root through Run Command. The deploy
workflow sends it with the release's arguments; by hand, from Cloud Shell:

```
bash deploy/azure/run-on-vm.sh deploy/host/deploy.sh deploy sha=<commit> \
  api=ghcr.io/dhruvgoyal404/chitthi-api@sha256:<…> migrate=ghcr.io/dhruvgoyal404/chitthi-migrate@sha256:<…> \
  web=ghcr.io/dhruvgoyal404/chitthi-web@sha256:<…> \
  vault=<KEY_VAULT> storage=<BACKUP_ACCOUNT> container=backups r2_bucket=<R2_BUCKET>
bash deploy/azure/run-on-vm.sh deploy/host/deploy.sh rollback
bash deploy/azure/run-on-vm.sh deploy/host/deploy.sh smoke
```

**A deploy, in order:**
1. **Lock.** One deploy at a time (`flock`).
2. **Configuration at that exact commit.** The compose and Caddy files come from
   `raw.githubusercontent.com/DhruvGoyal404/chitthi/<sha>/…`, and the compose file is validated.
   Images are accepted only as `ghcr.io/dhruvgoyal404/chitthi-*@sha256:…`.
3. **Secrets from Key Vault**, read with the VM's managed identity. The deploy fetches a token from
   the metadata service, which only root can reach.
   - Each value is written to the env file of the one container that needs it (`0600`, root).
   - Values never appear in output or on a command line.
   - Database passwords must be 24+ characters of `[A-Za-z0-9_-]`, so they go into URLs unescaped.

   | Key Vault secret | Goes to |
   |---|---|
   | `chitthi-postgres-password` | `db.env`, `migrate.env` |
   | `chitthi-api-db-password` | `migrate.env`, `api.env` |
   | `chitthi-google-client-id` and `chitthi-google-client-secret` | `api.env` |
   | `chitthi-github-client-id` and `chitthi-github-client-secret` | `api.env` |
4. **Pull by digest**, before anything stops.
5. **Switch.** The running release's `.env` and `compose.yaml` become `*.previous`, the rollback
   point. A re-deploy of the same release keeps the older rollback point.
6. **Pre-deploy dump** (`pg_dump -Fc`) to `/data/chitthi/pre-deploy/`. The newest 5 are kept; the
   nightly off-VM backups are the real history.
7. **Migrations** (`docker compose run --rm migrate`), then the API and web come up, waiting for
   their health checks.
8. **Edge: Chitthi's site file only.** `sites/chitthi.caddy` is validated twice:
   - **Before anything changes.** A broken file stops the deploy right there.
   - **Again before it's installed,** under the edge lock, against whatever the other apps' files
     are by then.

   Validation runs the main `Caddyfile` plus every site file in a one-off container configured
   exactly like the edge: same image, uid and capabilities. Then Caddy reloads. If it refuses,
   the old file goes back, and every site keeps being served as before.
9. **Smoke test through the public hostname** (resolved to 127.0.0.1, real TLS):
   - health, with the database;
   - the app shell with its CSP and HSTS;
   - HTTP redirecting to HTTPS;
   - a Socket.IO handshake for the app's own Origin, and 403 for a foreign one;
   - 403 for a POST without Origin;
   - no dev sign-in.

**If anything fails after the switch,** the previous release comes back automatically: its images
and compose file, but not its migrations. That release is then smoke-tested, and the script exits
non-zero either way. Every outcome is appended to `/srv/chitthi/deploys.log`.

**Migrations are forward-only.** A rollback restores images, never the schema. So every
migration must keep the previous release working: add a column in one release, and only stop
using or drop the old one in a later release (expand, then contract).

**The edge itself** is installed or updated with `edge.sh`, never by an app's deploy:

```
bash deploy/azure/run-on-vm.sh deploy/host/edge.sh sha=<commit> acme_email=<address> [acme_ca=staging]
```

A new main `Caddyfile` is validated with every site file already present. If Caddy then refuses
it, the old file is put back. edge.sh and every app's deploy take the same lock
(`/run/edge-deploy.lock`).

**Tested in CI on every push** (`deploy/host/test-deploy.sh`, on the bootstrapped runner). A
second app's site file (`other.caddy`, serving its own hostname) sits next to Chitthi's
throughout. The scenarios:
- a first deploy;
- the same release again;
- a release whose API exits at once, which must fail, roll itself back and leave the previous
  release passing the smoke test;
- a release whose site file is broken, which must fail before changing anything, with Chitthi
  still served;
- an explicit rollback.

At the end, `other.caddy`, the main `Caddyfile`, and the edge's `compose.yaml` and `.env` must be
byte-identical to before, and the other site must still answer.

## Backups

[`deploy/host/backup.sh`](../deploy/host/backup.sh), installed by every deploy at
`/srv/chitthi/bin/backup.sh` with its systemd timers.

**What runs when:**

| Run | When | What |
|---|---|---|
| `chitthi-backup.timer` → `backup.sh run` | nightly, 20:30 UTC (02:00 IST), before the reboot window | Database dump, new media, manifest; to Azure Blob, then to R2 |
| `chitthi-restore-drill.timer` → `backup.sh drill` | the 1st of each month, 23:00 UTC | Restores the newest backup into a scratch database and verifies it |
| `backup.sh selftest` | once at setup: `run-on-vm.sh deploy/host/backup.sh selftest` | Proves the VM's real credentials can create but not overwrite or delete |

Both timer services are capped at 256 MB and run at idle CPU and I/O priority.

**Append-only by design.** The VM never deletes or overwrites a backup:
- **Azure:** the VM's identity has a custom role with only `blobs/read` and `blobs/add/action`,
  scoped to the backup container. Every upload is a single Put Blob with `If-None-Match: *`.
  (Put Block needs `write`, which the role doesn't have.)
- **R2:** objects are copied with `rclone copy --immutable`, or streamed for media the bucket
  doesn't have yet. The bucket lock refuses overwrites and deletes for 30 days.
  - **The limit of that:** R2 has no create-only token, and the VM's token is "Object Read & Write". Once an object's 30-day lock ends, a compromised VM could delete or overwrite it on R2.
  - Dumps and manifests expire at 35 days anyway. Media older than 30 days is safe in Azure, where the VM can't delete. The drill reads media from Azure.
- **Not restic.** restic must delete its own lock files, and `--no-lock` isn't supported for
  `backup` (restic issue #1544).

**What a night's run writes:**
- `db/YYYY/MM/DD/chitthi-<UTC>.dump.age`: `pg_dump -Fc`, age-encrypted to a public key, plus a
  `.sha256` object next to it.
- `media/<key>.age` for each stored file the bucket doesn't have yet. Keys are random and never
  reused, so an existing key is already correct.
- `manifests/<UTC>.json`, uploaded last. It records the dump's name and sha256, the schema version,
  the message and attachment counts taken just before the dump, and every media key that existed.
  A restore uses exactly what a manifest lists.

**What the drill checks:**
- the newest manifest's dump against both its sha256 records;
- decryption, with the private key fetched from Key Vault into memory only;
- `pg_restore` into `chitthi_restore`;
- the schema version, and message and attachment counts at least those recorded;
- up to five media files, decrypted and checked against `attachments.sha256`;
- the R2 copy of the dump, byte for byte.

It then drops the scratch database.

**Alerts and freshness:**
- healthchecks.io gets start, success and failure pings, with a one-line reason and never a
  secret. Its 26-hour freshness window catches a backup that silently didn't run.
- Every deploy also fails if a timer isn't active or the last successful backup is more than 26
  hours old, once the first night is past.

**Key Vault secrets used** (on top of the deploy's):

| Secret | Used for |
|---|---|
| `chitthi-backup-age-recipient` | The public key backups are encrypted to |
| `chitthi-backup-age-identity` | The private key, read by the drill only |
| `chitthi-r2-endpoint`, `chitthi-r2-access-key-id`, `chitthi-r2-secret-access-key` | The R2 copy |
| `chitthi-hc-backup-url`, `chitthi-hc-drill-url` | healthchecks.io ping URLs |

**Retention is the storage's job, never the VM's:**
- **Dumps and manifests:** lifecycle rules delete `db/`, `manifests/` and `selftest/` 35 days after
  creation, on Azure and on R2 (R2's lock ends at 30). Azure's soft delete keeps deleted blobs 14
  more days.
- **Media isn't deleted by age,** because files still in use are old too. Once a month, the owner
  runs [`compact_media.py`](../deploy/azure/compact_media.py) in Cloud Shell, under their own identity.
  The VM still never deletes.

  ```
  python3 deploy/azure/compact_media.py --vault <KEY_VAULT> --account <BACKUP_ACCOUNT> --r2-bucket <R2_BUCKET>          # report
  python3 deploy/azure/compact_media.py --vault <KEY_VAULT> --account <BACKUP_ACCOUNT> --r2-bucket <R2_BUCKET> --apply  # delete
  ```

  It deletes a media object, on Azure and on R2, only if all of these hold:
  - no manifest from the last 35 days lists it;
  - it was created more than 35 days ago, so R2's lock has ended and no manifest can still be on its way;
  - the newest manifest is under 48 hours old;
  - the run would delete no more than half of all media, unless you pass `--force` after looking.

  It reaches R2 with the VM's token, read from Key Vault into memory. Cloud Shell has no rclone, so it signs requests itself (SigV4, tested against AWS's vector).

**What that means for privacy.** A message deleted for everyone, or an erased account's messages,
lives on in dumps for up to about 7 weeks (35 days plus 14 of soft delete). Files can last up to
about 12 weeks: listed by manifests for 35 days, up to a month until the next compaction, then 14
days of soft delete. The app says so in Settings and on the account-deletion screen.

**Tested in CI on every push** (`deploy/host/test-deploy.sh`), with folders standing in for the
two buckets. It runs:
- two nightly runs: two dumps and manifests, media uploaded once, R2 in step, dumps unreadable
  without the key;
- a drill that passes;
- a tampered dump the drill catches;
- a deploy that confirms the timers and the fresh backup.

The Azure REST calls and R2 permissions themselves are proven on the VM by `backup.sh selftest`.

## Pending dependency upgrades

A high or critical advisory whose fix is younger than the 14-day release rule gets a dated entry
in [`audit-exceptions.json`](../audit-exceptions.json). CI's audit
([`scripts/audit.sh`](../scripts/audit.sh)) treats it as excepted until the entry expires, then
fails with "upgrade". Each entry expires one day after its fix becomes installable, which leaves
a day to land the upgrade before CI turns red.

| Advisory | Severity | Exploitable in Chitthi? | Mitigation until the upgrade | Upgrade (own commit) | Exception expires |
|---|---|---|---|---|---|
| [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828), body-parser ≤ 2.3.0 (through Express 5.2.1) | High | **Yes, before the mitigation:** one unauthenticated request with a gzipped body plus trailing bytes crashed the API. Parsing runs before routing and before the session check. | `express.json({ inflate: false })`: compressed request bodies get 415, before any decompression (`e3638eb`). No client sends them. Test: `api/test/process.test.ts`, which crashed the real process before. | body-parser 2.4.0 (published 2026-10-22 11:39 UTC), **on 2026-11-06**: `npm update body-parser --before=2026-10-23`. Express's `^2.2.1` range allows it; check `npm ls body-parser` shows 2.4.0. Keep `inflate: false`. | 2026-11-07 |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), zod ≤ 4.6.5 | High | **Yes, before the mitigation, for signed-in users:** `.max()` did not stop zod validating every element first. One 98 KB body to `POST /conversations` or the send route meant 50,001 issues, +28 MiB of heap, 116–164 ms of CPU and a 4.3 MB error response. Three or four at once could exhaust the API's 96 MiB heap. | Arrays are length-checked before any element (`boundedArray` in `api/src/routes.ts`): the same body now costs one issue, 2.4 MiB and 11 ms. Error responses carry at most 10 issues (`MAX_ISSUES`). Test: `api/test/routes.db.test.ts`. | zod 4.6.6 (published 2026-10-11 16:18 UTC), **on 2026-10-26**: `npm install -w api --save-exact --before=2026-10-12 zod@4.6.6`. That date excludes 4.6.7, which arrived on 10-12. Check `npm ls zod` shows one copy, 4.6.6. Keep `boundedArray` and the cap. | 2026-10-27 |

After each upgrade: the full gate, then remove the entry from `audit-exceptions.json` in the same
commit. Until then, the audit prints a note for any exception whose advisory has disappeared.

## Memory budget

**The go-live questions, answered** (commits `0cd5008` and `325b6e4`; the tables below):

| Question | Answer |
|---|---|
| (a) The max-size photo, at production settings | Production runs `IMAGE_MAX_PIXELS=24000000` and `IMAGE_CONCURRENCY=1` ([compose.yaml](../deploy/chitthi/compose.yaml)). The load test makes its photo at exactly the running API's `IMAGE_MAX_PIXELS`: 6000×4000, 9.3 MB. It uploads one, then two at once, then one a pixel over (refused, 413). |
| (b) The API's heap cap, and memory under load | The cap is `--max-old-space-size=96`; V8 reports a 99 MiB limit inside the container. The API's anon + kernel memory, which can't be dropped, peaks at **155 MiB** with two max-size photos at once (96 with one). That's 61 % of its **256 MiB** `mem_limit`. `memory.peak`, page cache included, is 112 MiB (157 locally). No OOM kills. CI fails above 90 % of the limit. |
| (c) The edge Caddy, and the busy total for both apps | The edge measured **16 MiB** steady and **24 MiB** at peak, of 64. Both apps busy, with a max-size photo in flight: **≈ 699 MiB** of ≈ 900 (≈ 519 steady). |

The VM has 1 GiB, of which roughly 900 MiB is visible to Linux; confirm with `free -m` when the
VM exists. Every container has a `mem_limit`. A container that overruns its limit is OOM-killed
and restarted on its own, and the host and the other app keep running.

### How it is measured

- **What is read:** each container's cgroup v2 `memory.stat`, sampled from the host every 250 ms, plus the kernel's `memory.peak` after the run.
- **"Resident"** is `anon + kernel + shmem`: memory that can't be dropped under pressure. Page cache can be dropped, and is left out.
- **The workload** (`deploy/smoke/workload.mjs`):
  - four users with two tabs each, so eight WebSockets;
  - 200 messages sent at the pace the send limit allows, with every tab receiving every one exactly once;
  - one **max-size photo** through decode, EXIF strip, re-encode and thumbnail, then downloaded by two members. It's made at exactly the running API's `IMAGE_MAX_PIXELS` (production: 24 MP, so 6000×4000 at 9.3 MB, near the 10 MB cap);
  - **two more max-size photos from two people at once.** With `IMAGE_CONCURRENCY=1` the second waits for the first;
  - one photo over the limit refused, and a history read.
- **The second Postgres** is configured identically and migrated, and stands idle. It's the stand-in for the second app's database.

### Measured

Two runs of the same production images and limits, 2026-10-23/24:
- **CI:** Ubuntu 24.04 (the VM's OS), through the edge with TLS. CI repeats this on every push. The build fails if any container is OOM-killed, or if the API comes within 10 % of its limit.
- **Local:** Docker Desktop (WSL2, kernel 6.18), straight to the loopback ports. This run also sampled the API every 100 ms with the concurrent uploads.

All figures are in MiB; where they differ, the local figure is in brackets.

| Container | Idle resident | Under load (max resident) | `memory.peak` incl. page cache | `mem_limit` |
|---|---|---|---|---|
| chitthi db (Postgres) | 31 [27] | 59 [59] | 120 [98] | 160 |
| chitthi api | 34 [32]; 64 after load (V8 keeps its heap) | 96 [129], **155 with two max-size photos at once** | 112 [157] | 256 |
| chitthi web (Caddy, static) | 12 [10] | 12 [10] | 19 [12] | 32 |
| edge Caddy (CI only: it needs host networking) | 16 | 16 | 24 | 64 |
| second Postgres (stand-in), idle | 20 [26] | 23 | 78 (mostly page cache from initdb) | 160 |

**Why the API's heap cap is 96 MiB.** That's 37.5 % of the 256 MiB limit, and V8 reports a 99 MiB
heap limit including the young generation. sharp decodes in native memory, outside the V8 heap.
So the cap has to leave room for one decode (about 70–90 MiB for 24 MP) plus Node's own native
baseline (about 35 MiB): 99 + 90 + 35 ≈ 224 MiB, under 256. At 70 % (179 MiB), a heap allowed to
grow that far plus one decode would pass the limit, and the cgroup would OOM-kill the API before
V8 felt any pressure to collect. CI checks that the cap applied (`v8.getHeapStatistics()` inside
the container) and that the API stays under 90 % of its limit under load.

### Budget

| | Steady | Busy: both apps under load, a max-size photo in flight |
|---|---|---|
| OS, Azure agent, dockerd, containerd, one shim per container (estimate; measure on the VM) | 300 | 300 |
| Edge Caddy (measured in CI) | 16 | 24 |
| Chitthi: db + api + web | 31 + 64 + 12 = 107 | 59 + 155 + 12 = 226 |
| Second app: db (stand-in) + api (estimate: Chitthi's API without image work) + web | 26 + 60 + 10 = 96 | 59 + 80 + 10 = 149 |
| **Total** | **≈ 519 MiB** | **≈ 699 MiB** |
| **Left of ≈ 900 MiB** (page cache, headroom) | ≈ 380 MiB | ≈ 200 MiB |

**It fits, under these conditions:**
- **One image at a time** (`IMAGE_CONCURRENCY=1`). A second photo waits in line, which costs about 25 MiB (its upload held in memory), not a second decode at 70–100 MiB.
- **The 24 MP pixel limit** (`IMAGE_MAX_PIXELS=24000000`). The 50 MP default would roughly double the decode buffer.
- **The sharp cache off** (`IMAGE_CACHE=false`).
- **Postgres tuned small:**
  - `shared_buffers=32MB`, `work_mem=2MB`, 20 connections;
  - no parallel query, no JIT.
- **The API's V8 heap capped at 96 MiB**, for the reason above.

**Limits are ceilings, not reservations.** Together they add up to more than the VM's memory, and
that is intended: they stop one runaway container, while the 2 GiB swapfile (host setup) absorbs
the rare moment when every app peaks at once.

**When the second app joins,** it is measured the same way, and its rows above are replaced with
real numbers. The way out, if it ever stops fitting: one shared Postgres with a database and role
per app saves about 25 MiB idle; a bigger VM costs more than the budget.
