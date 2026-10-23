#!/usr/bin/env bash
# Installs or updates the shared edge Caddy: its compose file, its main Caddyfile and its .env.
# Host infrastructure, not part of any app: no app's deploy runs this, and this never writes a
# site file. Each app owns exactly one file, /srv/edge/sites/<app>.caddy, written by its deploy.
# Runs as root through Azure Run Command:
#
#   edge.sh sha=<git sha> acme_email=<address> [acme_ca=production|staging]
#
# A changed Caddyfile is validated with every site file already present before it replaces the
# running one; if Caddy refuses it anyway, the old file is put back.
set -euo pipefail
umask 022

REPO=DhruvGoyal404/chitthi
EDGE=/srv/edge
EDGE_UID=10002
TEST_CONFIG_DIR=${CHITTHI_TEST_CONFIG_DIR:-} # CI only

log() { echo "edge: $*"; }
die() { echo "edge: FAILED: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root"
[[ -d $EDGE/sites && -d /data/edge/caddy ]] || die "the host is not bootstrapped (deploy/host/bootstrap.sh)"

declare -A arg=([acme_ca]=production)
for kv in "$@"; do
  [[ $kv == *=* ]] || die "argument '$kv' is not key=value"
  arg[${kv%%=*}]=${kv#*=}
done
[[ ${arg[sha]:-} =~ ^[0-9a-f]{40}$ ]] || die "sha= must be a full commit id"
[[ ${arg[acme_email]:-} =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]] || die "acme_email= must be an email address"
case ${arg[acme_ca]} in
  production) ca_option= ;;
  staging) ca_option='acme_ca https://acme-staging-v02.api.letsencrypt.org/directory' ;;
  local) [[ -n $TEST_CONFIG_DIR ]] || die "acme_ca=local is for CI only"; ca_option=local_certs ;;
  *) die "acme_ca must be production or staging" ;;
esac

exec 9>/run/edge-deploy.lock
flock -w 120 9 || die "another edge or app deploy is holding the edge"
work=$(mktemp -d /run/edge.XXXXXX)
trap 'rm -rf -- "$work"' EXIT

for f in compose.yaml Caddyfile; do
  if [[ -n $TEST_CONFIG_DIR ]]; then
    cp "$TEST_CONFIG_DIR/deploy/edge/$f" "$work/$f"
  else
    curl -fsSL --proto '=https' --max-time 30 -o "$work/$f" "https://raw.githubusercontent.com/$REPO/${arg[sha]}/deploy/edge/$f"
  fi
done
printf 'ACME_EMAIL=%s\nEDGE_CA_OPTION=%s\nEDGE_DATA=/data/edge\nEDGE_UID=%s\n' \
  "${arg[acme_email]}" "$ca_option" "$EDGE_UID" > "$work/.env"
chmod 0600 "$work/.env"

edge() { docker compose -p edge --project-directory "$EDGE" -f "$EDGE/compose.yaml" "$@"; }

# The candidate Caddyfile with every site file as it is now, in a one-off container run like the
# edge itself (same image, uid and capabilities), never touching the running one.
image=$(docker compose -p edge --project-directory "$work" -f "$work/compose.yaml" --env-file "$work/.env" config --images)
docker run --rm --network none --read-only --user "$EDGE_UID:$EDGE_UID" --cap-drop ALL --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges --tmpfs "/config:uid=$EDGE_UID,gid=$EDGE_UID,mode=0700" --tmpfs "/data:uid=$EDGE_UID,gid=$EDGE_UID,mode=0700" --env-file "$work/.env" \
  -v "$work/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$EDGE/sites:/etc/caddy/sites:ro" \
  "$image" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>"$work/validate.log" \
  || { cat "$work/validate.log" >&2; die "the new Caddyfile does not validate with the current site files"; }

changed=()
for f in compose.yaml .env; do
  cmp -s "$work/$f" "$EDGE/$f" || { cp "$work/$f" "$EDGE/$f"; changed+=("$f"); }
done
# The Caddyfile is a single-file bind mount: written in place (same inode), with the old copy kept.
caddyfile_changed=0
if ! cmp -s "$work/Caddyfile" "$EDGE/Caddyfile"; then
  [[ -f $EDGE/Caddyfile ]] && cp "$EDGE/Caddyfile" "$work/Caddyfile.old"
  cp "$work/Caddyfile" "$EDGE/Caddyfile"
  chmod 0644 "$EDGE/Caddyfile"
  caddyfile_changed=1
fi

running=$(edge ps --status running --services 2>/dev/null || true)
if ! grep -qx caddy <<<"$running" || [[ ${#changed[@]} -gt 0 ]]; then
  edge up -d --wait || die "the edge did not start"
  log "started (changed: ${changed[*]:-none}$( ((caddyfile_changed)) && echo ', Caddyfile'))"
elif ((caddyfile_changed)); then
  if ! edge exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//run/caddy/admin.sock; then
    [[ -f $work/Caddyfile.old ]] && cp "$work/Caddyfile.old" "$EDGE/Caddyfile"
    die "Caddy refused the new Caddyfile; the old one is back and still running"
  fi
  log "reloaded with the new Caddyfile"
else
  log "unchanged"
fi
