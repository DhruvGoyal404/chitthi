#!/usr/bin/env bash
# Azure setup for the host and for Chitthi. The owner runs it in Azure Cloud Shell (Bash), signed
# in as themselves (they must be Owner of the subscription):
#
#   git clone https://github.com/DhruvGoyal404/chitthi && cd chitthi
#   bash deploy/azure/setup.sh infra alert_email=<address> [region=malaysiawest] [disks=premium|standard] [image=<urn>]
#                                    [budget=<amount>] [subscription=<id>]
#   bash deploy/azure/setup.sh secrets      # generates or asks for each missing Key Vault secret
#   bash deploy/azure/setup.sh rotate name=<secret>   # a new value for one (docs/MAINTENANCE.md)
#   bash deploy/azure/setup.sh check        # read-only: verifies everything below
#   bash deploy/azure/setup.sh summary      # read-only: the checks (secrets as todo), the IP and the GitHub values
#
# Re-runnable. Each step creates what's missing and brings settings back to what's written here.
# It never deletes anything, and never replaces a secret that exists.
#
# What it builds (docs/MAINTENANCE.md, "Azure setup"):
# - Host (resource group apps-host): the VM, B2ats v2 with Ubuntu 24.04 and a system identity; a
#   static IPv4; a network security group allowing 80 and 443 only; a 64 GiB data disk at LUN 0;
#   alerts to email; the subscription's budget.
# - Chitthi (resource group chitthi):
#   - the backup storage account and container: the VM's identity may only create and read blobs
#     there; lifecycle rules expire dumps, manifests and selftest probes; 14 days of soft delete;
#   - Key Vault: the VM's identity reads secrets, the owner manages them;
#   - the deploy identity, which GitHub Actions signs in as (OIDC, environment "production"); it
#     may only use Run Command on this VM.
set -euo pipefail
umask 077

DEFAULT_REGION=malaysiawest # Azure for Students allows only a few regions (docs/MAINTENANCE.md, "Region")
HOST_RG=apps-host
VM=apps-vm
VM_SIZE=Standard_B2ats_v2
VNET=apps-vnet
SUBNET=apps-subnet
NSG=apps-vm-nsg
PIP=apps-vm-ip
DATA_DISK=apps-vm-data
ADMIN_USER=azureops # required by Azure; it has no usable login (see create_vm)
ACTION_GROUP=ops-email
BUDGET_NAME=apps-host
APP_RG=chitthi
CONTAINER=backups
DEPLOY_ID=chitthi-deploy
GITHUB_REPO=DhruvGoyal404/chitthi
GITHUB_ENVIRONMENT=production # the deploy job's environment: you approve each deploy, from main only
BACKUP_ROLE="Blob create-only writer"
RUNCMD_ROLE="VM Run Command operator"
KEEP_DAYS=35
SOFT_DELETE_DAYS=14
MIN_IMAGE_AGE_DAYS=14 # the supply-chain rule: a younger pinned image is reported (preflight)
# The VM image, pinned like a container digest. Versions roll out per region: this one is present
# in malaysiawest (24.04.202610210 and 202610220 were, checked 2026-10-24). Override with image=<publisher:offer:sku:version>.
DEFAULT_IMAGE=Canonical:ubuntu-24_04-lts:server:24.04.202610210
METRIC_ALERTS=(vm-unavailable vm-low-memory vm-cpu-credits-low)
ACTIVITY_ALERTS=(vm-resource-health role-assignment-changed)
SECRETS=(
  chitthi-postgres-password chitthi-api-db-password
  chitthi-google-client-id chitthi-google-client-secret chitthi-github-client-id chitthi-github-client-secret
  chitthi-backup-age-recipient chitthi-backup-age-identity
  chitthi-r2-endpoint chitthi-r2-access-key-id chitthi-r2-secret-access-key
  chitthi-hc-backup-url chitthi-hc-drill-url
)

log() { echo "setup: $*"; }
die() { echo "setup: FAILED: $*" >&2; exit 1; }
q() { az "$@" --only-show-errors --output none; }      # run, no output
v() { az "$@" --only-show-errors --output tsv; }       # one value
# JSON from az, checked before jq reads it: a failure names the command and shows what came
# back, never a bare "jq: parse error". (Don't pass --output to v or q: their own wins, being last.)
json() {
  local out
  out=$(az "$@" --only-show-errors --output json) || return 1
  if ! jq -e . >/dev/null 2>&1 <<<"$out"; then
    echo "setup: 'az $1 $2 ${3:-}' did not return JSON: ${out:0:200}" >&2
    return 1
  fi
  printf '%s\n' "$out"
}
j() { json "$@" | jq -cS .; } # compact JSON, sorted keys
exists() { az "$@" --only-show-errors --output none >/dev/null 2>&1; }
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

declare -A arg=()
cmd=${1:-}
[[ $# -gt 0 ]] && shift
for kv in "$@"; do
  [[ $kv == *=* ]] || die "argument '$kv' is not key=value"
  arg[${kv%%=*}]=${kv#*=}
done
if ! command -v az >/dev/null || ! command -v jq >/dev/null; then die "run this in Azure Cloud Shell (Bash): it needs az and jq"; fi
LOCATION=${arg[region]:-$DEFAULT_REGION}
[[ $LOCATION =~ ^[a-z0-9]+$ ]] || die "region= must be an Azure region name, such as malaysiawest"
IMAGE_URN=${arg[image]:-$DEFAULT_IMAGE}
[[ $IMAGE_URN =~ ^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+:[0-9]+(\.[0-9]+)+$ ]] \
  || die "image= must be a full URN with an exact version, publisher:offer:sku:version (never 'latest')"
# premium: two P6 (64 GiB Premium SSD), the disks the 12-month free allowance has listed.
# standard: E4 (32 GiB) for the OS and E6 (64 GiB) for data, Standard SSD: never free, but less
# than half of P6's price once nothing is free (docs/MAINTENANCE.md, "What it costs").
case ${arg[disks]:-premium} in
  premium) DISK_SKU=Premium_LRS OS_DISK_GB=64 DATA_DISK_GB=64 ;;
  standard) DISK_SKU=StandardSSD_LRS OS_DISK_GB=32 DATA_DISK_GB=64 ;;
  *) die "disks= must be premium or standard" ;;
esac
[[ -n ${arg[subscription]:-} ]] && q account set --subscription "${arg[subscription]}"
SUB=$(v account show --query id) || die "not signed in: run az login"
TENANT=$(v account show --query tenantId)
SUB_NAME=$(v account show --query name)
# Globally unique names, the same on every run for this subscription.
sfx=$(printf '%s' "$SUB" | sha256sum | cut -c1-6)
KV=chitthi-kv-$sfx
SA=chitthibk$sfx
SUB_SCOPE=/subscriptions/$SUB
VM_ID=$SUB_SCOPE/resourceGroups/$HOST_RG/providers/Microsoft.Compute/virtualMachines/$VM
SA_ID=$SUB_SCOPE/resourceGroups/$APP_RG/providers/Microsoft.Storage/storageAccounts/$SA
CONTAINER_ID=$SA_ID/blobServices/default/containers/$CONTAINER
KV_ID=$SUB_SCOPE/resourceGroups/$APP_RG/providers/Microsoft.KeyVault/vaults/$KV
AG_ID=$SUB_SCOPE/resourceGroups/$HOST_RG/providers/microsoft.insights/actionGroups/$ACTION_GROUP

me() { v ad signed-in-user show --query id; }

# Role assignment, idempotent. New principals take a while to replicate, and new custom roles to
# become assignable, so it retries.
assign() { # <principal id> <principal type> <role> <scope>
  local n i
  n=$(v role assignment list --scope "$4" --query "length([?principalId=='$1' && roleDefinitionName=='$3'])")
  [[ $n == 0 ]] || return 0
  for i in $(seq 1 20); do
    if q role assignment create --assignee-object-id "$1" --assignee-principal-type "$2" --role "$3" --scope "$4" 2>/dev/null; then
      log "assigned '$3' on ${4##*/} to $2 $1"
      return 0
    fi
    [[ $i -eq 1 ]] && log "waiting for '$3' and the principal to replicate..."
    sleep 15
  done
  die "could not assign '$3' on $4 to $1"
}

role_definition() { # <name> <description> <actions JSON array> <data actions JSON array>
  local file
  file=$(mktemp)
  jq -n --arg name "$1" --arg desc "$2" --argjson actions "$3" --argjson data "$4" --arg scope "$SUB_SCOPE" \
    '{Name: $name, IsCustom: true, Description: $desc, Actions: $actions, NotActions: [], DataActions: $data, NotDataActions: [], AssignableScopes: [$scope]}' > "$file"
  if [[ $(v role definition list --custom-role-only true --name "$1" --query 'length(@)') == 0 ]]; then
    q role definition create --role-definition @"$file"
    log "created role '$1'"
  else
    q role definition update --role-definition @"$file"
  fi
  rm -f "$file"
}

# ==================================================================================================
infra() {
  local email=${arg[alert_email]:-} budget=${arg[budget]:-} me_id
  [[ $email =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "alert_email=<address> is required"
  [[ -z $budget || $budget =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "budget must be a number"
  log "subscription: $SUB_NAME ($SUB), region $LOCATION"
  log "names: Key Vault $KV, storage account $SA"
  preflight
  if [[ -t 0 ]]; then
    read -rp "Create or update these resources in this subscription? [y/N] " yn
    [[ $yn == [yY] ]] || die "stopped"
  fi
  me_id=$(me)
  [[ $(v role assignment list --assignee "$me_id" --scope "$SUB_SCOPE" --include-inherited --query "length([?roleDefinitionName=='Owner'])") != 0 ]] \
    || die "you need Owner on the subscription (role assignments are part of this setup)"

  log "resource providers"
  local ns
  for ns in Microsoft.Compute Microsoft.Network Microsoft.Storage Microsoft.KeyVault Microsoft.ManagedIdentity \
    Microsoft.Insights Microsoft.AlertsManagement Microsoft.Consumption Microsoft.CostManagement; do
    [[ $(v provider show --namespace "$ns" --query registrationState) == Registered ]] || q provider register --namespace "$ns" --wait
  done
  q group create --name "$HOST_RG" --location "$LOCATION"
  q group create --name "$APP_RG" --location "$LOCATION"

  network
  create_vm
  storage
  key_vault
  identities "$me_id"
  alerts "$email"
  set_budget "$email" "$budget"

  echo
  check infra
  next_steps "$email"
}

# Read-only checks, before anything is created: each failure names its fix.
preflight() {
  local allowed sku restrictions zones rg loc n
  log "preflight: region $LOCATION, $VM_SIZE, $DISK_SKU disks"

  # 1. The subscription's allowed-locations policy (Azure for Students has one), from every policy
  #    assignment that applies here, inherited ones included: each location-list parameter
  #    (listOfAllowedLocations, for resources and for resource groups) must contain the region.
  allowed=$(az policy assignment list --disable-scope-strict-match --only-show-errors --output json \
    | jq -r '[.[] | (.parameters // {}) | to_entries[] | select(.key | test("location"; "i")) | .value.value
              | select(type == "array") | map(ascii_downcase)]
             | if length == 0 then "" else (reduce .[1:][] as $l (.[0]; map(select(. as $x | $l | index($x) != null)))) | join(" ") end') \
    || die "could not read the subscription's policy assignments"
  if [[ -n $allowed ]]; then
    [[ " $allowed " == *" $LOCATION "* ]] \
      || die "this subscription's policy doesn't allow region $LOCATION. Allowed: $allowed. Pass region=<one of them>"
    log "policy: allowed regions are $allowed"
  else
    log "policy: no allowed-locations restriction found"
  fi

  # 2. The VM size: offered in the region, with no Location restriction for this subscription,
  #    and able to use Premium SSD if the disks are premium. (A Zone restriction doesn't matter:
  #    the VM is placed in no zone.)
  sku=$(az vm list-skus --location "$LOCATION" --size "$VM_SIZE" --resource-type virtualMachines --all --only-show-errors --output json \
    | jq -c --arg n "$VM_SIZE" '[.[] | select(.name == $n)] | first // empty')
  [[ -n $sku ]] || die "$VM_SIZE is not offered in $LOCATION"
  restrictions=$(jq -r '[.restrictions[]? | select(.type == "Location") | .reasonCode] | join(", ")' <<<"$sku")
  [[ -z $restrictions ]] || die "$VM_SIZE is restricted in $LOCATION for this subscription ($restrictions)"
  zones=$(jq -r '[.restrictions[]? | select(.type == "Zone") | .restrictionInfo.zones[]?] | join(",")' <<<"$sku")
  [[ -z $zones ]] || log "note: $VM_SIZE is unavailable in zones $zones of $LOCATION; the VM uses no zone"
  if [[ $DISK_SKU == Premium_LRS && $(jq -r '.capabilities[]? | select(.name == "PremiumIO") | .value' <<<"$sku") != True ]]; then
    die "$VM_SIZE in $LOCATION can't use Premium SSD: pass disks=standard"
  fi
  log "$VM_SIZE: offered in $LOCATION, unrestricted"

  # 3. Resource groups an earlier run left in another region. A group's region is only where its
  #    metadata lives, but `az group create` refuses to "move" it, and mixed regions confuse. An
  #    empty one is safe to delete; this never deletes anything itself.
  for rg in "$HOST_RG" "$APP_RG"; do
    loc=$(v group show --name "$rg" --query location 2>/dev/null || true)
    [[ -z $loc || $loc == "$LOCATION" ]] && continue
    n=$(v resource list --resource-group "$rg" --query 'length(@)')
    [[ $n == 0 ]] && die "resource group $rg exists in $loc, empty (left by an earlier run). Delete it, then run this again: az group delete --name $rg --yes"
    die "resource group $rg exists in $loc and holds $n resources; this won't build across regions (docs/MAINTENANCE.md, \"Region\")"
  done

  # 4. The VM image: the pinned URN must exist IN THIS REGION, checked with exactly the lookup VM
  #    creation does (image versions roll out region by region; `vm image list` once offered a
  #    version that `vm image show` couldn't find in malaysiawest). Only when the VM doesn't exist.
  if ! exists vm show -g "$HOST_RG" -n "$VM"; then
    local publisher offer image_sku version day newest
    IFS=: read -r publisher offer image_sku version <<<"$IMAGE_URN"
    if ! exists vm image show --location "$LOCATION" --urn "$IMAGE_URN"; then
      newest=$(az rest --method get --only-show-errors --output tsv --query '[].name' \
        --url "https://management.azure.com$SUB_SCOPE/providers/Microsoft.Compute/locations/$LOCATION/publishers/$publisher/artifacttypes/vmimage/offers/$offer/skus/$image_sku/versions?api-version=2024-07-01" 2>/dev/null \
        | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 3 | sed "s/^/$publisher:$offer:$image_sku:/" | paste -sd' ' -)
      die "image $IMAGE_URN is not in $LOCATION. Newest there: ${newest:-none found}. Pass image=<one of them> (docs/MAINTENANCE.md, \"The VM image\")"
    fi
    # Ubuntu versions are 24.04.YYYYMMDDn. The pin is your choice, so an image younger than the
    # supply-chain rule's 14 days is reported, not refused (a region may have nothing older).
    day=$(sed -n 's/^[0-9]*\.[0-9]*\.\([0-9]\{8\}\).*/\1/p' <<<"$version")
    if [[ -n $day ]] && (( ($(date -u +%s) - $(date -u -d "$day" +%s)) / 86400 < MIN_IMAGE_AGE_DAYS )); then
      log "note: $IMAGE_URN was published $day, under the $MIN_IMAGE_AGE_DAYS-day rule; using it because it is pinned"
    fi
    log "image: $IMAGE_URN (present in $LOCATION)"
  fi
  log "preflight passed"
}

network() {
  log "network: $VNET, $NSG (80 and 443 in, nothing else), static IPv4 $PIP"
  exists network vnet show -g "$HOST_RG" -n "$VNET" \
    || q network vnet create -g "$HOST_RG" -n "$VNET" -l "$LOCATION" --address-prefixes 10.20.0.0/24 \
         --subnet-name "$SUBNET" --subnet-prefixes 10.20.0.0/26
  exists network nsg show -g "$HOST_RG" -n "$NSG" || q network nsg create -g "$HOST_RG" -n "$NSG" -l "$LOCATION"
  q network nsg rule create -g "$HOST_RG" --nsg-name "$NSG" -n allow-http --priority 100 --direction Inbound \
    --access Allow --protocol Tcp --source-address-prefixes Internet --source-port-ranges '*' \
    --destination-address-prefixes '*' --destination-port-ranges 80
  q network nsg rule create -g "$HOST_RG" --nsg-name "$NSG" -n allow-https --priority 110 --direction Inbound \
    --access Allow --protocol Tcp --source-address-prefixes Internet --source-port-ranges '*' \
    --destination-address-prefixes '*' --destination-port-ranges 443
  exists network public-ip show -g "$HOST_RG" -n "$PIP" \
    || q network public-ip create -g "$HOST_RG" -n "$PIP" -l "$LOCATION" --sku Standard --allocation-method Static --version IPv4
}

create_vm() {
  exists disk show -g "$HOST_RG" -n "$DATA_DISK" \
    || q disk create -g "$HOST_RG" -n "$DATA_DISK" -l "$LOCATION" --size-gb "$DATA_DISK_GB" --sku "$DISK_SKU"
  q lock create --name do-not-delete --lock-type CanNotDelete -g "$HOST_RG" --resource "$DATA_DISK" \
    --resource-type Microsoft.Compute/disks --notes "Chat history and media live here"

  if ! exists vm show -g "$HOST_RG" -n "$VM"; then
    local keydir
    log "creating $VM ($VM_SIZE, $IMAGE_URN)"
    # Azure insists on an admin login. It gets a key whose private half is deleted right here,
    # and the host disables SSH anyway: access is Run Command only.
    keydir=$(mktemp -d)
    ssh-keygen -q -t ed25519 -N '' -C no-login -f "$keydir/key"
    q vm create -g "$HOST_RG" -n "$VM" -l "$LOCATION" --size "$VM_SIZE" \
      --image "$IMAGE_URN" \
      --security-type TrustedLaunch --enable-secure-boot true --enable-vtpm true \
      --admin-username "$ADMIN_USER" --authentication-type ssh --ssh-key-values "$(cat "$keydir/key.pub")" \
      --assign-identity '[system]' \
      --vnet-name "$VNET" --subnet "$SUBNET" --nsg "$NSG" --public-ip-address "$PIP" \
      --os-disk-name "$VM-os" --os-disk-size-gb "$OS_DISK_GB" --storage-sku "$DISK_SKU" \
      --os-disk-delete-option Delete --nic-delete-option Delete --patch-mode ImageDefault
    rm -rf "$keydir"
  fi
  if [[ -z $(v vm show -g "$HOST_RG" -n "$VM" --query "storageProfile.dataDisks[?lun==\`0\`].name") ]]; then
    q vm disk attach -g "$HOST_RG" --vm-name "$VM" --name "$DATA_DISK" --lun 0 --caching ReadOnly
    log "attached $DATA_DISK at LUN 0"
  fi
  # Boot diagnostics (managed storage), which the Serial Console needs in an emergency.
  q vm boot-diagnostics enable -g "$HOST_RG" -n "$VM"
}

storage() {
  log "backup storage: $SA/$CONTAINER"
  if ! exists storage account show -g "$APP_RG" -n "$SA"; then
    q storage account create -g "$APP_RG" -n "$SA" -l "$LOCATION" --sku Standard_LRS --kind StorageV2 --access-tier Hot \
      --min-tls-version TLS1_2 --https-only true --allow-blob-public-access false --allow-shared-key-access false \
      --allow-cross-tenant-replication false
  else
    q storage account update -g "$APP_RG" -n "$SA" --access-tier Hot --min-tls-version TLS1_2 --https-only true \
      --allow-blob-public-access false --allow-shared-key-access false --allow-cross-tenant-replication false
  fi
  q storage account blob-service-properties update -g "$APP_RG" --account-name "$SA" \
    --enable-delete-retention true --delete-retention-days "$SOFT_DELETE_DAYS" \
    --enable-container-delete-retention true --container-delete-retention-days "$SOFT_DELETE_DAYS" \
    --enable-versioning false
  exists storage container-rm show -g "$APP_RG" --storage-account "$SA" -n "$CONTAINER" \
    || q storage container-rm create -g "$APP_RG" --storage-account "$SA" -n "$CONTAINER" --public-access off
  # Media is not in the rule: files still in use are old too. The owner's monthly compaction
  # (compact_media.py) handles it.
  local policy
  policy=$(mktemp)
  jq -n --arg c "$CONTAINER" --argjson days "$KEEP_DAYS" '{rules: [{enabled: true, name: "expire-dumps-manifests-probes", type: "Lifecycle",
    definition: {actions: {baseBlob: {delete: {daysAfterCreationGreaterThan: $days}}},
                 filters: {blobTypes: ["blockBlob"], prefixMatch: ["\($c)/db/", "\($c)/manifests/", "\($c)/selftest/"]}}}]}' > "$policy"
  q storage account management-policy create -g "$APP_RG" --account-name "$SA" --policy @"$policy"
  rm -f "$policy"
  q lock create --name do-not-delete --lock-type CanNotDelete -g "$APP_RG" --resource "$SA" \
    --resource-type Microsoft.Storage/storageAccounts --notes "Off-VM backups"
}

key_vault() {
  log "Key Vault: $KV"
  exists keyvault show -g "$APP_RG" -n "$KV" \
    || q keyvault create -g "$APP_RG" -n "$KV" -l "$LOCATION" --sku standard \
         --enable-rbac-authorization true --enable-purge-protection true --retention-days 90
  q lock create --name do-not-delete --lock-type CanNotDelete -g "$APP_RG" --resource "$KV" \
    --resource-type Microsoft.KeyVault/vaults --notes "Secrets, including the backups' private key"
}

identities() { # <owner's object id>
  local vm_pid deploy_pid
  role_definition "$BACKUP_ROLE" "Create and read blobs; never overwrite or delete them. Append-only backups." '[]' \
    '["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read","Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action"]'
  # Managed Run Command only (create, read its result, delete it): the API with protected
  # parameters. Not runCommand/action, the older API, which has none.
  role_definition "$RUNCMD_ROLE" "Run scripts on a VM through managed Run Command; nothing else." \
    '["Microsoft.Compute/virtualMachines/read","Microsoft.Compute/virtualMachines/runCommands/read","Microsoft.Compute/virtualMachines/runCommands/write","Microsoft.Compute/virtualMachines/runCommands/delete"]' '[]'

  vm_pid=$(v vm show -g "$HOST_RG" -n "$VM" --query identity.principalId)
  [[ -n $vm_pid ]] || die "the VM has no system identity"
  assign "$vm_pid" ServicePrincipal "$BACKUP_ROLE" "$CONTAINER_ID"
  assign "$vm_pid" ServicePrincipal "Key Vault Secrets User" "$KV_ID"
  # The owner: manages secrets, and runs the media compaction (which deletes).
  assign "$1" User "Key Vault Secrets Officer" "$KV_ID"
  assign "$1" User "Storage Blob Data Contributor" "$CONTAINER_ID"

  exists identity show -g "$APP_RG" -n "$DEPLOY_ID" || q identity create -g "$APP_RG" -n "$DEPLOY_ID" -l "$LOCATION"
  q identity federated-credential create -g "$APP_RG" --identity-name "$DEPLOY_ID" -n "github-$GITHUB_ENVIRONMENT" \
    --issuer https://token.actions.githubusercontent.com --subject "repo:$GITHUB_REPO:environment:$GITHUB_ENVIRONMENT" \
    --audiences api://AzureADTokenExchange
  deploy_pid=$(v identity show -g "$APP_RG" -n "$DEPLOY_ID" --query principalId)
  assign "$deploy_pid" ServicePrincipal "$RUNCMD_ROLE" "$VM_ID"
}

alerts() { # <email>
  log "alerts to $1"
  q monitor action-group create -g "$HOST_RG" -n "$ACTION_GROUP" --short-name ops --action email owner "$1"
  metric() { # <name> <severity> <window> <frequency> <condition> <description>
    q monitor metrics alert create -g "$HOST_RG" -n "$1" --scopes "$VM_ID" --severity "$2" --window-size "$3" \
      --evaluation-frequency "$4" --condition "$5" --description "$6" --action "$AG_ID" --auto-mitigate true
  }
  metric vm-unavailable 1 5m 1m "avg VmAvailabilityMetric < 1" "The VM is down or unreachable to Azure."
  metric vm-low-memory 2 15m 5m "avg Available Memory Bytes < 104857600" \
    "Under 100 MiB available for 15 minutes (docs/MAINTENANCE.md, Memory budget)."
  metric vm-cpu-credits-low 2 15m 5m "avg CPU Credits Remaining < 30" \
    "The burstable VM is close to being throttled to its baseline."
  q monitor activity-log alert create -g "$HOST_RG" -n vm-resource-health --scope "$SUB_SCOPE" \
    --condition "category=ResourceHealth and resourceId=$VM_ID" --action-group "$AG_ID" \
    --description "Azure reports the VM degraded or unavailable."
  q monitor activity-log alert create -g "$HOST_RG" -n role-assignment-changed --scope "$SUB_SCOPE" \
    --condition "category=Administrative and operationName=Microsoft.Authorization/roleAssignments/write and status=Succeeded" \
    --action-group "$AG_ID" --description "Someone granted a role in this subscription. Expected only when you run setup.sh."
}

set_budget() { # <email> [amount]
  local amount=${2:-} currency url existing body
  # Budgets are in the billing currency. Month-to-date cost reports it, once there is any usage.
  currency=$(az rest --method post --only-show-errors \
    --url "https://management.azure.com$SUB_SCOPE/providers/Microsoft.CostManagement/query?api-version=2023-03-01" \
    --body '{"type":"ActualCost","timeframe":"MonthToDate","dataset":{"granularity":"None","aggregation":{"cost":{"name":"Cost","function":"Sum"}}}}' \
    --query 'properties.rows[0][1]' --output tsv 2>/dev/null || true)
  if [[ -z $amount ]]; then
    [[ -z $currency || $currency == INR ]] || die "the billing currency is $currency: pass budget=<amount in $currency> (₹700 is about 8 USD)"
    amount=700
  fi
  log "budget: $amount ${currency:-(billing currency)} a month, alerts at 50, 80 and 100 % (and 100 % forecast)"
  url="https://management.azure.com$SUB_SCOPE/providers/Microsoft.Consumption/budgets/$BUDGET_NAME?api-version=2023-05-01"
  existing=$(az rest --method get --url "$url" --only-show-errors --output json 2>/dev/null || echo null)
  jq -e . >/dev/null 2>&1 <<<"$existing" || existing=null # no budget yet, or not JSON: start fresh
  # An existing budget keeps its start date (Azure refuses to move it) and passes its eTag back.
  body=$(jq -n --argjson amount "$amount" --arg email "$1" --argjson old "$existing" \
    --arg start "$(date -u +%Y-%m-01)T00:00:00Z" --arg end "$(date -u -d "$(date -u +%Y-%m-01) +5 years" +%Y-%m-01)T00:00:00Z" '
    def n(t; kind): {enabled: true, operator: "GreaterThanOrEqualTo", threshold: t, thresholdType: kind, contactEmails: [$email]};
    {properties: {category: "Cost", amount: $amount, timeGrain: "Monthly",
      timePeriod: ($old.properties.timePeriod // {startDate: $start, endDate: $end}),
      notifications: {actual50: n(50; "Actual"), actual80: n(80; "Actual"), actual100: n(100; "Actual"), forecast100: n(100; "Forecasted")}}}
    + (if $old.eTag then {eTag: $old.eTag} else {} end)')
  az rest --method put --url "$url" --body "$body" --only-show-errors --output none \
    || die "the budget could not be set (is Cost Management available for this subscription type?)"
}

# ==================================================================================================
# --- Secrets: values go from 0600 files on /dev/shm to Key Vault, never on a command line.
# Asked-for secrets: name|prompt|shape.
ASKED=(
  'chitthi-google-client-id|Google OAuth client ID|^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$'
  'chitthi-google-client-secret|Google OAuth client secret|^[A-Za-z0-9_-]{20,}$'
  'chitthi-github-client-id|GitHub OAuth app client ID|^[A-Za-z0-9.]{16,}$'
  'chitthi-github-client-secret|GitHub OAuth app client secret|^[0-9a-f]{40}$'
  'chitthi-r2-endpoint|R2 S3 endpoint (https://<account id>.r2.cloudflarestorage.com)|^https://[0-9a-f]{32}(\.(eu|fedramp))?\.r2\.cloudflarestorage\.com$'
  'chitthi-r2-access-key-id|R2 access key ID|^[0-9a-f]{32}$'
  'chitthi-r2-secret-access-key|R2 secret access key|^[0-9a-f]{64}$'
  'chitthi-hc-backup-url|healthchecks.io ping URL for the nightly backup|^https://hc-ping\.com/[A-Za-z0-9/_-]+$'
  'chitthi-hc-drill-url|healthchecks.io ping URL for the monthly restore drill|^https://hc-ping\.com/[A-Za-z0-9/_-]+$'
)
open_vault() { # waits for access; sets $have (stored names) and $tmp
  local i
  exists keyvault show -g "$APP_RG" -n "$KV" || die "Key Vault $KV doesn't exist yet: run setup.sh infra first"
  log "Key Vault $KV: waiting until you can manage secrets (a new role assignment takes a few minutes)"
  for i in $(seq 1 40); do
    have=$(v keyvault secret list --vault-name "$KV" --query '[].name' 2>/dev/null) && break
    [[ $i -lt 40 ]] || die "you still can't list secrets in $KV; run 'setup.sh infra' first, or wait and retry"
    sleep 15
  done
  tmp=$(mktemp -d -p /dev/shm 2>/dev/null || mktemp -d)
  # Expanded now: $tmp is the caller's local, gone by the time the trap runs.
  # shellcheck disable=SC2064
  trap "rm -rf -- '$tmp'" EXIT
}
has() { grep -qx "$1" <<<"$have"; }
store() { # <name> <file>: a new value (a new version, if the name exists)
  q keyvault secret set --vault-name "$KV" --name "$1" --file "$2" --encoding utf-8
  rm -f "$2"
  log "stored $1"
}
new_password() { # <name>: 32 characters of [A-Za-z0-9_-] (what deploy.sh requires)
  openssl rand -base64 24 | tr '+/' '-_' | tr -d '\n' > "$tmp/value"
  store "$1" "$tmp/value"
}
new_keypair() {
  rm -rf "$tmp/age" && mkdir "$tmp/age"
  python3 "$here/age_keypair.py" "$tmp/age"
  store chitthi-backup-age-identity "$tmp/age/identity"
  store chitthi-backup-age-recipient "$tmp/age/recipient"
  log "new backup keypair. Keep a copy of the private key outside Azure (a password manager): without it no backup can be read."
  log "  show it once with: az keyvault secret show --vault-name $KV -n chitthi-backup-age-identity --query value -o tsv"
}
ask() { # <name>: asks for the value (hidden), checks its shape, stores it
  local entry prompt shape value
  for entry in "${ASKED[@]}"; do
    [[ ${entry%%|*} == "$1" ]] || continue
    prompt=${entry#*|}; shape=${prompt#*|}; prompt=${prompt%%|*}
    while :; do
      read -rsp "  $prompt: " value
      echo
      [[ $value =~ $shape ]] && break
      echo "  that doesn't look like one; try again (Ctrl-C to stop; what's stored so far stays)"
    done
    printf '%s' "$value" > "$tmp/value"
    unset value
    store "$1" "$tmp/value"
    return 0
  done
  die "no such secret: $1"
}

secrets() { # every missing secret: generated or asked for; never replaces one
  local have tmp name entry
  open_vault
  for name in chitthi-postgres-password chitthi-api-db-password; do
    has "$name" || new_password "$name"
  done
  if has chitthi-backup-age-identity && has chitthi-backup-age-recipient; then
    :
  elif has chitthi-backup-age-identity || has chitthi-backup-age-recipient; then
    die "only one half of the backup keypair is in Key Vault; restore the other half (or, if no backup was ever made, delete both and re-run)"
  else
    new_keypair
  fi
  for entry in "${ASKED[@]}"; do
    has "${entry%%|*}" || ask "${entry%%|*}"
  done
  log "all secrets are in $KV"
}

rotate() { # <name>: a new value for one secret (docs/MAINTENANCE.md, "Secret rotation")
  local have tmp name=${arg[name]:-}
  [[ -n $name ]] || die "usage: setup.sh rotate name=<secret>"
  open_vault
  has "$name" || die "$name isn't stored yet: use setup.sh secrets"
  case $name in
    chitthi-postgres-password | chitthi-api-db-password)
      new_password "$name"
      log "next: deploy (Actions > Deploy > Run workflow). The deploy sets the new password in Postgres." ;;
    chitthi-backup-age-identity | chitthi-backup-age-recipient)
      # Old media stays encrypted to the old key until compaction removes it, and old dumps until
      # they expire: the old private key is kept as -previous, which the drill and restore also use.
      if has chitthi-backup-age-identity-previous; then
        die "chitthi-backup-age-identity-previous still exists. Delete it only once nothing encrypted to it remains (12 weeks after the last rotation, docs/MAINTENANCE.md), then rotate again"
      fi
      az keyvault secret show --vault-name "$KV" --name chitthi-backup-age-identity --query value --output tsv --only-show-errors \
        | tr -d '\n' > "$tmp/previous"
      [[ -s $tmp/previous ]] || die "could not read the current private key"
      store chitthi-backup-age-identity-previous "$tmp/previous"
      new_keypair
      log "next: tonight's backup uses the new key; keep the old private key (now -previous) until $(date -u -d '+12 weeks' +%F)." ;;
    *)
      ask "$name"
      log "next: deploy for OAuth secrets; the backup secrets are read at every run. Then revoke the old value at its provider." ;;
  esac
}

# ==================================================================================================
check() { # [infra|summary]: secrets not yet stored are reported as todo, not counted
  local fails=0 todo=0 got vm_pid deploy_pid name names
  ok() { echo "ok   $*"; }
  bad() { echo "FAIL $*"; fails=$((fails + 1)); }
  expect() { if [[ $2 == "$3" ]]; then ok "$1"; else bad "$1: got $2, expected $3"; fi; }
  lower() { tr '[:upper:]' '[:lower:]'; }

  # The VM, its network and disks
  got=$(j vm show -g "$HOST_RG" -n "$VM" --query "{size: hardwareProfile.vmSize, identity: identity.type, security: securityProfile.securityType}")
  expect "VM $VM: size, system identity, Trusted Launch" "$got" "{\"identity\":\"SystemAssigned\",\"security\":\"TrustedLaunch\",\"size\":\"$VM_SIZE\"}"
  expect "VM is running" "$(v vm get-instance-view -g "$HOST_RG" -n "$VM" --query "instanceView.statuses[?starts_with(code, 'PowerState/')].code | [0]")" PowerState/running
  got=$(j network public-ip show -g "$HOST_RG" -n "$PIP" --query "{allocation: publicIPAllocationMethod, sku: sku.name}")
  expect "public IPv4 is static" "$got" '{"allocation":"Static","sku":"Standard"}'
  got=$(j network nsg rule list -g "$HOST_RG" --nsg-name "$NSG" --query "sort_by([?direction=='Inbound' && access=='Allow'], &priority)[].[protocol, sourceAddressPrefix, destinationPortRange]")
  expect "network security group lets in TCP 80 and 443, nothing else" "$got" '[["Tcp","Internet","80"],["Tcp","Internet","443"]]'
  got=$(v network nic list -g "$HOST_RG" --query "[?virtualMachine.id!=null].networkSecurityGroup.id | [0]" | lower)
  expect "the VM's network interface uses that security group" "${got##*/}" "$NSG"
  expect "data disk $DATA_DISK at LUN 0" "$(v vm show -g "$HOST_RG" -n "$VM" --query "storageProfile.dataDisks[?lun==\`0\`].name | [0]")" "$DATA_DISK"
  for name in "disk:$HOST_RG:$DATA_DISK:Microsoft.Compute/disks" "storage account:$APP_RG:$SA:Microsoft.Storage/storageAccounts" "Key Vault:$APP_RG:$KV:Microsoft.KeyVault/vaults"; do
    IFS=: read -r what rg res type <<<"$name"
    expect "$what $res can't be deleted (lock)" "$(v lock list -g "$rg" --resource "$res" --resource-type "$type" --query "[?level=='CanNotDelete'] | length(@)")" 1
  done

  # Backup storage
  got=$(j storage account show -g "$APP_RG" -n "$SA" --query "{sharedKey: allowSharedKeyAccess, publicBlobs: allowBlobPublicAccess, tls: minimumTlsVersion, httpsOnly: enableHttpsTrafficOnly, tier: accessTier}")
  expect "storage account: Entra sign-in only, no public blobs, TLS 1.2, HTTPS, Hot tier" "$got" '{"httpsOnly":true,"publicBlobs":false,"sharedKey":false,"tier":"Hot","tls":"TLS1_2"}'
  got=$(j storage account blob-service-properties show -g "$APP_RG" --account-name "$SA" \
    --query "{softDelete: deleteRetentionPolicy.enabled, days: deleteRetentionPolicy.days, versioning: isVersioningEnabled || \`false\`}")
  expect "blob soft delete for $SOFT_DELETE_DAYS days, no versioning" "$got" "{\"days\":$SOFT_DELETE_DAYS,\"softDelete\":true,\"versioning\":false}"
  got=$(j storage account management-policy show -g "$APP_RG" --account-name "$SA" \
    --query "policy.rules[?enabled].{days: definition.actions.baseBlob.delete.daysAfterCreationGreaterThan, prefixes: definition.filters.prefixMatch}" \
    | jq -c 'map(.days |= floor)') # Azure returns the days as a float
  expect "lifecycle deletes db/, manifests/ and selftest/ after $KEEP_DAYS days, and nothing else" "$got" \
    "[{\"days\":$KEEP_DAYS,\"prefixes\":[\"$CONTAINER/db/\",\"$CONTAINER/manifests/\",\"$CONTAINER/selftest/\"]}]"
  expect "container $CONTAINER is private" "$(v storage container-rm show -g "$APP_RG" --storage-account "$SA" -n "$CONTAINER" --query publicAccess)" None

  # Roles: exactly what each identity needs, nothing more
  got=$(j role definition list --custom-role-only true --name "$BACKUP_ROLE" --query "[0].permissions[0].{actions: actions, data: sort(dataActions)}")
  expect "role '$BACKUP_ROLE' grants create and read only" "$got" \
    '{"actions":[],"data":["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action","Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read"]}'
  got=$(j role definition list --custom-role-only true --name "$RUNCMD_ROLE" --query "[0].permissions[0].{actions: sort(actions), data: dataActions}")
  expect "role '$RUNCMD_ROLE' grants Run Command only" "$got" \
    '{"actions":["Microsoft.Compute/virtualMachines/read","Microsoft.Compute/virtualMachines/runCommands/delete","Microsoft.Compute/virtualMachines/runCommands/read","Microsoft.Compute/virtualMachines/runCommands/write"],"data":[]}'
  vm_pid=$(v vm show -g "$HOST_RG" -n "$VM" --query identity.principalId)
  got=$(json role assignment list --all --query "sort([?principalId=='$vm_pid'].join('@', [roleDefinitionName, scope]))" | jq -r 'join(" ")' | lower)
  expect "the VM's identity holds exactly: create-only on $CONTAINER, Secrets User on $KV" "$got" \
    "$(echo "$BACKUP_ROLE@$CONTAINER_ID Key Vault Secrets User@$KV_ID" | lower)"
  deploy_pid=$(v identity show -g "$APP_RG" -n "$DEPLOY_ID" --query principalId)
  got=$(json role assignment list --all --query "[?principalId=='$deploy_pid'].join('@', [roleDefinitionName, scope])" | jq -r 'join(" ")' | lower)
  expect "the deploy identity holds exactly: Run Command on $VM" "$got" "$(echo "$RUNCMD_ROLE@$VM_ID" | lower)"
  got=$(j identity federated-credential list -g "$APP_RG" --identity-name "$DEPLOY_ID" --query "[].{issuer: issuer, subject: subject, audiences: audiences}")
  expect "the deploy identity trusts only $GITHUB_REPO's '$GITHUB_ENVIRONMENT' environment" "$got" \
    "[{\"audiences\":[\"api://AzureADTokenExchange\"],\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"repo:$GITHUB_REPO:environment:$GITHUB_ENVIRONMENT\"}]"

  # Key Vault and its secrets (names only)
  got=$(j keyvault show -g "$APP_RG" -n "$KV" --query "{rbac: properties.enableRbacAuthorization, purgeProtection: properties.enablePurgeProtection, softDelete: properties.enableSoftDelete}")
  expect "Key Vault: RBAC, soft delete, purge protection" "$got" '{"purgeProtection":true,"rbac":true,"softDelete":true}'
  if names=$(v keyvault secret list --vault-name "$KV" --query '[].name' 2>/dev/null); then
    for name in "${SECRETS[@]}"; do
      if grep -qx "$name" <<<"$names"; then :
      elif [[ ${1:-} == infra || ${1:-} == summary ]]; then todo=$((todo + 1))
      else bad "secret $name is missing (setup.sh secrets)"
      fi
    done
    if [[ $todo -gt 0 ]]; then echo "todo $todo secrets to store: bash deploy/azure/setup.sh secrets"; else ok "all ${#SECRETS[@]} secrets are stored"; fi
  else
    if [[ ${1:-} == infra || ${1:-} == summary ]]; then echo "todo secrets: your Key Vault access is still replicating; run setup.sh secrets in a few minutes"
    else bad "can't list secrets in $KV"; fi
  fi

  # Alerts and the budget
  # shellcheck disable=SC2016 # a JMESPath literal, not a shell expansion
  expect "action group $ACTION_GROUP emails someone" "$(j monitor action-group show -g "$HOST_RG" -n "$ACTION_GROUP" --query 'length(emailReceivers) > `0`')" true
  for name in "${METRIC_ALERTS[@]}"; do
    expect "metric alert $name is on" "$(j monitor metrics alert show -g "$HOST_RG" -n "$name" --query enabled 2>/dev/null || echo missing)" true
  done
  for name in "${ACTIVITY_ALERTS[@]}"; do
    expect "activity log alert $name is on" "$(j monitor activity-log alert show -g "$HOST_RG" -n "$name" --query enabled 2>/dev/null || echo missing)" true
  done
  got=$(az rest --method get --only-show-errors --output json \
    --url "https://management.azure.com$SUB_SCOPE/providers/Microsoft.Consumption/budgets/$BUDGET_NAME?api-version=2023-05-01" 2>/dev/null \
    | jq -c '[.properties.notifications[] | select(.enabled) | "\(.thresholdType):\(.threshold | floor)"] | sort' || echo missing) # thresholds come back as floats (100.0)
  expect "budget $BUDGET_NAME alerts at 50/80/100 % and on a 100 % forecast" "$got" '["Actual:100","Actual:50","Actual:80","Forecasted:100"]'

  echo
  if [[ $fails -gt 0 ]]; then die "$fails check(s) failed"; fi
  log "all checks passed"
}

# Read-only: every check (missing secrets shown as todo), then the IP and the GitHub values, even
# when some checks fail. Exits non-zero if any did.
summary() {
  local rc=0 email
  ( check summary ) || rc=$?
  email=$(v monitor action-group show -g "$HOST_RG" -n "$ACTION_GROUP" --query "emailReceivers[0].emailAddress" 2>/dev/null || true)
  next_steps "${email:-<you@…>}"
  return "$rc"
}

next_steps() { # <email>
  local ip client_id
  ip=$(v network public-ip show -g "$HOST_RG" -n "$PIP" --query ipAddress 2>/dev/null || echo "(no public IP yet)")
  client_id=$(v identity show -g "$APP_RG" -n "$DEPLOY_ID" --query clientId 2>/dev/null || echo "(no deploy identity yet)")
  cat <<EOF

Next (docs/MAINTENANCE.md, "Azure setup"):
  1. DNS: an A record chitthi.dhruvgoyal.tech -> $ip (no AAAA).
  2. Secrets: bash deploy/azure/setup.sh secrets
  3. The host: bash deploy/azure/run-on-vm.sh deploy/host/bootstrap.sh
  4. The edge: bash deploy/azure/run-on-vm.sh deploy/host/edge.sh sha=<commit> acme_email=$1
  5. GitHub, environment "$GITHUB_ENVIRONMENT" (Settings > Environments > $GITHUB_ENVIRONMENT):
     secrets (masked in the public logs):
       AZURE_CLIENT_ID=$client_id
       AZURE_TENANT_ID=$TENANT
       AZURE_SUBSCRIPTION_ID=$SUB
       KEY_VAULT=$KV  BACKUP_ACCOUNT=$SA  R2_BUCKET=<your bucket>  ACME_EMAIL=$1
     variables:
       VM_RG=$HOST_RG  VM_NAME=$VM  BACKUP_CONTAINER=$CONTAINER
     then the repository variable DEPLOY_ENABLED=true
  6. After the first deploy: bash deploy/azure/run-on-vm.sh deploy/host/backup.sh selftest
EOF
}

case $cmd in
  infra) infra ;;
  secrets) secrets ;;
  rotate) rotate ;;
  check) check ;;
  summary) summary ;;
  *) die "usage: setup.sh infra alert_email=<address> [region=] [disks=] [image=] [budget=<amount>] [subscription=<id>] | secrets | rotate name=<secret> | check | summary" ;;
esac
