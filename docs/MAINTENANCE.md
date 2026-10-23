# Running Chitthi in production

How the production deployment is built, run and repaired. This file grows with Phase 7: each
piece adds its section when it lands (host setup, deploy and rollback, backups and restore,
alerts, secret rotation, updates, disk growth, adding the second app, budget, incidents).

## Layout

- **VM:** Azure B2ats v2 (2 vCPU, 1 GiB), Ubuntu 24.04, Central India.
- **`deploy/edge`:** the shared Caddy (compose project `edge`, host network, ports 80 and 443).
  - `Caddyfile` holds the global options and a loopback-only liveness site on 127.0.0.1:2080.
  - `sites/<app>.caddy` holds one file per app.
- **`deploy/chitthi`:** Chitthi's stack (compose project `chitthi`).
  - **db:** Postgres 18, on an internal network only.
  - **migrate:** a one-off job.
  - **api:** on 127.0.0.1:8082.
  - **web:** on 127.0.0.1:5175.
  - Data lives under `/data/chitthi` on the data disk.
- **Secrets:** each container reads only its own env file (`db.env`, `migrate.env`, `api.env`).
  - The API never sees the database owner's password.
  - The compose `.env` holds only image digests and paths, so `docker compose config` is safe to print.
- **`deploy/smoke/smoke.sh`:** brings up both stacks exactly as committed, with throwaway secrets and Caddy's internal CA, then:
  - checks the edge and the production refusals;
  - runs `deploy/smoke/workload.mjs` through TLS;
  - prints the memory table.

  CI runs it on every push (the `images` job).

## Host setup

[`deploy/host/bootstrap.sh`](../deploy/host/bootstrap.sh) turns a fresh Ubuntu 24.04 VM into the host.

**Running it.** Use Run Command; there is no SSH:

```
az vm run-command invoke -g <rg> -n <vm> --command-id RunShellScript --scripts @deploy/host/bootstrap.sh
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

## Memory budget

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
