"""Local stand-in for iopenpod.device.write_guard.

Upstream's real write_guard.py (~500 lines) implements a whole
device-write-safety subsystem (free-space checks, write journaling,
recovery) coupled to the rest of iopenpod.device. artworkdb_chunks.py
only needs the exception type it raises on a malformed/unsafe
ArtworkDB, so that's all this stand-in provides - TuneBridge's own
backup-before-write + atomic-replace pattern (see
ipod/itunesdb_writer.py's backup_itunesdb/write_ipod_itunesdb_atomic,
reused for ArtworkDB in ipod/artworkdb.py) already covers the actual
safety net.
"""
from __future__ import annotations


class DeviceWriteSafetyError(Exception):
    pass
