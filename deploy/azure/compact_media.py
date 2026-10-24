"""Monthly media compaction for Chitthi's backups. The owner runs it in Azure Cloud Shell, under
their own identity; the VM never deletes anything (docs/MAINTENANCE.md, "Backups").

    python3 deploy/azure/compact_media.py --vault <key vault> --account <storage account> \
        --r2-bucket <bucket> [--container backups] [--apply]

Without --apply it only reports. A media object is deleted only when all of these hold:
- no manifest from the last 35 days lists it (manifests older than that are expired by lifecycle
  rules anyway);
- it was created more than 35 days ago, so it can't be an upload whose manifest is still to come,
  and R2's 30-day bucket lock has ended;
- the newest manifest is less than 48 hours old, so backups are running and the manifests
  describe the present;
- it isn't part of a deletion of more than half of all media (--force overrides, after you've
  looked).
Azure's soft delete keeps what this deletes for 14 more days.

Azure is reached through `az` (Entra sign-in; the account refuses shared keys). R2 is reached with
the same API token the VM uses, read from Key Vault into memory, over S3's API, signed here with
SigV4 because Cloud Shell has neither rclone nor the AWS CLI.
"""

import argparse
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

KEEP_DAYS = 35
FRESH_HOURS = 48
MAX_FRACTION = 0.5
MANIFEST_RE = re.compile(r"^manifests/(\d{8}T\d{6}Z)\.json$")
MEDIA_RE = re.compile(r"^media/([0-9a-f]{32})\.age$")
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


class Refused(Exception):
    """A safety check failed: nothing is deleted."""


# --- What to delete (pure; tested in deploy/azure/test_azure_tools.py) ------------------------------
def manifests_to_keep(names, now):
    """The manifest blob names from the last KEEP_DAYS days, after checking backups are current."""
    stamped = []
    for name in names:
        m = MANIFEST_RE.match(name)
        if m:
            stamped.append((dt.datetime.strptime(m.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc), name))
    if not stamped:
        raise Refused("there are no manifests: backups have never run, or this is the wrong container")
    newest = max(stamped)[0]
    if now - newest > dt.timedelta(hours=FRESH_HOURS):
        raise Refused(f"the newest manifest is from {newest:%Y-%m-%d %H:%M} UTC: backups aren't current, so the manifests can't be trusted to list everything in use")
    return sorted(name for stamp, name in stamped if now - stamp <= dt.timedelta(days=KEEP_DAYS))


def listed_keys(manifests):
    """Every media key the given parsed manifests list."""
    keys = set()
    for name, doc in manifests.items():
        media = doc.get("media") if isinstance(doc, dict) else None
        if not isinstance(media, list) or not all(isinstance(k, str) for k in media):
            raise Refused(f"{name} has no media list")
        keys.update(media)
    return keys


def to_delete(objects, listed, now, force=False):
    """objects: {key: (created, size)}. Returns the keys to delete, oldest first."""
    cutoff = now - dt.timedelta(days=KEEP_DAYS)
    doomed = sorted((created, key) for key, (created, _size) in objects.items() if key not in listed and created < cutoff)
    if not force and len(doomed) > 10 and len(doomed) > MAX_FRACTION * len(objects):
        raise Refused(f"{len(doomed)} of {len(objects)} media objects would go, more than {MAX_FRACTION:.0%}: check the manifests, then use --force")
    return [key for _created, key in doomed]


# --- Azure Blob, through az -----------------------------------------------------------------------
def az(*args, capture=True):
    result = subprocess.run(["az", *args, "--only-show-errors"], capture_output=capture, text=True)
    if result.returncode != 0:
        sys.exit(f"compact: az {args[0]} {args[1]} failed: {(result.stderr or '').strip()}")
    return result.stdout


def parse_time(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(dt.timezone.utc)


class AzureStore:
    name = "Azure"

    def __init__(self, account, container):
        self.base = ["--auth-mode", "login", "--account-name", account, "--container-name", container]

    def list(self, prefix):
        out = az("storage", "blob", "list", *self.base, "--prefix", prefix, "--num-results", "*", "--output", "json",
                 "--query", "[].{name: name, created: properties.creationTime, size: properties.contentLength}")
        return json.loads(out)

    def media(self):
        objects = {}
        for blob in self.list("media/"):
            m = MEDIA_RE.match(blob["name"])
            if m:
                objects[m.group(1)] = (parse_time(blob["created"]), int(blob["size"] or 0))
        return objects

    def read(self, name):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "blob")
            az("storage", "blob", "download", *self.base, "--name", name, "--file", path, "--no-progress", "--output", "none")
            with open(path, encoding="utf-8") as f:
                return f.read()

    def delete(self, key):
        result = subprocess.run(["az", "storage", "blob", "delete", *self.base, "--name", f"media/{key}.age",
                                 "--only-show-errors", "--output", "none"], capture_output=True, text=True)
        return result.returncode == 0, result.stderr.strip()


# --- R2, over the S3 API with SigV4 ---------------------------------------------------------------
def _enc(value, safe="-_.~"):
    return urllib.parse.quote(value, safe=safe)


def sigv4(method, host, path, query, payload_hash, access_key, secret_key, amz_date, region, service, headers=None):
    """AWS Signature Version 4: the headers to send, Authorization included. `path` is already
    URI-encoded; `query` is a dict of raw values."""
    day = amz_date[:8]
    hdrs = {k.lower(): " ".join(str(v).split()) for k, v in (headers or {}).items()}
    hdrs["host"] = host
    hdrs["x-amz-date"] = amz_date
    signed = ";".join(sorted(hdrs))
    canonical = "\n".join([
        method,
        path,
        "&".join(f"{_enc(k)}={_enc(v)}" for k, v in sorted(query.items())),
        "".join(f"{k}:{hdrs[k]}\n" for k in sorted(hdrs)),
        signed,
        payload_hash,
    ])
    scope = f"{day}/{region}/{service}/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = ("AWS4" + secret_key).encode()
    for part in (day, region, service, "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    hdrs["authorization"] = f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed}, Signature={signature}"
    return hdrs


# S3's XML has a namespace; match on local names.
def _children(el, name):
    return [c for c in el if c.tag.rsplit("}", 1)[-1] == name]


def _text(el, name):
    found = _children(el, name)
    return (found[0].text or "") if found else ""


class R2Store:
    name = "R2"

    def __init__(self, endpoint, bucket, access_key, secret_key):
        parsed = urllib.parse.urlsplit(endpoint)
        if parsed.scheme != "https" or not parsed.hostname:
            sys.exit("compact: the R2 endpoint in Key Vault is not an https URL")
        self.endpoint, self.host, self.bucket = f"https://{parsed.hostname}", parsed.hostname, bucket
        self.access_key, self.secret_key = access_key, secret_key

    def _request(self, method, key="", query=None):
        query = query or {}
        path = "/" + _enc(self.bucket) + ("/" + _enc(key, safe="/-_.~") if key else "")
        amz_date = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        headers = sigv4(method, self.host, path, query, EMPTY_SHA256, self.access_key, self.secret_key, amz_date,
                        "auto", "s3", {"x-amz-content-sha256": EMPTY_SHA256})
        del headers["host"]
        qs = "&".join(f"{_enc(k)}={_enc(v)}" for k, v in sorted(query.items()))
        req = urllib.request.Request(self.endpoint + path + (f"?{qs}" if qs else ""), method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def media(self):
        objects, token = {}, None
        while True:
            query = {"list-type": "2", "prefix": "media/"}
            if token:
                query["continuation-token"] = token
            status, body = self._request("GET", query=query)
            if status != 200:
                sys.exit(f"compact: listing R2 media got HTTP {status}")
            root = ET.fromstring(body)
            for item in _children(root, "Contents"):
                m = MEDIA_RE.match(_text(item, "Key"))
                if m:
                    objects[m.group(1)] = (parse_time(_text(item, "LastModified")), int(_text(item, "Size") or 0))
            if _text(root, "IsTruncated") != "true":
                return objects
            token = _text(root, "NextContinuationToken")

    def delete(self, key):
        status, body = self._request("DELETE", key=f"media/{key}.age")
        return status in (200, 204), f"HTTP {status} {body[:200]!r}"


# --------------------------------------------------------------------------------------------------
def secret(vault, name):
    value = az("keyvault", "secret", "show", "--vault-name", vault, "--name", name, "--query", "value", "--output", "tsv").strip()
    if not value:
        sys.exit(f"compact: Key Vault secret {name} is empty")
    return value


def mib(n):
    return f"{n / 1048576:.1f} MiB"


def main():
    p = argparse.ArgumentParser(description="Delete backed-up media that no recent manifest lists.")
    p.add_argument("--vault", required=True)
    p.add_argument("--account", required=True)
    p.add_argument("--container", default="backups")
    p.add_argument("--r2-bucket", required=True)
    p.add_argument("--apply", action="store_true", help="delete (without it, only report)")
    p.add_argument("--force", action="store_true", help=f"allow deleting more than {MAX_FRACTION:.0%} of all media")
    args = p.parse_args()
    now = dt.datetime.now(dt.timezone.utc)

    azure = AzureStore(args.account, args.container)
    try:
        keep = manifests_to_keep([b["name"] for b in azure.list("manifests/")], now)
        manifests = {name: json.loads(azure.read(name)) for name in keep}
        listed = listed_keys(manifests)
    except Refused as e:
        sys.exit(f"compact: refused, nothing deleted: {e}")
    print(f"compact: {len(keep)} manifests from the last {KEEP_DAYS} days list {len(listed)} media files")

    r2 = R2Store(secret(args.vault, "chitthi-r2-endpoint"), args.r2_bucket,
                 secret(args.vault, "chitthi-r2-access-key-id"), secret(args.vault, "chitthi-r2-secret-access-key"))
    failures = 0
    for store in (azure, r2):
        objects = store.media()
        try:
            doomed = to_delete(objects, listed, now, args.force)
        except Refused as e:
            sys.exit(f"compact: refused, nothing deleted in {store.name}: {e}")
        size = sum(objects[k][1] for k in doomed)
        print(f"compact: {store.name}: {len(objects)} media objects, {len(doomed)} unlisted and older than {KEEP_DAYS} days ({mib(size)})")
        if not args.apply:
            continue
        deleted = 0
        for key in doomed:
            ok, detail = store.delete(key)
            if ok:
                deleted += 1
            else:
                failures += 1
                print(f"compact: {store.name}: could not delete media/{key}.age: {detail}", file=sys.stderr)
        print(f"compact: {store.name}: deleted {deleted}")
    if not args.apply:
        print("compact: nothing deleted (report only); run again with --apply")
    if failures:
        sys.exit(f"compact: {failures} deletions failed")


if __name__ == "__main__":
    main()
