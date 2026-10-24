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

# The public pages Google's consent screen links to, and the icons and manifest.
for page in /privacy /terms; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:5175$page")
  [[ $code == 200 ]] || fail "$page got $code, not the app shell"
done
type_of() { curl -fsS -D - -o /dev/null "http://127.0.0.1:5175$1" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Tt]ype: //p'; }
[[ $(type_of /manifest.webmanifest) == application/manifest+json* ]] || fail "the manifest is served as '$(type_of /manifest.webmanifest)'"
curl -fsS http://127.0.0.1:5175/manifest.webmanifest | jq -e '.icons | length == 4' >/dev/null || fail "the manifest is not valid JSON with four icons"
[[ $(type_of /favicon.ico) == image/x-icon* ]] || fail "favicon.ico is served as '$(type_of /favicon.ico)'"
for icon in favicon-32.png apple-touch-icon.png icon-192.png icon-512.png icon-maskable-192.png icon-maskable-512.png; do
  [[ $(type_of "/$icon") == image/png* ]] || fail "/$icon is not served as a PNG"
done
[[ $(type_of /robots.txt) == text/plain* ]] || fail "robots.txt is served as '$(type_of /robots.txt)'"
curl -fsS http://127.0.0.1:5175/robots.txt | grep -qx 'Disallow: /api/' || fail "robots.txt does not keep crawlers out of /api/"
[[ $(type_of /sitemap.xml) == application/xml* ]] || fail "sitemap.xml is served as '$(type_of /sitemap.xml)'"
curl -fsS http://127.0.0.1:5175/sitemap.xml | grep -qF '<loc>https://chitthi.dhruvgoyal.tech/privacy</loc>' || fail "sitemap.xml does not list /privacy"
echo "ok   /privacy and /terms get the app shell; manifest, favicon, icons, robots.txt and sitemap.xml served with their types"
echo "all image checks passed"
