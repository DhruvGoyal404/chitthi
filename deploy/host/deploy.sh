#!/usr/bin/env bash
# Deploys a CI-built release of Chitthi on the VM, rolls it back, or smoke-tests what is running.
# Runs as root through Azure Run Command (the deploy workflow sends this file):
#
#   deploy.sh deploy sha=<git sha> api=<image@digest> migrate=<image@digest> web=<image@digest> \
#                    vault=<key vault name> storage=<account> container=<name> r2_bucket=<name>
#   deploy.sh rollback      back to the release before the current one (images only)
#   deploy.sh smoke         check what is running, through the edge and the public hostname
#
# deploy: fetch Chitthi's compose file and its site file at <sha>; check the site file against the
# whole edge configuration; write each container's env file from Key Vault (through the VM's
# managed identity); pull by digest; dump the database; migrate; start; install the site file and
# reload the edge; smoke-test. If anything fails after the switch, the previous release comes back
# automatically and the script exits non-zero either way.
#
# The edge is shared. This script writes exactly one file there, /srv/edge/sites/chitthi.caddy;
# the main Caddyfile, the edge's compose file and every other app's site file belong to others
# (deploy/host/edge.sh, the other apps' deploys) and are never written here.
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
SITE=$EDGE/sites/chitthi.caddy
EDGE_UID=10002
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
declare -A arg=()
for kv in "$@"; do
  [[ $kv == *=* ]] || die "argument '$kv' is not key=value"
  arg[${kv%%=*}]=${kv#*=}
done
for key in sha api migrate web vault storage container r2_bucket; do [[ -n ${arg[$key]:-} ]] || die "missing $key=..."; done
[[ ${arg[sha]} =~ ^[0-9a-f]{40}$ ]] || die "sha must be a full commit id"
for key in api migrate web; do
  [[ ${arg[$key]} =~ $IMAGE_RE && ${BASH_REMATCH[1]} == "$key" ]] || die "$key must be the chitthi-$key image pinned by digest"
done
[[ ${arg[vault]} =~ ^[A-Za-z0-9-]{3,24}$ ]] || die "vault is not a Key Vault name"
[[ ${arg[storage]} =~ ^[a-z0-9]{3,24}$ ]] || die "storage is not a storage account name"
[[ ${arg[container]} =~ ^[a-z0-9-]{3,63}$ ]] || die "container is not a blob container name"
[[ ${arg[r2_bucket]} =~ ^[a-z0-9-]{3,63}$ ]] || die "r2_bucket is not a bucket name"

exec 9>/run/chitthi-deploy.lock
flock -n 9 || die "another deploy is running"
[[ -d $SRV && -d $DATA/pg && -d $EDGE/sites ]] || die "the host is not bootstrapped (deploy/host/bootstrap.sh)"
[[ -f $EDGE/Caddyfile && -f $EDGE/.env && -f $EDGE/compose.yaml ]] || die "the edge is not installed (deploy/host/edge.sh)"
log "release ${arg[sha]}"

# --- Configuration files at exactly this commit: Chitthi's own, nothing of the edge's.
files=(deploy/chitthi/compose.yaml deploy/edge/sites/chitthi.caddy deploy/host/backup.sh)
for f in "${files[@]}"; do
  mkdir -p "$work/$(dirname "$f")"
  if [[ -n $TEST_CONFIG_DIR ]]; then
    cp "$TEST_CONFIG_DIR/$f" "$work/$f"
  else
    curl -fsSL --proto '=https' --max-time 30 -o "$work/$f" "https://raw.githubusercontent.com/$REPO/${arg[sha]}/$f"
  fi
done

# --- The new site file must validate together with the main Caddyfile and every other app's
# site file as they are now, in a one-off container run like the edge (same image, uid and
# capabilities). Checked before anything changes: a broken site file stops the deploy here.
validate_site() {
  local image
  rm -rf "$work/sites" && mkdir "$work/sites"
  find "$EDGE/sites" -maxdepth 1 -name '*.caddy' -type f -exec cp {} "$work/sites/" \;
  cp "$work/deploy/edge/sites/chitthi.caddy" "$work/sites/chitthi.caddy"
  image=$(edge config --images)
  docker run --rm --network none --read-only --user "$EDGE_UID:$EDGE_UID" --cap-drop ALL --cap-add NET_BIND_SERVICE \
    --security-opt no-new-privileges --tmpfs "/config:uid=$EDGE_UID,gid=$EDGE_UID,mode=0700" --tmpfs "/data:uid=$EDGE_UID,gid=$EDGE_UID,mode=0700" --env-file "$EDGE/.env" \
    -v "$EDGE/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$work/sites:/etc/caddy/sites:ro" \
    "$image" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>"$work/validate.log"
}
validate_site || { tail -n 5 "$work/validate.log" >&2; die "the site file at this commit does not validate with the edge's configuration; nothing was changed"; }
log "site file validates with the whole edge configuration"

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

# --- Edge: only Chitthi's own site file, under the edge lock (edge.sh and other apps' deploys
# take it too). Validated again against whatever the others have now, then reloaded. If Caddy
# refuses the reload, the old file goes back: the running configuration never changed, so every
# site, this one included, keeps being served as before.
exec 8>/run/edge-deploy.lock
flock -w 120 8 || failed "another deploy is holding the edge"
running=$(edge ps --status running --services 2>/dev/null || true)
grep -qx caddy <<<"$running" || failed "the edge is not running (deploy/host/edge.sh)"
if ! cmp -s "$work/deploy/edge/sites/chitthi.caddy" "$SITE"; then
  validate_site || failed "the site file no longer validates with the edge's configuration"
  [[ -f $SITE ]] && cp "$SITE" "$work/chitthi.caddy.old"
  cp "$work/deploy/edge/sites/chitthi.caddy" "$SITE"
  chmod 0644 "$SITE"
  if ! edge exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//run/caddy/admin.sock; then
    if [[ -f $work/chitthi.caddy.old ]]; then cp "$work/chitthi.caddy.old" "$SITE"; else rm -f "$SITE"; fi
    failed "Caddy refused the new site file; the old one is back"
  fi
  log "edge reloaded with the new site file"
fi
flock -u 8

smoke || failed "the smoke test failed"
record "${arg[sha]}" ok
log "deployed ${arg[sha]}"

# --- Backups: the script at this commit, its configuration, and its timers. Not part of the
# release's rollback point; a failure from here on fails the deploy without undoing it.
install -d -m 0700 "$SRV/bin"
install -m 0700 "$work/deploy/host/backup.sh" "$SRV/bin/backup.sh"
printf 'VAULT=%s\nAZ_ACCOUNT=%s\nAZ_CONTAINER=%s\nR2_BUCKET=%s\n' \
  "${arg[vault]}" "${arg[storage]}" "${arg[container]}" "${arg[r2_bucket]}" > "$SRV/backup.conf"
unit() { # <name> <contents>: written only when it changed
  if ! cmp -s <(printf '%s\n' "$2") "/etc/systemd/system/$1"; then
    printf '%s\n' "$2" > "/etc/systemd/system/$1"
    chmod 0644 "/etc/systemd/system/$1"
  fi
}
for job in backup:run restore-drill:drill; do
  unit "chitthi-${job%%:*}.service" "[Unit]
Description=Chitthi ${job%%:*} (deploy/host/backup.sh ${job#*:})
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=$SRV/bin/backup.sh ${job#*:}
Nice=10
IOSchedulingClass=idle
MemoryMax=256M
TimeoutStartSec=2h"
done
# 02:00 IST, before the 03:00 IST reboot window; the drill on the 1st, after it.
unit chitthi-backup.timer "[Unit]
Description=Nightly Chitthi backup

[Timer]
OnCalendar=*-*-* 20:30:00 UTC
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target"
unit chitthi-restore-drill.timer "[Unit]
Description=Monthly Chitthi restore drill

[Timer]
OnCalendar=*-*-01 23:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target"
systemctl daemon-reload
systemctl enable --now chitthi-backup.timer chitthi-restore-drill.timer >/dev/null 2>&1
[[ -f $SRV/backup-installed-at ]] || date -u +%s > "$SRV/backup-installed-at"

# Asserted on every deploy: both timers live, and the last backup under 26 hours old (once the
# first night is behind us).
for t in chitthi-backup.timer chitthi-restore-drill.timer; do
  if ! systemctl is-active --quiet "$t" || ! systemctl is-enabled --quiet "$t"; then die "deployed, but $t is not active and enabled"; fi
done
now=$(date -u +%s)
if [[ -f $DATA/backup-state/last-success ]]; then
  age_h=$(( (now - $(stat -c %Y "$DATA/backup-state/last-success")) / 3600 ))
  (( age_h < 26 )) || die "deployed, but the last successful backup is ${age_h} hours old"
  log "backups: timers active, last backup ${age_h} h ago"
elif (( now - $(cat "$SRV/backup-installed-at") > 26 * 3600 )); then
  die "deployed, but no backup has succeeded since the timers were installed over 26 hours ago"
else
  log "backups: timers active; the first backup runs tonight at 02:00 IST"
fi
