#!/usr/bin/env bash
# Runs one of the repo's host scripts as root on the VM through Azure Run Command (there is no
# SSH), prints its output, and exits with its exit code. From Cloud Shell or the deploy workflow:
#
#   deploy/azure/run-on-vm.sh deploy/host/bootstrap.sh
#   deploy/azure/run-on-vm.sh deploy/host/edge.sh sha=<commit> acme_email=<address>
#   deploy/azure/run-on-vm.sh deploy/host/deploy.sh rollback
#   deploy/azure/run-on-vm.sh deploy/host/backup.sh selftest
#
# VM_RG and VM_NAME choose the VM (default apps-host / apps-vm, as setup.sh creates it).
# RUN_ON_VM_GITHUB_TOKEN, if set (the deploy workflow's own GITHUB_TOKEN), reaches the script as
# CHITTHI_GITHUB_TOKEN, exported inside the wrapper: never an argument, never echoed. The repo is
# private, and deploy.sh and edge.sh use it to fetch their files and images. It is revoked when
# the workflow job ends, so the copy Run Command keeps on the VM (root-only) is dead minutes later.
#
# Why not plain `az vm run-command invoke --parameters`: it reports success whatever the script's
# exit code, and on Linux it may hand name=value parameters over as environment variables rather
# than arguments. So the script travels inside a wrapper that passes its arguments itself and
# ends its output with the exit code, which this reads back. Run Command keeps only the last
# 4096 bytes of output, so the scripts put what matters (failures, verification) last.
set -euo pipefail

VM_RG=${VM_RG:-apps-host}
VM_NAME=${VM_NAME:-apps-vm}

die() { echo "run-on-vm: $*" >&2; exit 1; }
[[ $# -ge 1 && -f $1 ]] || die "usage: run-on-vm.sh <script> [arguments...]"
script=$1
shift
# Arguments are pasted into the wrapper unquoted, so only characters no shell treats specially.
for a in "$@"; do
  [[ $a =~ ^[A-Za-z0-9@._:/=+-]+$ ]] || die "argument '$a' has characters this refuses to pass"
done

token=${RUN_ON_VM_GITHUB_TOKEN:-}
[[ -z $token || $token =~ ^gh[a-z]_[A-Za-z0-9_]+$ ]] || die "RUN_ON_VM_GITHUB_TOKEN is not a GitHub token"

delim=END_OF_SCRIPT_$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
grep -qF "$delim" "$script" && die "the script contains the wrapper's delimiter"
payload=$(mktemp)
trap 'rm -f "$payload"' EXIT
# The wrapper's own lines are written literally: they run on the VM.
# shellcheck disable=SC2016
{
  echo '#!/bin/sh'
  echo 'f=$(mktemp)'
  echo "cat > \"\$f\" <<'$delim'"
  cat "$script"
  [[ -z $(tail -c 1 "$script") ]] || echo
  echo "$delim"
  [[ -z $token ]] || echo "CHITTHI_GITHUB_TOKEN=$token; export CHITTHI_GITHUB_TOKEN"
  echo "bash \"\$f\" $* 2>&1"
  echo 'rc=$?'
  echo 'rm -f "$f"'
  echo 'echo "run-on-vm: exit $rc"'
} > "$payload"

echo "run-on-vm: $script $* on $VM_RG/$VM_NAME" >&2
message=$(az vm run-command invoke --resource-group "$VM_RG" --name "$VM_NAME" --command-id RunShellScript \
  --scripts @"$payload" --only-show-errors --output json | jq -r '.value[0].message // empty')
printf '%s\n' "$message"
rc=$(grep -oE '^run-on-vm: exit [0-9]+$' <<<"$message" | tail -n 1 | grep -oE '[0-9]+$' || true)
[[ -n $rc ]] || die "the script's exit code didn't come back (Run Command failed, or timed out)"
exit "$rc"
