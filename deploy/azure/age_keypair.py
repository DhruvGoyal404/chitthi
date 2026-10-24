"""An age X25519 keypair in pure Python, for Azure Cloud Shell, which has Python but not age.

    python3 deploy/azure/age_keypair.py <directory>

writes <directory>/identity (AGE-SECRET-KEY-1…, the private key) and <directory>/recipient
(age1…, the public key), both mode 0600 and without a trailing newline, ready for
`az keyvault secret set --file`. setup.sh deletes them as soon as they're stored.

The format is age's: 32 random bytes are the identity; the recipient is their X25519 public key
(RFC 7748); both are Bech32-encoded (BIP 173) with the HRPs "age-secret-key-" (upper-cased) and
"age". CI checks the output against the real age: age-keygen -y must derive the same recipient,
and a file encrypted to it must decrypt with the identity (deploy/azure/test_azure_tools.py).
Not constant-time, which doesn't matter for a key generated once on a machine you control.
"""

import os
import secrets
import sys

P = 2**255 - 19
A24 = 121665
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def x25519(scalar: bytes, u: int) -> bytes:
    """RFC 7748, section 5: the Montgomery ladder on Curve25519."""
    k = bytearray(scalar)
    k[0] &= 248
    k[31] &= 127
    k[31] |= 64
    n = int.from_bytes(k, "little")
    x1, x2, z2, x3, z3, swap = u, 1, 0, u, 1, 0
    for t in reversed(range(255)):
        bit = (n >> t) & 1
        swap ^= bit
        if swap:
            x2, x3, z2, z3 = x3, x2, z3, z2
        swap = bit
        a = (x2 + z2) % P
        aa = a * a % P
        b = (x2 - z2) % P
        bb = b * b % P
        e = (aa - bb) % P
        c = (x3 + z3) % P
        d = (x3 - z3) % P
        da = d * a % P
        cb = c * b % P
        x3 = (da + cb) ** 2 % P
        z3 = x1 * (da - cb) ** 2 % P
        x2 = aa * bb % P
        z2 = e * (aa + A24 * e) % P
    if swap:
        x2, x3, z2, z3 = x3, x2, z3, z2
    return (x2 * pow(z2, P - 2, P) % P).to_bytes(32, "little")


def _polymod(values):
    gen = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    chk = 1
    for v in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            if (top >> i) & 1:
                chk ^= gen[i]
    return chk


def bech32(hrp: str, data: bytes) -> str:
    """BIP 173 Bech32 (not Bech32m), without the 90-character limit, as age uses it."""
    acc = bits = 0
    five = []
    for byte in data:
        acc = (acc << 8) | byte
        bits += 8
        while bits >= 5:
            bits -= 5
            five.append((acc >> bits) & 31)
    if bits:
        five.append((acc << (5 - bits)) & 31)
    expanded = [ord(ch) >> 5 for ch in hrp] + [0] + [ord(ch) & 31 for ch in hrp]
    pm = _polymod(expanded + five + [0] * 6) ^ 1
    five += [(pm >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(CHARSET[d] for d in five)


def keypair() -> tuple[str, str]:
    """Returns (identity, recipient)."""
    sk = secrets.token_bytes(32)
    return bech32("age-secret-key-", sk).upper(), bech32("age", x25519(sk, 9))


def main() -> None:
    if len(sys.argv) != 2 or not os.path.isdir(sys.argv[1]):
        sys.exit("usage: age_keypair.py <existing directory>")
    identity, recipient = keypair()
    for name, value in (("identity", identity), ("recipient", recipient)):
        fd = os.open(os.path.join(sys.argv[1], name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(value)


if __name__ == "__main__":
    main()
