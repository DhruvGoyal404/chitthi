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
  - one **max-size photo**, 6000×4000 (24.0 MP, 9.3 MB, the production pixel limit) through decode, EXIF strip, re-encode and thumbnail, then downloaded by two members;
  - one photo over the limit refused, and a history read.
- **The second Postgres** is configured identically and migrated, and stands idle. It's the stand-in for the second app's database.

### Measured

Local run on Docker Desktop (WSL2, kernel 6.18), 2026-10-23, production images and limits. CI
repeats this on Ubuntu 24.04 on every push and fails the build if any container is OOM-killed.

| Container | Idle resident | Under load (max resident) | `memory.peak` incl. page cache | `mem_limit` |
|---|---|---|---|---|
| chitthi db (Postgres) | 27 MiB | 59 MiB | 98 MiB | 160 MiB |
| chitthi api | 32 MiB, 64 MiB after load (V8 keeps its heap) | 129 MiB (the 24 MP decode) | 133 MiB | 256 MiB |
| chitthi web (Caddy, static) | 10 MiB | 10 MiB | 12 MiB | 32 MiB |
| second Postgres (stand-in), idle | 26 MiB | — | 79 MiB (mostly page cache from initdb) | 160 MiB |
| edge Caddy | measured in CI only (host networking) | | | 64 MiB |

### Budget

| | Steady | Busy: both apps under load, a max-size photo in flight |
|---|---|---|
| OS, Azure agent, dockerd, containerd, one shim per container (estimate; measure on the VM) | 300 | 300 |
| Edge Caddy (estimate until the CI number is recorded) | 20 | 30 |
| Chitthi: db + api + web | 27 + 64 + 10 = 101 | 59 + 129 + 10 = 198 |
| Second app: db (stand-in) + api (estimate: Chitthi's API without image work) + web | 26 + 60 + 10 = 96 | 59 + 80 + 10 = 149 |
| **Total** | **≈ 517 MiB** | **≈ 677 MiB** |
| **Left of ≈ 900 MiB** (page cache, headroom) | ≈ 380 MiB | ≈ 220 MiB |

**It fits, under these conditions:**
- **One image at a time** (`IMAGE_CONCURRENCY=1`). Each additional concurrent 24 MP decode would add about 70–100 MiB.
- **The 24 MP pixel limit** (`IMAGE_MAX_PIXELS=24000000`). The 50 MP default would roughly double the decode buffer.
- **The sharp cache off** (`IMAGE_CACHE=false`).
- **Postgres tuned small:**
  - `shared_buffers=32MB`, `work_mem=2MB`, 20 connections;
  - no parallel query, no JIT.
- **The API's V8 heap capped at 96 MiB.** sharp's memory is native and sits outside that cap.

**Limits are ceilings, not reservations.** Together they add up to more than the VM's memory, and
that is intended: they stop one runaway container, while the 2 GiB swapfile (host setup) absorbs
the rare moment when every app peaks at once.

**When the second app joins,** it is measured the same way, and its rows above are replaced with
real numbers. The way out, if it ever stops fitting: one shared Postgres with a database and role
per app saves about 25 MiB idle; a bigger VM costs more than the budget.
