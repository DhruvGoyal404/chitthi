# shellcheck shell=bash
# Shared by host-up.sh, host-down.sh and each app's <app>-up.sh / <app>-down.sh. Sourced, not run.
# Works in Git Bash on Windows, Azure Cloud Shell and Linux (docs/MAINTENANCE.md, "Up and down").
#
# Azure changes go through ARM REST (az rest), not version-dependent subcommands, and every call
# retries what Azure itself calls transient: 429, 5xx and "another operation is in progress".
# Secrets: read from Key Vault into shell variables only, and handed to curl on stdin (-K -):
# never on a command line, never in a file, never printed.
# shellcheck disable=SC2034 # the constants are for the scripts that source this
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash would rewrite /subscriptions/... into a Windows path

HOST_RG=${HOST_RG:-apps-host}
VM=${VM:-apps-vm}
PIP=${PIP:-apps-vm-ip}
ARM=https://management.azure.com
API_VM=2024-07-01
API_NET=2024-05-01
API_RES=2021-04-01
# The alerts that only make sense while the VM runs. role-assignment-changed and the budget stay on.
HOST_METRIC_ALERTS=(vm-unavailable vm-low-memory vm-cpu-credits-low)
HOST_ACTIVITY_ALERTS=(vm-resource-health)
LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Git Bash: az, jq and curl are Windows programs. az and jq print CRLF; none of them can open an
# MSYS path such as /dev/null or /tmp/... (curl -o /dev/null fails with exit 23), so curl writes
# what it discards to NUL there.
if command -v cygpath >/dev/null; then NULL_OUT=NUL; else NULL_OUT=/dev/null; fi
az() { command az "$@" | tr -d '\r'; }
jq() { command jq "$@" | tr -d '\r'; }
log() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf '!!  WARNING: %s\n' "$*" >&2; }
die() { printf '\nXX  FAILED: %s\n' "$*" >&2; exit 1; }

arm() { # <method> <path or URL> [JSON body]: prints the response body
  local url=$2 out i
  [[ $url == https://* ]] || url=$ARM$url
  for i in 1 2 3 4 5 6 7 8; do
    if out=$(command az rest --method "$1" --url "$url" ${3:+--body "$3"} --only-show-errors --output json 2>&1); then
      printf '%s\n' "$out" | tr -d '\r'
      return 0
    fi
    # az rest names the status in words: "Too Many Requests(...)", "Service Unavailable(...)".
    if [[ $i -lt 8 ]] && grep -qiE 'Too ?Many ?Requests|Service ?Unavailable|Internal ?Server ?Error|Bad ?Gateway|Gateway ?Time-?out|Retryable|InProgress|in progress|Connection(Reset|Error)|timed out' <<<"$out"; then
      warn "Azure said: $(head -c 200 <<<"$out" | tr '\n' ' ')... retrying in $((i * ${ARM_RETRY_SECONDS:-10})) s"
      sleep $((i * ${ARM_RETRY_SECONDS:-10}))
      continue
    fi
    printf '%s\n' "$out" >&2
    return 1
  done
}
arm_maybe() { # <path>: GET; prints nothing (and succeeds) when the resource doesn't exist
  local out
  if out=$(arm get "$1" 2>&1); then printf '%s\n' "$out"; return 0; fi
  grep -qE 'NotFound|\(404\)' <<<"$out" && return 0
  printf '%s\n' "$out" >&2
  return 1
}

# Sets SUB, SUB_SCOPE, VM_ID, PIP_ID, KV and OPS_KV. Picks, among the subscriptions you're signed
# in to (Azure for Students first), the one that holds $HOST_RG; signs in if none does.
# <require-enabled|allow-disabled>: down still runs on a subscription that isn't Enabled.
preflight() {
  local c s state
  for c in az jq curl; do command -v "$c" >/dev/null || die "'$c' is not installed"; done
  if [[ -n ${PREFLIGHT_SUB:-} ]]; then # host-up/down.sh under an app script that already did all this
    SUB=$PREFLIGHT_SUB
  else
    step "Azure sign-in and subscription"
    command az account show --output none 2>/dev/null || command az login --output none
    pick() {
      for s in $(az account list --query "[?name=='Azure for Students'].id" --output tsv) \
               $(az account list --query "[?name!='Azure for Students'].id" --output tsv); do
        if [[ $(az group exists --name "$HOST_RG" --subscription "$s" 2>/dev/null) == true ]]; then
          az account set --subscription "$s"
          SUB=$s
          return 0
        fi
      done
      return 1
    }
    if ! pick; then
      log "no subscription you're signed in to holds resource group $HOST_RG: signing in"
      command az login --output none
      pick || die "no subscription you can sign in to holds resource group $HOST_RG"
    fi
    # The CLI caches a subscription's state; ARM has the real one.
    state=$(arm get "/subscriptions/$SUB?api-version=2022-12-01" | jq -r .state)
    if [[ $state != Enabled ]]; then
      [[ $1 == allow-disabled ]] || die "the subscription is '$state' (ARM): fix billing at portal.azure.com → Subscriptions first"
      warn "the subscription is '$state' (ARM): going on, since this only stops things"
    fi
    log "subscription $(az account show --query name --output tsv) ($SUB): $state"
    export PREFLIGHT_SUB=$SUB
  fi
  SUB_SCOPE=/subscriptions/$SUB
  VM_ID=$SUB_SCOPE/resourceGroups/$HOST_RG/providers/Microsoft.Compute/virtualMachines/$VM
  PIP_ID=$SUB_SCOPE/resourceGroups/$HOST_RG/providers/Microsoft.Network/publicIPAddresses/$PIP
  local sfx
  sfx=$(printf '%s' "$SUB" | sha256sum | cut -c1-6) # setup.sh names them the same way
  KV=chitthi-kv-$sfx
  OPS_KV=chitthi-ops-$sfx
}

kv_secret() { # <vault> <name>: prints the value (capture it in a variable, never echo it)
  local v i
  for i in 1 2 3; do
    v=$(az keyvault secret show --vault-name "$1" --name "$2" --query value --output tsv --only-show-errors) && break
    [[ $i -lt 3 ]] || die "could not read secret $2 from $1 (bash deploy/azure/setup.sh secrets stores it)"
    sleep 5
  done
  [[ -n $v ]] || die "secret $2 in $1 is empty"
  printf '%s' "$v"
}

vm_json() { arm get "$VM_ID?\$expand=instanceView&api-version=$API_VM"; }
power_of() { jq -r '[.properties.instanceView.statuses[]? | select(.code | startswith("PowerState/")).code][0] // "PowerState/unknown"'; }
wait_power() { # <PowerState/...> <seconds>
  local end=$((SECONDS + $2)) now
  while :; do
    now=$(vm_json | power_of)
    [[ $now == "$1" ]] && return 0
    [[ $SECONDS -lt $end ]] || die "$VM is still $now after $2 s (wanted $1)"
    sleep 10
  done
}
wait_provisioned() { # <resource id with ?api-version=>: until provisioningState is Succeeded
  local i
  for i in $(seq 1 30); do
    [[ $(arm get "$1" | jq -r .properties.provisioningState) == Succeeded ]] && return 0
    sleep 5
  done
  die "${1%%\?*} never reached provisioningState Succeeded"
}

set_host_alerts() { # true|false
  local n body
  body=$(jq -cn --argjson on "$1" '{properties: {enabled: $on}}')
  for n in "${HOST_METRIC_ALERTS[@]}"; do
    if [[ -n $(arm_maybe "$SUB_SCOPE/resourceGroups/$HOST_RG/providers/Microsoft.Insights/metricAlerts/$n?api-version=2018-03-01") ]]; then
      arm patch "$SUB_SCOPE/resourceGroups/$HOST_RG/providers/Microsoft.Insights/metricAlerts/$n?api-version=2018-03-01" "$body" >/dev/null
      log "alert $n: enabled=$1"
    else warn "alert $n doesn't exist (setup.sh infra creates it)"; fi
  done
  for n in "${HOST_ACTIVITY_ALERTS[@]}"; do
    if [[ -n $(arm_maybe "$SUB_SCOPE/resourceGroups/$HOST_RG/providers/Microsoft.Insights/activityLogAlerts/$n?api-version=2020-10-01") ]]; then
      arm patch "$SUB_SCOPE/resourceGroups/$HOST_RG/providers/Microsoft.Insights/activityLogAlerts/$n?api-version=2020-10-01" "$body" >/dev/null
      log "alert $n: enabled=$1"
    else warn "alert $n doesn't exist (setup.sh infra creates it)"; fi
  done
}

# Each app on the VM has a tag app-<name>: up or down. Down means its own down steps ran (backup,
# monitors, DNS), so the VM can go without it. Any other value, like the older "hosted", means up.
set_app_state() { # <app> <up|down>
  arm patch "$VM_ID/providers/Microsoft.Resources/tags/default?api-version=$API_RES" \
    "$(jq -cn --arg t "app-$1" --arg v "$2" '{operation: "Merge", properties: {tags: {($t): $v}}}')" >/dev/null
}
apps_up() { # <VM JSON> <app to leave out>: the other apps that are up, one per line
  jq -r --arg me "app-$2" '.tags // {} | to_entries[]
    | select((.key | startswith("app-")) and .key != $me and .value != "down") | .key | ltrimstr("app-")' <<<"$1"
}

host_ip() { arm_maybe "$PIP_ID?api-version=$API_NET" | jq -r '.properties.ipAddress // empty'; }

# Every resource in the subscription, priced while the host is down (audit.jq). Prints a table and
# returns 1 if anything bills beyond the expected pennies.
audit() { # [step prefix, e.g. "4/4 "]
  local resources disks vms='{}' storage='{}' mtd id first free_until bytes report
  step "${1:-}Audit: everything in the subscription that could bill"
  resources=$(arm get "$SUB_SCOPE/resources?\$expand=createdTime&api-version=$API_RES" | jq -c .value)
  disks=$(arm get "$SUB_SCOPE/providers/Microsoft.Compute/disks?api-version=2023-04-02" | jq -c .value)
  for id in $(jq -r '.[] | select(.type | ascii_downcase == "microsoft.compute/virtualmachines") | .id' <<<"$resources"); do
    vms=$(jq -c --arg id "$id" --arg p "$(arm get "$id?\$expand=instanceView&api-version=$API_VM" | power_of)" '. + {($id | ascii_downcase): $p}' <<<"$vms")
  done
  for id in $(jq -r '.[] | select(.type | ascii_downcase == "microsoft.storage/storageaccounts") | .id' <<<"$resources"); do
    bytes=$(arm get "$id/providers/Microsoft.Insights/metrics?metricnames=UsedCapacity&aggregation=Average&interval=PT1H&api-version=2023-10-01" \
      | jq '[.value[0].timeseries[0].data[]?.average // empty] | last // 0' 2>/dev/null || echo 0)
    storage=$(jq -c --arg id "$id" --argjson b "${bytes:-0}" '. + {($id | ascii_downcase): $b}' <<<"$storage")
  done
  # What each resource has really cost this month: proves the "free" disks are free.
  mtd=$(arm post "$SUB_SCOPE/providers/Microsoft.CostManagement/query?api-version=2023-03-01" \
    '{"type":"ActualCost","timeframe":"MonthToDate","dataset":{"granularity":"None","aggregation":{"cost":{"name":"Cost","function":"Sum"}},"grouping":[{"type":"Dimension","name":"ResourceId"}]}}' \
    | jq -c '[.properties.rows[] | {key: (.[1] | ascii_downcase), value: .[0]}] | from_entries' 2>/dev/null) \
    || { warn "Cost Management didn't answer: the disks' 'free' is from the date alone"; mtd='{}'; }
  # The 12-month free allowance counts from sign-up, which ARM doesn't report: the first resource's
  # creation is the latest it can have started. Portal → "Free services" has the exact date.
  first=$(jq -r '[.[].createdTime // empty] | sort | first // empty' <<<"$resources")
  free_until=$(date -u -d "${first:0:10} +12 months" +%F 2>/dev/null || date -u +%F)
  report=$(jq -n --argjson r "$resources" --argjson d "$disks" --argjson vms "$vms" --argjson sa "$storage" --argjson mtd "$mtd" \
    --arg today "$(date -u +%F)" --arg free_until "$free_until" -f "$(winpath "$LIB_DIR/audit.jq")")
  jq -r '.rows[] | [.status, .monthly, .name, .type, .note] | @tsv' <<<"$report" | sort \
    | awk -F'\t' '{ printf "%-9s %-9s %-24s %-42s %s\n", $1, $2, $3, $4, $5 }'
  log ""
  log "Free allowance (disks): until $free_until at the latest. Expected while down: about ₹$(jq -r .expected <<<"$report") a month."
  if [[ $(jq -r .billing <<<"$report") != 0 ]]; then
    printf '\n!!!!!!!!  STILL BILLING: %s resource(s) above bill while idle (about ₹%s a month)  !!!!!!!!\n' \
      "$(jq -r .billing <<<"$report")" "$(jq -r .billing_monthly <<<"$report")" >&2
    return 1
  fi
  log "audit clean: nothing bills beyond the expected ~₹0"
}
winpath() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else printf '%s\n' "$1"; fi; }

# A curl whose secret header or form field arrives on stdin as a curl config, never in argv.
# <config line, e.g. header = "X-Api-Key: ..."> <curl arguments...>
curl_with() { local conf=$1; shift; printf '%s\n' "$conf" | curl -sS --max-time 30 -K - "$@"; }

# The monitors that would alarm while the site is down by design. Each takes pause|resume.
hc_set() { # pause|resume <check name prefix> <API key secret in $OPS_KV>: healthchecks.io checks
  local key list name status url n=0
  key=$(kv_secret "$OPS_KV" "$3")
  list=$(curl_with "header = \"X-Api-Key: $key\"" -f https://healthchecks.io/api/v3/checks/) \
    || die "healthchecks.io refused the API key $3 (it must be a read-write key of the project holding $2*)"
  while IFS='|' read -r name status url; do
    n=$((n + 1))
    if [[ $1 == pause && $status == paused ]] || [[ $1 == resume && $status != paused ]]; then
      log "healthchecks.io $name: already $status"
      continue
    fi
    curl_with "header = \"X-Api-Key: $key\"" -f -o "$NULL_OUT" -X POST "$url/$1" || die "healthchecks.io: could not $1 $name"
    log "healthchecks.io $name: ${1}d"
  done < <(jq -r --arg p "$2" '.checks[] | select(.name | startswith($p)) | "\(.name)|\(.status)|\(.update_url)"' <<<"$list")
  [[ $n -gt 0 ]] || warn "healthchecks.io: no check named $2* in that key's project"
}
uptimerobot_set() { # pause|resume <URL substring> <API key secret in $OPS_KV>
  local key list id name status want n=0
  key=$(kv_secret "$OPS_KV" "$3")
  want=$([[ $1 == pause ]] && echo 0 || echo 1) # 0 paused; 1 "not checked yet", which UptimeRobot moves to up or down
  list=$(curl_with "data = \"api_key=$key&format=json&search=$2\"" -f -X POST https://api.uptimerobot.com/v2/getMonitors)
  [[ $(jq -r .stat <<<"$list") == ok ]] || die "UptimeRobot refused the API key $3 (it must be the Main API key)"
  while IFS='|' read -r id name status; do
    n=$((n + 1))
    if [[ $1 == pause && $status == 0 ]] || [[ $1 == resume && $status != 0 ]]; then
      log "UptimeRobot $name: already $([[ $status == 0 ]] && echo paused || echo active)"
      continue
    fi
    [[ $(curl_with "data = \"api_key=$key&format=json&id=$id&status=$want\"" -f -X POST https://api.uptimerobot.com/v2/editMonitor | jq -r .stat) == ok ]] \
      || die "UptimeRobot: could not $1 $name"
    log "UptimeRobot $name: ${1}d"
  done < <(jq -r '.monitors[] | "\(.id)|\(.friendly_name)|\(.status)"' <<<"$list")
  [[ $n -gt 0 ]] || warn "UptimeRobot: no monitor matches $2"
}

# Cloudflare: the zone's A record for <name> -> <ip>, DNS only (grey cloud), TTL 60 s so a new
# address spreads fast. The token needs Zone → Zone → Read and Zone → DNS → Edit, on this zone only.
cf_set_a() { # <zone> <name> <ip> <token secret in $OPS_KV>
  local auth zone rec body api=https://api.cloudflare.com/client/v4
  auth="header = \"Authorization: Bearer $(kv_secret "$OPS_KV" "$4")\""
  zone=$(curl_with "$auth" -f "$api/zones?name=$1" | jq -r '.result[0].id // empty') || true
  [[ -n $zone ]] || die "Cloudflare: zone $1 isn't visible to $4 (it needs Zone → Zone → Read on $1)"
  rec=$(curl_with "$auth" -f "$api/zones/$zone/dns_records?type=A&name=$2" | jq -c '.result[0] // empty') \
    || die "Cloudflare: could not read the A record $2 (the token needs Zone → DNS → Edit)"
  body=$(jq -cn --arg n "$2" --arg ip "$3" '{type: "A", name: $n, content: $ip, ttl: 60, proxied: false}')
  if [[ -n $rec && $(jq -r '"\(.content) \(.proxied)"' <<<"$rec") == "$3 false" ]]; then
    log "Cloudflare: $2 A $3 (DNS only) already"
    return 0
  fi
  if [[ -z $rec ]]; then
    curl_with "$auth" -f -o "$NULL_OUT" -X POST -H 'Content-Type: application/json' --data "$body" "$api/zones/$zone/dns_records"
  else
    curl_with "$auth" -f -o "$NULL_OUT" -X PATCH -H 'Content-Type: application/json' --data "$body" "$api/zones/$zone/dns_records/$(jq -r .id <<<"$rec")"
  fi || die "Cloudflare: could not set $2 to $3 (the token needs Zone → DNS → Edit)"
  log "Cloudflare: $2 A $3 (DNS only, TTL 60 s)"
}
# What the A record points at while the site is down: TEST-NET-1 (RFC 5737), routed nowhere. A
# record left on a released Azure address would follow it to whoever Azure gives it next.
PARKED_IP=192.0.2.1
