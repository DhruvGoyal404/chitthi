#!/usr/bin/env bash
# Brings the shared host (apps-vm) back: the reverse of host-down.sh. Each app's <app>-up.sh runs
# this, then its own steps (DNS to the new address, health, monitors, dependency checks):
#
#   bash deploy/azure/host-up.sh app=chitthi
#
# 1. Tags the VM app-<name>, so host-down.sh knows this app lives there.
# 2. A new static IPv4 (a new address every time), attached to the VM's NIC.
# 3. The VM: started, through ARM.
# 4. The alerts host-down.sh turned off: on.
# Re-runnable: every step checks first. The other apps on the VM come up with it, but their DNS
# still points at the parked address until their own <app>-up.sh --app-only runs.
# shellcheck source=deploy/azure/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

app=''
for kv in "$@"; do
  case $kv in
    app=*) app=${kv#app=} ;;
    *) die "usage: host-up.sh app=<name>" ;;
  esac
done
[[ $app =~ ^[a-z0-9-]+$ ]] || die "usage: host-up.sh app=<name>"

preflight require-enabled
vm=$(arm_maybe "$VM_ID?\$expand=instanceView&api-version=$API_VM")
[[ -n $vm ]] || die "there is no VM $VM in $HOST_RG (setup.sh infra builds it)"
arm patch "$VM_ID/providers/Microsoft.Resources/tags/default?api-version=$API_RES" \
  "$(jq -cn --arg t "app-$app" '{operation: "Merge", properties: {tags: {($t): "hosted"}}}')" >/dev/null

step "1/3 Static IPv4 $PIP"
if [[ -z $(arm_maybe "$PIP_ID?api-version=$API_NET") ]]; then
  arm put "$PIP_ID?api-version=$API_NET" "$(jq -cn --arg l "$(jq -r .location <<<"$vm")" \
    '{location: $l, sku: {name: "Standard", tier: "Regional"}, properties: {publicIPAllocationMethod: "Static", publicIPAddressVersion: "IPv4"}}')" >/dev/null
  wait_provisioned "$PIP_ID?api-version=$API_NET"
  log "created: $(host_ip)"
else
  log "exists: $(host_ip)"
fi
nic_id=$(jq -r '.properties.networkProfile.networkInterfaces[0].id' <<<"$vm")
nic=$(arm get "$nic_id?api-version=$API_NET")
if jq -e --arg p "$PIP_ID" '[.properties.ipConfigurations[].properties.publicIPAddress.id // empty | ascii_downcase] | index($p | ascii_downcase)' <<<"$nic" >/dev/null; then
  log "attached to ${nic_id##*/}"
else
  # On the primary IP configuration (the only one setup.sh makes).
  arm put "$nic_id?api-version=$API_NET" "$(jq -c --arg p "$PIP_ID" '
    {location, tags, properties: (.properties | .ipConfigurations |= (
      ((map(.properties.primary == true) | index(true)) // 0) as $i | .[$i].properties.publicIPAddress = {id: $p}))}' <<<"$nic")" >/dev/null
  wait_provisioned "$nic_id?api-version=$API_NET"
  log "attached to ${nic_id##*/}"
fi

step "2/3 Start $VM"
power=$(power_of <<<"$vm")
if [[ $power == PowerState/running ]]; then
  log "already running"
else
  log "$power: starting (a minute or two)"
  arm post "$VM_ID/start?api-version=$API_VM" >/dev/null
  wait_power PowerState/running 600
  log "running"
fi

step "3/3 Alerts: on"
set_host_alerts true
log ""
log "host up: $VM at $(host_ip)"
