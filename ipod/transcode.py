"""FLAC -> ALAC transcoding for click-wheel iPods, with a hash-keyed cache.

No click-wheel iPod supports FLAC playback, so every FLAC track needs
converting before it can be copied to a device — this is the piece
flagged as unavoidable since the very first research pass (see
CLAUDE.md's iPod research notes). Tracks already in an iPod-native
format (MP3/M4A/AAC/WAV/AIFF) are copied as-is; nothing generically
transcodes lossy source formats "up" to ALAC, since that would only
bloat file size without recovering any quality.

Cache has an explicit size cap and LRU eviction by design — this is a
direct response to a documented real bug in iOpenPod (the reference
project from Phase 0/1/2): its own transcode cache had no size limit
and would grow unbounded. Flagged as a known failure mode to avoid
back in the original plan, not a hypothetical.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from pathlib import Path

TRANSCODE_CACHE_MAX_BYTES = 5 * 1024 ** 3  # 5 GB
_NATIVE_FORMATS = {'.mp3', '.m4a', '.m4b', '.m4p', '.aac', '.wav', '.aif', '.aiff'}


class TranscodeError(RuntimeError):
    pass


def ffmpeg_executable() -> str:
    """Return an ffmpeg binary that works for both terminal and app launches.

    A GUI-launched app on macOS often has a small PATH.  Checking for ffmpeg
    with a broader PATH elsewhere but then invoking the bare ``ffmpeg`` name
    made a large sync look as if each FLAC were individually corrupt.  Resolve
    the executable once and give subprocess its absolute path instead.
    """
    found = shutil.which('ffmpeg')
    if found:
        return found
    for candidate in ('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'):
        if Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return candidate
    raise TranscodeError(
        'ffmpeg is required to convert this track for an iPod, but was not found.'
    )


def file_hash(path) -> str:
    """Content hash, used as the cache key — an edited/retagged source
    file naturally invalidates its old transcode without any separate
    cache-busting logic."""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def needs_transcode(source_path) -> bool:
    return Path(source_path).suffix.lower() not in _NATIVE_FORMATS


def transcode_flac_to_alac(src_path, dest_path, timeout: int = 300) -> None:
    """Losslessly transcode to ALAC (in an .m4a container) via ffmpeg.
    Raises TranscodeError on failure - callers should surface this per
    track, not let one bad file abort an entire sync."""
    result = subprocess.run(
        # -f mp4 forced explicitly: ffmpeg otherwise sniffs the output
        # container from the destination filename's extension, and the
        # temp path used during a safe write (name.m4a.tmp) ends in
        # .tmp, not .m4a - without this it fails to find a muxer at all.
        [ffmpeg_executable(), '-y', '-i', str(src_path), '-c:a', 'alac', '-vn', '-f', 'mp4', str(dest_path)],
        capture_output=True, timeout=timeout,
    )
    if result.returncode != 0 or not Path(dest_path).exists():
        stderr_tail = result.stderr.decode('utf-8', errors='replace')[-800:]
        raise TranscodeError(f'ffmpeg failed for {src_path}: {stderr_tail}')


def get_or_create_transcode(source_path, cache_dir: Path) -> Path:
    """Returns a path ready to copy to the device for this source track:
    a cached/freshly-made ALAC transcode if the source needs one, or the
    source path itself unchanged if it's already iPod-native.
    """
    source_path = Path(source_path)
    if not needs_transcode(source_path):
        return source_path

    cache_dir.mkdir(parents=True, exist_ok=True)
    h = file_hash(source_path)
    dest = cache_dir / f'{h}.m4a'
    if dest.exists() and dest.stat().st_size > 0:
        dest.touch()  # bump mtime so LRU eviction treats it as recently used
        return dest

    tmp = cache_dir / f'.{h}.m4a.tmp'
    try:
        transcode_flac_to_alac(source_path, tmp)
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)
    return dest


def enforce_cache_size_limit(cache_dir: Path, max_bytes: int = TRANSCODE_CACHE_MAX_BYTES) -> int:
    """LRU eviction (oldest mtime first) until the cache is back under
    max_bytes. Returns the number of files removed. The iPod sync calls
    this after each copied transcode so a large batch cannot consume all
    local disk space."""
    if not cache_dir.exists():
        return 0
    files = sorted(cache_dir.glob('*.m4a'), key=lambda p: p.stat().st_mtime)
    total = sum(f.stat().st_size for f in files)
    removed = 0
    for f in files:
        if total <= max_bytes:
            break
        size = f.stat().st_size
        f.unlink(missing_ok=True)
        total -= size
        removed += 1
    return removed


def cache_stats(cache_dir: Path) -> dict:
    if not cache_dir.exists():
        return {'file_count': 0, 'total_bytes': 0}
    files = list(cache_dir.glob('*.m4a'))
    return {'file_count': len(files), 'total_bytes': sum(f.stat().st_size for f in files)}
