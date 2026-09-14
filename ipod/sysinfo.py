"""
Reads the FireWire GUID from a click-wheel iPod's SysInfo file.

Only needed for devices with hashing_scheme=1 (HASH58) - iPod Classic (all
gens), Nano 3G, and Nano 4G, see ipod/checksum.py. Other devices
(hashing_scheme=0) never read this value and are unaffected if it's
missing or unparseable here.

SysInfo lives at iPod_Control/Device/SysInfo and is a plain text file of
"Key: Value" lines (format documented by the ipodlinux/libgpod projects,
e.g. libgpod's itdb_device.c). The key holding the FireWire GUID has been
observed as "FirewireGuid" with a value like "0x000a270012345678"; matching
is case/punctuation-insensitive and accepts a couple of known variants in
case a given firmware spells it differently.
"""

from pathlib import Path

_FIREWIRE_KEY_ALIASES = {'firewireguid', 'firewireid', 'fwid', 'fwguid'}


def normalize_firewire_guid(raw: str) -> str | None:
    """Validate/normalize a hex FireWire GUID from any source (SysInfo
    file or a user-entered override). Returns a lowercase hex string with
    no "0x" prefix, or None if `raw` isn't a plausible 8-20 byte GUID.
    """
    if not raw:
        return None
    candidate = raw.strip()
    if candidate.lower().startswith('0x'):
        candidate = candidate[2:].strip()
    if len(candidate) % 2 != 0 or not (16 <= len(candidate) <= 40):
        return None
    try:
        bytes.fromhex(candidate)
    except ValueError:
        return None
    return candidate.lower()


def read_firewire_guid(mount_path) -> str | None:
    """Best-effort read of the FireWire GUID from a mounted iPod's SysInfo
    file. Returns a lowercase hex string (no "0x" prefix), or None if the
    file is missing, unreadable, or doesn't contain a recognisable GUID
    field. Callers should treat None as "couldn't auto-detect" rather than
    "device has no GUID" and fall back to any value already on record.
    """
    if not mount_path:
        return None
    sysinfo_path = Path(mount_path) / 'iPod_Control' / 'Device' / 'SysInfo'
    try:
        text = sysinfo_path.read_text(encoding='utf-8', errors='ignore')
    except OSError:
        return None

    for line in text.splitlines():
        if ':' not in line:
            continue
        key, _, value = line.partition(':')
        normalized_key = key.strip().lower().replace('_', '').replace('-', '')
        if normalized_key not in _FIREWIRE_KEY_ALIASES:
            continue
        normalized = normalize_firewire_guid(value)
        if normalized:
            return normalized

    return None
