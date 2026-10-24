#!/usr/bin/env bash
# One look at the host, for incidents and routine checks (docs/MAINTENANCE.md, "Incidents"). Read-only.
#
#   deploy/azure/run-on-vm.sh deploy/host/status.sh
#
# Sections are short and the most useful come last, because Run Command keeps only the last 4 KB.
set -uo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
HOST=chitthi.dhruvgoyal.tech
app() { docker compose -p chitthi --project-directory /srv/chitthi -f /srv/chitthi/compose.yaml "$@"; }
section() { printf '\n== %s\n' "$1"; }

section "host"
uptime
free -m | sed -n '1,3p'
df -h / /data | sed 1d
[[ -f /var/run/reboot-required ]] && echo "a reboot is pending (unattended-upgrades reboots at 21:30 UTC)"

section "recent API errors (last hour)"
app logs --since 1h --no-log-prefix api 2>/dev/null | grep -E '"level":(50|60)' | tail -n 5 || true

section "backups"
for f in last-success last-drill last-restore; do
  [[ -f /data/chitthi/backup-state/$f ]] && echo "$f: $(cat "/data/chitthi/backup-state/$f")"
done
systemctl list-timers 'chitthi-*' --no-pager 2>/dev/null | sed -n '1,3p'

section "deploys (last 5)"
tail -n 5 /srv/chitthi/deploys.log 2>/dev/null || echo "no deploys yet"

section "certificate"
echo | openssl s_client -connect 127.0.0.1:443 -servername "$HOST" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null \
  || echo "no certificate served for $HOST"

section "containers"
docker ps --format '{{.Names}}\t{{.Status}}' | sort
docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}' 2>/dev/null | sort

section "health"
code=$(curl -sS --max-time 10 --resolve "$HOST:443:127.0.0.1" "https://$HOST/api/health" 2>&1)
echo "api/health: $code"
