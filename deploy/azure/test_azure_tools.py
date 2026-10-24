"""Tests for the Cloud Shell tools: python3 -m unittest discover -s deploy/azure -v

REQUIRE_AGE=1 (set in CI, where the bootstrapped runner has age) turns the checks against the real
age into failures instead of skips.
"""

import datetime as dt
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import age_keypair
import compact_media as cm

NOW = dt.datetime(2026, 10, 24, 12, 0, tzinfo=dt.timezone.utc)


def ago(days=0, hours=0):
    return NOW - dt.timedelta(days=days, hours=hours)


def manifest(when):
    return f"manifests/{when:%Y%m%dT%H%M%SZ}.json"


class AgeKeypair(unittest.TestCase):
    def test_x25519_rfc7748_vectors(self):
        # RFC 7748 section 5.2, the first test vector, and section 6.1 (Alice's public key).
        u = int.from_bytes(bytes.fromhex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c"), "little") & ((1 << 255) - 1)
        out = age_keypair.x25519(bytes.fromhex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"), u)
        self.assertEqual(out.hex(), "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552")
        alice = age_keypair.x25519(bytes.fromhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"), 9)
        self.assertEqual(alice.hex(), "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")

    def test_bech32_bip173_vector(self):
        self.assertEqual(age_keypair.bech32("a", b""), "a12uel5l")

    def test_format(self):
        identity, recipient = age_keypair.keypair()
        self.assertRegex(identity, r"^AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}$")
        self.assertRegex(recipient, r"^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$")

    def test_against_real_age(self):
        if not (shutil.which("age") and shutil.which("age-keygen")):
            if os.environ.get("REQUIRE_AGE") == "1":
                self.fail("age and age-keygen are required here (REQUIRE_AGE=1)")
            self.skipTest("age is not installed")
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run([sys.executable, age_keypair.__file__, tmp], check=True)
            identity, recipient = (os.path.join(tmp, n) for n in ("identity", "recipient"))
            self.assertEqual(os.stat(identity).st_mode & 0o777, 0o600)
            with open(recipient) as f:
                pub = f.read()
            derived = subprocess.run(["age-keygen", "-y", identity], check=True, capture_output=True, text=True).stdout.strip()
            self.assertEqual(derived, pub)
            sealed = subprocess.run(["age", "-r", pub], input=b"chitthi backup", check=True, capture_output=True).stdout
            opened = subprocess.run(["age", "-d", "-i", identity], input=sealed, check=True, capture_output=True).stdout
            self.assertEqual(opened, b"chitthi backup")


class SigV4(unittest.TestCase):
    # AWS's Signature Version 4 test suite, "get-vanilla".
    def test_get_vanilla(self):
        h = cm.sigv4("GET", "example.amazonaws.com", "/", {}, cm.EMPTY_SHA256, "AKIDEXAMPLE",
                     "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830T123600Z", "us-east-1", "service")
        self.assertEqual(h["authorization"],
                         "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, "
                         "SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31")


class Compaction(unittest.TestCase):
    def test_keeps_only_recent_manifests(self):
        names = [manifest(ago(days=d)) for d in (0, 10, 34, 36, 60)] + ["manifests/junk.json"]
        self.assertEqual(cm.manifests_to_keep(names, NOW), sorted(names[:3]))

    def test_refuses_without_manifests(self):
        with self.assertRaisesRegex(cm.Refused, "no manifests"):
            cm.manifests_to_keep([], NOW)

    def test_refuses_when_backups_are_stale(self):
        with self.assertRaisesRegex(cm.Refused, "aren't current"):
            cm.manifests_to_keep([manifest(ago(hours=49)), manifest(ago(days=20))], NOW)

    def test_refuses_a_manifest_without_media(self):
        with self.assertRaisesRegex(cm.Refused, "no media list"):
            cm.listed_keys({"m1": {"media": ["a" * 32]}, "m2": {"dump": "x"}})

    def test_deletes_only_unlisted_and_old(self):
        listed = {"a" * 32}
        objects = {
            "a" * 32: (ago(days=200), 1),  # listed: kept however old
            "b" * 32: (ago(days=40), 2),   # unlisted, old: deleted
            "c" * 32: (ago(days=34), 3),   # unlisted, too young: kept (its manifest may be coming; R2 lock)
            "d" * 32: (ago(days=90), 4),   # unlisted, old: deleted
        }
        self.assertEqual(cm.to_delete(objects, listed, NOW), ["d" * 32, "b" * 32])

    def test_refuses_a_mass_deletion_unless_forced(self):
        objects = {f"{i:032x}": (ago(days=40), 1) for i in range(20)}
        with self.assertRaisesRegex(cm.Refused, "more than 50%"):
            cm.to_delete(objects, set(), NOW)
        self.assertEqual(len(cm.to_delete(objects, set(), NOW, force=True)), 20)

    def test_small_deletions_need_no_force(self):
        objects = {f"{i:032x}": (ago(days=40), 1) for i in range(3)}
        self.assertEqual(len(cm.to_delete(objects, set(), NOW)), 3)


FAKE_AZ = r"""#!/usr/bin/env bash
# Stands in for `az vm run-command invoke`: runs the payload with sh, answers in Run Command's shape.
for a in "$@"; do case $a in @*) f=${a#@} ;; esac; done
out=$(sh "$f" 2>/dev/null)
jq -n --arg m "Enable succeeded: $(printf '\n[stdout]\n%s\n\n[stderr]\n' "$out")" '{value: [{message: $m}]}'
"""


@unittest.skipUnless(shutil.which("bash") and shutil.which("jq"), "needs bash and jq")
class RunOnVm(unittest.TestCase):
    def run_on_vm(self, tmp, *args):
        env = {**os.environ, "PATH": tmp + os.pathsep + os.environ["PATH"]}
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "run-on-vm.sh")
        return subprocess.run([shutil.which("bash"), script, *args], capture_output=True, text=True, env=env)

    def test_arguments_text_and_exit_code_come_through(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "az"), "w", newline="\n") as f:
                f.write(FAKE_AZ)
            os.chmod(os.path.join(tmp, "az"), 0o755)
            with open(os.path.join(tmp, "s.sh"), "w", newline="\n") as f:
                f.write('echo "args: $*"\necho \'literal: $HOME `x`\'\nexit 3')  # no trailing newline
            r = self.run_on_vm(tmp, os.path.join(tmp, "s.sh"), "deploy", "sha=ab12", "api=ghcr.io/o/r@sha256:00", "acme_email=a@b.c")
            self.assertEqual(r.returncode, 3, r.stderr)
            self.assertIn("args: deploy sha=ab12 api=ghcr.io/o/r@sha256:00 acme_email=a@b.c", r.stdout)
            self.assertIn("literal: $HOME `x`", r.stdout)
            r = self.run_on_vm(tmp, os.path.join(tmp, "s.sh"), "x;reboot")
            self.assertEqual(r.returncode, 1)
            self.assertIn("refuses to pass", r.stderr)


if __name__ == "__main__":
    unittest.main()
