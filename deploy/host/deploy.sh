#!/usr/bin/env bash
# Deploys a CI-built release of Chitthi on the VM, rolls it back, or smoke-tests what is running.
# Runs as root through Azure Run Command (the deploy workflow sends this file):
#
#   deploy.sh deploy sha=<git sha> api=<image@digest> migrate=<image@digest> web=<image@digest> \
#                    vault=<key vault name> acme_email=<address> [acme_ca=production|staging]
#   deploy.sh rollback      back to the release before the current one (images only)
#   deploy.sh smoke         check what is running, through the edge and the public hostname
#
# deploy: fetch the compose and Caddy files at <sha>; write each container's env file from Key
# Vault (through the VM's managed identity); pull by digest; dump the database; migrate; start;
# update the edge; smoke-test. If anything fails after the switch, the previous release comes
# back automatically and the script exits non-zero either way.
#
# Migrations are forward-only, so a rollback restores images, never the schema: every migration
# must keep the previous release working (expand, then contract in a later release).
set -euo pipefail
umask 077

REPO=DhruvGoyal404/chitthi
HOST=chitthi.dhruvgoyal.tech
ORIGIN=https://$HOST
SRV=/srv/chitthi
EDGE=/srv/edge
DATA=/data/chitthi
DUMPS=$DATA/pre-deploy
KEEP_DUMPS=5
IMAGE_RE='^ghcr\.io/dhruvgoyal404/chitthi-(api|migrate|web)@sha256:[0-9a-f]{64}$'

# CI only, never on the VM: local images and config, secrets from files, the edge's internal CA.
TEST_CONFIG_DIR=${CHITTHI_TEST_CONFIG_DIR:-}
TEST_SECRETS_DIR=${CHITTHI_TEST_SECRETS_DIR:-}
TEST_CACERT=${CHITTHI_TEST_CACERT:-}
if [[ -n $TEST_CONFIG_DIR ]]; then IMAGE_RE='^chitthi-(api|migrate|web):[a-z0-9.-]+$'; fi

log() { echo "deploy: $*"; }
die() { echo "deploy: FAILED: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root"

work=$(mktemp -d /run/chitthi-deploy.XXXXXX)
trap 'rm -rf -- "$work"' EXIT

app() { docker compose -p chitthi --project-directory "$SRV" -f "$SRV/compose.yaml" "$@"; }
edge() { docker compose -p edge --project-directory "$EDGE" -f "$EDGE/compose.yaml" "$@"; }

# --- Smoke: the public hostname, resolved to this machine, through the edge and real TLS.
smoke() {
  local c=(curl -sS --max-time 10 --resolve "$HOST:443:127.0.0.1" --resolve "$HOST:80:127.0.0.1")
  [[ -n $TEST_CACERT ]] && c+=(--cacert "$TEST_CACERT")
  local i out code headers
  for i in $(seq 1 30); do
    out=$("${c[@]}" "https://$HOST/api/health" 2>/dev/null || true)
    [[ $out == '{"status":"ok","db":"ok"}' ]] && break
    [[ $i -eq 30 ]] && { echo "smoke: health never became ok (last: ${out:-no answer})"; return 1; }
    sleep 2
  done
  echo "ok   health: API and database"
  headers=$("${c[@]}" -D - -o /dev/null "https://$HOST/c/smoke")
  grep -qi '^HTTP/[0-9.]* 200' <<<"$headers" || { echo "smoke: the page did not answer 200"; return 1; }
  grep -qi "^content-security-policy: .*frame-ancestors 'none'" <<<"$headers" || { echo "smoke: the page has no CSP"; return 1; }
  grep -qi '^strict-transport-security: max-age=' <<<"$headers" || { echo "smoke: no HSTS"; return 1; }
  echo "ok   page: app shell, CSP, HSTS"
  code=$("${c[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' "http://$HOST/")
  [[ $code == "308 https://$HOST/" ]] || { echo "smoke: plain HTTP got '$code', not a redirect to HTTPS"; return 1; }
  out=$("${c[@]}" -H "Origin: $ORIGIN" "https://$HOST/api/socket.io/?EIO=4&transport=polling")
  [[ $out == 0\{* ]] || { echo "smoke: no Socket.IO handshake for the app's own Origin"; return 1; }
  code=$("${c[@]}" -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example' "https://$HOST/api/socket.io/?EIO=4&transport=polling")
  [[ $code == 403 ]] || { echo "smoke: a foreign Origin's Socket.IO handshake got $code"; return 1; }
  code=$("${c[@]}" -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "https://$HOST/api/auth/logout")
  [[ $code == 403 ]] || { echo "smoke: a POST without Origin got $code"; return 1; }
  code=$("${c[@]}" -o /dev/null -w '%{http_code}' -X POST -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{}' "https://$HOST/api/dev/login")
  [[ $code == 404 ]] || { echo "smoke: the dev sign-in answered $code"; return 1; }
  echo "ok   Socket.IO handshake; foreign Origin and Origin-less POST refused; no dev sign-in"
}

# --- Rollback: the previous release's image references and compose file, no migrations.
rollback() {
  [[ -f $SRV/.env.previous && -f $SRV/compose.yaml.previous ]] || die "there is no previous release to roll back to"
  log "rolling back to $(grep -h '^CHITTHI_API_IMAGE=' "$SRV/.env.previous" | cut -d= -f2-)"
  cp "$SRV/.env" "$SRV/.env.failed" && cp "$SRV/compose.yaml" "$SRV/compose.yaml.failed"
  cp "$SRV/.env.previous" "$SRV/.env" && cp "$SRV/compose.yaml.previous" "$SRV/compose.yaml"
  # Called where set -e doesn't reach (if, ||), so every step returns its failure explicitly.
  app up -d --wait --remove-orphans db api web || return 1
  smoke
}

record() { printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$1" "$2" >> "$SRV/deploys.log"; }

case ${1:-} in
  smoke) smoke; exit ;;
  rollback)
    exec 9>/run/chitthi-deploy.lock
    flock -n 9 || die "another deploy is running"
    if rollback; then record rollback ok; log "rolled back"; exit 0; fi
    record rollback failed; die "rollback did not pass its smoke test"
    ;;
  deploy) shift ;;
  *) die "usage: deploy.sh deploy key=value... | rollback | smoke" ;;
esac

# --- Arguments.
declare -A arg=([acme_ca]=production)
for kv in "$@"; do
  [[ $kv == *=* ]] || die "argument '$kv' is not key=value"
  arg[${kv%%=*}]=${kv#*=}
done
for key in sha api migrate web vault acme_email; do [[ -n ${arg[$key]:-} ]] || die "missing $key=..."; done
[[ ${arg[sha]} =~ ^[0-9a-f]{40}$ ]] || die "sha must be a full commit id"
for key in api migrate web; do
  [[ ${arg[$key]} =~ $IMAGE_RE && ${BASH_REMATCH[1]} == "$key" ]] || die "$key must be the chitthi-$key image pinned by digest"
done
[[ ${arg[vault]} =~ ^[A-Za-z0-9-]{3,24}$ ]] || die "vault is not a Key Vault name"
[[ ${arg[acme_email]} =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]] || die "acme_email is not an email address"
case ${arg[acme_ca]} in
  production) ca_option= ;;
  staging) ca_option='acme_ca https://acme-staging-v02.api.letsencrypt.org/directory' ;;
  local) [[ -n $TEST_CONFIG_DIR ]] || die "acme_ca=local is for CI only"; ca_option=local_certs ;;
  *) die "acme_ca must be production or staging" ;;
esac

exec 9>/run/chitthi-deploy.lock
flock -n 9 || die "another deploy is running"
[[ -d $SRV && -d $DATA/pg && -d $EDGE ]] || die "the host is not bootstrapped (deploy/host/bootstrap.sh)"
log "release ${arg[sha]}"

# --- Configuration files at exactly this commit.
files=(deploy/chitthi/compose.yaml deploy/edge/compose.yaml deploy/edge/Caddyfile deploy/edge/sites/chitthi.caddy)
for f in "${files[@]}"; do
  mkdir -p "$work/$(dirname "$f")"
  if [[ -n $TEST_CONFIG_DIR ]]; then
    cp "$TEST_CONFIG_DIR/$f" "$work/$f"
  else
    curl -fsSL --proto '=https' --max-time 30 -o "$work/$f" "https://raw.githubusercontent.com/$REPO/${arg[sha]}/$f"
  fi
done

# --- Secrets: Key Vault through the managed identity. Values are never printed, never put on a
# command line (where other users could read them in /proc), and only written to 0600 files.
if [[ -z $TEST_SECRETS_DIR ]]; then
  token=$(curl -fsS --max-time 10 -H Metadata:true \
    'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net' | jq -r .access_token)
  [[ -n $token && $token != null ]] || die "no managed identity token for Key Vault"
  printf 'Authorization: Bearer %s\n' "$token" > "$work/auth"
  unset token
fi
secret() { # <name>: one Key Vault secret, checked for shape
  local v
  if [[ -n $TEST_SECRETS_DIR ]]; then
    v=$(cat "$TEST_SECRETS_DIR/$1")
  else
    v=$(curl -fsS --max-time 10 -H @"$work/auth" "https://${arg[vault]}.vault.azure.net/secrets/$1?api-version=7.4" | jq -r .value) \
      || die "could not read secret $1"
  fi
  [[ -n $v && $v != null && $v != *[[:space:]]* ]] || die "secret $1 is empty or contains whitespace"
  printf '%s' "$v"
}
# Each into a variable first: a failing $(secret ...) inside printf's arguments would go unnoticed.
db_password=$(secret chitthi-postgres-password)
api_password=$(secret chitthi-api-db-password)
google_id=$(secret chitthi-google-client-id)
google_secret=$(secret chitthi-google-client-secret)
github_id=$(secret chitthi-github-client-id)
github_secret=$(secret chitthi-github-client-secret)
for p in "$db_password" "$api_password"; do
  # Hex or base64url only, so they go into connection URLs without escaping.
  [[ $p =~ ^[A-Za-z0-9_-]{24,}$ ]] || die "database passwords must be 24+ characters of [A-Za-z0-9_-]"
done
{
  printf 'POSTGRES_PASSWORD=%s\n' "$db_password"
} > "$work/db.env"
{
  printf 'MIGRATION_DATABASE_URL=postgres://chitthi:%s@db:5432/chitthi?sslmode=disable\n' "$db_password"
  printf 'DATABASE_URL=postgres://chitthi_api:%s@db:5432/chitthi?sslmode=disable\n' "$api_password"
} > "$work/migrate.env"
{
  printf 'DATABASE_URL=postgres://chitthi_api:%s@db:5432/chitthi?sslmode=disable\n' "$api_password"
  printf 'GOOGLE_CLIENT_ID=%s\nGOOGLE_CLIENT_SECRET=%s\n' "$google_id" "$google_secret"
  printf 'GITHUB_CLIENT_ID=%s\nGITHUB_CLIENT_SECRET=%s\n' "$github_id" "$github_secret"
} > "$work/api.env"
unset db_password api_password google_id google_secret github_id github_secret
rm -f "$work/auth"
printf 'CHITTHI_API_IMAGE=%s\nCHITTHI_MIGRATE_IMAGE=%s\nCHITTHI_WEB_IMAGE=%s\nCHITTHI_DATA=%s\n' \
  "${arg[api]}" "${arg[migrate]}" "${arg[web]}" "$DATA" > "$work/.env"
docker compose -p chitthi --project-directory "$work" -f "$work/deploy/chitthi/compose.yaml" \
  --env-file "$work/.env" config --quiet 2>/dev/null || die "the compose file at this commit is invalid"
log "configuration and secrets ready"

# --- Images, by digest, before anything stops.
if [[ -z $TEST_CONFIG_DIR ]]; then
  for key in api migrate web; do docker pull -q "${arg[$key]}" >/dev/null; done
  log "images pulled"
fi

# --- Switch. The current release becomes the rollback point (unless this is a re-deploy of it).
cp "$work/db.env" "$work/migrate.env" "$work/api.env" "$SRV/"
if [[ -f $SRV/.env ]] && ! cmp -s "$work/.env" "$SRV/.env"; then
  cp "$SRV/.env" "$SRV/.env.previous"
  cp "$SRV/compose.yaml" "$SRV/compose.yaml.previous"
fi
cp "$work/.env" "$SRV/.env"
cp "$work/deploy/chitthi/compose.yaml" "$SRV/compose.yaml"

failed() {
  echo "deploy: $1" >&2
  if [[ -f $SRV/.env.previous ]] && ! cmp -s "$SRV/.env.previous" "$SRV/.env"; then
    if rollback; then record "${arg[sha]}" "failed, rolled back"; die "$1; rolled back to the previous release"; fi
    record "${arg[sha]}" "failed, rollback failed"; die "$1; the rollback failed too: run 'deploy.sh smoke' and see docs/MAINTENANCE.md"
  fi
  record "${arg[sha]}" failed
  die "$1; there is no previous release to roll back to"
}

app up -d --wait db || failed "Postgres did not become healthy"
running=$(app ps --status running --services)
if grep -qx api <<<"$running"; then
  install -d -m 0700 "$DUMPS"
  dump=$DUMPS/chitthi-$(date -u +%Y%m%dT%H%M%SZ).dump
  app exec -T db pg_dump -U chitthi -d chitthi -Fc > "$dump" || failed "the pre-deploy dump failed"
  # The newest few only: nightly backups (off the VM) are the real history.
  find "$DUMPS" -name 'chitthi-*.dump' -type f -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP_DUMPS + 1)) | cut -d' ' -f2- | xargs -r rm -f --
  log "pre-deploy dump: $(du -h "$dump" | cut -f1)"
fi
app run --rm migrate || failed "the migrations failed"
app up -d --wait --remove-orphans api web || failed "the API or web container did not become healthy"
log "app up"

# --- Edge: write the shared files in place (Caddyfile is a single-file bind mount, so its inode
# must stay), then start Caddy, or reload it if its configuration changed. A reload with a broken
# Caddyfile is refused and the running configuration stays.
install -d -m 0755 "$EDGE/sites"
printf 'ACME_EMAIL=%s\nEDGE_CA_OPTION=%s\nEDGE_DATA=/data/edge\n' "${arg[acme_email]}" "$ca_option" > "$work/edge.env"
changed=()
for pair in "compose.yaml:$EDGE/compose.yaml" "Caddyfile:$EDGE/Caddyfile" "sites/chitthi.caddy:$EDGE/sites/chitthi.caddy" ; do
  src=$work/deploy/edge/${pair%%:*} dst=${pair#*:}
  cmp -s "$src" "$dst" || { cp "$src" "$dst"; chmod 0644 "$dst"; changed+=("${pair%%:*}"); }
done
cmp -s "$work/edge.env" "$EDGE/.env" || { cp "$work/edge.env" "$EDGE/.env"; changed+=(.env); }
running=$(edge ps --status running --services 2>/dev/null || true)
if ! grep -qx caddy <<<"$running" || [[ " ${changed[*]} " == *" compose.yaml "* || " ${changed[*]} " == *" .env "* ]]; then
  edge up -d --wait || failed "the edge did not start"
elif [[ ${#changed[@]} -gt 0 ]]; then
  edge exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//run/caddy/admin.sock \
    || failed "the edge refused the new Caddyfile"
fi
log "edge up${changed[*]:+ (changed: ${changed[*]})}"

smoke || failed "the smoke test failed"
record "${arg[sha]}" ok
log "deployed ${arg[sha]}"
