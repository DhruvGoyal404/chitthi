#!/usr/bin/env bash
# Checks the production images without a database (the full stack is smoke-tested separately):
#   scripts/check-images.sh <api-image> <migrate-image> <web-image>
# Every container runs the way production runs it: read-only, all capabilities dropped,
# no-new-privileges. Uses host port 5175 (Chitthi's web port) while it runs.
set -euo pipefail

api=$1 migrate=$2 web=$3
harden=(--read-only --cap-drop ALL --security-opt no-new-privileges)
name="chitthi-image-check-$$"
fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

for image in "$api" "$migrate" "$web"; do
  user=$(docker image inspect -f '{{.Config.User}}' "$image")
  [[ -n $user && $user != root && $user != 0 ]] || fail "$image runs as root"
done
echo "ok   all three images run as a non-root user"

# The API refuses to start on bad configuration and names the key.
set +e
out=$(docker run --rm "${harden[@]}" -e NODE_ENV=production "$api" 2>&1)
code=$?
set -e
[[ $code -eq 1 && $out == *DATABASE_URL* ]] || fail "API started without DATABASE_URL (exit $code): $out"
echo "ok   API refuses to start without DATABASE_URL"

out=$(docker run --rm "${harden[@]}" --entrypoint node "$api" \
  -e "import('sharp').then((m) => console.log(m.default.versions.sharp))")
[[ -n $out ]] || fail "sharp does not load in the API image"
echo "ok   sharp $out loads (musl build)"

docker run --rm "${harden[@]}" --entrypoint sh "$api" -c '! command -v npm && ! touch /app/x 2>/dev/null' >/dev/null \
  || fail "API image still has npm, or its code is writable"
echo "ok   API image has no npm and its code is read-only"

out=$(docker run --rm "${harden[@]}" --entrypoint dbmate "$migrate" --version)
[[ $out == dbmate* ]] || fail "dbmate missing from the migrate image"
echo "ok   migrate image: $out, $(docker run --rm --entrypoint sh "$migrate" -c 'ls db/migrations | wc -l') migrations"

docker run -d --name "$name" "${harden[@]}" --tmpfs /tmp -p 127.0.0.1:5175:5175 "$web" >/dev/null
for _ in $(seq 1 20); do curl -fsS -o /dev/null http://127.0.0.1:5175/ 2>/dev/null && break; sleep 0.5; done
headers=$(curl -fsS -D - -o /dev/null http://127.0.0.1:5175/)
for want in "Content-Security-Policy: default-src 'self'" "frame-ancestors 'none'" \
  'X-Content-Type-Options: nosniff' 'X-Frame-Options: DENY' 'Cache-Control: no-cache'; do
  grep -qF "$want" <<<"$headers" || fail "web page is missing header: $want"
done
grep -qi '^Server:' <<<"$headers" && fail "web page announces its server"
echo "ok   web page headers (CSP with frame-ancestors, nosniff, DENY, no-cache, no Server)"

code=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:5175/c/deep/link)
[[ $code == 200 ]] || fail "deep link got $code, not the app shell"
code=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:5175/assets/missing.js)
[[ $code == 404 ]] || fail "missing asset got $code, not 404"
asset=$(curl -fsS http://127.0.0.1:5175/ | grep -o '/assets/[^"]*\.js' | head -n 1)
headers=$(curl -fsS -H 'Accept-Encoding: gzip' -D - -o /dev/null "http://127.0.0.1:5175$asset")
grep -qi '^Content-Encoding: gzip' <<<"$headers" || fail "assets are not served precompressed"
grep -qF 'Cache-Control: public, max-age=31536000, immutable' <<<"$headers" || fail "assets are not cached as immutable"
echo "ok   deep links get the app shell, a missing asset is a 404, assets are gzip and immutable"
echo "all image checks passed"
