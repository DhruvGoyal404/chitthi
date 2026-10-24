#!/usr/bin/env bash
# CI: exercises deploy/host/edge.sh and deploy/host/deploy.sh on a runner already set up by
# deploy/host/bootstrap.sh, with the images CI just built, secrets from throwaway files and the
# edge's internal CA. A second app's site file sits next to Chitthi's the whole time, and must come
# out byte-identical and still served, as must the edge's own files.
#   1. deploy (first release: nothing to roll back to). With CHITTHI_TEST_GITHUB_TOKEN (CI's own
#      token), the edge install and this deploy fetch their files through the GitHub API and sign
#      in to ghcr.io, as on the VM, where the repo is private
#   2. the same release again (converges, keeps the rollback point)
#   3. a release whose API exits at once: must fail, roll itself back, previous release serving
#   4. a release whose site file is broken: must fail before changing anything
#   5. an explicit rollback after a good second release
#   6. backups: two nightly runs (append-only, media uploaded once; the disk warning), a restore
#      drill that passes, a backup key rotation (drill and restore read both keys), a real restore
#      (from Azure, then from R2), a tampered dump that the drill catches, and a re-deploy that
#      finds the timers and a fresh backup
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
token=()
[[ -n ${CHITTHI_TEST_GITHUB_TOKEN:-} ]] && token=(CHITTHI_GITHUB_TOKEN="$CHITTHI_TEST_GITHUB_TOKEN")
extra=() # set for one release at a time
run() { sudo env "${hooks[@]}" "$repo/deploy/host/deploy.sh" "$@"; }
release() { # <api tag> [config dir]
  sudo env "${hooks[@]}" "${extra[@]}" ${2:+CHITTHI_TEST_CONFIG_DIR="$2"} "$repo/deploy/host/deploy.sh" deploy \
    "sha=$sha" vault=ci-vault "api=chitthi-api:$1" migrate=chitthi-migrate:ci web=chitthi-web:ci     storage=cistorage container=chitthi-backups r2_bucket=chitthi-backups
}
current_api() { sudo grep -h '^CHITTHI_API_IMAGE=' /srv/chitthi/.env | cut -d= -f2-; }
edge_files() { sudo sha256sum /srv/edge/sites/other.caddy /srv/edge/Caddyfile /srv/edge/compose.yaml /srv/edge/.env; }
other_site() { sudo curl -fsS --max-time 5 --cacert "$ca" --resolve other.example.test:443:127.0.0.1 https://other.example.test/; }

# The edge, installed the way the host does it, then a second app's site file and its reload.
sudo env CHITTHI_TEST_CONFIG_DIR="$repo" "${token[@]}" "$repo/deploy/host/edge.sh" "sha=$sha" acme_email=ci@example.com acme_ca=local
printf 'other.example.test {\n\trespond "the other app"\n}\n' | sudo tee /srv/edge/sites/other.caddy >/dev/null
sudo docker compose -p edge --project-directory /srv/edge exec -T caddy \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//run/caddy/admin.sock
for _ in $(seq 1 20); do [[ $(other_site 2>/dev/null) == 'the other app' ]] && break; sleep 0.5; done
[[ $(other_site) == 'the other app' ]] || fail "the dummy second site is not served"
before=$(edge_files)
echo "ok   0. edge installed; a second app's site file is served next to where Chitthi's will go"

extra=("${token[@]}")
out=$(release ci) || { echo "$out"; fail "the first deploy failed"; }
extra=()
echo "$out"
if [[ ${#token[@]} -gt 0 ]]; then
  grep -qF 'configuration fetched through the GitHub API' <<<"$out" || fail "the deploy did not fetch through the API"
  grep -qF 'signed in to ghcr.io' <<<"$out" || fail "the deploy did not sign in to the registry"
  echo "ok   1. first deploy, its files fetched through the GitHub API with a short-lived token, signed in to ghcr.io"
else
  echo "ok   1. first deploy (no token: local files)"
fi
# Both database passwords rotated in "Key Vault" first: the migrations log in over TCP as the owner
# and the API's health includes its database, so success means both new passwords took effect.
openssl rand -hex 24 > "$secrets/chitthi-postgres-password"
openssl rand -hex 24 > "$secrets/chitthi-api-db-password"
release ci
[[ $(current_api) == chitthi-api:ci ]] || fail "re-deploy changed the release"
sudo grep -qF "$(cat "$secrets/chitthi-postgres-password")" /srv/chitthi/migrate.env || fail "the rotated owner password was not written"
echo "ok   2. re-deploy of the same release, with both database passwords rotated"

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
if release untouched "$broken" 2>&1 | tee "$broken/deploy.log"; then fail "a deploy with a broken site file reported success"; fi
grep -q 'does not validate with the edge' "$broken/deploy.log" || fail "a broken site file got past the check before the switch"
if grep -q '^deploy: app up' "$broken/deploy.log"; then fail "a deploy with a broken site file switched the app"; fi
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

# --- 6. Backups, with local folders standing in for Azure Blob and R2.
bt=$(mktemp -d)
mkdir -p "$bt/secrets"
age-keygen -o "$bt/secrets/chitthi-backup-age-identity" 2>/dev/null
age-keygen -y "$bt/secrets/chitthi-backup-age-identity" > "$bt/secrets/chitthi-backup-age-recipient"
backup() { sudo env CHITTHI_BACKUP_TEST_DIR="$bt" /srv/chitthi/bin/backup.sh "$@"; }
db() { sudo docker compose -p chitthi --project-directory /srv/chitthi exec -T db psql -X -q -At -v ON_ERROR_STOP=1 -U chitthi -d chitthi; }

# One stored file and its attachments row, the way the API leaves them.
key=$(openssl rand -hex 16)
sudo install -d -o 10010 -g 10010 -m 0700 "/data/chitthi/media/${key:0:2}" "/data/chitthi/media/${key:0:2}/${key:2:2}"
head -c 50000 /dev/urandom | sudo tee "/data/chitthi/media/${key:0:2}/${key:2:2}/$key" >/dev/null
file_sha=$(sudo sha256sum "/data/chitthi/media/${key:0:2}/${key:2:2}/$key" | cut -d' ' -f1)
db <<SQL
WITH u AS (INSERT INTO users (handle, display_name) VALUES ('backup_probe', 'Backup probe') RETURNING id)
INSERT INTO attachments (uploader_id, kind, mime, byte_size, sha256, file_name, storage_key)
SELECT id, 'file', 'application/pdf', 50000, decode('$file_sha', 'hex'), 'probe.pdf', '$key' FROM u;
SQL

backup run
sleep 1
out=$(sudo env CHITTHI_BACKUP_TEST_DIR="$bt" CHITTHI_BACKUP_DISK_WARN_PCT=0 /srv/chitthi/bin/backup.sh run)
echo "$out"
grep -q 'WARNING: /data is [0-9]*% full' <<<"$out" || fail "the nightly run did not warn about the disk at its threshold"
dumps=$(sudo find "$bt/azure/db" -name '*.dump.age' | wc -l)
[[ $dumps -eq 2 ]] || fail "two backups should leave two dumps, found $dumps"
[[ $(sudo find "$bt/azure/manifests" -name '*.json' | wc -l) -eq 2 ]] || fail "two backups should leave two manifests"
[[ $(sudo find "$bt/azure/media" -name '*.age' | wc -l) -eq 1 ]] || fail "the media file was uploaded more than once"
if [[ $(sudo find "$bt/r2/db" -name '*.dump.age' | wc -l) -ne 2 ]] || ! sudo test -f "$bt/r2/media/$key.age"; then fail "the R2 copy is incomplete"; fi
sudo grep -q "$key" "$(sudo find "$bt/azure/manifests" -name '*.json' | sort | tail -n 1)" || fail "the manifest does not list the media file"
if sudo grep -q 'backup_probe' "$(sudo find "$bt/azure/db" -name '*.dump.age' | head -n 1)"; then fail "the dump is not encrypted"; fi
echo "ok   6a. two nightly backups: two dumps and manifests, media uploaded once, R2 in step, dumps encrypted"

backup drill
echo "ok   6b. restore drill: checksums, decryption, restore, counts, schema version, media sha256, R2 copy"

# Key rotation: the old private key becomes -previous, a new pair takes over. The media file stays
# encrypted to the old key (it's never re-uploaded); the next dump uses the new one.
sudo mv "$bt/secrets/chitthi-backup-age-identity" "$bt/secrets/chitthi-backup-age-identity-previous"
age-keygen -o "$bt/secrets/chitthi-backup-age-identity" 2>/dev/null
age-keygen -y "$bt/secrets/chitthi-backup-age-identity" > "$bt/secrets/chitthi-backup-age-recipient"
sleep 1
backup run >/dev/null
backup drill
echo "ok   6c. after a key rotation, the drill reads the new dump and the old-key media"

# A real restore: the media file is lost, and a table appears that the backup never had.
media_file=/data/chitthi/media/${key:0:2}/${key:2:2}/$key
sudo rm -f "$media_file"
db <<<'CREATE TABLE written_after_the_backup (x int)'
if backup restore 2>/dev/null; then fail "a restore ran without confirm="; fi
backup restore confirm=chitthi.dhruvgoyal.tech
[[ $(db <<<"SELECT count(*) FROM pg_tables WHERE tablename = 'written_after_the_backup'") == 0 ]] || fail "the restore did not replace the database"
[[ $(db <<<"SELECT count(*) FROM attachments WHERE storage_key = '$key'") == 1 ]] || fail "the restored database lacks the attachment"
[[ $(sudo sha256sum "$media_file" | cut -d' ' -f1) == "$file_sha" ]] || fail "the media file did not come back intact"
[[ $(sudo stat -c '%u %a' "$media_file") == '10010 600' ]] || fail "the restored media file is not owned by the API, mode 0600"
sudo find /data/chitthi/pre-deploy -name 'chitthi-pre-restore-*.dump' | grep -q . || fail "the restore kept no copy of the database it replaced"
run smoke >/dev/null || fail "the site does not pass the smoke test after the restore"
sudo rm -f "$media_file"
backup restore confirm=chitthi.dhruvgoyal.tech from=r2 >/dev/null
[[ $(sudo sha256sum "$media_file" | cut -d' ' -f1) == "$file_sha" ]] || fail "the restore from R2 did not bring the media file back"
run smoke >/dev/null || fail "the site does not pass the smoke test after the restore from R2"
echo "ok   6d. restore: refused without confirm=; database replaced (old one kept), media back with its owner and mode, site healthy; again from R2"

newest=$(sudo find "$bt/azure/db" -name '*.dump.age' | sort | tail -n 1)
echo tampered | sudo tee -a "$newest" >/dev/null
if backup drill 2>/dev/null; then fail "the drill passed on a tampered dump"; fi
echo "ok   6e. the drill catches a tampered dump"

release ci | tee "$bt/deploy.log"
grep -q 'backups: timers active, last backup 0 h ago' "$bt/deploy.log" || fail "the deploy did not confirm the timers and a fresh backup"
echo "ok   6f. a deploy asserts both timers and the fresh backup"

[[ $(edge_files) == "$before" ]] || { diff <(echo "$before") <(edge_files) >&2; fail "Chitthi's deploys changed a file that isn't theirs"; }
[[ $(other_site) == 'the other app' ]] || fail "the second app's site stopped being served"
echo "ok   the second app's site file, the main Caddyfile and the edge's compose/.env are byte-identical, and the other site still answers"

echo "--- deploys.log"
sudo cat /srv/chitthi/deploys.log
echo "deploy tests passed"
