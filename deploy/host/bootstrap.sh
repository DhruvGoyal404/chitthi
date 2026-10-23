#!/usr/bin/env bash
# Prepares an Ubuntu 24.04 VM to host Chitthi (and, later, the second app) behind the edge Caddy.
# Run as root, through Azure Run Command:
#   az vm run-command invoke -g <rg> -n <vm> --command-id RunShellScript --scripts @deploy/host/bootstrap.sh
# Idempotent: run it again after any change to this file; it converges and re-verifies.
#
#   DATA_DEVICE  the data disk (default: Azure's LUN 0 link). CI passes a loop device.
#   SWAP_SIZE    swapfile size (default 2G).
#
# It never formats a device that carries any signature (filesystem, partition table, RAID...),
# and refuses a data disk that isn't ext4 instead of guessing.
set -euo pipefail

SWAP_SIZE=${SWAP_SIZE:-2G}
# Container uids, one set per app, so no two apps share a uid on the host (deploy/*/compose.yaml).
EDGE_UID=10002
APP_UIDS=(chitthi:10010 chitthi-db:10011)
# What only root may reach (iptables matches): the instance metadata service, which hands out
# identity tokens, and the wireserver. 168.63.129.16 is also the VM's DNS resolver, so port 53
# stays open there; blocking it would break name resolution for systemd-resolved and containers.
GUARDED=("-d 169.254.169.254/32" "-d 168.63.129.16/32 -p tcp ! --dport 53")
# Alpine 3.24.2 (pushed 2026-09-18), the digest the web image builds on: the container probe.
PROBE_IMAGE=alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

log() { echo "bootstrap: $*"; }
die() { echo "bootstrap: FAILED: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root"
# shellcheck source=/dev/null
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || die "expected Ubuntu 24.04, found $ID $VERSION_ID"
export DEBIAN_FRONTEND=noninteractive

# --- Packages. Docker comes from Ubuntu's archive (docker.io, docker-compose-v2), so its security
# fixes arrive through unattended-upgrades like every other package.
log "packages"
apt-get update -q
packages=(ca-certificates curl jq ufw unattended-upgrades iptables)
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  packages+=(docker.io docker-compose-v2)
fi
apt-get install -y -q --no-install-recommends "${packages[@]}"

# --- Less running: no SSH (port 22 is closed everywhere; access is Run Command, or the Serial
# Console in an emergency), no snaps, no multipath (Azure disks don't use it). Each idle daemon
# costs RAM a 1 GiB VM doesn't have.
log "services"
for unit in ssh.socket ssh.service multipathd.socket multipathd.service; do
  if systemctl list-unit-files "$unit" >/dev/null 2>&1; then systemctl disable --now "$unit" >/dev/null 2>&1 || true; fi
done
if dpkg -s snapd >/dev/null 2>&1; then apt-get purge -y -q snapd; fi

# --- Users: one per container uid, never able to log in.
log "users"
ensure_user() { # <name> <uid>
  local name=$1 uid=$2 have
  if have=$(getent passwd "$uid" | cut -d: -f1) && [[ -n $have && $have != "$name" ]]; then
    die "uid $uid belongs to $have, not $name"
  fi
  getent group "$name" >/dev/null || groupadd --system --gid "$uid" "$name"
  id "$name" >/dev/null 2>&1 || useradd --system --uid "$uid" --gid "$uid" --no-create-home \
    --home-dir /nonexistent --shell /usr/sbin/nologin "$name"
  [[ $(id -u "$name") == "$uid" ]] || die "$name has uid $(id -u "$name"), expected $uid"
}
ensure_user edge "$EDGE_UID"
for pair in "${APP_UIDS[@]}"; do ensure_user "${pair%%:*}" "${pair##*:}"; done

# --- Data disk on /data, mounted by UUID.
log "data disk"
device=${DATA_DEVICE:-}
if [[ -z $device ]]; then
  for link in /dev/disk/azure/data/by-lun/0 /dev/disk/azure/scsi1/lun0; do
    [[ -e $link ]] && { device=$link; break; }
  done
fi
[[ -n $device ]] || die "no data disk found (attach one at LUN 0, or set DATA_DEVICE)"
device=$(readlink -f "$device")
[[ -b $device ]] || die "$device is not a block device"
# blkid -p exits 2 when the device carries no signature of any kind: only then is it new.
set +e
blkid -p "$device" >/dev/null 2>&1
probe=$?
set -e
if [[ $probe -eq 2 ]]; then
  [[ -z $(lsblk -no MOUNTPOINTS "$device" | tr -d '[:space:]') ]] || die "$device is mounted"
  log "formatting the empty data disk $device as ext4"
  mkfs.ext4 -q -L data -m 1 "$device"
fi
fstype=$(blkid -s TYPE -o value "$device" || true)
[[ $fstype == ext4 ]] || die "$device holds '${fstype:-a partition table or unknown data}', not ext4; refusing to touch it"
uuid=$(blkid -s UUID -o value "$device")
current=$(findmnt --fstab -n -o SOURCE /data || true)
if [[ -z $current ]]; then
  echo "UUID=$uuid /data ext4 defaults,nofail,noatime,x-systemd.device-timeout=10s 0 2" >> /etc/fstab
  systemctl daemon-reload
elif [[ $current != "UUID=$uuid" ]]; then
  die "/etc/fstab mounts $current on /data, not this disk (UUID=$uuid)"
fi
install -d -m 0755 /data
mountpoint -q /data || mount /data

# --- Directories. Configuration and env files: root only. Data: each owned by the uid that writes it.
log "directories"
install -d -m 0755 /srv/edge /srv/edge/sites
install -d -m 0700 /srv/chitthi
install -d -m 0711 /data/edge /data/chitthi
install -d -m 0700 -o "$EDGE_UID" -g "$EDGE_UID" /data/edge/caddy
install -d -m 0700 -o 10011 -g 10011 /data/chitthi/pg
install -d -m 0700 -o 10010 -g 10010 /data/chitthi/media

# --- Swap: a safety net for the rare moment every container peaks at once (docs/MAINTENANCE.md).
log "swap"
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l "$SWAP_SIZE" /swapfile
    chmod 0600 /swapfile
    mkswap -q /swapfile
  fi
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

# --- Kernel settings.
log "sysctl"
cat > /etc/sysctl.d/90-chitthi.conf <<'EOF'
# Swap only under real pressure.
vm.swappiness = 10
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
EOF
sysctl -q --system

# --- Logs can't fill the disk: journald capped here, containers capped in daemon.json.
log "journald"
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/90-chitthi.conf <<'EOF'
[Journal]
SystemMaxUse=200M
MaxRetentionSec=1month
EOF
systemctl restart systemd-journald

# --- Docker daemon: capped local logs, containers survive a daemon upgrade (live-restore), no
# docker-proxy process per published port, no-new-privileges by default. Merged into any
# existing daemon.json; restarted only when something changed.
log "docker"
install -d /etc/docker
want='{"log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"},"live-restore":true,"userland-proxy":false,"no-new-privileges":true}'
have=$(cat /etc/docker/daemon.json 2>/dev/null || echo '{}')
merged=$(jq -S -s '.[0] * .[1]' <(echo "$have") <(echo "$want"))
if [[ $(jq -S . <<<"$have") != "$merged" ]]; then
  echo "$merged" > /etc/docker/daemon.json
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null

# --- Only root may ask the metadata service for identity tokens (they unlock Key Vault and the
# backup storage). Containers never reach it, so one app can't read the other's secrets.
log "metadata guard"
{
  echo '#!/bin/sh'
  echo '# Installed by deploy/host/bootstrap.sh. Idempotent: adds each rule only if it is missing.'
  echo 'set -e'
  for match in "${GUARDED[@]}"; do
    echo "iptables -C DOCKER-USER $match -j REJECT 2>/dev/null || iptables -I DOCKER-USER $match -j REJECT"
    echo "iptables -C OUTPUT $match -m owner ! --uid-owner 0 -j REJECT 2>/dev/null || iptables -I OUTPUT $match -m owner ! --uid-owner 0 -j REJECT"
  done
} > /usr/local/sbin/metadata-guard
chmod 0755 /usr/local/sbin/metadata-guard
cat > /etc/systemd/system/metadata-guard.service <<'EOF'
[Unit]
Description=Keep containers and non-root users away from the Azure metadata endpoints
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/metadata-guard

[Install]
WantedBy=docker.service multi-user.target
EOF
systemctl daemon-reload
systemctl enable metadata-guard.service >/dev/null
systemctl restart metadata-guard.service

# --- Firewall: 80 and 443 in, nothing else (the network security group says the same).
log "firewall"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw delete allow OpenSSH >/dev/null 2>&1 || true
ufw delete allow 22/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null

# --- Security updates every night; a reboot, when one needs it, at 03:00 IST (21:30 UTC),
# after the nightly backup.
log "unattended upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat > /etc/apt/apt.conf.d/52chitthi-unattended-upgrades <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "21:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
systemctl enable --now unattended-upgrades.service >/dev/null

# --- Verify everything above, every run.
log "verifying"
owner_mode() { stat -c %u:%a "$1"; }
v_data_disk() { [[ $(findmnt -n -o FSTYPE /data) == ext4 && $(findmnt -n -o SOURCE /data) == "$device" ]]; }
v_data_dirs() {
  [[ $(owner_mode /data/chitthi/pg) == 10011:700 && $(owner_mode /data/chitthi/media) == 10010:700     && $(owner_mode /data/edge/caddy) == "$EDGE_UID:700" && $(owner_mode /srv/chitthi) == 0:700 ]]
}
v_swap() { swapon --show=NAME --noheadings | grep -qx /swapfile && [[ $(sysctl -n vm.swappiness) == 10 ]]; }
v_docker() {
  docker compose version && [[ $(docker info -f '{{.LiveRestoreEnabled}}') == true ]] && ! pgrep -x docker-proxy
}
v_firewall() {
  local status
  status=$(ufw status)
  grep -q '^Status: active' <<<"$status" && grep -q '^80/tcp .*ALLOW' <<<"$status"     && grep -q '^443/tcp .*ALLOW' <<<"$status" && ! grep -Eq '^(22|OpenSSH)' <<<"$status"
}
v_no_ssh() { ! ss -Hltn 'sport = :22' | grep -q .; }
v_guard_rules() {
  local match
  for match in "${GUARDED[@]}"; do
    # shellcheck disable=SC2086 # each match is a list of iptables words
    iptables -C DOCKER-USER $match -j REJECT || return 1
    # shellcheck disable=SC2086
    iptables -C OUTPUT $match -m owner ! --uid-owner 0 -j REJECT || return 1
  done
}
# A probe failing isn't proof on its own (the endpoint also refuses requests without its header,
# and error wording differs between tools), so each probe must fail AND the guard's REJECT rule
# must have counted its packets.
rejected() { # <chain>: packets the IMDS REJECT rule in that chain has matched
  iptables -L "$1" -v -x -n | awk '$3=="REJECT" && $9=="169.254.169.254" { n += $1 } END { print n + 0 }'
}
v_guard_host() {
  local before
  before=$(rejected OUTPUT)
  ! setpriv --reuid=nobody --regid=nogroup --clear-groups curl -sS -m 3 -o /dev/null http://169.254.169.254/ \
    && (( $(rejected OUTPUT) > before ))
}
v_guard_containers() {
  local before
  before=$(rejected DOCKER-USER)
  ! docker run --rm "$PROBE_IMAGE" wget -q -T 3 -O /dev/null http://169.254.169.254/ \
    && (( $(rejected DOCKER-USER) > before ))
}
# The guard must not cost name resolution: the API needs it for the sign-in providers.
v_dns() {
  setpriv --reuid=nobody --regid=nogroup --clear-groups getent hosts github.com \
    && docker run --rm "$PROBE_IMAGE" nslookup github.com
}
v_upgrades() { systemctl is-enabled unattended-upgrades.service; }

fails=0
check() { # <description> <function>
  if "$2" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi
}
check "/data is the ext4 data disk, mounted by UUID" v_data_disk
check "data directories owned per uid; /srv/chitthi root-only" v_data_dirs
check "swap on /swapfile, swappiness 10" v_swap
check "docker: compose, live-restore, no docker-proxy" v_docker
check "firewall active: 80 and 443 in, no 22" v_firewall
check "nothing listens on 22" v_no_ssh
check "metadata guard rules in place" v_guard_rules
check "non-root users can't reach the metadata service" v_guard_host
check "containers can't reach the metadata service" v_guard_containers
check "DNS still works for non-root users and containers" v_dns
check "unattended upgrades enabled" v_upgrades
echo "memory:"
free -m
[[ $fails -eq 0 ]] || die "$fails check(s) failed"
log "done"
