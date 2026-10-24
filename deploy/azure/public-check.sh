#!/usr/bin/env bash
# Checks the live site from the outside: real DNS, the network security group, the real
# certificate. deploy.sh's smoke test makes the same checks from the VM itself; this one proves
# the path the world takes. Run by the deploy workflow after every deploy, and by hand:
#
#   deploy/azure/public-check.sh [host]        (default chitthi.dhruvgoyal.tech)
# `test && ok || bad` is safe here: ok only echoes, so it never fails into bad.
# shellcheck disable=SC2015
set -euo pipefail

HOST=${1:-chitthi.dhruvgoyal.tech}
ORIGIN=https://$HOST
CERT_DAYS=14 # Caddy renews 30 days ahead, so under 14 left means renewal is failing
c=(curl -sS --max-time 15 --proto '=https,http')
fails=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fails=$((fails + 1)); }

out=""
for i in $(seq 1 20); do
  out=$("${c[@]}" "https://$HOST/api/health" 2>/dev/null || true)
  [[ $out == '{"status":"ok","db":"ok"}' ]] && break
  [[ $i -lt 20 ]] && sleep 3
done
if [[ $out == '{"status":"ok","db":"ok"}' ]]; then ok "health: API and database, through a trusted certificate"; else bad "health answered '${out:-nothing}'"; fi

if echo | openssl s_client -connect "$HOST:443" -servername "$HOST" 2>/dev/null | openssl x509 -noout -checkend $((CERT_DAYS * 86400)) >/dev/null; then
  ok "certificate valid for at least $CERT_DAYS more days"
else
  bad "the certificate expires within $CERT_DAYS days (or couldn't be read)"
fi

headers=$("${c[@]}" -D - -o /dev/null "https://$HOST/" || true)
grep -qi '^HTTP/[0-9.]* 200' <<<"$headers" && ok "page answers 200" || bad "the page did not answer 200"
grep -qi "^content-security-policy: .*frame-ancestors 'none'" <<<"$headers" && ok "CSP" || bad "no CSP on the page"
grep -qi '^strict-transport-security: max-age=' <<<"$headers" && ok "HSTS" || bad "no HSTS"
grep -qi '^server:' <<<"$headers" && bad "a Server header is sent" || ok "no Server header"

code=$("${c[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' "http://$HOST/" || true)
[[ $code == "308 https://$HOST/" ]] && ok "HTTP redirects to HTTPS" || bad "plain HTTP got '$code'"

out=$("${c[@]}" -H "Origin: $ORIGIN" "https://$HOST/api/socket.io/?EIO=4&transport=polling" || true)
[[ $out == 0\{* ]] && ok "Socket.IO handshake for the app's own Origin" || bad "no Socket.IO handshake"
code=$("${c[@]}" -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example' "https://$HOST/api/socket.io/?EIO=4&transport=polling" || true)
[[ $code == 403 ]] && ok "foreign Origin's handshake refused" || bad "a foreign Origin's handshake got $code"
code=$("${c[@]}" -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "https://$HOST/api/auth/logout" || true)
[[ $code == 403 ]] && ok "POST without Origin refused" || bad "a POST without Origin got $code"
code=$("${c[@]}" -o /dev/null -w '%{http_code}' -X POST -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{}' "https://$HOST/api/dev/login" || true)
[[ $code == 404 ]] && ok "no dev sign-in" || bad "the dev sign-in answered $code"
# Google's consent screen links to these: they must answer for anyone.
for page in /privacy /terms; do
  code=$("${c[@]}" -o /dev/null -w '%{http_code}' "https://$HOST$page" || true)
  [[ $code == 200 ]] && ok "$page answers" || bad "$page got $code"
done

# Nothing but 80 and 443 answers: SSH and Postgres must time out or be refused.
for port in 22 5432 5435 8082 5175; do
  if timeout 5 bash -c "exec 3<>/dev/tcp/$HOST/$port" 2>/dev/null; then bad "port $port is reachable from the internet"; else ok "port $port closed"; fi
done

[[ $fails -eq 0 ]] || { echo "public-check: $fails check(s) failed"; exit 1; }
echo "public-check: $HOST is healthy from the outside"
