#!/bin/bash
# mac_mount_helper.sh — workaround for macOS Sequoia 15.4.1+ no longer
# auto-mounting click-wheel iPods (USB mass-storage) as normal volumes.
#
# Background: Finder/diskutil recognize the device is present but refuse
# to auto-mount it. The community-documented fix is to bypass diskutil's
# media-type auto-recognition and mount the raw disk device directly with
# mount_hfs (iPod Classic/Mini/most Nanos, HFS+) or mount_msdos (FAT32,
# some Windows-formatted Nanos). This requires root because the low-level
# mount_* utilities do.
#
# STATUS: written but NOT YET VALIDATED against real hardware (Phase 0 gate).
# Do not wire this into the app's mount flow until it's been run against
# an actual connected iPod and confirmed to produce a working mount.
#
# Usage:
#   ./mac_mount_helper.sh --list                 # safe, no sudo: show candidate disks
#   sudo ./mac_mount_helper.sh --device /dev/diskN --fs hfs|msdos --mountpoint /path
#
# Deliberately does NOT auto-select a disk to mount — sudo-mounting the
# wrong device is exactly the kind of mistake this script should make
# structurally impossible, not just unlikely. --list is the only
# discovery step; mounting always requires an explicit --device.

set -euo pipefail

usage() {
    echo "Usage:"
    echo "  $0 --list"
    echo "  sudo $0 --device /dev/diskN --fs hfs|msdos --mountpoint /path/to/mount"
    exit 1
}

list_candidates() {
    echo "External, non-internal physical disks (candidates for a click-wheel iPod):"
    echo ""
    for disk in $(diskutil list -plist external physical 2>/dev/null | \
                  plutil -extract WholeDisks xml1 -o - -- - 2>/dev/null | \
                  grep -o '<string>.*</string>' | sed -E 's#</?string>##g'); do
        info=$(diskutil info -plist "$disk" 2>/dev/null || true)
        [ -z "$info" ] && continue
        name=$(echo "$info" | plutil -extract MediaName xml1 -o - -- - 2>/dev/null | grep -o '<string>.*</string>' | sed -E 's#</?string>##g' || echo "?")
        internal=$(echo "$info" | plutil -extract Internal xml1 -o - -- - 2>/dev/null | grep -o 'true\|false' || echo "?")
        echo "  /dev/${disk}  media=\"${name}\"  internal=${internal}"
        # Also list its partitions, since the mountable filesystem is usually
        # a partition (e.g. diskNs2 = data partition on an iPod Classic),
        # not the whole-disk device.
        for part in $(diskutil list -plist "$disk" 2>/dev/null | \
                      plutil -extract "AllDisksAndPartitions.0.Partitions" xml1 -o - -- - 2>/dev/null | \
                      grep -o '<string>disk[0-9]*s[0-9]*</string>' | sed -E 's#</?string>##g'); do
            pinfo=$(diskutil info -plist "$part" 2>/dev/null || true)
            [ -z "$pinfo" ] && continue
            ptype=$(echo "$pinfo" | plutil -extract FilesystemType xml1 -o - -- - 2>/dev/null | grep -o '<string>.*</string>' | sed -E 's#</?string>##g' || echo "?")
            pmounted=$(echo "$pinfo" | plutil -extract MountPoint xml1 -o - -- - 2>/dev/null | grep -o '<string>.*</string>' | sed -E 's#</?string>##g' || echo "")
            echo "    /dev/${part}  fs=${ptype:-unknown}  mounted_at=${pmounted:-<not mounted>}"
        done
    done
    echo ""
    echo "If an iPod is connected but shows no mounted_at above, that's the"
    echo "Sequoia bug this script works around. Pick the partition device"
    echo "(diskNsN, not the whole disk) and mount it explicitly:"
    echo "  sudo $0 --device /dev/diskNsN --fs hfs --mountpoint /Volumes/iPod"
}

DEVICE=""
FS=""
MOUNTPOINT=""

while [ $# -gt 0 ]; do
    case "$1" in
        --list) list_candidates; exit 0 ;;
        --device) DEVICE="$2"; shift 2 ;;
        --fs) FS="$2"; shift 2 ;;
        --mountpoint) MOUNTPOINT="$2"; shift 2 ;;
        *) usage ;;
    esac
done

[ -z "$DEVICE" ] || [ -z "$FS" ] || [ -z "$MOUNTPOINT" ] && usage

if [ "$(id -u)" -ne 0 ]; then
    echo "This action requires root (mount_hfs/mount_msdos are privileged)." >&2
    echo "Re-run with sudo, or trigger via osascript 'with administrator privileges' from the app." >&2
    exit 1
fi

# Refuse to touch anything that isn't an external physical disk — the
# single most important safety check in this script, since a wrong
# --device value here should never be able to reach an internal volume.
info=$(diskutil info -plist "$DEVICE" 2>/dev/null || true)
if [ -z "$info" ]; then
    echo "diskutil doesn't recognize $DEVICE — aborting." >&2
    exit 1
fi
internal=$(echo "$info" | plutil -extract Internal xml1 -o - -- - 2>/dev/null | grep -o 'true\|false' || echo "true")
if [ "$internal" = "true" ]; then
    echo "$DEVICE is reported as an INTERNAL disk. Refusing to mount — this script only ever targets external media." >&2
    exit 1
fi

mkdir -p "$MOUNTPOINT"

case "$FS" in
    hfs)   mount_hfs "$DEVICE" "$MOUNTPOINT" ;;
    msdos) mount_msdos "$DEVICE" "$MOUNTPOINT" ;;
    *) echo "Unknown --fs '$FS', expected hfs or msdos." >&2; exit 1 ;;
esac

echo "Mounted $DEVICE at $MOUNTPOINT"
