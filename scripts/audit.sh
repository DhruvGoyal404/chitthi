#!/usr/bin/env bash
# npm audit at high and above, with dated exceptions (audit-exceptions.json).
#
# An exception names one advisory and the day it expires: the day its fix clears the 14-day
# release rule. Until then the advisory is reported but doesn't fail the build; from that day it
# fails again, so the upgrade can't be forgotten. Anything high or critical without a current
# exception fails, as does an audit that couldn't run.
#
# AUDIT_TODAY=YYYY-MM-DD overrides the date (to check what an expiry will do).
set -euo pipefail
cd "$(dirname "$0")/.."

today=${AUDIT_TODAY:-$(date -u +%F)}
report=$(npm audit --json 2>/dev/null || true)
jq -e '.vulnerabilities' >/dev/null <<<"$report" 2>/dev/null \
  || { echo "audit: npm audit didn't produce a report:"; echo "$report" | head -20; exit 1; }
nocr() { tr -d '\r'; } # jq on Windows ends lines with CRLF

# One line per advisory at high or above: <GHSA id> <severity> <package> <title>
found=$(jq -r '[.vulnerabilities[].via[] | objects | select(.severity == "high" or .severity == "critical")
  | {id: (.url | capture("(?<g>GHSA(-[0-9a-z]{4}){3})").g), severity, name, title}] | unique_by(.id)[]
  | "\(.id) \(.severity) \(.name) \(.title)"' <<<"$report" | nocr)

failures=0
while read -r id severity name title; do
  [[ -n $id ]] || continue
  expires=$(jq -r --arg id "$id" '.[] | select(.id == $id) | .expires' audit-exceptions.json | nocr)
  if [[ -n $expires && $today < $expires ]]; then
    echo "excepted until $expires: $id ($severity) $name: $title"
  elif [[ -n $expires ]]; then
    echo "FAIL $id ($severity) $name: its exception expired on $expires; the fix is adoptable now: upgrade"
    failures=$((failures + 1))
  else
    echo "FAIL $id ($severity) $name: $title"
    failures=$((failures + 1))
  fi
done <<<"$found"

# Exceptions for advisories that no longer apply are clutter: say so (without failing).
jq -r '.[].id' audit-exceptions.json | nocr | while read -r id; do
  grep -q "^$id " <<<"$found" || echo "note: $id no longer appears in the audit; remove its exception"
done

if [[ $failures -gt 0 ]]; then echo "audit: $failures advisories at high or above"; exit 1; fi
echo "audit: nothing at high or above without a current exception"
