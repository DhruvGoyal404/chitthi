#!/usr/bin/env bash
# Takes https://chitthi.dhruvgoyal.tech offline and stops everything that bills while idle.
# Pairs with chitthi-up.sh (docs/MAINTENANCE.md, "Up and down"). Git Bash, Cloud Shell or Linux:
#
#   bash chitthi-down.sh [--skip-backup] [--app-only]
#
# 1. A final backup on the VM (backup.sh run). If it fails, nothing is stopped, unless --skip-backup.
# 2. Monitors paused: healthchecks.io chitthi-* and the UptimeRobot monitor.
# 3. DNS parked: the A record points at 192.0.2.1 (routed nowhere), never at a released address.
# 4. The host: deploy/azure/host-down.sh (alerts off, deallocate, delete the IPv4, audit).
#    --app-only stops after 3, for when another app's down script takes the host down.
# Re-runnable after a half-failed run. Exits non-zero if the audit finds anything still billing.
cd "$(dirname "$0")"
# shellcheck source=deploy/azure/lib.sh
source deploy/azure/lib.sh
APP=chitthi
DOMAIN=chitthi.dhruvgoyal.tech
ZONE=dhruvgoyal.tech

skip_backup='' app_only=''
for a in "$@"; do
  case $a in
    --skip-backup) skip_backup=1 ;;
    --app-only) app_only=1 ;;
    *) die "usage: bash chitthi-down.sh [--skip-backup] [--app-only]" ;;
  esac
done

preflight allow-disabled
power=$(vm_json | power_of)

step "Final backup on the VM"
if [[ $power != PowerState/running ]]; then
  log "$VM is $power: nothing new since its last backup"
elif [[ -n $skip_backup ]]; then
  warn "--skip-backup: anything since last night's backup exists only on the VM's disk (which stays)"
else
  bash deploy/azure/run-on-vm.sh deploy/host/backup.sh run \
    || die "the final backup failed, so nothing was stopped. Fix it (docs/MAINTENANCE.md, \"A backup alert\"), or re-run with --skip-backup"
fi

step "Monitors: pause"
hc_set pause "$APP-" chitthi-hc-api-key
uptimerobot_set pause "$DOMAIN" chitthi-uptimerobot-api-key

step "DNS: park $DOMAIN"
cf_set_a "$ZONE" "$DOMAIN" "$PARKED_IP" chitthi-cloudflare-dns-token

if [[ -n $app_only ]]; then
  set_app_state "$APP" down
  log ""
  log "$APP's own steps are done; the host is still up (--app-only)"
  exit 0
fi
bash deploy/azure/host-down.sh "app=$APP" # ends with the audit, non-zero if anything still bills

step "Is the site offline?"
if curl -sS --max-time 10 -o "$NULL_OUT" "https://$DOMAIN/api/health" 2>/dev/null; then
  warn "https://$DOMAIN still answered: a DNS cache somewhere has the old address (it can't last: that address is released)"
else
  log "https://$DOMAIN doesn't answer: offline"
fi
cat <<EOF

+----------------------------------------------------------------+
|  Chitthi is DOWN. Nothing bills beyond the audit above.        |
|  Bring it back:  bash chitthi-up.sh   (about 5-10 minutes)     |
+----------------------------------------------------------------+
EOF
