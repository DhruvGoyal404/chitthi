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
# Stands in for az: `vm show` and managed Run Command (`vm run-command create|show|delete`).
# Logs every invocation's arguments, one per line, to $FAKE_AZ_STATE/args.log. `create` runs the
# script with sh, with each --protected-parameters NAME=value in its environment, as on Linux.
# FAKE_AZ_LEAK=1 makes `show` echo the protected parameters back, as a broken API would.
state=${FAKE_AZ_STATE:?}
{ printf '%s\n' "$@"; echo ---; } >> "$state/args.log"
case "$1 $2 ${3:-}" in
  "vm show "*) echo centralindia ;;
  "vm run-command create")
    shift 3
    script= penv=()
    while [ $# -gt 0 ]; do
      case $1 in
        --script) script=${2#@}; shift ;;
        --protected-parameters) penv+=("$2"); shift ;;
      esac
      shift
    done
    set +e
    out=$(env "${penv[@]}" sh "$script" 2>/dev/null); rc=$?
    leak=
    [ -n "${FAKE_AZ_LEAK:-}" ] && leak="${penv[*]}"
    jq -n --arg o "$out" --argjson rc "$rc" --arg leak "$leak" --rawfile s "$script" \
      '{source: {script: $s}, protectedParameters: (if $leak == "" then null else [$leak] end),
        instanceView: {output: $o, error: "", exitCode: $rc, executionState: (if $rc == 0 then "Succeeded" else "Failed" end)}}' > "$state/view.json"
    ;;
  "vm run-command show") cat "$state/view.json" ;;
  "vm run-command delete") echo deleted >> "$state/deleted" ;;
  *) echo "fake az: unexpected $*" >&2; exit 2 ;;
esac
"""


@unittest.skipUnless(shutil.which("bash") and shutil.which("jq"), "needs bash and jq")
class RunOnVm(unittest.TestCase):
    TOKEN = "ghs_" + "A1b2" * 9

    def run_on_vm(self, tmp, body, *args, token=None, leak=False):
        with open(os.path.join(tmp, "az"), "w", newline="\n") as f:
            f.write(FAKE_AZ)
        os.chmod(os.path.join(tmp, "az"), 0o755)
        with open(os.path.join(tmp, "s.sh"), "w", newline="\n") as f:
            f.write(body)
        env = {**os.environ, "PATH": tmp + os.pathsep + os.environ["PATH"], "FAKE_AZ_STATE": tmp}
        env.pop("RUN_ON_VM_GITHUB_TOKEN", None)
        if token is not None:
            env["RUN_ON_VM_GITHUB_TOKEN"] = token
        if leak:
            env["FAKE_AZ_LEAK"] = "1"
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "run-on-vm.sh")
        return subprocess.run([shutil.which("bash"), script, os.path.join(tmp, "s.sh"), *args], capture_output=True, text=True, env=env)

    def calls(self, tmp):
        with open(os.path.join(tmp, "args.log"), encoding="utf-8") as f:
            return [c.strip("\n").split("\n") for c in f.read().split("---\n") if c.strip()]

    def test_arguments_text_and_exit_code_come_through(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = 'echo "args: $*"\necho \'literal: $HOME `x`\'\nexit 3'  # no trailing newline
            r = self.run_on_vm(tmp, body, "deploy", "sha=ab12", "api=ghcr.io/o/r@sha256:00", "acme_email=a@b.c")
            self.assertEqual(r.returncode, 3, r.stderr)
            self.assertIn("args: deploy sha=ab12 api=ghcr.io/o/r@sha256:00 acme_email=a@b.c", r.stdout)
            self.assertIn("literal: $HOME `x`", r.stdout)
            self.assertTrue(os.path.exists(os.path.join(tmp, "deleted")), "the run command resource was not deleted")
            create = next(c for c in self.calls(tmp) if c[:3] == ["vm", "run-command", "create"])
            self.assertNotIn("--parameters", create)  # arguments travel in the script, never as parameters
            self.assertNotIn("--protected-parameters", create)  # nothing secret was given
            r = self.run_on_vm(tmp, body, "x;reboot")
            self.assertEqual(r.returncode, 1)
            self.assertIn("refuses to pass", r.stderr)

    def test_the_token_goes_only_in_protected_parameters(self):
        with tempfile.TemporaryDirectory() as tmp:
            # The script compares against the token's sha256, so its own text doesn't hold the token.
            digest = __import__("hashlib").sha256(self.TOKEN.encode()).hexdigest()
            body = ('[ "$(printf %%s "$CHITTHI_GITHUB_TOKEN" | sha256sum | cut -d" " -f1)" = "%s" ] && echo token-arrived\n'
                    'echo "args: $*"\n') % digest
            r = self.run_on_vm(tmp, body, "deploy", token=self.TOKEN)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("token-arrived", r.stdout)
            self.assertIn("args: deploy", r.stdout)
            self.assertNotIn(self.TOKEN, r.stdout + r.stderr)
            # Across every az call: the token appears exactly once, right after --protected-parameters.
            seen = 0
            for call in self.calls(tmp):
                for i, a in enumerate(call):
                    if self.TOKEN in a:
                        self.assertEqual(call[i - 1], "--protected-parameters", call[:3])
                        self.assertEqual(a, "CHITTHI_GITHUB_TOKEN=" + self.TOKEN)
                        seen += 1
            self.assertEqual(seen, 1)
            # What Azure would store and show: the script text and the instance view.
            with open(os.path.join(tmp, "view.json"), encoding="utf-8") as f:
                self.assertNotIn(self.TOKEN, f.read())

    def test_a_token_returned_by_the_api_fails_the_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = self.run_on_vm(tmp, "echo hi\n", token=self.TOKEN, leak=True)
            self.assertEqual(r.returncode, 1)
            self.assertIn("came back from the API", r.stderr)
            self.assertNotIn(self.TOKEN, r.stdout + r.stderr)

    def test_a_malformed_token_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = self.run_on_vm(tmp, "echo should-not-run\n", token="not a token; reboot")
            self.assertEqual(r.returncode, 1)
            self.assertIn("doesn't look like a GitHub token", r.stderr)
            self.assertFalse(os.path.exists(os.path.join(tmp, "args.log")), "az was called")


def _has_yaml():
    try:
        import yaml  # noqa: F401
        return True
    except ImportError:
        return False


@unittest.skipUnless(os.environ.get("REQUIRE_YAML") == "1" or _has_yaml(), "needs PyYAML")
class DeployWorkflow(unittest.TestCase):
    """The token handed to the VM comes from a job that can only read; the job that pushes images
    never hands its token anywhere."""

    def test_permissions(self):
        import yaml
        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
        with open(os.path.join(root, ".github", "workflows", "deploy.yml"), encoding="utf-8") as f:
            wf = yaml.safe_load(f)
        self.assertEqual(wf["permissions"], {})
        gate, build, deploy = wf["jobs"]["gate"], wf["jobs"]["build"], wf["jobs"]["deploy"]
        self.assertEqual(gate["permissions"], {"actions": "read"})
        self.assertEqual(build["permissions"], {"contents": "read", "packages": "write"})
        # Azure trusts only this environment's tokens (setup.sh's federated credential).
        self.assertEqual(deploy["environment"], "production")
        self.assertNotIn("environment", build)
        # id-token lets the job request an OIDC token for Azure; it adds no scope to GITHUB_TOKEN.
        self.assertEqual(deploy["permissions"], {"contents": "read", "packages": "read", "id-token": "write"})
        build_text = yaml.safe_dump(build)
        self.assertNotIn("RUN_ON_VM_GITHUB_TOKEN", build_text)
        self.assertNotIn("run-on-vm", build_text)
        handed = [s for s in deploy["steps"] if "RUN_ON_VM_GITHUB_TOKEN" in (s.get("env") or {})]
        self.assertTrue(handed)
        for s in handed:
            self.assertEqual(s["env"]["RUN_ON_VM_GITHUB_TOKEN"], "${{ github.token }}")


if __name__ == "__main__":
    unittest.main()
