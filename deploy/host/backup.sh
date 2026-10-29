#!/usr/bin/env bash
# Chitthi's off-VM backups: append-only, encrypted, and never deleted by the VM.
# Installed by deploy.sh as /srv/chitthi/bin/backup.sh; systemd runs it (chitthi-backup.timer,
# chitthi-restore-drill.timer). Root only.
#
#   backup.sh run       nightly: database dump, new media, manifest; to Azure Blob, then to R2
#   backup.sh drill     monthly: restore the newest backup into a scratch database and verify it
#   backup.sh selftest  once, at setup: prove the VM's own credentials can create but not
#                       overwrite or delete
#   backup.sh check     read-only (chitthi-up.sh): Key Vault, Azure Blob and R2 each answer
#   backup.sh restore confirm=<host> [manifest=latest|manifests/<UTC>.json] [from=azure|r2]
#                       replace the live database and missing media from a backup (incidents)
#
# Every object is new and uniquely named, and nothing is ever overwritten or deleted from here:
# - Azure: the VM's identity holds only blobs/read and blobs/add/action (create-only). Each upload
#   is a single Put Blob with If-None-Match: *.
# - R2: one PutObject per object with If-None-Match: * (curl, SigV4), and the bucket lock refuses
#   overwrites and deletes for 30 days.
# Retention is the storage's job: lifecycle rules delete db/, manifests/ and selftest/ after 35
# days. Media is pruned only by the monthly compaction the owner runs by hand
# (docs/MAINTENANCE.md, "Backups").
#
# Encryption: age, to a public key. The private key stays in Key Vault, and only the drill fetches
# it, into memory.
set -euo pipefail
umask 077

CONF=/srv/chitthi/backup.conf # VAULT, AZ_ACCOUNT, AZ_CONTAINER, R2_BUCKET (written by deploy.sh)
SRV=/srv/chitthi
MEDIA=/data/chitthi/media
STATE=/data/chitthi/backup-state
STAGE=/data/chitthi/backup-stage
AZ_VERSION=2023-11-03
DISK_WARN_PCT=${CHITTHI_BACKUP_DISK_WARN_PCT:-80} # the nightly run alerts at this much of /data used
CERT_WARN_DAYS=14 # ... and when the certificate has fewer days left than this
DUMPS=/data/chitthi/pre-deploy # where deploy.sh keeps its dumps; a restore keeps one there too
HOST=chitthi.dhruvgoyal.tech
# CI only, never on the VM: secrets from files, and local folders standing in for the buckets.
TEST=${CHITTHI_BACKUP_TEST_DIR:-}

log() { echo "backup: $*"; }
die() { # also from inside $(...): the reason goes to a file the EXIT handler reports
  echo "backup: FAILED: $*" >&2
  [[ -n ${work:-} && -d $work ]] && echo "$*" > "$work/reason"
  exit 1
}
[[ $EUID -eq 0 ]] || die "run as root"
if [[ -n $TEST ]]; then
  VAULT=test AZ_ACCOUNT=test AZ_CONTAINER=test R2_BUCKET=test
else
  # shellcheck source=/dev/null
  . "$CONF"
fi
: "${VAULT:?} ${AZ_ACCOUNT:?} ${AZ_CONTAINER:?} ${R2_BUCKET:?}"

work=$(mktemp -d /run/chitthi-backup.XXXXXX)
# However the script ends, a failure reaches healthchecks.io (once a check URL is known) with the
# reason die() recorded, and the scratch directory goes away.
finish() {
  local status=$?
  if [[ $status -ne 0 && -n ${HC:-} ]]; then
    hc fail "$(cat "$work/reason" 2>/dev/null || echo "exit $status")"
  fi
  rm -rf -- "$work"
}
trap finish EXIT
app() { docker compose -p chitthi --project-directory "$SRV" -f "$SRV/compose.yaml" "$@"; }
psql_owner() { app exec -T db psql -X -q -v ON_ERROR_STOP=1 -U chitthi "$@"; }

# --- Tokens and secrets (IMDS is root-only on this host: deploy/host/bootstrap.sh).
imds_token() { # <resource>
  curl -fsS --max-time 10 -H Metadata:true \
    "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=$1" | jq -er .access_token
}
secret() { # <name>
  local v
  if [[ -n $TEST ]]; then
    v=$(cat "$TEST/secrets/$1")
  else
    [[ -f $work/kv-auth ]] || printf 'Authorization: Bearer %s\n' "$(imds_token https%3A%2F%2Fvault.azure.net)" > "$work/kv-auth"
    v=$(curl -fsS --max-time 10 -H @"$work/kv-auth" "https://$VAULT.vault.azure.net/secrets/$1?api-version=7.4" | jq -er .value) \
      || die "could not read secret $1"
  fi
  [[ -n $v ]] || die "secret $1 is empty"
  printf '%s' "$v"
}
secret_optional() { # <name>: prints it, or returns 1 if there is no such secret
  if [[ -n $TEST ]]; then [[ -s $TEST/secrets/$1 ]] && cat "$TEST/secrets/$1"; return; fi
  secret chitthi-backup-age-recipient >/dev/null # makes sure the Key Vault header exists
  curl -fsS --max-time 10 -H @"$work/kv-auth" "https://$VAULT.vault.azure.net/secrets/$1?api-version=7.4" 2>/dev/null | jq -er .value
}

# The private keys, into 0600 files on /run (tmpfs: memory), removed with $work. The current key,
# plus the previous one while backups encrypted to it still exist (key rotation:
# docs/MAINTENANCE.md, "Secret rotation"). Sets age_ids for `age -d "${age_ids[@]}"`.
load_identities() {
  secret chitthi-backup-age-identity > "$work/id-current"
  age_ids=(-i "$work/id-current")
  if secret_optional chitthi-backup-age-identity-previous > "$work/id-previous"; then
    age_ids+=(-i "$work/id-previous")
  fi
}

# --- Azure Blob, create-only. Uploads stream from disk (curl -T), one Put Blob per object.
az_url() { echo "https://$AZ_ACCOUNT.blob.core.windows.net/$AZ_CONTAINER/$1"; }
az_auth() { [[ -f $work/az-auth ]] || printf 'Authorization: Bearer %s\n' "$(imds_token https%3A%2F%2Fstorage.azure.com%2F)" > "$work/az-auth"; }
az_put() { # <file> <name> [overwrite]: prints the HTTP status (201 created, 409 exists, 403 refused)
  if [[ -n $TEST ]]; then
    local dst=$TEST/azure/$2
    if [[ -e $dst ]]; then echo 409; return; fi
    mkdir -p "$(dirname "$dst")" && cp "$1" "$dst" && echo 201
    return
  fi
  az_auth
  local cond=(-H 'If-None-Match: *')
  [[ ${3:-} == overwrite ]] && cond=()
  curl -sS --max-time 600 -o /dev/null -w '%{http_code}' -X PUT -T "$1" -H @"$work/az-auth" \
    -H "x-ms-version: $AZ_VERSION" -H 'x-ms-blob-type: BlockBlob' "${cond[@]}" "$(az_url "$2")"
}
az_put_new() { # <file> <name>: must be created now
  local code
  code=$(az_put "$1" "$2")
  [[ $code == 201 ]] || die "upload of $2 got HTTP $code"
}
az_get() { # <name> <file>
  if [[ -n $TEST ]]; then cp "$TEST/azure/$1" "$2"; return; fi
  az_auth
  curl -fsS --max-time 600 -o "$2" -H @"$work/az-auth" -H "x-ms-version: $AZ_VERSION" "$(az_url "$1")"
}
az_list() { # <prefix>: blob names, one per line
  if [[ -n $TEST ]]; then
    [[ -d $TEST/azure/$1 ]] || return 0
    (cd "$TEST/azure" && find "$1" -type f | sort)
    return
  fi
  az_auth
  local marker='' page
  while :; do
    page=$(curl -fsS --max-time 60 -H @"$work/az-auth" -H "x-ms-version: $AZ_VERSION" \
      "https://$AZ_ACCOUNT.blob.core.windows.net/$AZ_CONTAINER?restype=container&comp=list&prefix=$1&maxresults=5000${marker:+&marker=$marker}")
    grep -o '<Name>[^<]*</Name>' <<<"$page" | sed -e 's/<Name>//' -e 's#</Name>##' || true
    marker=$(grep -o '<NextMarker>[^<]*</NextMarker>' <<<"$page" | sed -e 's/<NextMarker>//' -e 's#</NextMarker>##' || true)
    [[ -n $marker ]] || break
  done
}
az_delete() { # <name>: prints the HTTP status (selftest only: it must be refused)
  az_auth
  curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -X DELETE -H @"$work/az-auth" -H "x-ms-version: $AZ_VERSION" "$(az_url "$1")"
}
az_exists() { # <name>: true if the blob is there (blobs/read is in the role)
  if [[ -n $TEST ]]; then [[ -e $TEST/azure/$1 ]]; return; fi
  az_auth
  [[ $(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -I -H @"$work/az-auth" -H "x-ms-version: $AZ_VERSION" "$(az_url "$1")") == 200 ]]
}

# --- R2 over its S3 API with curl (not rclone: rclone's streamed multipart uploads got 501
# NotImplemented from R2, docs/MAINTENANCE.md). One PutObject per object, from a file: its length
# is known, so no multipart and no streaming, and its sha256 is the signed payload hash.
# If-None-Match: * never overwrites a key that exists. Signed by curl (--aws-sigv4); the keys sit
# in a 0600 curl config file under $work, never on a command line.
R2_EMPTY_SHA=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 # sha256 of no body
r2_env() {
  if [[ -n $TEST ]]; then R2_DIR="$TEST/r2"; mkdir -p "$R2_DIR"; return; fi
  [[ -f $work/r2.curl ]] && return
  local endpoint key secret_key
  endpoint=$(secret chitthi-r2-endpoint)
  key=$(secret chitthi-r2-access-key-id)
  secret_key=$(secret chitthi-r2-secret-access-key)
  R2_BASE="${endpoint%/}/$R2_BUCKET"
  printf 'user = "%s:%s"\naws-sigv4 = "aws:amz:auto:s3"\n' "$key" "$secret_key" > "$work/r2.curl"
}
r2_curl() { curl -sS --max-time 600 -K "$work/r2.curl" "$@"; }
r2_put() { # <file> <key> [overwrite]: prints the HTTP status (200 created; 412 or 409 exists; 409 locked)
  if [[ -n $TEST ]]; then
    local dst=$R2_DIR/$2
    if [[ -e $dst ]]; then echo 412; return; fi
    mkdir -p "$(dirname "$dst")" && cp "$1" "$dst" && echo 200
    return
  fi
  local cond=(-H 'If-None-Match: *')
  [[ ${3:-} == overwrite ]] && cond=()
  r2_curl -o /dev/null -w '%{http_code}' -X PUT -T "$1" -H "x-amz-content-sha256: $(sha256sum "$1" | cut -d' ' -f1)" \
    "${cond[@]}" "$R2_BASE/$2"
}
r2_put_new() { # <file> <key>: must be created now
  local code
  code=$(r2_put "$1" "$2")
  [[ $code == 200 ]] || die "R2 upload of $2 got HTTP $code"
}
r2_get() { # <key> <file>
  if [[ -n $TEST ]]; then cp "$R2_DIR/$1" "$2"; return; fi
  r2_curl -f -o "$2" -H "x-amz-content-sha256: $R2_EMPTY_SHA" "$R2_BASE/$1"
}
r2_list() { # <prefix>: keys, one per line (ListObjectsV2, every page)
  if [[ -n $TEST ]]; then
    [[ -d $R2_DIR/$1 ]] || return 0
    (cd "$R2_DIR" && find "$1" -type f | sort)
    return
  fi
  local token='' page
  while :; do
    page=$(r2_curl -f -H "x-amz-content-sha256: $R2_EMPTY_SHA" \
      "$R2_BASE?list-type=2&prefix=$1${token:+&continuation-token=$(jq -rn --arg t "$token" '$t|@uri')}")
    grep -o '<Key>[^<]*</Key>' <<<"$page" | sed -e 's/<Key>//' -e 's#</Key>##' || true
    grep -q '<IsTruncated>true</IsTruncated>' <<<"$page" || break
    token=$(grep -o '<NextContinuationToken>[^<]*</NextContinuationToken>' <<<"$page" | sed -e 's/<[^>]*>//g')
    [[ -n $token ]] || break
  done
}
r2_delete() { # <key>: prints the HTTP status (selftest only: it must be refused)
  r2_curl -o /dev/null -w '%{http_code}' -X DELETE -H "x-amz-content-sha256: $R2_EMPTY_SHA" "$R2_BASE/$1"
}

# --- healthchecks.io: start, success, failure (with a one-line reason, never a secret).
HC=
hc() { # start | success | fail [message]
  [[ -n $HC ]] || return 0
  local url=$HC body=()
  [[ $1 == success ]] || url=$HC/$1
  [[ -n ${2:-} ]] && body=(--data-raw "$2")
  curl -fsS --max-time 10 --retry 3 -o /dev/null "${body[@]}" "$url" || true
}

media_keys() { # every stored file (main files and thumbnails), never the in-progress .tmp ones
  find "$MEDIA" -type f -regextype posix-extended -regex '.*/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{32}' -printf '%f\n' | sort
}
media_path() { echo "$MEDIA/${1:0:2}/${1:2:2}/$1"; }

# =====================================================================================================
run_backup() {
  if [[ -z $TEST ]]; then HC=$(secret chitthi-hc-backup-url); fi
  hc start
  local recipient ts day name counts version keys existing missing=0 k code sha n_messages n_attachments
  recipient=$(secret chitthi-backup-age-recipient)
  [[ $recipient == age1* ]] || die "chitthi-backup-age-recipient is not an age public key"
  ts=$(date -u +%Y%m%dT%H%M%SZ) day=$(date -u +%Y/%m/%d)
  name=db/$day/chitthi-$ts.dump.age
  rm -rf "$STAGE" && install -d -m 0700 "$STAGE" "$STAGE/db/$day" "$STAGE/manifests" "$STATE"

  # Counted before the dump: messages and attachments are never deleted (tombstones), so the
  # restored copy can only hold as many or more.
  counts=$(psql_owner -d chitthi -At -F ' ' -c \
    'SELECT (SELECT count(*) FROM messages), (SELECT count(*) FROM attachments), (SELECT max(version) FROM schema_migrations)')
  read -r n_messages n_attachments version <<<"$counts"
  app exec -T db pg_dump -U chitthi -d chitthi -Fc | age -r "$recipient" > "$STAGE/$name"
  sha=$(sha256sum "$STAGE/$name" | cut -d' ' -f1)
  printf '%s  %s\n' "$sha" "$(basename "$name")" > "$STAGE/$name.sha256"
  az_put_new "$STAGE/$name" "$name"
  az_put_new "$STAGE/$name.sha256" "$name.sha256"
  log "database: $name ($(du -h "$STAGE/$name" | cut -f1))"

  # Media: keys are random and never reused, so a key already in the bucket is already right.
  keys=$(media_keys)
  existing=$(az_list media/ | sed -n 's#^media/\([0-9a-f]\{32\}\)\.age$#\1#p' | sort)
  while read -r k; do
    [[ -n $k ]] || continue
    age -r "$recipient" < "$(media_path "$k")" > "$work/m.age"
    code=$(az_put "$work/m.age" "media/$k.age")
    # Already there (listed late): 409 from If-None-Match, or 403, because the create-only role
    # fails the overwrite authorization before the condition is looked at. Only a 403 for a blob
    # that really exists counts.
    if [[ $code == 403 ]] && az_exists "media/$k.age"; then code=409; fi
    [[ $code == 201 || $code == 409 ]] || die "upload of media/$k.age got HTTP $code"
    missing=$((missing + 1))
  done < <(comm -23 <(echo "$keys") <(echo "$existing"))
  rm -f "$work/m.age"
  log "media: $(grep -c . <<<"$keys" || true) files, $missing new"

  # The manifest, last: a restore uses exactly what it lists.
  jq -n --arg created "$ts" --arg dump "$name" --arg sha "$sha" --arg version "$version" \
    --argjson messages "$n_messages" --argjson attachments "$n_attachments" --arg keys "$keys" \
    '{created: $created, dump: $dump, sha256: $sha, schema_version: $version,
      counts: {messages: $messages, attachments: $attachments},
      media: ($keys | split("\n") | map(select(length > 0)))}' > "$STAGE/manifests/$ts.json"
  az_put_new "$STAGE/manifests/$ts.json" "manifests/$ts.json"

  # The R2 copy, in the same order: the dump, every media file R2 doesn't have yet (encrypted to
  # a file first, never streamed), then the manifest.
  r2_env
  r2_put_new "$STAGE/$name" "$name"
  r2_put_new "$STAGE/$name.sha256" "$name.sha256"
  existing=$(r2_list media/ | sed -n 's#^media/\([0-9a-f]\{32\}\)\.age$#\1#p' | sort)
  missing=0
  while read -r k; do
    [[ -n $k ]] || continue
    age -r "$recipient" < "$(media_path "$k")" > "$work/m.age"
    code=$(r2_put "$work/m.age" "media/$k.age")
    [[ $code == 200 || $code == 409 || $code == 412 ]] || die "R2 upload of media/$k.age got HTTP $code" # already there: 412, or 409 under the lock
    missing=$((missing + 1))
  done < <(comm -23 <(echo "$keys") <(echo "$existing"))
  rm -f "$work/m.age"
  r2_put_new "$STAGE/manifests/$ts.json" "manifests/$ts.json"
  log "R2: dump, manifest and $missing new media"

  echo "$ts" > "$STATE/last-success"
  rm -rf "$STAGE"
  # Two host alerts ride on this check, turning it red with the reason though the backup itself
  # succeeded: /data filling up (Azure has no metric for a filesystem's free space), and the TLS
  # certificate close to expiry (Caddy renews 30 days ahead, so under 14 left means renewal has
  # been failing for two weeks). The certificate is checked on the VM only: CI's is Caddy's
  # internal one, which lives hours.
  local used warnings=()
  used=$(df --output=pcent /data | tail -n 1 | tr -dc '0-9')
  if (( used >= DISK_WARN_PCT )); then
    log "WARNING: /data is ${used}% full (docs/MAINTENANCE.md, \"Disk growth\")"
    warnings+=("/data is ${used}% full: grow the data disk (docs/MAINTENANCE.md, Disk growth)")
  fi
  if [[ -z $TEST ]] && ! echo | openssl s_client -connect 127.0.0.1:443 -servername "$HOST" 2>/dev/null \
      | openssl x509 -noout -checkend $((CERT_WARN_DAYS * 86400)) >/dev/null 2>&1; then
    log "WARNING: the certificate for $HOST expires within $CERT_WARN_DAYS days, or isn't served"
    warnings+=("the TLS certificate expires within $CERT_WARN_DAYS days: Caddy's renewal is failing (docs/MAINTENANCE.md, Incidents)")
  fi
  if [[ ${#warnings[@]} -gt 0 ]]; then
    hc fail "backup $ts succeeded, but: $(IFS=';'; echo "${warnings[*]}")"
  else
    hc success "backup $ts: $name, $(grep -c . <<<"$keys" || true) media files, /data ${used}% full"
  fi
  log "done: $ts"
}

# =====================================================================================================
run_drill() {
  if [[ -z $TEST ]]; then HC=$(secret chitthi-hc-drill-url); fi
  hc start
  local manifest dump sha restored sample k want got
  manifest=$(az_list manifests/ | sort | tail -n 1)
  [[ -n $manifest ]] || die "no manifest in the backup container"
  az_get "$manifest" "$work/manifest.json"
  dump=$(jq -er .dump "$work/manifest.json")
  sha=$(jq -er .sha256 "$work/manifest.json")
  az_get "$dump" "$work/dump.age"
  az_get "$dump.sha256" "$work/dump.sha256"
  [[ $(sha256sum "$work/dump.age" | cut -d' ' -f1) == "$sha" ]] || die "the dump does not match its manifest's sha256"
  [[ $(cut -d' ' -f1 "$work/dump.sha256") == "$sha" ]] || die "the dump's .sha256 object disagrees with the manifest"
  log "newest backup: $manifest, dump checksum verified"

  load_identities
  psql_owner -d postgres -c 'DROP DATABASE IF EXISTS chitthi_restore' -c 'CREATE DATABASE chitthi_restore'
  age -d "${age_ids[@]}" < "$work/dump.age" \
    | app exec -T db pg_restore -U chitthi -d chitthi_restore --no-owner --exit-on-error

  restored=$(psql_owner -d chitthi_restore -At -F ' ' -c \
    'SELECT (SELECT count(*) FROM messages), (SELECT count(*) FROM attachments), (SELECT max(version) FROM schema_migrations)')
  read -r r_messages r_attachments r_version <<<"$restored"
  [[ $r_version == "$(jq -r .schema_version "$work/manifest.json")" ]] || die "restored schema version $r_version is not the manifest's"
  (( r_messages >= $(jq -r .counts.messages "$work/manifest.json") )) || die "the restore has fewer messages than were counted"
  (( r_attachments >= $(jq -r .counts.attachments "$work/manifest.json") )) || die "the restore has fewer attachments than were counted"
  log "restored: schema $r_version, $r_messages messages, $r_attachments attachments"

  # A sample of media from the manifest, decrypted and checked against the database's sha256.
  jq -r '.media[]' "$work/manifest.json" | sort > "$work/manifest-keys"
  # awk reads all its input, so nothing upstream dies of SIGPIPE under pipefail.
  sample=$(psql_owner -d chitthi_restore -At -F ' ' -c \
    "SELECT storage_key, encode(sha256, 'hex') FROM attachments WHERE deleted_at IS NULL ORDER BY random()" \
    | awk 'NR == FNR { listed[$1] = 1; next } ($1 in listed) && n < 5 { print; n++ }' "$work/manifest-keys" -)
  local checked=0
  while read -r k want; do
    [[ -n $k ]] || continue
    az_get "media/$k.age" "$work/m.age"
    got=$(age -d "${age_ids[@]}" < "$work/m.age" | sha256sum | cut -d' ' -f1)
    [[ $got == "$want" ]] || die "media $k does not match its sha256 after decryption"
    checked=$((checked + 1))
  done <<<"$sample"
  log "media: $checked sampled files decrypt to their recorded sha256"

  # The R2 copy holds the same dump, byte for byte.
  r2_env
  r2_get "$dump" "$work/r2-dump.age" || die "R2 has no copy of $dump"
  got=$(sha256sum "$work/r2-dump.age" | cut -d' ' -f1)
  [[ $got == "$sha" ]] || die "R2's copy of the dump differs"
  log "R2: the same dump, checksum verified"

  psql_owner -d postgres -c 'DROP DATABASE chitthi_restore'
  echo "$(date -u +%Y%m%dT%H%M%SZ) $manifest" > "$STATE/last-drill"
  hc success "drill ok: $manifest"
  log "restore drill passed"
}

# =====================================================================================================
run_selftest() {
  [[ -z $TEST ]] || die "selftest needs the real storage"
  local probe code fails=0
  probe=selftest/$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)
  echo "selftest $(date -u +%FT%TZ)" > "$work/probe"
  echo "changed" > "$work/changed"
  # <what> <HTTP status> <allowed statuses, as an extended regex>
  expect() { if [[ $2 =~ ^($3)$ ]]; then echo "ok   $1 ($2)"; else echo "FAIL $1: got $2, expected $3"; fails=$((fails + 1)); fi; }
  # The proof that matters, whatever status a refusal came back with: the probe is still there, unchanged.
  intact() { # <store> <fetch function>
    if "$2" "$probe" "$work/back" 2>/dev/null && cmp -s "$work/back" "$work/probe"; then echo "ok   $1: after those attempts the probe is still there, unchanged"
    else echo "FAIL $1: the probe was changed or removed"; fails=$((fails + 1)); fi
  }
  code=$(az_put "$work/probe" "$probe");             expect "Azure: create a new blob" "$code" 201
  # 409 from If-None-Match, or 403: the create-only role fails an existing blob's overwrite
  # authorization before the condition is evaluated (seen on the VM). Both are a refusal.
  code=$(az_put "$work/probe" "$probe");             expect "Azure: create again is refused" "$code" '403|409'
  code=$(az_put "$work/changed" "$probe" overwrite); expect "Azure: overwrite is refused" "$code" 403
  code=$(az_delete "$probe");                        expect "Azure: delete is refused" "$code" 403
  intact Azure az_get
  r2_env
  code=$(r2_put "$work/probe" "$probe");             expect "R2: create a new object, one PutObject, first attempt" "$code" 200
  # 412 from If-None-Match, or 409: R2 answers 409 for a key under the bucket lock (seen on the VM).
  code=$(r2_put "$work/probe" "$probe");             expect "R2: create again is refused" "$code" '409|412'
  # Without the condition, only the bucket lock stands in the way: any refusal, then the read-back.
  code=$(r2_put "$work/changed" "$probe" overwrite); expect "R2: overwrite is refused (bucket lock)" "$code" '[34][0-9][0-9]|501'
  code=$(r2_delete "$probe");                        expect "R2: delete is refused (bucket lock)" "$code" '[34][0-9][0-9]|501'
  intact R2 r2_get
  [[ $fails -eq 0 ]] || die "$fails selftest check(s) failed: fix the permissions before relying on these backups"
  log "selftest passed: the VM can create, and cannot overwrite or delete, in both stores"
}

# =====================================================================================================
# The live database and media back from a backup: after losing or corrupting the data disk
# (docs/MAINTENANCE.md, "Incidents"). Replaces the live database, so it needs confirm=<hostname>.
run_restore() {
  local manifest=latest from=azure confirm='' kv dump sha restored r_messages r_attachments r_version keys k dst n=0 before='(none: there was no database)'
  for kv in "$@"; do
    case $kv in
      manifest=*) manifest=${kv#*=} ;;
      from=*) from=${kv#*=} ;;
      confirm=*) confirm=${kv#*=} ;;
      *) die "unknown argument '$kv'" ;;
    esac
  done
  [[ $confirm == "$HOST" ]] || die "this replaces the live database and its files: pass confirm=$HOST"
  [[ $from == azure || $from == r2 ]] || die "from= must be azure or r2"
  if [[ $from == r2 ]]; then r2_env; fi
  fetch() { if [[ $from == azure ]]; then az_get "$1" "$2"; else r2_get "$1" "$2"; fi; }
  if [[ $manifest == latest ]]; then
    if [[ $from == azure ]]; then manifest=$(az_list manifests/ | sort | tail -n 1)
    else manifest=$(r2_list manifests/ | sort | tail -n 1); fi
  fi
  [[ $manifest =~ ^manifests/[0-9]{8}T[0-9]{6}Z\.json$ ]] || die "manifest= must be manifests/<UTC>.json or latest (got '$manifest')"

  # Everything is fetched and checked before the live database is touched.
  fetch "$manifest" "$work/manifest.json"
  dump=$(jq -er .dump "$work/manifest.json")
  sha=$(jq -er .sha256 "$work/manifest.json")
  fetch "$dump" "$work/dump.age"
  fetch "$dump.sha256" "$work/dump.sha256"
  [[ $(sha256sum "$work/dump.age" | cut -d' ' -f1) == "$sha" ]] || die "the dump does not match its manifest's sha256"
  [[ $(cut -d' ' -f1 "$work/dump.sha256") == "$sha" ]] || die "the dump's .sha256 object disagrees with the manifest"
  load_identities
  age -d "${age_ids[@]}" < "$work/dump.age" > /dev/null || die "the dump does not decrypt with the backup keys"
  log "restoring $manifest from $from: dump checksum and decryption verified"

  app stop api
  # What's there now is kept, in case this restore was the mistake.
  if psql_owner -d postgres -At -c "SELECT 1 FROM pg_database WHERE datname = 'chitthi'" | grep -qx 1; then
    install -d -m 0700 "$DUMPS"
    before=$DUMPS/chitthi-pre-restore-$(date -u +%Y%m%dT%H%M%SZ).dump
    app exec -T db pg_dump -U chitthi -d chitthi -Fc > "$before" || die "could not dump the current database first; nothing was replaced"
    log "the database as it was: $before"
  fi
  psql_owner -d postgres -c 'DROP DATABASE IF EXISTS chitthi WITH (FORCE)' -c 'CREATE DATABASE chitthi OWNER chitthi'
  age -d "${age_ids[@]}" < "$work/dump.age" | app exec -T db pg_restore -U chitthi -d chitthi --no-owner --exit-on-error \
    || die "pg_restore failed; the previous database is in $before"
  restored=$(psql_owner -d chitthi -At -F ' ' -c \
    'SELECT (SELECT count(*) FROM messages), (SELECT count(*) FROM attachments), (SELECT max(version) FROM schema_migrations)')
  read -r r_messages r_attachments r_version <<<"$restored"
  [[ $r_version == "$(jq -r .schema_version "$work/manifest.json")" ]] || die "restored schema version $r_version is not the manifest's"
  (( r_messages >= $(jq -r .counts.messages "$work/manifest.json") )) || die "the restore has fewer messages than were counted"
  log "database restored: schema $r_version, $r_messages messages, $r_attachments attachments"

  # Media the manifest lists and the disk lacks: decrypted next to its place, then renamed into
  # it, owned by the API's uid like the files it writes.
  keys=$(jq -r '.media[]' "$work/manifest.json")
  while read -r k; do
    [[ $k =~ ^[0-9a-f]{32}$ ]] || continue
    dst=$(media_path "$k")
    [[ -f $dst ]] && continue
    fetch "media/$k.age" "$work/m.age"
    install -d -o 10010 -g 10010 -m 0700 "$(dirname "$(dirname "$dst")")" "$(dirname "$dst")"
    age -d "${age_ids[@]}" < "$work/m.age" > "$dst.restoring" || die "media $k does not decrypt"
    chown 10010:10010 "$dst.restoring" && chmod 0600 "$dst.restoring" && mv "$dst.restoring" "$dst"
    n=$((n + 1))
  done <<<"$keys"
  rm -f "$work/m.age"
  log "media: $n files restored, the rest were already on disk"

  # The running release may be newer than the backup: its migrations bring the schema forward.
  app run --rm migrate >/dev/null || die "the migrations failed after the restore"
  app up -d --wait api || die "the API did not come back after the restore"
  install -d -m 0700 "$STATE"
  echo "$(date -u +%Y%m%dT%H%M%SZ) $manifest from $from" > "$STATE/last-restore"
  log "restore complete: run 'deploy.sh smoke' to check the site"
}

# Read-only, for chitthi-up.sh: one real request to Key Vault and to each store, with the VM's own
# credentials, and the newest backup in each.
run_check() {
  local last
  secret chitthi-backup-age-recipient >/dev/null
  echo "ok   Key Vault $VAULT: the VM's identity reads its secrets"
  last=$(az_list manifests/ | sort | tail -n 1)
  [[ -n $last ]] || die "Azure Blob: no manifest listed"
  echo "ok   Azure Blob $AZ_ACCOUNT/$AZ_CONTAINER: newest $last"
  r2_env
  last=$(r2_list manifests/ | sort | tail -n 1)
  [[ -n $last ]] || die "R2: no manifest listed"
  echo "ok   R2 $R2_BUCKET: newest $last"
}

case ${1:-} in
  run) run_backup ;;
  drill) run_drill ;;
  selftest) run_selftest ;;
  check) run_check ;;
  restore) shift; run_restore "$@" ;;
  *) die "usage: backup.sh run | drill | selftest | check | restore confirm=$HOST [manifest=latest|manifests/<UTC>.json] [from=azure|r2]" ;;
esac
