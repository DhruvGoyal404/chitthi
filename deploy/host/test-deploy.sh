#!/usr/bin/env bash
# CI: exercises deploy/host/edge.sh and deploy/host/deploy.sh on a runner already set up by
# deploy/host/bootstrap.sh, with the images CI just built, secrets from throwaway files and the
# edge's internal CA. A second app's site file sits next to Chitthi's the whole time, and must come
# out byte-identical and still served, as must the edge's own files.
#   1. deploy (first release: nothing to roll back to)
#   2. the same release again (converges, keeps the rollback point)
#   3. a release whose API exits at once: must fail, roll itself back, previous release serving
#   4. a release whose site file is broken: must fail before changing anything
#   5. an explicit rollback after a good second release
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
secrets=$(mktemp -d)
ca=/data/edge/caddy/caddy/pki/authorities/local/root.crt
sha=${GITHUB_SHA:-0000000000000000000000000000000000000000}
fail() { echo "FAIL: $*" >&2; exit 1; }

openssl rand -hex 24 > "$secrets/chitthi-postgres-password"
openssl rand -hex 24 > "$secrets/chitthi-api-db-password"
for name in google-client-id google-client-secret github-client-id github-client-secret; do
  echo "ci-$name" > "$secrets/chitthi-$name"
done

hooks=(CHITTHI_TEST_CONFIG_DIR="$repo" CHITTHI_TEST_SECRETS_DIR="$secrets" CHITTHI_TEST_CACERT="$ca")
run() { sudo env "${hooks[@]}" "$repo/deploy/host/deploy.sh" "$@"; }
release() { # <api tag> [config dir]
  sudo env "${hooks[@]}" ${2:+CHITTHI_TEST_CONFIG_DIR="$2"} "$repo/deploy/host/deploy.sh" deploy \
    "sha=$sha" vault=ci-vault "api=chitthi-api:$1" migrate=chitthi-migrate:ci web=chitthi-web:ci
}
current_api() { sudo grep -h '^CHITTHI_API_IMAGE=' /srv/chitthi/.env | cut -d= -f2-; }
edge_files() { sudo sha256sum /srv/edge/sites/other.caddy /srv/edge/Caddyfile /srv/edge/compose.yaml /srv/edge/.env; }
other_site() { sudo curl -fsS --max-time 5 --cacert "$ca" --resolve other.example.test:443:127.0.0.1 https://other.example.test/; }

# The edge, installed the way the host does it, then a second app's site file and its reload.
sudo env CHITTHI_TEST_CONFIG_DIR="$repo" "$repo/deploy/host/edge.sh" "sha=$sha" acme_email=ci@example.com acme_ca=local
printf 'other.example.test {\n\trespond "the other app"\n}\n' | sudo tee /srv/edge/sites/other.caddy >/dev/null
sudo docker compose -p edge --project-directory /srv/edge exec -T caddy \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//run/caddy/admin.sock
for _ in $(seq 1 20); do [[ $(other_site 2>/dev/null) == 'the other app' ]] && break; sleep 0.5; done
[[ $(other_site) == 'the other app' ]] || fail "the dummy second site is not served"
before=$(edge_files)
echo "ok   0. edge installed; a second app's site file is served next to where Chitthi's will go"

release ci
echo "ok   1. first deploy"
release ci
[[ $(current_api) == chitthi-api:ci ]] || fail "re-deploy changed the release"
echo "ok   2. re-deploy of the same release"

docker build -q -t chitthi-api:broken - >/dev/null <<'EOF'
FROM chitthi-api:ci
CMD ["node", "-e", "console.error('deliberately broken'); process.exit(1)"]
EOF
if release broken; then fail "a deploy whose API can't start reported success"; fi
[[ $(current_api) == chitthi-api:ci ]] || fail "after the failed deploy the API is $(current_api), not the previous release"
run smoke >/dev/null || fail "the rolled-back release does not pass the smoke test"
echo "ok   3. a broken API rolled itself back, and the previous release serves"

broken=$(mktemp -d)
cp -r "$repo/deploy" "$broken/"
printf '\nthis is { not a Caddyfile\n' >> "$broken/deploy/edge/sites/chitthi.caddy"
site_before=$(sudo sha256sum /srv/edge/sites/chitthi.caddy)
docker tag chitthi-api:ci chitthi-api:untouched
if release untouched "$broken"; then fail "a deploy with a broken site file reported success"; fi
[[ $(sudo sha256sum /srv/edge/sites/chitthi.caddy) == "$site_before" ]] || fail "a broken site file was installed"
[[ $(current_api) == chitthi-api:ci ]] || fail "a deploy with a broken site file switched the release"
run smoke >/dev/null || fail "Chitthi stopped passing the smoke test after a broken site file"
echo "ok   4. a broken site file stopped the deploy before anything changed"

docker tag chitthi-api:ci chitthi-api:second
release second
[[ $(current_api) == chitthi-api:second ]] || fail "the second release is not current"
run rollback
[[ $(current_api) == chitthi-api:ci ]] || fail "rollback did not restore the previous release"
echo "ok   5. explicit rollback to the previous release"

[[ $(edge_files) == "$before" ]] || { diff <(echo "$before") <(edge_files) >&2; fail "Chitthi's deploys changed a file that isn't theirs"; }
[[ $(other_site) == 'the other app' ]] || fail "the second app's site stopped being served"
echo "ok   the second app's site file, the main Caddyfile and the edge's compose/.env are byte-identical, and the other site still answers"

echo "--- deploys.log"
sudo cat /srv/chitthi/deploys.log
echo "deploy tests passed"
