#!/usr/bin/env bash
# CI: exercises deploy/host/deploy.sh on a runner already set up by deploy/host/bootstrap.sh,
# with the images CI just built, secrets from throwaway files and the edge's internal CA:
#   1. deploy (first release: nothing to roll back to)
#   2. the same release again (converges, keeps the rollback point)
#   3. a release whose API exits at once: the deploy must fail, roll itself back, and leave the
#      first release serving and passing the smoke test
#   4. an explicit rollback after a good second release
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
secrets=$(mktemp -d)
fail() { echo "FAIL: $*" >&2; exit 1; }

openssl rand -hex 24 > "$secrets/chitthi-postgres-password"
openssl rand -hex 24 > "$secrets/chitthi-api-db-password"
for name in google-client-id google-client-secret github-client-id github-client-secret; do
  echo "ci-$name" > "$secrets/chitthi-$name"
done

run() { # deploy.sh with the test hooks
  sudo env CHITTHI_TEST_CONFIG_DIR="$repo" CHITTHI_TEST_SECRETS_DIR="$secrets" \
    CHITTHI_TEST_CACERT=/data/edge/caddy/caddy/pki/authorities/local/root.crt \
    "$repo/deploy/host/deploy.sh" "$@"
}
release() { # <api tag> <web tag>
  run deploy "sha=${GITHUB_SHA:-0000000000000000000000000000000000000000}" vault=ci-vault acme_email=ci@example.com \
    acme_ca=local "api=chitthi-api:$1" migrate=chitthi-migrate:ci "web=chitthi-web:$2"
}
current_api() { sudo grep -h '^CHITTHI_API_IMAGE=' /srv/chitthi/.env | cut -d= -f2-; }

release ci ci
echo "ok   1. first deploy"
release ci ci
[[ $(current_api) == chitthi-api:ci ]] || fail "re-deploy changed the release"
echo "ok   2. re-deploy of the same release"

docker build -q -t chitthi-api:broken - >/dev/null <<'EOF'
FROM chitthi-api:ci
CMD ["node", "-e", "console.error('deliberately broken'); process.exit(1)"]
EOF
if release broken ci; then fail "a deploy whose API can't start reported success"; fi
[[ $(current_api) == chitthi-api:ci ]] || fail "after the failed deploy the API is $(current_api), not the previous release"
run smoke >/dev/null || fail "the rolled-back release does not pass the smoke test"
echo "ok   3. a broken deploy rolled itself back, and the previous release serves"

docker tag chitthi-api:ci chitthi-api:second
release second ci
[[ $(current_api) == chitthi-api:second ]] || fail "the second release is not current"
run rollback
[[ $(current_api) == chitthi-api:ci ]] || fail "rollback did not restore the previous release"
echo "ok   4. explicit rollback to the previous release"

echo "--- deploys.log"
sudo cat /srv/chitthi/deploys.log
echo "deploy tests passed"
