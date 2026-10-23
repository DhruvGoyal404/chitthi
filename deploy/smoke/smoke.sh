#!/usr/bin/env bash
# Smoke-tests the production stack exactly as deploy/ defines it, and measures its memory:
#   deploy/smoke/smoke.sh <api-image> <migrate-image> <web-image>
#
# Brings up deploy/chitthi (with throwaway secrets) and deploy/edge (with Caddy's internal CA in
# place of Let's Encrypt), points chitthi.dhruvgoyal.tech at 127.0.0.1, checks the edge and the
# production refusals, runs deploy/smoke/workload.mjs through the edge, and prints each
# container's memory: idle, under the workload, and the peak.
#
# CI only: it needs Linux (host networking, cgroup v2 files), sudo (/etc/hosts, data-directory
# owners), free ports 80/443/8082/5175, and `npm ci` done (the workload uses socket.io-client and
# sharp). Everything it creates is removed on exit.
set -euo pipefail

api_image=$1 migrate_image=$2 web_image=$3
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
host=chitthi.dhruvgoyal.tech
work=$(mktemp -d)
media=/dev/shm/chitthi-smoke-media
samples=$work/samples
pids=()

fail() { echo "FAIL: $*" >&2; exit 1; }

cleanup() {
  set +e
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null; done
  (cd "$work/chitthi" && docker compose -p chitthi logs --no-color api > "$work/api.log" 2>&1)
  if [[ ${status:-1} -ne 0 && -f $work/api.log ]]; then echo "--- API log (last 60 lines)"; tail -n 60 "$work/api.log"; fi
  (cd "$work/edge" && docker compose -p edge down -v --remove-orphans) >/dev/null 2>&1
  (cd "$work/chitthi" && docker compose -p chitthi --profile migrate down -v --remove-orphans) >/dev/null 2>&1
  (cd "$work/standin" && docker compose -p chitthi-standin down -v --remove-orphans) >/dev/null 2>&1
  sudo sed -i "/ $host\$/d" /etc/hosts
  sudo rm -rf "$work" "$media"
}
trap 'status=$?; cleanup' EXIT

secret() { openssl rand -hex 24; }

# --- The app stack, from the committed files, with secrets the way the deploy script writes them.
write_stack() { # <dir> <data dir>
  local dir=$1 data=$2 owner_pw api_pw
  owner_pw=$(secret) api_pw=$(secret)
  mkdir -p "$dir" "$data"
  cp "$repo/deploy/chitthi/compose.yaml" "$dir/"
  umask 077
  printf 'CHITTHI_API_IMAGE=%s\nCHITTHI_MIGRATE_IMAGE=%s\nCHITTHI_WEB_IMAGE=%s\nCHITTHI_DATA=%s\n' \
    "$api_image" "$migrate_image" "$web_image" "$data" > "$dir/.env"
  printf 'POSTGRES_PASSWORD=%s\n' "$owner_pw" > "$dir/db.env"
  printf 'MIGRATION_DATABASE_URL=postgres://chitthi:%s@db:5432/chitthi?sslmode=disable\nDATABASE_URL=postgres://chitthi_api:%s@db:5432/chitthi?sslmode=disable\n' \
    "$owner_pw" "$api_pw" > "$dir/migrate.env"
  printf 'DATABASE_URL=postgres://chitthi_api:%s@db:5432/chitthi?sslmode=disable\n' "$api_pw" > "$dir/api.env"
  umask 022
}

write_stack "$work/chitthi" "$work/data"
# Media on RAM-backed /dev/shm, as in the e2e job: the API refuses uploads below max(15 %, 2 GB)
# free, and runner disks can be fuller than that. The bind mount below replaces the data-disk one.
mkdir -p "$media" && sudo chown 1000:1000 "$media"
cat > "$work/chitthi/compose.override.yaml" <<EOF
services:
  api:
    volumes: !override
      - $media:/media
EOF

cd "$work/chitthi"
docker compose -p chitthi config --quiet
docker compose -p chitthi up -d --wait db
docker compose -p chitthi run --rm migrate
docker compose -p chitthi up -d --wait api web
echo "ok   stack up: db, migrate, api, web"

# A second Postgres, configured identically, standing in for the second app's database.
write_stack "$work/standin" "$work/standin-data"
(cd "$work/standin" && docker compose -p chitthi-standin up -d --wait db)

# --- The edge, from the committed files, with the internal CA.
mkdir -p "$work/edge" "$work/edge-data/caddy"
cp -r "$repo/deploy/edge/." "$work/edge/"
sudo chown 10002:10002 "$work/edge-data/caddy"
printf 'ACME_EMAIL=smoke@example.com\nEDGE_CA_OPTION=local_certs\nEDGE_DATA=%s\n' "$work/edge-data" > "$work/edge/.env"
echo "127.0.0.1 $host" | sudo tee -a /etc/hosts >/dev/null
(cd "$work/edge" && docker compose -p edge config --quiet && docker compose -p edge up -d --wait)
for _ in $(seq 1 40); do sudo test -s "$work/edge-data/caddy/caddy/pki/authorities/local/root.crt" && break; sleep 0.5; done
sudo cat "$work/edge-data/caddy/caddy/pki/authorities/local/root.crt" > "$work/root.crt"
for _ in $(seq 1 40); do curl -fsS --cacert "$work/root.crt" -o /dev/null "https://$host/api/health" 2>/dev/null && break; sleep 0.5; done
echo "ok   edge up: TLS for $host from the internal CA"

curl_edge() { curl -sS --cacert "$work/root.crt" "$@"; }

# --- The edge and the production refusals.
code=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "http://$host/c/x")
[[ $code == "308 https://$host/c/x" ]] || fail "plain HTTP is not redirected to HTTPS: $code"
headers=$(curl_edge -D - -o /dev/null "https://$host/")
grep -qF 'Strict-Transport-Security: max-age=31536000' <<<"$headers" || fail "no HSTS on the page"
grep -qF "frame-ancestors 'none'" <<<"$headers" || fail "the page lost its CSP through the edge"
grep -qi '^Server:' <<<"$headers" && fail "the edge announces its server"
headers=$(curl_edge -D - -o /dev/null "https://$host/api/health")
grep -qF "Content-Security-Policy: default-src 'none'" <<<"$headers" || fail "the API lost its CSP through the edge"
grep -qF 'Strict-Transport-Security: max-age=31536000' <<<"$headers" || fail "no HSTS on the API"
echo "ok   edge: HTTP→HTTPS, HSTS, CSPs intact, no Server header"

# The Origin allow-list guards every Engine.IO request; the session is checked at Socket.IO connect
# (the workload covers that: a socket without a session gets "unauthenticated").
code=$(curl_edge -o /dev/null -w '%{http_code}' -H "Origin: https://evil.example" "https://$host/api/socket.io/?EIO=4&transport=polling")
[[ $code == 403 ]] || fail "a Socket.IO handshake from a foreign Origin got $code, not 403"
code=$(curl_edge -o /dev/null -w '%{http_code}' "https://$host/api/socket.io/?EIO=4&transport=polling")
[[ $code == 403 ]] || fail "a Socket.IO handshake without Origin got $code, not 403"
code=$(curl_edge -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "https://$host/api/auth/logout")
[[ $code == 403 ]] || fail "a POST without Origin got $code, not 403"
code=$(curl_edge -o /dev/null -w '%{http_code}' -X POST -H "Origin: https://evil.example" -H 'Content-Type: application/json' -d '{}' "https://$host/api/auth/logout")
[[ $code == 403 ]] || fail "a POST from a foreign Origin got $code, not 403"
code=$(curl_edge -o /dev/null -w '%{http_code}' -X POST -H "Origin: https://$host" -H 'Content-Type: application/json' -d '{"handle":"x"}' "https://$host/api/dev/login")
[[ $code == 404 ]] || fail "the dev sign-in answered $code in production, not 404"
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:5432/ 2>/dev/null || true)
[[ $code == 000 ]] || fail "Postgres is reachable from the host"
set +e
out=$(docker run --rm -e NODE_ENV=production -e DEV_LOGIN=true -e MEDIA_DIR=/media \
  -e DATABASE_URL=postgres://u:p@db/x "$api_image" 2>&1)
code=$?
set -e
[[ $code -eq 1 && $out == *DEV_LOGIN* ]] || fail "the API started in production with DEV_LOGIN=true (exit $code)"
echo "ok   refusals: missing/foreign Origin (REST and Socket.IO), dev sign-in 404, DEV_LOGIN fatal, Postgres not on the host"

# --- Memory: cgroup v2 files of each container, sampled from the host every 250 ms.
containers=(chitthi-db-1 chitthi-api-1 chitthi-web-1 edge-caddy-1 chitthi-standin-db-1)
cgdir() {
  local id
  id=$(docker inspect -f '{{.Id}}' "$1")
  for d in "/sys/fs/cgroup/system.slice/docker-$id.scope" "/sys/fs/cgroup/docker/$id"; do
    [[ -d $d ]] && { echo "$d"; return; }
  done
  fail "no cgroup directory for $1"
}
declare -A cg
for c in "${containers[@]}"; do cg[$c]=$(cgdir "$c"); done
phase_file=$work/phase
sample() {
  while :; do
    local phase
    phase=$(cat "$phase_file")
    for c in "${containers[@]}"; do
      awk -v p="$phase" -v c="$c" '$1=="anon"{a=$2} $1=="kernel"{k=$2} $1=="shmem"{s=$2} $1=="file"{f=$2}
        END{print p, c, a, k, s, f}' "${cg[$c]}/memory.stat"
    done >> "$samples"
    sleep 0.25
  done
}

echo idle > "$phase_file"
sleep 10 # let start-up allocations settle before the idle window
sample & pids+=($!)
sleep 10

echo load > "$phase_file"
node "$here/workload.mjs" seed "$work/tokens.json" \
  | docker compose -p chitthi exec -T db psql -q -v ON_ERROR_STOP=1 -U chitthi -d chitthi >/dev/null
API_BASE="https://$host" WEB_BASE="https://$host" ORIGIN="https://$host" NODE_EXTRA_CA_CERTS="$work/root.crt" \
  IMAGE_MAX_PIXELS=$(docker compose -p chitthi exec -T api printenv IMAGE_MAX_PIXELS) \
  node "$here/workload.mjs" run "$work/tokens.json"
sleep 2
kill "${pids[@]}" 2>/dev/null; pids=()

# resident = anon + kernel + shmem: what can't be dropped under pressure. Page cache ("file") can,
# and is left out. For the API, shmem is mostly uploads sitting on /dev/shm in this run; on the
# VM they go to disk.
echo
echo "MEMORY (MiB)   resident = anon + kernel + shmem; peak = cgroup memory.peak since start (incl. page cache)"
printf '%-22s %10s %10s %10s %10s %10s %10s\n' container idle load-max anon-max shmem-max peak limit
for c in "${containers[@]}"; do
  read -r idle load anon shmem < <(awk -v c="$c" '$2==c { r=$3+$4+$5
      if ($1=="idle" && r>i) i=r; if ($1=="load" && r>l) l=r; if ($3>a) a=$3; if ($5>s) s=$5 }
    END { printf "%.1f %.1f %.1f %.1f\n", i/1048576, l/1048576, a/1048576, s/1048576 }' "$samples")
  peak=$(awk '{ printf "%.1f", $1/1048576 }' "${cg[$c]}/memory.peak")
  limit=$(awk '{ if ($1=="max") print "none"; else printf "%.0f", $1/1048576 }' "${cg[$c]}/memory.max")
  printf '%-22s %10s %10s %10s %10s %10s %10s\n' "$c" "$idle" "$load" "$anon" "$shmem" "$peak" "$limit"
done
for c in "${containers[@]}"; do
  oom=$(awk '$1=="oom_kill"{print $2}' "${cg[$c]}/memory.events")
  [[ $oom == 0 ]] || fail "$c was OOM-killed $oom time(s) during the smoke test"
done
echo "ok   no container hit its memory limit"

curl_edge -fsS -o /dev/null "https://$host/api/health" || fail "the API is not healthy after the workload"
echo "smoke test passed"
