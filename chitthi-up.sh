#!/usr/bin/env bash
# Brings https://chitthi.dhruvgoyal.tech back, from fully down to live in about 5-10 minutes.
# Pairs with chitthi-down.sh (docs/MAINTENANCE.md, "Up and down"). Git Bash, Cloud Shell or Linux:
#
#   bash chitthi-up.sh [--app-only]
#
# 1. The host: deploy/azure/host-up.sh (new static IPv4, VM started, alerts on).
#    --app-only skips it, for when another app's up script brought the host up.
# 2. Cloudflare: the A record to the new address (DNS only, grey cloud).
# 3. Waits for /api/health on the new address, then for the domain itself with a valid certificate.
# 4. Monitors resumed: healthchecks.io chitthi-* and the UptimeRobot monitor.
# 5. One real request to each outside dependency: Google and GitHub sign-in, Let's Encrypt, and,
#    from the VM with its own identity, Key Vault, Azure Blob and R2.
# Re-runnable. Exits non-zero if the site never got healthy, or if a dependency check failed.
cd "$(dirname "$0")"
# shellcheck source=deploy/azure/lib.sh
source deploy/azure/lib.sh
APP=chitthi
DOMAIN=chitthi.dhruvgoyal.tech
ZONE=dhruvgoyal.tech
HEALTHY='{"status":"ok","db":"ok"}'
started=$SECONDS

app_only=''
for a in "$@"; do
  case $a in
    --app-only) app_only=1 ;;
    *) die "usage: bash chitthi-up.sh [--app-only]" ;;
  esac
done

preflight require-enabled
if [[ -z $app_only ]]; then bash deploy/azure/host-up.sh "app=$APP"; else set_app_state "$APP" up; fi
ip=$(host_ip)
[[ -n $ip ]] || die "$PIP has no address: run without --app-only"

step "DNS: $DOMAIN -> $ip"
cf_set_a "$ZONE" "$DOMAIN" "$ip" chitthi-cloudflare-dns-token

step "Health on $ip (the certificate checked against $DOMAIN, DNS bypassed)"
out=''
for _ in $(seq 1 60); do
  out=$(curl -sS --max-time 10 --resolve "$DOMAIN:443:$ip" "https://$DOMAIN/api/health" 2>&1 || true)
  [[ $out == "$HEALTHY" ]] && break
  sleep 5
done
[[ $out == "$HEALTHY" ]] || die "no healthy answer from $ip in 5 minutes (last: ${out:0:200}). The VM bills now: look with
  bash deploy/azure/run-on-vm.sh deploy/host/status.sh
or take it down again with bash chitthi-down.sh --skip-backup"
log "healthy: $out"

step "Public DNS answers $ip"
for _ in $(seq 1 60); do
  got=$(curl -sS --max-time 10 -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=$DOMAIN&type=A" \
    | jq -r '[.Answer[]? | select(.type == 1).data] | join(" ")' || true)
  [[ $got == "$ip" ]] && break
  sleep 5
done
[[ $got == "$ip" ]] || die "1.1.1.1 still answers '${got:-nothing}' for $DOMAIN after 5 minutes"
log "1.1.1.1: $got"
# This machine's own resolver may still hold the parked address for up to its TTL.
if command -v ipconfig >/dev/null; then ipconfig /flushdns >/dev/null 2>&1 || true; fi

step "The domain itself, through real DNS, with a trusted certificate"
for _ in $(seq 1 36); do
  out=$(curl -sS --max-time 10 "https://$DOMAIN/api/health" 2>&1 || true)
  [[ $out == "$HEALTHY" ]] && break
  sleep 5
done
[[ $out == "$HEALTHY" ]] || die "https://$DOMAIN doesn't answer here yet (${out:0:200}) though 1.1.1.1 has the new address: this machine's DNS is caching the old one. Re-run in a few minutes"
log "https://$DOMAIN: $out"
end=$(echo | openssl s_client -connect "$ip:443" -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
days=$(( ($(date -u -d "$end" +%s) - $(date -u +%s)) / 86400 ))
[[ $days -ge 14 ]] || warn "the certificate expires in $days days: Caddy renews 30 days ahead, so renewal is failing (docs/MAINTENANCE.md, Incidents)"
log "certificate: $days days left (until $end)"

step "Monitors: resume"
hc_set resume "$APP-" chitthi-hc-api-key
uptimerobot_set resume "$DOMAIN" chitthi-uptimerobot-api-key

step "Outside dependencies: one real request each"
fails=0
check() { if "${@:2}"; then log "ok   $1"; else log "FAIL $1"; fails=$((fails + 1)); fi; }
redirect=https%3A%2F%2F$DOMAIN%2Fapi%2Fauth
google_id=$(kv_secret "$KV" chitthi-google-client-id)
github_id=$(kv_secret "$KV" chitthi-github-client-id)
# Each provider's authorize page for our client and callback: a known client and an allowed
# redirect get the sign-in page; a wrong one gets an error.
google() {
  local r
  r=$(curl -sS --max-time 15 -o "$NULL_OUT" -w '%{http_code} %{redirect_url}' \
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=$google_id&redirect_uri=$redirect%2Fgoogle%2Fcallback&response_type=code&scope=openid%20email%20profile")
  [[ $r =~ ^(200|302|303)\  && $r != *rror* ]] || { log "     Google answered: ${r:0:200}"; return 1; }
}
github() {
  local r
  r=$(curl -sS --max-time 15 -o "$NULL_OUT" -w '%{http_code} %{redirect_url}' \
    "https://github.com/login/oauth/authorize?client_id=$github_id&redirect_uri=$redirect%2Fgithub%2Fcallback&scope=read:user%20user:email")
  [[ $r == "302 https://github.com/login?"* ]] || { log "     GitHub answered: ${r:0:200}"; return 1; }
}
check "Google sign-in: our client and callback are accepted" google
check "GitHub sign-in: the authorize page answers for our client" github
check "Let's Encrypt (Caddy renews through it) answers" curl -fsS --max-time 15 -o "$NULL_OUT" https://acme-v02.api.letsencrypt.org/directory
check "From the VM: Key Vault, Azure Blob and R2 (backup.sh check)" bash deploy/azure/run-on-vm.sh deploy/host/backup.sh check

cat <<EOF

+--------------------------------------------------------------------------+
  Chitthi is UP ($(( (SECONDS - started) / 60 )) min $(( (SECONDS - started) % 60 )) s)
  URL:       https://$DOMAIN
  Fallback:  if your DNS still has the old address, add this line to your
             hosts file:   $ip $DOMAIN
             (https://$ip itself won't do: the certificate is for the
             name, and sign-in only works on the name)
  Cost:      while up, ₹0.48 an hour (the IPv4; the VM's hours are free for
             the first 12 months), ₹1.51 an hour after them (VM ₹1.03 + IPv4).
             The disks bill the same up or down: see chitthi-down.sh's audit.
  When done: bash chitthi-down.sh
+--------------------------------------------------------------------------+
EOF
[[ $fails -eq 0 ]] || die "$fails dependency check(s) failed above: the site is up, but that part of it isn't"
