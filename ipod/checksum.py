"""iTunesDB checksum scheme identification.

Which scheme a given click-wheel iPod requires is informational at
read time (Phase 1) and load-bearing once we write (Phase 2+) — the
mhbd header's `hashing_scheme` field tells us which, if any, applies.

Scheme mapping ported from iOpenPod's device/checksum.py (MIT, see
ipod/_vendor/LICENSE) — that file is a tiny enum/mapping, not parsing
logic, so it's reproduced here directly rather than vendored wholesale.

Verified during Phase 0 against a real iPod 5th Gen: its mhbd header
reports hashing_scheme=0 (NONE) — pre-2007 iPods need no checksum at
all to write a valid iTunesDB.
"""
from __future__ import annotations

from enum import IntEnum


class ChecksumType(IntEnum):
    """NONE        — Pre-2007 iPods (iPod 1G-5.5G, Mini 1G-2G, Nano 1G-2G, Shuffle)
    HASH58      — iPod Classic (all gens), Nano 3G, Nano 4G
    HASH72      — Nano 5G
    HASHAB      — Nano 6G, Nano 7G (white-box AES via WASM module — out of scope, Phase 6)
    UNKNOWN     — Not yet identified / unrecognized value
    """
    NONE = 0
    HASH58 = 1
    HASH72 = 2
    HASHAB = 4
    UNKNOWN = 99


# Raw mhbd `hashing_scheme` wire value -> ChecksumType. Note HASHAB's
# enum value (4, matching iOpenPod's CHECKSUM_MHBD_SCHEME mapping) is
# the wire value directly, unlike iOpenPod's own enum which numbers it
# 3 internally — kept as the wire value here since we don't otherwise
# need a separate internal numbering.
MHBD_SCHEME_TO_CHECKSUM = {
    0: ChecksumType.NONE,
    1: ChecksumType.HASH58,
    2: ChecksumType.HASH72,
    4: ChecksumType.HASHAB,
}


def checksum_type_for(hashing_scheme: int) -> ChecksumType:
    return MHBD_SCHEME_TO_CHECKSUM.get(hashing_scheme, ChecksumType.UNKNOWN)
