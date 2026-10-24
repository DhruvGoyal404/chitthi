#!/usr/bin/env bash
# Runs one of the repo's host scripts as root on the VM through managed Run Command (there is no
# SSH), prints its output, and exits with its exit code. From Cloud Shell or the deploy workflow:
#
#   deploy/azure/run-on-vm.sh deploy/host/bootstrap.sh
#   deploy/azure/run-on-vm.sh deploy/host/edge.sh sha=<commit> acme_email=<address>
#   deploy/azure/run-on-vm.sh deploy/host/deploy.sh rollback
#   deploy/azure/run-on-vm.sh deploy/host/backup.sh selftest
#
# VM_RG and VM_NAME choose the VM (default apps-host / apps-vm, as setup.sh creates it).
#
# Managed Run Command (`az vm run-command create`), not the older action Run Command (`invoke`):
# - Secrets go in protectedParameters, the only Run Command field meant for them. Microsoft
#   documents managed Run Command as "passing secrets (parameters, passwords) in a secure manner";
#   the action API has no protected parameters, and whatever it's given sits in the script or the
#   parameters, which are stored and shown. On Linux a named parameter reaches the script as an
#   environment variable.
#   - RUN_ON_VM_GITHUB_TOKEN, if set (the deploy job's own GITHUB_TOKEN, which GitHub revokes when
#     the job ends), is passed as the protected parameter CHITTHI_GITHUB_TOKEN, and nowhere else.
#   - After every run, the run command's whole resource view (instance view included) is fetched
#     and must not contain the token. Then the resource is deleted.
# - Its instance view carries the script's real exit code (`invoke` reports success regardless).
# The script's own arguments are not secret: they travel inside the script, after a check that
# they hold only characters no shell treats specially. (Named `--parameters` would become
# environment variables, and these scripts take key=value arguments.)
# Output is the last 4 KB, so the scripts put what matters (failures, verification) last.
set -euo pipefail

VM_RG=${VM_RG:-apps-host}
VM_NAME=${VM_NAME:-apps-vm}

die() { echo "run-on-vm: $*" >&2; exit 1; }
[[ $# -ge 1 && -f $1 ]] || die "usage: run-on-vm.sh <script> [arguments...]"
script=$1
shift
for a in "$@"; do
  [[ $a =~ ^[A-Za-z0-9@._:/=+-]+$ ]] || die "argument '$a' has characters this refuses to pass"
done
token=${RUN_ON_VM_GITHUB_TOKEN:-}
unset RUN_ON_VM_GITHUB_TOKEN
[[ -z $token || $token =~ ^[A-Za-z0-9_.-]{20,}$ ]] || die "RUN_ON_VM_GITHUB_TOKEN doesn't look like a GitHub token"

delim=END_OF_SCRIPT_$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
grep -qF "$delim" "$script" && die "the script contains the wrapper's delimiter"
name=run-on-vm-$(date -u +%Y%m%d%H%M%S)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
payload=$(mktemp)
# shellcheck disable=SC2317 # called by the EXIT trap
cleanup() {
  rm -f "$payload"
  az vm run-command delete --resource-group "$VM_RG" --vm-name "$VM_NAME" --name "$name" --yes \
    --only-show-errors --output none >/dev/null 2>&1 || echo "run-on-vm: could not delete run command $name" >&2
}
trap cleanup EXIT

# The wrapper's own lines are written literally: they run on the VM.
# shellcheck disable=SC2016
{
  echo '#!/bin/sh'
  if [[ -n $token ]]; then
    echo '[ -n "${CHITTHI_GITHUB_TOKEN:-}" ] || { echo "run-on-vm: the protected parameter did not arrive"; exit 97; }'
  fi
  echo 'f=$(mktemp)'
  echo "cat > \"\$f\" <<'$delim'"
  cat "$script"
  [[ -z $(tail -c 1 "$script") ]] || echo
  echo "$delim"
  echo "bash \"\$f\" $* 2>&1"
  echo 'rc=$?'
  echo 'rm -f "$f"'
  echo 'exit $rc'
} > "$payload"
if [[ -n $token ]] && grep -qF -- "$token" "$payload"; then die "the token is in the script text"; fi

protected=()
[[ -n $token ]] && protected=(--protected-parameters "CHITTHI_GITHUB_TOKEN=$token")
location=$(az vm show --resource-group "$VM_RG" --name "$VM_NAME" --query location --only-show-errors --output tsv)
echo "run-on-vm: $script $* on $VM_RG/$VM_NAME (run command $name)" >&2
az vm run-command create --resource-group "$VM_RG" --vm-name "$VM_NAME" --name "$name" --location "$location" \
  --script @"$payload" "${protected[@]}" --async-execution false --timeout-in-seconds 3600 \
  --only-show-errors --output none || echo "run-on-vm: the run command did not complete cleanly" >&2
unset protected

view=$(az vm run-command show --resource-group "$VM_RG" --vm-name "$VM_NAME" --name "$name" --instance-view \
  --only-show-errors --output json)
if [[ -n $token ]] && grep -qF -- "$token" <<<"$view"; then
  die "the token came back from the API in the run command's view; treat it as exposed"
fi
unset token
jq -r '.instanceView.output // empty' <<<"$view"
err=$(jq -r '.instanceView.error // empty' <<<"$view")
[[ -z $err ]] || printf '%s\n' "$err" >&2
rc=$(jq -r '.instanceView.exitCode // empty' <<<"$view")
[[ $rc =~ ^[0-9]+$ ]] || die "no exit code came back (state: $(jq -r '.instanceView.executionState // "unknown"' <<<"$view"))"
exit "$rc"
