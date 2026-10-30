#!/usr/bin/env bash
# Takes the shared host (apps-vm) down and stops what bills while it's idle. Each app's
# <app>-down.sh runs its own steps first (final backup, monitors paused, DNS parked), then this:
#
#   bash deploy/azure/host-down.sh app=chitthi [also=hisaab]
#   bash deploy/azure/host-down.sh audit          # read-only: what still bills
#
# 1. The alerts that need a running VM: off (role-assignment-changed and the budget stay on).
# 2. The VM: deallocated, through ARM (a "stopped" VM still bills its compute).
# 3. The static IPv4: detached from the NIC, then deleted. The NIC, NSG, VNet, disks, Key Vaults,
#    storage and DNS records stay.
# 4. An audit of the whole subscription: exits non-zero, with STILL BILLING, if anything bills
#    beyond the expected ~₹0.
#
# The VM is shared. Each app on it carries a tag app-<name>=up|down (lib.sh, set_app_state), and
# this refuses while another app is up unless also= names it: run that app's down steps first
# (<other>-down.sh --app-only, which marks it down), so its backup and monitors aren't skipped
# silently. Every app this takes down is marked down.
# Re-runnable: every step checks first.
# shellcheck source=deploy/azure/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

declare -A arg=()
mode=down
for kv in "$@"; do
  case $kv in
    audit) mode=audit ;;
    *=*) arg[${kv%%=*}]=${kv#*=} ;;
    *) die "usage: host-down.sh app=<name> [also=<other,...>] | audit" ;;
  esac
done

preflight allow-disabled
if [[ $mode == audit ]]; then audit; exit; fi
app=${arg[app]:-}
[[ $app =~ ^[a-z0-9-]+$ ]] || die "usage: host-down.sh app=<name> [also=<other,...>] | audit"

vm=$(arm_maybe "$VM_ID?\$expand=instanceView&api-version=$API_VM")
[[ -n $vm ]] || die "there is no VM $VM in $HOST_RG"
for other in $(apps_up "$vm" "$app"); do
  [[ ",${arg[also]:-}," == *",$other,"* ]] \
    || die "$VM also hosts $other, and this would take it down too. Run its own steps first ($other-down.sh --app-only), then: host-down.sh app=$app also=$other"
done

step "1/4 Alerts that need a running VM: off"
set_host_alerts false

step "2/4 Deallocate $VM"
power=$(power_of <<<"$vm")
if [[ $power == PowerState/deallocated ]]; then
  log "already deallocated"
else
  log "$power: deallocating (a minute or two)"
  arm post "$VM_ID/deallocate?api-version=$API_VM" >/dev/null
  wait_power PowerState/deallocated 900
  log "deallocated"
fi

step "3/4 Static IPv4 $PIP: detach, then delete"
nic_id=$(jq -r '.properties.networkProfile.networkInterfaces[0].id' <<<"$vm")
nic=$(arm get "$nic_id?api-version=$API_NET")
if jq -e '[.properties.ipConfigurations[].properties.publicIPAddress // empty] | length > 0' <<<"$nic" >/dev/null; then
  arm put "$nic_id?api-version=$API_NET" \
    "$(jq -c '{location, tags, properties: (.properties | .ipConfigurations |= map(del(.properties.publicIPAddress)))}' <<<"$nic")" >/dev/null
  wait_provisioned "$nic_id?api-version=$API_NET"
  log "detached from ${nic_id##*/}"
else
  log "${nic_id##*/} has no public address"
fi
if [[ -n $(arm_maybe "$PIP_ID?api-version=$API_NET") ]]; then
  arm delete "$PIP_ID?api-version=$API_NET" >/dev/null
  for _ in $(seq 1 30); do [[ -z $(arm_maybe "$PIP_ID?api-version=$API_NET") ]] && break; sleep 5; done
  [[ -z $(arm_maybe "$PIP_ID?api-version=$API_NET") ]] || die "$PIP still exists after 150 s"
  log "deleted"
else
  log "already deleted"
fi

also=${arg[also]:-}
for a in "$app" ${also//,/ }; do set_app_state "$a" down; done

audit "4/4 "
