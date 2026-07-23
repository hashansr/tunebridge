"""Click-wheel iPod USB detection.

Phase 0 concern only: can we see a connected iPod at all, before it's
necessarily mounted as a normal volume? macOS Sequoia 15.4.1+ stopped
auto-mounting iPod Classic/Mini/Nano as a USB mass-storage volume, so
detection has to start one layer below `/Volumes` — at the USB device
tree — rather than assuming `diskutil` already knows about it.

This module is intentionally standalone: no Flask, no app.py imports,
so it can be exercised (and unit tested) without a running server or a
physical device attached. Mirrors the identity fields already used by
the DAP feature's `_discover_mount_points()` / `_mac_mount_identity()`
in app.py, so results compose cleanly with that existing pattern once
a candidate iPod actually gets mounted.
"""
from __future__ import annotations

import json
import plistlib
import subprocess
import sys

# Apple's USB vendor ID. Necessary but not sufficient on its own —
# every Apple peripheral (keyboard, trackpad, iPhone) shares it, so
# candidates are additionally filtered by product name.
APPLE_VENDOR_ID = 0x05ac

# Product-name substrings covering Classic 1-7, Mini 1-2, Nano 1-7.
# Deliberately excludes "iPod touch" — out of scope per the plan (it's
# an iOS/AFC device, not a USB mass-storage iTunesDB device).
_CLICKWHEEL_NAME_HINTS = ('ipod', 'ipod classic', 'ipod mini', 'ipod nano', 'ipod shuffle')
_EXCLUDED_NAME_HINTS = ('ipod touch',)


def _looks_like_clickwheel_ipod(product_name: str) -> bool:
    name = (product_name or '').strip().lower()
    if not name:
        return False
    if any(bad in name for bad in _EXCLUDED_NAME_HINTS):
        return False
    return any(hint in name for hint in _CLICKWHEEL_NAME_HINTS)


def _walk_usb_tree(node, depth=0):
    """Yield every dict node in a system_profiler SPUSBDataType tree."""
    if isinstance(node, dict):
        yield node, depth
        for child in node.get('_items', []) or []:
            yield from _walk_usb_tree(child, depth + 1)
    elif isinstance(node, list):
        for child in node:
            yield from _walk_usb_tree(child, depth)


def list_candidate_usb_ipods():
    """Return Apple click-wheel iPods visible on the USB bus right now,
    independent of whether they're currently mounted as a volume.

    Each result: {name, vendor_id, product_id, serial_num, location_id}.
    Empty list (not an exception) when nothing is connected or the
    platform isn't macOS — this is a probe, not a hard requirement.
    """
    if sys.platform != 'darwin':
        return []

    try:
        proc = subprocess.run(
            ['system_profiler', 'SPUSBDataType', '-json'],
            capture_output=True,
            check=False,
            timeout=15,
        )
    except Exception:
        return []

    if proc.returncode != 0 or not proc.stdout:
        return []

    try:
        data = json.loads(proc.stdout)
    except Exception:
        return []

    candidates = []
    for node, _depth in _walk_usb_tree(data):
        name = node.get('_name', '')
        vendor_raw = node.get('vendor_id', '')
        # system_profiler reports vendor_id like "0x05ac  (Apple Inc.)"
        vendor_hex = vendor_raw.split()[0] if vendor_raw else ''
        try:
            vendor_id = int(vendor_hex, 16) if vendor_hex else None
        except ValueError:
            vendor_id = None

        if vendor_id != APPLE_VENDOR_ID:
            continue
        if not _looks_like_clickwheel_ipod(name):
            continue

        product_raw = node.get('product_id', '')
        product_hex = product_raw.split()[0] if product_raw else ''

        candidates.append({
            'name': name,
            'vendor_id': hex(vendor_id),
            'product_id': product_hex,
            'serial_num': node.get('serial_num', ''),
            'location_id': node.get('location_id', ''),
        })

    return candidates


def diskutil_identity(mount_path: str) -> dict:
    """Same identity fields the DAP feature already keys on
    (VolumeUUID/DiskUUID/DeviceIdentifier via `diskutil info -plist`),
    kept separate here so this module has no dependency on app.py.
    """
    info = {'volume_uuid': '', 'disk_uuid': '', 'device_identifier': ''}
    if sys.platform != 'darwin':
        return info
    try:
        proc = subprocess.run(
            ['diskutil', 'info', '-plist', mount_path],
            capture_output=True,
            check=False,
            timeout=10,
        )
        if proc.returncode != 0 or not proc.stdout:
            return info
        data = plistlib.loads(proc.stdout)
        info['volume_uuid'] = str(data.get('VolumeUUID') or '')
        info['disk_uuid'] = str(data.get('DiskUUID') or '')
        info['device_identifier'] = str(data.get('DeviceIdentifier') or '')
    except Exception:
        pass
    return info


if __name__ == '__main__':
    found = list_candidate_usb_ipods()
    if not found:
        print('No click-wheel iPods detected on the USB bus.')
    else:
        for dev in found:
            print(dev)
