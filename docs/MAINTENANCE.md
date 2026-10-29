# Running Chitthi in production

How the production deployment is built, run and repaired.

**Sections:**
- **Layout:** what runs where.
- **Inventory and access.**
- **Setting it up:** Azure setup, then host setup.
- **Running it:** up and down; deploy and rollback; backups; alerts.
- **Looking after it:** secret rotation; updates; disk growth; adding the second app.
- **Incidents:** when something breaks.
- **Reference:** pending dependency upgrades; the memory budget. The budget in money is under "What it costs".

Every command here runs from Azure Cloud Shell, in a clone of this repo. `chitthi-up.sh` and
`chitthi-down.sh` also run from Git Bash on your own machine.

**The site is not up all the time.** It runs only when needed (before an interview, say):
`bash chitthi-up.sh` brings it up, `bash chitthi-down.sh` takes it down. See "Up and down".

## Layout

- **VM:** Azure B2ats v2 (2 vCPU, 1 GiB), Ubuntu 24.04, Malaysia West (`malaysiawest`; see "Region").
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
- **`deploy/azure`:** what you run from Azure Cloud Shell: `setup.sh` (the Azure resources), `run-on-vm.sh` (the host scripts, through Run Command) and `compact_media.py` (the monthly media compaction). Also `host-up.sh`, `host-down.sh`, `lib.sh` and `audit.jq`, behind the repo root's `chitthi-up.sh` and `chitthi-down.sh` ("Up and down").
- **Secrets:** each container reads only its own env file (`db.env`, `migrate.env`, `api.env`).
  - The API never sees the database owner's password.
  - The compose `.env` holds only image digests and paths, so `docker compose config` is safe to print.
- **`deploy/smoke/smoke.sh`:** brings up both stacks exactly as committed, with throwaway secrets and Caddy's internal CA, then:
  - checks the edge and the production refusals;
  - runs `deploy/smoke/workload.mjs` through TLS;
  - prints the memory table.

  CI runs it on every push (the `images` job).

## Inventory and access

**Everything that exists, and where:**

| What | Name | Where |
|---|---|---|
| VM | `apps-vm` (B2ats v2, Ubuntu 24.04) | Azure, resource group `apps-host`, Malaysia West |
| Public IPv4 (static) | `apps-vm-ip`, only while up: a new address every `chitthi-up.sh` | `apps-host`. DNS: `chitthi.dhruvgoyal.tech` A record (Cloudflare, DNS only), parked at 192.0.2.1 while down |
| Data disk | `apps-vm-data` (64 GiB: P6 Premium SSD, or E6 Standard SSD with `disks=standard`; LUN 0; delete lock) → `/data` | `apps-host` |
| Network security group | `apps-vm-nsg` (TCP 80 and 443 in) | `apps-host` |
| Alerts and budget | `ops-email`, 3 metric alerts, 2 activity log alerts, budget `apps-host` | `apps-host` and the subscription |
| Backup storage | `chitthibk<6 hex>`, container `backups` | Azure, resource group `chitthi` |
| Secrets | Key Vault `chitthi-kv-<6 hex>` (the app's; the VM reads it) | `chitthi` |
| Operator tokens | Key Vault `chitthi-ops-<6 hex>`: Cloudflare DNS, healthchecks.io and UptimeRobot API keys, for `chitthi-up.sh` and `chitthi-down.sh`. The VM has no access | `chitthi` |
| Deploy identity | `chitthi-deploy` (OIDC from GitHub `main`) | `chitthi` |
| Second backup copy | R2 bucket (`R2_BUCKET`), 30-day bucket lock | Cloudflare |
| Backup monitoring | `chitthi-backup` (also disk and certificate), `chitthi-drill` | healthchecks.io |
| Uptime monitoring | keyword monitor on `/api/health`, every 5 minutes | UptimeRobot |
| Code, CI, images | `DhruvGoyal404/chitthi` (private), `ghcr.io/dhruvgoyal404/chitthi-{api,migrate,web}` | GitHub |
| On the VM | `/srv/edge` (shared Caddy), `/srv/chitthi` (compose, env files, `deploys.log`, `bin/backup.sh`), `/data/chitthi/{pg,media,pre-deploy,backup-state}` | `apps-vm` |

`setup.sh check` verifies the Azure half: settings, locks, and each identity's exact roles.

**Access:**
- **Normal: Run Command,** from Cloud Shell (`run-on-vm.sh <script>`) or the deploy workflow. It needs the VM's Run Command permission: your Owner role, or `chitthi-deploy`'s custom role.
  - For a look around: `bash deploy/azure/run-on-vm.sh deploy/host/status.sh`.
  - For anything else, put the commands in a small script file and run that.
- **No SSH, ever:** sshd is disabled, the network security group has no port 22, and nobody holds the admin login's private key.
- **Emergency: the Serial Console,** when the VM boots but Run Command doesn't answer.
  - It needs boot diagnostics (on) and a password login, which doesn't exist until you make one: `az vm user update -g apps-host -n apps-vm -u rescue -p '<long random password>'`. That goes through the VM agent; if the agent is dead too, see "Incidents".
  - Then use Portal → apps-vm → Serial console.
  - Afterwards, `az vm user delete -g apps-host -n apps-vm -u rescue`.

## Azure setup

[`deploy/azure/setup.sh`](../deploy/azure/setup.sh) creates everything in Azure. You run it in
Azure Cloud Shell (Bash), signed in as yourself, with Owner on the subscription. It's
re-runnable: each run creates what's missing, brings settings back to what the script says, and
ends with the same read-only verification as `setup.sh check`. It never deletes anything and never
replaces a stored secret.

**What it builds:**

| Resource group | What | Settings |
|---|---|---|
| `apps-host` (shared by both apps) | VM `apps-vm` | B2ats v2, Ubuntu 24.04 from a pinned image URN, checked to exist in the region ("The VM image"), Trusted Launch, system identity. Azure requires an admin login, so it gets a key whose private half is deleted on the spot: there is no SSH, by design. Boot diagnostics are on, for the Serial Console. |
| | Network | `apps-vm-nsg` allows TCP 80 and 443 from the Internet, nothing else. `apps-vm-ip` is a static Standard IPv4. No IPv6. |
| | Disks | `disks=premium` (default): OS and data disk `apps-vm-data` are both 64 GiB Premium SSD (P6). `disks=standard`: a 32 GiB E4 OS disk and a 64 GiB E6 data disk (Standard SSD). See "What it costs". The data disk sits at LUN 0, with a delete lock. |
| | Alerts | Action group `ops-email` sends to your address. Metric alerts: the VM unavailable, under 100 MiB available memory for 15 minutes, CPU credits under 30. Activity log alerts: the VM's resource health, and any role assignment written in the subscription. |
| | Budget | `apps-host`, monthly, for the whole subscription. Default ₹500 (pass `budget=` if the billing currency isn't INR). Email at 50, 80 and 100 % actual, and at 100 % forecast. **An alert, not a cap:** Azure keeps billing past it. |
| `chitthi` | Storage `chitthibk<6 hex>` | StorageV2 LRS, Hot tier (switched back from Cool on 2026-10-24: at a few GB the difference is a few rupees, and Hot has no early-deletion or retrieval charges). Entra sign-in only (shared keys off), no public blobs, TLS 1.2. Container `backups`. Lifecycle deletes `db/`, `manifests/` and `selftest/` 35 days after creation. Blob and container soft delete keep things 14 days. No versioning, no container WORM: append-only comes from the VM's role. Delete lock. |
| | Key Vault `chitthi-kv-<6 hex>` | Standard, RBAC, purge protection, 90-day soft delete, delete lock. |
| | Key Vault `chitthi-ops-<6 hex>` | Standard, RBAC, 7-day soft delete. Only you hold a role on it: a compromised VM can't read the Cloudflare token and repoint `dhruvgoyal.tech`. |
| | Identity `chitthi-deploy` | What GitHub Actions signs in as (OIDC, no stored secret). It trusts only `repo:DhruvGoyal404@151380878/chitthi@1425788626:environment:production` (the immutable-ID form GitHub sends; `setup.sh` builds it from the GitHub API). |

The `<6 hex>` suffix comes from the subscription id, so every run finds the same names.

**Who may do what:**

| Identity | Role | Scope |
|---|---|---|
| The VM | `Blob create-only writer` (custom: `blobs/read` and `blobs/add/action`, no `write` or `delete`) | the `backups` container |
| The VM | Key Vault Secrets User | the vault |
| `chitthi-deploy` | `VM Run Command operator` (custom: `virtualMachines/read` and managed Run Command's `runCommands/read`, `write` and `delete`; not the older `runCommand/action`) | the VM |
| You | Key Vault Secrets Officer | both vaults |
| You | Storage Blob Data Contributor, for the monthly compaction | the `backups` container |

`setup.sh check` fails if any of these identities holds anything more.

### Going live, in order

Everything you do by hand, in order. Every command runs in Azure Cloud Shell (Bash), in a clone
of this repo, unless a step says GitHub, a browser or another service.

1. **Wait for CI to be green on the latest commit of `main`.** That includes the `secrets-scan` job: gitleaks over the full history, run on every push.
2. **Make the repo public:** GitHub → the repo → Settings → General → Danger Zone → Change visibility → Public.
3. **Make outside contributors' workflows wait for you:** Settings → Actions → General → "Approval for running fork pull request workflows from contributors" → "Require approval for all external contributors".
4. **Create the `production` environment,** with you as the required reviewer and deployments from `main` only. Run this from any terminal where `gh` is signed in as you; 151380878 is your GitHub user id, from `gh api users/DhruvGoyal404 -q .id`:
   ```
   gh api -X PUT repos/DhruvGoyal404/chitthi/environments/production --input - <<'JSON'
   {"reviewers":[{"type":"User","id":151380878}],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
   JSON
   gh api -X POST repos/DhruvGoyal404/chitthi/environments/production/deployment-branch-policies -f name=main -f type=branch
   ```
5. **Protect `main`** with a ruleset that blocks deleting it and force-pushing to it:
   ```
   gh api -X POST repos/DhruvGoyal404/chitthi/rulesets --input - <<'JSON'
   {"name":"protect main","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},"rules":[{"type":"deletion"},{"type":"non_fast_forward"}]}
   JSON
   ```
6. **Open Azure Cloud Shell** (Bash) and get the repo at the commit CI passed:
   ```
   git clone https://github.com/DhruvGoyal404/chitthi && cd chitthi && git checkout <commit>
   ```
7. **Create the Azure resources.**
   - First, Portal → search "Free services": check whether this subscription's free services include the B2ats v2 hours and the P6 managed disks. If the P6 disks aren't listed, add `disks=standard` below ("What it costs" explains why).
   - If an earlier run left empty resource groups in another region, the preflight stops and prints the `az group delete` command to run first.
   - Then run:
     ```
     bash deploy/azure/setup.sh infra alert_email=<you@…> region=malaysiawest
     ```
   - Its preflight checks the region against your subscription's allowed-locations policy, and checks that B2ats v2 is offered there unrestricted. Then answer `y`.
   - It ends with its checks (secrets still to come are listed as "todo") and prints your IP and the GitHub values. Keep that output for steps 10 and 20.
8. **Confirm Azure's alert email:** an email from Azure Monitor saying you were added to the action group `ops-email`. If it went to spam, mark it "not spam".
9. **DNS:** at your DNS provider, add an A record `chitthi.dhruvgoyal.tech` pointing to the IP from step 7. No AAAA record.
10. **Google OAuth client:**
    - Google Cloud console → APIs & Services → Credentials → Create OAuth client ID → Web application.
    - Authorized redirect URI: `https://chitthi.dhruvgoyal.tech/api/auth/google/callback`.
    - On the consent screen (external), publish the app. Otherwise only test users can sign in, and email/profile scopes need no verification.
    - Consent screen links: home page `https://chitthi.dhruvgoyal.tech`, privacy policy `https://chitthi.dhruvgoyal.tech/privacy`, terms `https://chitthi.dhruvgoyal.tech/terms`. The pages are public, and the deploy's outside check confirms they answer.
    - **Mail forwarding:** both pages publish `privacy@dhruvgoyal.tech` as the contact. Set up forwarding from it to your inbox at your domain's email or DNS provider, then send a test mail and confirm it arrives.
    - Keep the client ID and secret for step 15.
11. **GitHub OAuth app:**
    - GitHub → Settings → Developer settings → OAuth Apps → New.
    - Homepage `https://chitthi.dhruvgoyal.tech`, callback `https://chitthi.dhruvgoyal.tech/api/auth/github/callback`.
    - Generate a client secret, and keep both values for step 15.
12. **Cloudflare R2:**
    - Create the bucket `chitthi-backups` (location hint Asia-Pacific).
    - Add a bucket lock rule: the whole bucket (no prefix), 30 days.
    - Add lifecycle rules: delete objects under `db/`, `manifests/` and `selftest/` 35 days after upload.
    - Create an API token, "Object Read & Write", for this bucket only. Keep its access key ID, secret and S3 endpoint for step 15.
13. **healthchecks.io:** create two checks, then send the email integration's test ping and confirm it arrives (Integrations → Email → "Test!"):
    - `chitthi-backup`: period 1 day, grace 2 hours.
    - `chitthi-drill`: cron `0 23 1 * *`, time zone UTC, grace 6 hours.
14. **Store the secrets:** `bash deploy/azure/setup.sh secrets`. It generates both database passwords and the backup key pair, then asks for each other value with your typing hidden.
15. **Enter the values when asked:** Google (step 10), GitHub (step 11), R2 (step 12), and the two healthchecks.io ping URLs (step 13).
16. **Keep the backup private key outside Azure:**
    - Show it once with `az keyvault secret show --vault-name <KEY_VAULT> -n chitthi-backup-age-identity --query value -o tsv`, save it in your password manager, then `clear`.
    - Without it, no backup can be read if the Key Vault is ever lost.
17. **Check everything:** `bash deploy/azure/setup.sh check` must end with "all checks passed". Any time, `bash deploy/azure/setup.sh summary` prints the same checks read-only, with missing secrets as "todo", then the IP and the GitHub values.
18. **Set up the host:** `bash deploy/azure/run-on-vm.sh deploy/host/bootstrap.sh`. It ends with its own checks and `free -m`. Note the "used" figure: it's the real OS row of the memory budget.
19. **Start the edge,** once `nslookup chitthi.dhruvgoyal.tech` returns your IP: `bash deploy/azure/run-on-vm.sh deploy/host/edge.sh sha=<commit> acme_email=<you@…>`.
20. **GitHub environment values:** Settings → Environments → production. Use the values from step 7.
    - **Secrets:** `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `KEY_VAULT`, `BACKUP_ACCOUNT`, `R2_BUCKET` (`chitthi-backups`), `ACME_EMAIL`.
    - **Variables:** `VM_RG`, `VM_NAME`, `BACKUP_CONTAINER`.
21. **Switch deploys on:** Settings → Secrets and variables → Actions → Variables → New repository variable `DEPLOY_ENABLED` = `true`.
22. **First deploy:**
    - Actions → Deploy → Run workflow (branch `main`, action `deploy`).
    - When it pauses, open the run and press "Review deployments" → Approve.
    - It must end green, with every line of "Check the site from the outside" ok.
23. **Try it yourself:** open `https://chitthi.dhruvgoyal.tech` in two browsers. Sign in with Google in one and GitHub in the other, start a DM, and send messages and a photo.
24. **Prove the backups are append-only:** `bash deploy/azure/run-on-vm.sh deploy/host/backup.sh selftest`. Every line must say ok.
25. **First backup, now rather than tonight:** `bash deploy/azure/run-on-vm.sh deploy/host/backup.sh run`. healthchecks.io must show `chitthi-backup` green.
26. **First restore drill:** `bash deploy/azure/run-on-vm.sh deploy/host/backup.sh drill`. `chitthi-drill` must turn green.
27. **UptimeRobot** (free plan):
    - Add a monitor of type Keyword on `https://chitthi.dhruvgoyal.tech/api/health`. Keyword `"db":"ok"`, alert when the keyword does not exist, every 5 minutes. Alert contact: your email; confirm the address when UptimeRobot asks.
    - **Test alert:** change the keyword to `"db":"never"`, wait for the "down" email (up to about 10 minutes), then set it back to `"db":"ok"` and wait for the "up" email.
    - If your plan offers SSL-expiry reminders on the monitor, turn them on, 14 days ahead. Either way the VM checks the certificate every night: the `chitthi-backup` check turns red with 14 days left.
28. **Test Azure's alert email:** Portal → Monitor → Alerts → Action groups → `ops-email` → Test action group → Email. The email must arrive.
29. **Rehearse a broken deploy:**
    - Actions → Deploy → Run workflow (branch `main`, action `rehearse-rollback`), then approve.
    - It deploys a release whose API can't start. The run must end green, with "the broken release failed and rolled itself back" and the outside check ok.
    - Afterwards, the rollback point is the release that's running. The next real deploy sets a new one.
30. **Calendar:**
    - 2026-10-26: the zod upgrade. 2026-11-06: the body-parser upgrade ("Pending dependency upgrades").
    - Every month after the drill email: the media compaction ("Backups").
    - The first time Azure bills you: a look at Cost Management.
    - A month before the free 12 months end (`host-down.sh audit` prints the date): the disk decision ("What it costs").
31. **Up and down** (added 2026-10-30): `bash deploy/azure/setup.sh infra alert_email=<you@…>` once more (the ops vault, your role on it, the ₹500 budget), make the three tokens in "Up and down", store them with `bash deploy/azure/setup.sh secrets`, then run "Up and down, for real: the full cycle".

That's go-live. From now on, every push to `main` that passes CI and changes more than docs waits for your approval, then deploys itself.

**Things only the real run can prove,** because CI has no Azure account:
- the deploy identity's role is enough for managed Run Command (create, show, delete);
- the protected parameter arrives as `CHITTHI_GITHUB_TOKEN` (the wrapper exits 97 if it doesn't);
- budgets work on this subscription type (the script fails loudly if they don't);
- the preflight's reading of the allowed-locations policy matches what Azure enforces (if it misses a policy, creation fails at the first resource, as before);

`setup.sh check` and the selftest are the evidence.

### Running scripts on the VM

[`deploy/azure/run-on-vm.sh`](../deploy/azure/run-on-vm.sh) `<script> [arguments…]` runs one of
this repo's host scripts as root through **managed** Run Command (`az vm run-command create`),
prints its output, and exits with its exit code. Afterwards it deletes the run command resource.

**Why managed, not the older action Run Command (`az vm run-command invoke`):**
- **Secrets.** Managed Run Command has `protectedParameters`, the field Microsoft documents for "passing secrets (parameters, passwords) in a secure manner". The action API has no protected parameters: anything secret would sit in the script or the parameters, which are stored and shown.
  - The deploy workflow's GitHub token travels only as the protected parameter `CHITTHI_GITHUB_TOKEN`. On Linux that reaches the script as an environment variable.
  - After every run, `run-on-vm.sh` fetches the run command's whole resource view, instance view included, and fails if the token appears anywhere in it.
  - On the VM, the wrapper stops before the script if the protected parameter didn't arrive.
- **Exit codes.** The instance view reports the script's real exit code; `invoke` reports success whatever happened.

**Tested in CI** (`deploy/azure/test_azure_tools.py`, against a stand-in `az` that logs every call):
- the token appears in exactly one argument of all the `az` calls, right after `--protected-parameters`;
- it is in neither the script text nor the stored view, nor in any output;
- a view that returns the token fails the run;
- a malformed token is refused before `az` is called.

**Arguments** aren't secret. They travel inside the script, limited to `[A-Za-z0-9@._:/=+-]`: named Run Command parameters would become environment variables, and these scripts take `key=value` arguments. The instance view keeps the last 4 KB of output.

### GitHub: a public repo

The repo is public (decided and made public on 2026-10-24, after CI run 40081823261 passed on 4a657ad). That brings unmetered Actions minutes for standard runners, environments and rulesets on the Free plan. Before the flip, the whole history was scanned with gitleaks (v8.30.1): three findings, all made-up test values in `api/test/oauth.db.test.ts`, are recorded in `.gitleaksignore`. The tracked files were searched for account, subscription and tenant IDs, emails, IPs, keys and service URLs, and nothing was found:
- Azure resource names derive from the subscription when `setup.sh` runs, and are never committed.
- The only addresses are loopback, Azure's documented platform addresses, private ranges and RFC 5737 documentation addresses in tests.
- CI's `secrets-scan` job runs gitleaks over the full history on every push.

What protects deploys now:
- **The `production` environment:** each deploy job waits until you approve it, and only runs from `main`. Azure's federated credential trusts only `repo:DhruvGoyal404@151380878/chitthi@1425788626:environment:production` (the immutable-ID form GitHub sends; `setup.sh` builds it from the GitHub API), so no other job, branch or workflow can sign in.
- **Account identifiers are environment secrets,** not variables: the client, tenant and subscription IDs, the Key Vault and storage names, the bucket and your email. Actions logs are public, and secrets are masked in them. Only resource-group, VM and container names are plain variables.
- **A ruleset on `main`** forbids deleting it and force-pushing to it.
- **Workflows from outside contributors' pull requests** wait for your approval, and run with a read-only token, without the environment or its secrets.

**Actions minutes** are free for a public repo. For reference, a CI run on code is about 14 job-minutes and a deploy about 10.

**Docs-only changes** (`docs/`, `*.md`) skip CI's `images` and `perf` jobs, and so the deploy:
- CI's `changes` job diffs the push against what came before. A new branch or a force push counts as code.
- The deploy's `gate` job deploys only if CI's `images` job passed for that commit.
- On `main`, CI runs are no longer cancelled by a newer push, so a code push followed quickly by a docs push still deploys.

### Region

**Malaysia West** (`malaysiawest`), decided 2026-10-24.
- **Why:** Azure for Students subscriptions carry an allowed-locations policy. This one allows `eastasia`, `koreacentral`, `uaenorth`, `indonesiacentral` and `malaysiawest`, and not `centralindia`. The first attempt failed with `RequestDisallowedByAzure`.
  - B2ats v2 isn't offered in `uaenorth`.
  - In `malaysiawest` it's offered with no restrictions.
- **The preflight:** `setup.sh infra region=…` (default `malaysiawest`) checks, before it asks to create anything:
  - every location list in the subscription's policy assignments, inherited ones included;
  - that the VM size is offered in the region without a Location restriction, and supports Premium SSD when `disks=premium`;
  - that no resource group from an earlier run sits in another region;
  - that a suitable Ubuntu image exists there.
- **A resource group left in another region:** delete it and let `setup.sh` recreate it, rather than reuse it.
  - A group's region only says where its metadata lives, so reuse would work in principle.
  - But `az group create` refuses a group that exists in another region, so reuse would need special code in every re-run.
  - Mixing regions also makes the inventory and any data-residency answer harder.
  - An empty group holds nothing to lose. The preflight refuses a non-empty one, and never deletes anything itself.
- **Latency:** chat traffic from India now crosses to Kuala Lumpur. Expect roughly 60–100 ms round trip from north India, against roughly 25–45 ms to Central India. That's an estimate: measure it after go-live with `curl -o /dev/null -sw '%{time_connect}\n' https://chitthi.dhruvgoyal.tech/api/health`. A chat app tolerates this well: messages carry their own sequence numbers, and the UI updates optimistically.
- **Data location:** messages, files and the primary backups live in Malaysia West, and the second backup copy in Cloudflare R2 (Asia-Pacific). Keep any privacy text that names a data location in step.

### The VM image

The VM is created from a pinned image URN, like a container digest. The default is
`Canonical:ubuntu-24_04-lts:server:24.04.202610210`, set in `setup.sh` (`DEFAULT_IMAGE`); pass `image=<URN>` to override it.

- **The pin is per region.** Canonical's image versions reach regions at different times, and the version list can disagree with the region.
  - The second go-live attempt chose `24.04.202610090` from `az vm image list`, which `az vm image show` couldn't find in `malaysiawest`.
  - So the preflight checks the exact URN with `az vm image show --location <region>`, the lookup VM creation itself does.
  - If the image is missing, the preflight stops before the prompt and prints the region's three newest versions.
- **Under 14 days old is allowed, with a note.** `202610210` was published 2026-10-21, younger than the 14-day supply-chain rule. Every version present in `malaysiawest` on 2026-10-24 was, and the only older candidate wasn't actually there. The preflight reports the age and goes ahead, because the pin is a deliberate choice. Security updates arrive through unattended-upgrades from the first boot either way.
- **The pin only matters when the VM is created.** Afterwards the OS is updated in place ("Updates"). Bump it only before building a VM (a rebuild, a new LTS), and choose a version at least 14 days old when the region has one:
  ```
  az vm image list --location malaysiawest --publisher Canonical --offer ubuntu-24_04-lts --sku server --all --query '[].urn' -o tsv | sort | tail -n 5
  az vm image show --location malaysiawest --urn <one of them>   # must succeed in the region
  ```
  Then update `DEFAULT_IMAGE` in `setup.sh` (or pass `image=`).

### What it costs

Monthly, at Azure's retail prices for `malaysiawest` in INR (Azure Retail Prices API, 2026-10-24; 730 hours a month). Cost Management shows the real figures a day after anything changes.

| Item | Unit price | Monthly |
|---|---|---|
| VM, B2ats v2 (Linux) | ₹1.0271 an hour | ₹750 |
| OS + data disks, `disks=premium`: two P6 (64 GiB Premium SSD) | ₹979.76 each | ₹1,960 |
| OS + data disks, `disks=standard`: E4 (32 GiB) + E6 (64 GiB) Standard SSD | ₹230.37 + ₹460.75 | ₹691 (plus pennies of I/O) |
| Static public IPv4 (Standard) | ₹0.4799 an hour | ₹350 |
| Backup storage, Blob Hot LRS, about 5 GB | ₹1.7278 per GB, writes ₹4.32 per 10,000 | about ₹9 |
| Key Vault, about 300 secret reads | ₹2.88 per 10,000 operations | under ₹1 |
| Outbound traffic | First 100 GB free, then ₹10.56 per GB | ₹0 at this app's scale |
| Metric alerts (3) | First 10 monitored series free | ₹0 |

**Totals, depending on what Azure's free allowance covers:**

| Case | `disks=premium` | `disks=standard` |
|---|---|---|
| A. VM hours and both P6 disks free (the 12-month allowance, as Microsoft has listed it) | **≈ ₹359** | ≈ ₹1,050 |
| B. VM hours free, disks not | ≈ ₹2,319 | **≈ ₹1,050** |
| C. Nothing free (after the 12 months) | ≈ ₹3,069 | **≈ ₹1,800** |

**What Microsoft's pages say:**
- The Students page lists "750 hours each of B1s, B2pts v2 … and B2ats v2" for 12 months, for new Azure customers only. Neither it nor the free-account FAQ limits those hours to a region.
- They no longer mention the two free P6 disks, which older versions of the free-services list included.
- Portal → "Free services" shows what this subscription actually gets. Check it before step 7.

These totals are for a site that never goes down. Since 2026-10-30 it runs only when needed
("Up and down"), which removes the IPv4 and the VM's hours while it's down:

| | During the free 12 months (case A) | After them (`disks=premium`) |
|---|---|---|
| **Per hour while up** | ₹0.48 (the IPv4; the VM's hours are free) | ₹1.51 (VM ₹1.03 + IPv4 ₹0.48), plus the disks below |
| **Per month while down** | ≈ ₹9 (backup storage) | ≈ ₹1,969 (two P6 disks ₹1,960 + storage) |
| **Per month if you forget `chitthi-down.sh`** | ≈ ₹359 | ≈ ₹3,069 |

**Against the ₹500 budget (an alert, not a cap) and the ₹9,599 credit (valid until October 2027):**
- **In the free 12 months:** down costs pennies, and even a forgotten month up (≈ ₹359) stays under ₹500.
- **After them, the disks alone are ≈ ₹1,960 a month, up or down: four times the budget.** `chitthi-down.sh`'s audit starts reporting them as STILL BILLING on that date. Before it, decide: `disks=standard` (≈ ₹691 a month, still over ₹500), or snapshot the data disk and delete both disks on down (a few GB of snapshot costs a few rupees; up then rebuilds the VM, which these scripts don't do yet).

Changing the disk type later means stopping the VM: `az vm deallocate`, `az disk update --sku …`, then start it again. A few minutes of downtime.

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

## Up and down

The site runs only when it's needed. Two commands from the repo root, in Git Bash on Windows,
Cloud Shell or Linux (each needs `az`, `jq` and `curl`, and signs you in if needed):

```
bash chitthi-up.sh      # fully down -> live, about 5-10 minutes
bash chitthi-down.sh    # live -> nothing billing but the backups' pennies (and the disks after the free year)
```

Both are re-runnable after a half-failed run: every step checks before it creates or deletes. They
pick, among the subscriptions you're signed in to (Azure for Students first), the one holding
`apps-host`, and read its state from ARM (the CLI caches it). `up` refuses a subscription that isn't
`Enabled`; `down` goes on, since it only stops things. Azure calls go through `az rest` and retry
429, 5xx and "another operation in progress".

**`chitthi-down.sh` [`--skip-backup`] [`--app-only`]:**
1. **A final backup** on the VM (`backup.sh run`). If it fails, nothing is stopped. `--skip-backup` goes on without it, and whatever changed since the last nightly backup is then only on the data disk (which stays).
2. **Monitors paused:** the healthchecks.io checks named `chitthi-*` and the UptimeRobot monitor for the domain, through their APIs. Otherwise they'd email "down" all the time.
3. **DNS parked:** the A record now points at 192.0.2.1 (TEST-NET-1, routed nowhere). A record left on the released Azure address would follow it to whoever gets it next, and serve them `chitthi.dhruvgoyal.tech`.
4. **The host,** through [`deploy/azure/host-down.sh`](../deploy/azure/host-down.sh):
   - turns off the alerts that need a running VM: `vm-unavailable`, `vm-resource-health`, `vm-low-memory`, `vm-cpu-credits-low`. `role-assignment-changed` and the budget stay on;
   - deallocates the VM (a merely "stopped" VM still bills its compute);
   - detaches the static IPv4 from the NIC and deletes it;
   - keeps the NIC, NSG, VNet, disks, both Key Vaults, the storage and the DNS record.
5. **An audit** of every resource in the subscription, each with its idle cost. The P6 disks show as free until 12 months after the subscription's first resource, at the latest; Portal → Free services has the exact date. If Cost Management shows a "free" disk billing this month anyway, it counts as billing. Anything billing beyond the expected pennies prints **STILL BILLING** and exits non-zero. Read-only on its own: `bash deploy/azure/host-down.sh audit`.

**`chitthi-up.sh` [`--app-only`]:**
1. **The host,** through [`deploy/azure/host-up.sh`](../deploy/azure/host-up.sh): it tags the VM `app-chitthi`, creates a new static IPv4 (a new address every time), attaches it to the NIC, starts the VM, and turns the four alerts back on.
2. **Cloudflare:** the A record goes to the new address, DNS only (grey cloud), TTL 60 s.
3. **Waits** for `/api/health` on the new address (curl `--resolve`, so the certificate is checked against the name), then for 1.1.1.1 to answer the new address, then for the domain itself through this machine's DNS (it flushes the Windows DNS cache). It prints the certificate's days left; Caddy keeps its certificates on the data disk, so they survive.
4. **Monitors resumed.** A resumed healthchecks.io check is "new" until the next nightly ping.
5. **One real request to each outside dependency:** Google's and GitHub's authorize pages for our client and callback, Let's Encrypt's directory, and `backup.sh check` on the VM (Key Vault, Azure Blob and R2, with the VM's own identity; it lists the newest backup in each).
6. **A box** with the URL, the fallback, the cost per hour, and "run chitthi-down.sh when done". The fallback is a hosts-file line, `<ip> chitthi.dhruvgoyal.tech`: `https://<ip>` itself doesn't work, because the certificate is for the name and OAuth only accepts the name.

**The tokens they use** live in the ops vault `chitthi-ops-<6 hex>`, which the VM can't read. Store them with `bash deploy/azure/setup.sh secrets` (it asks for each missing one, hidden):

| Secret | Where to make it | Exactly what it may do |
|---|---|---|
| `chitthi-cloudflare-dns-token` | Cloudflare → My Profile → API Tokens → Create Token → Custom token | Permissions: **Zone → Zone → Read** and **Zone → DNS → Edit**. Zone Resources: **Include → Specific zone → dhruvgoyal.tech**. No account permissions. Optionally an IP filter and an expiry date. |
| `chitthi-hc-api-key` | healthchecks.io → the project with `chitthi-backup` → Settings → API Access | The **read-write** key (pause and resume need it). It reaches that project only. |
| `chitthi-uptimerobot-api-key` | UptimeRobot → Integrations & API → API | The **Main API key** (a monitor-specific key can only read). |

**What it costs:** see "What it costs". The Deploy workflow fails at once on a down site, with
"run chitthi-up.sh first": `run-on-vm.sh` checks the VM's power state before anything else.
Bring the site up, then re-run the deploy (Actions → Deploy → Re-run, or Run workflow).
`setup.sh check` expects a running VM and its IPv4, so run it while up; `setup.sh infra` while
down would recreate the IPv4 and turn the alerts back on.

**Two apps on one VM.** The VM is shared, so taking it down takes every app on it down.
- Each app's up script tags the VM `app-<name>`. `host-down.sh` refuses while another app's tag is there, unless `also=<name>` says you mean it.
- With Hisaab there: run `bash hisaab-down.sh --app-only` (its backup, monitors and DNS), then `bash chitthi-down.sh`, which asks you to re-run `host-down.sh app=chitthi also=hisaab`.
- Coming back: `bash chitthi-up.sh`, then `bash hisaab-up.sh --app-only`. Hisaab's DNS must follow the new address too.
- Hisaab's scripts are its own thin wrappers over `deploy/azure/lib.sh`, `host-up.sh` and `host-down.sh`, copied into its repo: `hc_set`, `uptimerobot_set` and `cf_set_a` take the check prefix, the domain and the secret names as arguments.

### Up and down, for real: the full cycle

Run this once after any change to these scripts, and before relying on them:

1. `bash chitthi-up.sh`. Expect the box, and exit code 0 (`echo $?`).
2. In a browser, sign in at https://chitthi.dhruvgoyal.tech and send a message. Reload: it's still there.
3. `bash chitthi-down.sh`. Expect "audit clean" and exit code 0. Then `curl -m 10 https://chitthi.dhruvgoyal.tech/api/health` fails, and healthchecks.io and UptimeRobot show the checks paused.
4. `bash chitthi-up.sh` again. The message from step 2 is still there, and so is the session (the database and cookies don't care about the address).

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

**The deploy workflow** ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)):
- **When it runs:**
  - after CI passes on a push to `main` whose `images` job ran (docs-only pushes skip it, and so the deploy);
  - or by hand from Actions → Deploy, with the action `deploy`, `rollback`, `smoke` or `rehearse-rollback`.
- **`rehearse-rollback`** first checks that the site is healthy. It then deploys this commit with an API image that exits at once. That deploy must fail and roll itself back, after which the outside check must pass. It is the go-live gate's "a broken deploy rolls itself back", proven on the real VM.
- **The gate job** asks CI whether its `images` job passed for the commit. It has `actions: read` only.
- **The build job:**
  - builds the three images at exactly the CI-tested commit;
  - runs `scripts/check-images.sh` on them;
  - pushes them to GHCR and passes their `@sha256` references on.
- **The jobs' token permissions:**

  ```yaml
  gate:               # reads CI's job results
    permissions:
      actions: read
  build:              # pushes the images; its token never leaves GitHub's runner
    permissions:
      contents: read
      packages: write
  deploy:             # its GITHUB_TOKEN is the one handed to the VM
    permissions:
      contents: read  # the VM fetches this commit's config
      packages: read  # and pulls the private images
      id-token: write # lets the job ask GitHub for an OIDC token for Azure; adds no scope to GITHUB_TOKEN
  ```

  The workflow's default is `permissions: {}`. `deploy/azure/test_azure_tools.py` asserts every block, the environment, and that only deploy-job steps pass a token to `run-on-vm.sh`.
- **The deploy job** runs in the `production` environment, from `main`, once you approve it:
  - It signs in to Azure as `chitthi-deploy` by OIDC. No credential is stored anywhere. Azure trusts only tokens for `repo:DhruvGoyal404@151380878/chitthi@1425788626:environment:production` (the immutable-ID form GitHub sends; `setup.sh` builds it from the GitHub API), and the identity can only use managed Run Command on the VM.
  - Account identifiers come from environment secrets, which are masked in the public logs.
  - It runs `edge.sh` (a no-op unless `deploy/edge` changed), then `deploy.sh`.
  - It then runs [`deploy/azure/public-check.sh`](../deploy/azure/public-check.sh) from the internet. It checks health, at least 14 days left on the certificate, the headers, the redirect, the Origin refusals, and that ports 22, 5432, 5435, 8082 and 5175 are closed.
  - The check runs after a failed deploy too, so the log shows what the rolled-back site serves.
- **The VM signs in to GitHub per deploy.** The repo is public, but its GHCR images may stay private (a package's visibility is its own setting), and the scripts work either way.
  - The deploy job hands the VM its own `GITHUB_TOKEN` (contents:read, packages:read) through `run-on-vm.sh`, as a managed Run Command **protected parameter**. It reaches the script as an environment variable and is never an argument or part of the script text.
  - `deploy.sh` and `edge.sh` use it for the GitHub contents API and a throwaway Docker login under their scratch folder.
  - GitHub revokes the token when the job ends, so the copy Run Command keeps on the VM (root-only) is dead within minutes.
  - CI exercises this path on every push: test-deploy's first deploy fetches through the API and signs in to ghcr.io with CI's own token.
- **The rest:** one deploy at a time, and a newer commit waits for the running one. Rollback is `deploy.sh rollback` (images only, see below).

**A deploy, in order:**
1. **Lock.** One deploy at a time (`flock`).
2. **Configuration at that exact commit.** The compose and Caddy files come from the GitHub
   contents API at `<sha>`, with the workflow's short-lived token (anonymously from
   `raw.githubusercontent.com` if there is none), and the compose file is validated.
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
| `backup.sh selftest` | once at setup: `run-on-vm.sh deploy/host/backup.sh selftest` | Proves, with the VM's real credentials, that each store accepts a new object on the first attempt and refuses a second create, an overwrite and a delete, then reads the probe back to prove it is unchanged |
| `backup.sh restore confirm=chitthi.dhruvgoyal.tech [manifest=…] [from=azure\|r2]` | in an incident ("Incidents") | Replaces the live database with a backup's, and brings back any media the disk lacks. Details below. |

Both timer services are capped at 256 MB and run at idle CPU and I/O priority.

**Append-only by design.** The VM never deletes or overwrites a backup:
- **Azure:** the VM's identity has a custom role with only `blobs/read` and `blobs/add/action`,
  scoped to the backup container. Every upload is a single Put Blob with `If-None-Match: *`.
  (Put Block needs `write`, which the role doesn't have.)
  - **A second create of an existing blob comes back 403, not 409** (seen on the VM, 2026-10-25). Azure checks authorization first: replacing a blob needs `write`, which the role lacks, so the request is refused before the `If-None-Match` condition is evaluated. The selftest accepts 403 or 409. The nightly media upload treats a 403 as "already there" only after a HEAD confirms the blob exists.
- **R2:** one `PutObject` per object over R2's S3 API, sent by curl, with `If-None-Match: *` so an
  existing key is never overwritten. The bucket lock refuses overwrites and deletes for 30 days.
  - **A second create of an existing key comes back 409, not 412** (seen on the VM, 2026-10-29). Under the bucket lock R2 refuses any write to a locked key with 409 before it evaluates `If-None-Match`, the same order as Azure's 403. The selftest accepts 409 or 412 and proves the refusal by reading the probe back. The nightly media upload treats 409 and 412 as "already there".
  - **Exactly what is sent** (`backup.sh`, `r2_*`): `curl -sS --max-time 600 -K <0600 config> -X PUT -T <file> -H "x-amz-content-sha256: <the file's sha256>" -H "If-None-Match: *" <endpoint>/<bucket>/<key>`. The config file holds `user = "<access key id>:<secret>"` and `aws-sigv4 = "aws:amz:auto:s3"`, so the keys never appear on a command line.
  - **Nothing is streamed and nothing is multipart.** Media is encrypted to a file first, so every object goes up in one request of known length. Listing is `GET ?list-type=2&prefix=…` (ListObjectsV2, following continuation tokens), and the drill and restore read with a plain signed `GET`.
  - **The signing is checked against our own SigV4 signer:** the one in `compact_media.py`, tested against AWS's published vector. On 2026-10-29 curl's PUT (with `If-None-Match` and the payload hash), its list (with an encoded continuation token) and its DELETE all verified.
  - **Version:** curl 8.5.0, as Ubuntu 24.04 ships it, with `--aws-sigv4`.
  - **Why not rclone any more** (rclone 1.60.1 from Ubuntu 24.04, `provider = Cloudflare`, `no_check_bucket = true`, `copy --immutable --no-traverse` and `rcat`): on 2026-10-25 R2 answered `501 NotImplemented`. `rcat` streams input of unknown length as a multipart upload (POST CreateMultipartUpload), and it failed on every attempt; `copy` failed its first attempt and succeeded on a retry. A single PutObject of known length is the most basic request R2 supports, and it removes rclone from the host.
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

**What a restore does** (`backup.sh restore`):
1. **Refuses without `confirm=chitthi.dhruvgoyal.tech`.**
2. **Fetches and checks everything before touching anything:** the manifest (the newest, or `manifest=manifests/<UTC>.json`), the dump against both of its sha256 records, and a trial decryption. It reads from Azure by default, or with `from=r2`.
3. **Keeps a copy of the current database:** stops the API, then dumps the live database to `/data/chitthi/pre-deploy/chitthi-pre-restore-<UTC>.dump`, in case the restore was the mistake.
4. **Replaces the database:** drops `chitthi`, recreates it, `pg_restore`s the dump, then checks the schema version and the counts.
5. **Brings back missing media:** every file the manifest lists that the disk lacks is decrypted next to its place, given to uid 10010 with mode 0600 (as the API writes them), and renamed into place.
6. **Brings the release back:** runs the release's migrations (the backup may be older than the code) and starts the API.

Then run `deploy.sh smoke`.

**Alerts and freshness:**
- healthchecks.io gets start, success and failure pings, with a one-line reason and never a
  secret. Its 26-hour freshness window catches a backup that silently didn't run.
- **The disk alert rides on the nightly check.** If `/data` is 80 % full or more, a successful run still pings "fail", with the reason ("backup … succeeded, but /data is N% full"). Azure has no metric for a filesystem's free space. See "Disk growth".
- Every deploy also fails if a timer isn't active or the last successful backup is more than 26
  hours old, once the first night is past.

**Key Vault secrets used** (on top of the deploy's):

| Secret | Used for |
|---|---|
| `chitthi-backup-age-recipient` | The public key backups are encrypted to |
| `chitthi-backup-age-identity` | The private key, read only by the drill and a restore |
| `chitthi-backup-age-identity-previous` | After a key rotation only: the old private key, kept while anything encrypted to it remains ("Secret rotation") |
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
  without the key, and the disk warning at its threshold;
- a drill that passes;
- a key rotation, after which the drill reads the new key's dump and the old key's media;
- a restore:
  - refused without `confirm=`;
  - with a media file deleted and a table added since the backup: the table is gone, the file is back intact with uid 10010 and mode 0600, the replaced database is kept, and the smoke test passes;
  - then again from R2;
- a tampered dump the drill catches;
- a deploy that confirms the timers and the fresh backup.

The Azure REST calls and R2 permissions themselves are proven on the VM by `backup.sh selftest`.

## Alerts

Everything below emails you. Each row says what it means and where to start; "Incidents" has the steps.
While the site is down by design, `chitthi-down.sh` has turned off the four `vm-*` alerts and
paused healthchecks.io and UptimeRobot; `chitthi-up.sh` turns them back on ("Up and down").
`role-assignment-changed` and the budget never pause.

| Alert | From | Means | First move |
|---|---|---|---|
| `vm-unavailable` (severity 1) | Azure metric | The VM is down or unreachable to Azure for 5 minutes | "The VM is down" |
| `vm-resource-health` | Azure activity log | Azure itself reports the VM's health changing: a host failure, maintenance, or a reboot. **Expected:** several during `setup.sh infra` (the VM is created, its disk attached and boot diagnostics enabled, and it reports Unknown, then Unavailable, then Available), and one around a security-update reboot (21:30 UTC, when one is needed) | Outside those times: read the event, then "The VM is down" |
| `vm-low-memory` | Azure metric | Under 100 MiB available for 15 minutes | `status.sh`: which container grew? See "Memory budget" |
| `vm-cpu-credits-low` | Azure metric | The burstable VM is about to be held to its baseline CPU | `status.sh`. A sustained load means the VM size no longer fits |
| `role-assignment-changed` | Azure activity log | A role assignment in the subscription succeeded. **Expected** only from `setup.sh infra` when it makes one: 5 on the first run (2 for the VM, 2 for you, 1 for the deploy identity), none on re-runs. Before 2026-10-24 the alert matched "Started" as well, so the first run sent 10. Deploys and backups never assign roles | Any other time: treat it as a compromise ("A credential is exposed") |
| Budget 50 / 80 / 100 % and 100 % forecast | Azure Cost Management | Spending this month | Cost Management → Cost analysis, grouped by resource |
| `chitthi-backup` down | healthchecks.io | Last night's backup failed (the reason is in the ping), didn't run, or `/data` is 80 % full | "A backup alert" |
| `chitthi-drill` down | healthchecks.io | The monthly restore drill failed or didn't run | "A backup alert" |
| Deploy workflow failed | GitHub (email on failed runs) | A deploy failed and rolled back, or the outside check failed | "A deploy failed" |
| A deploy is waiting for review | GitHub (the `production` environment) | A push to `main` passed CI and wants to deploy | Approve it, or reject it to skip that commit |
| UptimeRobot "down" | UptimeRobot, every 5 minutes from outside | `/api/health` didn't answer with `"db":"ok"`: the site, the API or its database is down, or the network path is broken | "The site is down, the VM is up" (or "The VM is down", if Azure alerted too) |
| `chitthi-backup` down, "the TLS certificate expires within 14 days" | The nightly backup, on the VM | Caddy's renewal has failed for over two weeks (it renews 30 days ahead) | "The certificate is about to expire" |

**Between deploys, two monitors watch the site:**
- **UptimeRobot** watches the site from outside, set up in step 27 of "Going live", with a test alert. It only reads the health endpoint and never carries chat traffic.
- **The nightly backup run** checks the certificate the VM serves, in case UptimeRobot's free plan has no SSL-expiry reminders.

## Secret rotation

`bash deploy/azure/setup.sh rotate name=<secret>` stores a new value: generated for passwords and the backup key, asked for (hidden, format-checked) for the rest. Then:

| Secret | Then | Takes effect |
|---|---|---|
| `chitthi-postgres-password` | Deploy (Actions → Deploy → Run workflow) | The deploy sets it in Postgres, through the local socket, before migrating |
| `chitthi-api-db-password` | Deploy | The migrate job sets it on the `chitthi_api` role, and the API's env file gets it |
| `chitthi-google-client-secret`, `chitthi-github-client-secret` (and the IDs) | Create the new secret at Google or GitHub first, then rotate, deploy, and delete the old secret there | The deploy writes `api.env` |
| `chitthi-r2-access-key-id`, `chitthi-r2-secret-access-key` | Create a new R2 token (Object Read & Write, this bucket only), rotate both, then revoke the old token | The next backup run: secrets are read on every run |
| `chitthi-hc-backup-url`, `chitthi-hc-drill-url` | Nothing more | The next run |
| `chitthi-backup-age-identity` (the backup key pair) | Rotate. The old private key moves to `chitthi-backup-age-identity-previous`, and a new pair takes over | Tonight's backup uses the new key. The drill and restore read both keys |

**About the backup key.** Rotate it only if it may be exposed: old media stays encrypted to the old key, since it is never re-uploaded. Update your offline copy of the private key.
- Delete `-previous` only once nothing encrypted to it remains. That is 12 weeks: dumps expire after 35 + 14 days, and media after compaction plus 14 days.
- Until then, `rotate` refuses to rotate again.

**Not secrets, nothing to rotate:**
- the deploy's GitHub token (a new one per job, revoked when the job ends);
- Azure access (OIDC and managed identities, no stored keys);
- the TLS certificate (Caddy renews it).

**Every value is checked in CI:** `deploy.sh` writes database passwords only if they're 24+ characters of `[A-Za-z0-9_-]`, and the deploy test rotates both database passwords on every push.

## Updates

| What | How it's updated | Who |
|---|---|---|
| Ubuntu packages, including Docker | unattended-upgrades, security updates daily. A reboot, when needed, at 21:30 UTC (03:00 IST); containers come back by themselves (`restart: unless-stopped`) | Automatic |
| Node dependencies | `npm install --save-exact --before=<today − 14 days> <pkg>@<version>`, the full gate, push. High or critical advisories: "Pending dependency upgrades" | You |
| Base images: `node`, `alpine`, `caddy`, `postgres` | Pick a version published at least 14 days ago and take its digest (`docker buildx imagetools inspect <image>:<tag>`). Replace it in `api/Dockerfile`, `web/Dockerfile`, `deploy/chitthi/compose.yaml` (Postgres) and `deploy/edge/compose.yaml` (the edge Caddy), and keep `.nvmrc` in step with Node. Push: CI builds, smoke-tests and measures. The deploy ships the app. For the edge, also run `run-on-vm.sh deploy/host/edge.sh sha=<commit> acme_email=…` | You |
| Postgres minor (18.x) | A new image digest in `deploy/chitthi/compose.yaml`; the deploy restarts the database on it | You |
| Postgres major (18 → 19) | Not in place: the data directory format changes. Take a backup (`run-on-vm.sh deploy/host/backup.sh run`). Change the image. Then, in one script through Run Command: stop the stack and move `/data/chitthi/pg` aside. Deploy, which starts an empty cluster on the new version. Then `backup.sh restore confirm=chitthi.dhruvgoyal.tech`. Delete the old directory a week later | You, in a quiet hour |
| Ubuntu's next LTS | Not in place. Build a new VM: delete the VM (the data disk stays, locked), run `setup.sh infra image=<the new LTS URN>` (check it exists in the region, "The VM image"), then bootstrap, edge and deploy. The data disk keeps the data | You, every couple of years |

## Disk growth

`/data` holds the database, media, pre-deploy dumps and the backup stage. Two guards:
- **The nightly backup check turns red** at 80 % used.
- **The API refuses uploads** (507) when free space falls below 15 % or 2 GB, whichever is larger. Chat keeps working.

**To grow it** (online; the app keeps running):
1. Make the disk bigger, for example 64 → 128 GiB (P6 → P10, which is no longer in the free allowance): `az disk update -g apps-host -n apps-vm-data --size-gb 128`. If Azure refuses while the disk is attached, `az vm deallocate -g apps-host -n apps-vm`, update, then `az vm start`. That means downtime.
2. Grow the filesystem: `bash deploy/azure/run-on-vm.sh deploy/host/grow-data-disk.sh`. It rescans the disk and runs `resize2fs` on the mounted ext4. CI does the same to a loop device on every push, with the stack running.
3. `status.sh` shows the new size.

Disks only grow. Shrinking means a new disk and a restore.

## Adding the second app (Hisaab)

The host was built for two apps. Hisaab gets its own of everything, and shares only the VM and the edge:

| Piece | Chitthi | Hisaab |
|---|---|---|
| Container uids | 10010 (app), 10011 (db) | 10020, 10021 |
| On the host | `/srv/chitthi`, `/data/chitthi/*` | `/srv/hisaab`, `/data/hisaab/*`. Add both, owned by its uids, to `bootstrap.sh`, and re-run it |
| Loopback ports | API 8082, web 5175 | API 8081, web 5174 (its dev ports) |
| Edge | `sites/chitthi.caddy`, written only by Chitthi's deploy | `sites/hisaab.caddy`, written only by Hisaab's deploy, validated the same way |
| Postgres | its own container, `mem_limit` 160m | its own |
| Azure | Key Vault, backup storage and deploy identity in resource group `chitthi` | the same set in its own resource group, from its own copy of `setup.sh`'s app half |
| GitHub | `DhruvGoyal404/chitthi` → `chitthi-deploy` | its repo → its own deploy identity, also limited to managed Run Command on `apps-vm` |
| Locks on the host | `/run/chitthi-deploy.lock` | `/run/hisaab-deploy.lock`. Both take `/run/edge-deploy.lock` around the edge reload |

**Before it goes live:**
- Measure it the way "Memory budget" measures Chitthi, and replace the stand-in rows with real numbers. If the busy total no longer fits the VM's ~900 MiB, the cheapest fix is one shared Postgres with a database and role per app (saves ~25 MiB idle). A bigger VM is next.
- The metadata guard and the firewall need no change: containers can't reach the metadata service whatever their app.

## Incidents

Start with `bash deploy/azure/run-on-vm.sh deploy/host/status.sh`. It shows memory, disk, recent API errors, backups, the last deploys, the certificate, containers and health. Also run `bash deploy/azure/public-check.sh` for what the world sees.

**The site is down, the VM is up.**
1. `status.sh`: is a container restarting? Are there errors in the API log?
2. If it broke at a deploy, roll back: Actions → Deploy → `rollback`, or `run-on-vm.sh deploy/host/deploy.sh rollback`.
3. Otherwise, redeploy the current commit (Actions → Deploy → `deploy`). That rewrites config and env files, and restarts everything that's down.

**The certificate is about to expire.** Caddy normally renews it 30 days ahead.
1. Read the edge's log through a small script: `docker compose -p edge --project-directory /srv/edge logs --since 24h caddy`.
2. The usual causes:
   - DNS no longer points to the VM;
   - port 80 is closed (the ACME HTTP challenge needs it);
   - Let's Encrypt rate limits after repeated failed attempts.
3. Fix the cause, then reload the edge: `run-on-vm.sh deploy/host/edge.sh sha=<commit> acme_email=…`, or restart it.

**The deploy can't sign in to Azure** (`AADSTS700213: No matching federated identity record found for presented assertion subject '…'`):
- The error names the subject GitHub sent. Compare it with what the credential trusts: `az identity federated-credential list -g chitthi --identity-name chitthi-deploy -o table`.
- `setup.sh infra` sets the credential from the GitHub API, and `setup.sh check` compares the exact string.
- If GitHub ever changes the format again, update `github_subject()` in `setup.sh` and re-run `infra`. As a stopgap, `az identity federated-credential update … --subject "<the subject from the error>"`.

**A deploy failed.** The workflow log shows which step failed. After the switch, a failure rolls back by itself, and the outside check then shows what's being served. Fix forward with a new commit.

Migrations never roll back. A migration that broke the previous release breaks the expand-then-contract rule ("Deploy and rollback"). Repair the schema with a new migration, or as a last resort restore the pre-deploy dump (`/data/chitthi/pre-deploy/`) with `pg_restore` through a script.

**The VM is down** (`vm-unavailable`, Resource Health):
1. Azure's own events (Resource Health) tell you whether it's a platform issue; if so, wait.
2. `az vm restart -g apps-host -n apps-vm`. If it doesn't come up, use the Serial Console ("Inventory and access").
3. **If the OS is beyond repair,** replace the VM. The data disk survives, with its delete lock and detach-on-delete:
   - `az vm delete -g apps-host -n apps-vm --yes`;
   - `setup.sh infra` (a new VM, with the existing data disk attached at LUN 0);
   - `run-on-vm.sh deploy/host/bootstrap.sh`, which finds ext4 and mounts it without formatting;
   - the edge, then a deploy.

   Nothing is restored, and nothing is lost. The public IP stays too, so DNS needs no change.

**The data disk is lost or corrupt:**
1. If it might still hold anything, snapshot it first: `az snapshot create -g apps-host -n apps-vm-data-old --source apps-vm-data`.
2. Remove its lock (`az lock delete -g apps-host -n do-not-delete --resource apps-vm-data --resource-type Microsoft.Compute/disks`). Then detach it (`az vm disk detach -g apps-host --vm-name apps-vm -n apps-vm-data`) and delete it (`az disk delete -g apps-host -n apps-vm-data`). Azure disks can't be renamed, and `setup.sh infra` recreates the name: a new, empty disk at LUN 0, with the lock back on.
3. `bootstrap.sh` formats the new disk, which has no signature. Then edge and deploy (an empty database).
4. `run-on-vm.sh deploy/host/backup.sh restore confirm=chitthi.dhruvgoyal.tech` (add `from=r2` if Azure's copy is unavailable).

At worst you lose everything since last night's backup (02:00 IST).

**A backup alert.** The ping carries the reason; healthchecks.io shows it.
- "/data is N% full": "Disk growth".
- Anything else: re-run it by hand with `run-on-vm.sh deploy/host/backup.sh run` and read the output.
- A failed drill means a backup that might not restore. Treat it as urgent until a drill passes again: `run-on-vm.sh deploy/host/backup.sh drill`.

**A credential is exposed:**
- **A Key Vault secret:** rotate it ("Secret rotation").
- **The VM may be compromised:**
  1. Take it off the network: `az network nsg rule delete -g apps-host --nsg-name apps-vm-nsg -n allow-https`, and the same for `allow-http`.
  2. Then replace the VM as above. Don't reuse its OS disk.
  3. Rotate every secret.
  4. The backups can't have been altered from the VM: Azure's copy is create-only, and R2 is locked for 30 days.
- **An unexpected role assignment:** remove it (`az role assignment delete`), then run `setup.sh check`, which fails while any identity holds more than its roles.
- **Your GitHub account:**
  1. Revoke your sessions and tokens.
  2. Check the `production` environment: its reviewers and its branch policy.
  3. Check the ruleset on `main`, then the federated credential (`setup.sh check`).
  4. Every deploy needs your approval, so an attacker with a stolen session could approve one. Revoke first.

**Over budget:** Cost Management shows which resource. `bash chitthi-down.sh` stops everything that bills while idle and ends with an audit naming whatever still does.

### Incident log

**2026-10-24: go-live, the first deploy couldn't sign in to Azure.**
- **What happened:** the Deploy workflow failed at OIDC sign-in with `AADSTS700213: No matching federated identity record found for presented assertion subject 'repo:DhruvGoyal404@151380878/chitthi@1425788626:environment:production'`.
- **Cause:** `setup.sh` had built the federated credential's subject by hand, as `repo:DhruvGoyal404/chitthi:environment:production`. GitHub sends the immutable-ID form, `repo:<owner>@<owner id>/<repo>@<repo id>:…` (the same as the CodeJudge AWS trust).
- **Why nothing caught it:** `setup.sh check` compared the credential against the same hand-built string, so it reported ok. A check must not compute its expected value the way the thing it checks was built.
- **Fixed by hand,** then by `setup.sh` itself:
  - The subject was corrected in Cloud Shell (`az identity federated-credential update … --subject "repo:DhruvGoyal404@151380878/chitthi@1425788626:environment:production"`), and Deploy #11 was green.
  - `setup.sh` now builds the subject from the GitHub API (owner id and repo id), and `check` compares that exact string.
  - The federated credential, the alerts (the same go-live had stopped on "activity log alert vm-resource-health already exists"), the NSG rules and the locks are all create-or-update now, so an `infra` re-run can't revert the fix or fail on what exists.
- **Tested:** CI runs `setup.sh infra` twice against a stand-in `az` (`deploy/azure/fake_az.py`). The stand-in refuses `create` on anything that exists, and evaluates `setup.sh`'s real queries with jmespath. The tests also prove that the old subject fails `check` and that a re-run repairs it, and that alerts left by an earlier run are updated.
- **Still unproven by CI:** that GitHub keeps this format. Only a real deploy proves the subject; the incident playbook covers that ("The deploy can't sign in to Azure").

**2026-10-25: the first real backup selftest and run.**
- **Azure: a false FAIL.** A second create was refused with 403, where the selftest expected 409. Both are refusals: authorization comes before the `If-None-Match` check (see "Append-only by design"). Fixed in the selftest, and the nightly media upload now handles the same 403.
- **R2: a real failure.** Every streamed `rclone rcat` got `501 NotImplemented`, and `rclone copy` needed a retry. That night's dump and manifest reached R2 on the retry; its two media files didn't.
  - The selftest's "overwrite refused" and "delete refused" lines proved nothing, because the overwrite failed with the same 501.
  - R2 now gets one curl `PutObject` per object. The selftest reads its probe back after each refused attempt, so a refusal is proven by the content, not the status code.
  - healthchecks.io turned `chitthi-backup` red that night, as designed.
- **Recovery:** the next run fills the missing R2 media by itself (it uploads what R2's listing lacks). Nothing on R2 needs deleting, and the 30-day lock wouldn't allow it.

**2026-10-29: the selftest after the curl change.** Every check passed but one: R2 refused the second create with 409, where the selftest expected 412. A false FAIL, like Azure's 403: the probe read back intact, and overwrite and delete were refused (409). The selftest now accepts 409 or 412. `run` and `drill` passed the same day, with R2 caught up.

## Pending dependency upgrades

A high or critical advisory whose fix is younger than the 14-day release rule gets a dated entry
in [`audit-exceptions.json`](../audit-exceptions.json). CI's audit
([`scripts/audit.sh`](../scripts/audit.sh)) treats it as excepted until the entry expires, then
fails with "upgrade". Each entry expires one day after its fix becomes installable, which leaves
a day to land the upgrade before CI turns red.

| Advisory | Severity | Exploitable in Chitthi? | Mitigation until the upgrade | Upgrade (own commit) | Exception expires |
|---|---|---|---|---|---|
| [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828), body-parser ≤ 2.3.0 (through Express 5.2.1) | High | **Yes, before the mitigation:** one unauthenticated request with a gzipped body plus trailing bytes crashed the API. Parsing runs before routing and before the session check. | `express.json({ inflate: false })`: compressed request bodies get 415, before any decompression (`e3638eb`). No client sends them. Test: `api/test/process.test.ts`, which crashed the real process before. | body-parser 2.4.0 (published 2026-10-22 11:39 UTC), **on 2026-11-06**: `npm update body-parser --before=2026-10-23`. Express's `^2.2.1` range allows it; check `npm ls body-parser` shows 2.4.0. Keep `inflate: false`. | 2026-11-07 |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), zod ≤ 4.6.5 | High | **Yes, before the mitigation, for signed-in users:** `.max()` did not stop zod validating every element first. One 98 KB body to `POST /conversations` or the send route meant 50,001 issues, +28 MiB of heap, 116–164 ms of CPU and a 4.3 MB error response. Three or four at once could exhaust the API's 96 MiB heap. | Arrays are length-checked before any element (`boundedArray` in `api/src/routes.ts`): the same body now costs one issue, 2.4 MiB and 11 ms. Error responses carry at most 10 issues (`MAX_ISSUES`). Test: `api/test/routes.db.test.ts`. | **Done 2026-10-29:** zod 4.6.7 (published 2026-10-12, the newest release past the 14-day rule by then), one copy (`npm ls zod`); exception removed. `boundedArray` and the cap stay. | (removed) |

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
