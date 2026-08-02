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
import json
import os
import shutil
import subprocess
from pathlib import Path

TRANSCODE_CACHE_MAX_BYTES = 5 * 1024 ** 3  # 5 GB
_NATIVE_FORMATS = {'.mp3', '.m4a', '.m4b', '.m4p', '.aac', '.wav', '.aif', '.aiff'}

# Click-wheel iPods (including iPod Classic 5.5G) cannot decode ALAC above
# this rate - the track is accepted onto the device with a correct-looking
# title/runtime but is silently skipped during playback, with no error
# anywhere. Hi-res FLAC sources (96kHz, 176.4kHz, 192kHz remasters) must be
# downsampled before transcode; standard 44.1/48kHz sources pass through
# untouched.
_MAX_IPOD_SAMPLE_RATE = 48000

# Click-wheel iPods only handle 24-bit ALAC via an unofficial, unreliable
# real-time truncation to 16-bit during playback (confirmed against a real
# iPod Classic 5th Gen: every synced 24-bit-sourced ALAC file - both ones
# that played fine and ones that stuttered every ~2s - decoded as "from
# 24-bit source" per afinfo; real iTunes itself never pre-truncated 24-bit
# files before sync, relying on this same shaky on-device path). Forcing
# 16-bit here, like iTunes' own contemporaries did in practice, avoids that
# marginal decode path entirely rather than gambling on it per-track.
_TARGET_SAMPLE_FMT = 's16p'

# Bump whenever transcode_flac_to_alac()'s ffmpeg arguments change, so a
# stale cache entry produced by the old logic (e.g. an un-clamped hi-res
# transcode from before the sample-rate fix, or a 24-bit transcode from
# before the bit-depth fix) is never silently reused - the cache key is
# otherwise just the source file's content hash, which doesn't change when
# only the transcode logic does.
TRANSCODE_FORMAT_VERSION = 3


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


def ffprobe_executable() -> str:
    """Same PATH-resolution rationale as ffmpeg_executable() - ffprobe ships
    alongside ffmpeg in the same install, so a GUI launch's narrow PATH
    misses it for the same reason."""
    found = shutil.which('ffprobe')
    if found:
        return found
    for candidate in ('/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'):
        if Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return candidate
    raise TranscodeError(
        'ffprobe is required to convert this track for an iPod, but was not found.'
    )


def probe_audio(path) -> dict:
    """Real sample rate (Hz), sample format, bitrate (kbps) of the first
    audio stream, and duration (ms) of the container, read straight from
    the file's bytes rather than trusted from source tags. Used both to
    decide whether a source needs downsampling/bit-depth conversion before
    transcode, to verify what ffmpeg actually produced afterwards, and to
    populate the iTunesDB bitrate/sample_rate fields from the real
    on-device file rather than stale source-tag values.

    bitrate_kbps comes from the container's overall bit_rate (ffprobe
    reports bits/sec) - ALAC has no fixed encoder bitrate, so this is
    measured, not requested, and will legitimately vary per track.
    """
    result = subprocess.run(
        [ffprobe_executable(), '-v', 'error', '-select_streams', 'a:0',
         '-show_entries', 'stream=sample_rate,sample_fmt:format=duration,bit_rate',
         '-of', 'json', str(path)],
        capture_output=True, timeout=30,
    )
    if result.returncode != 0:
        raise TranscodeError(
            f'ffprobe failed for {path}: '
            f'{result.stderr.decode("utf-8", errors="replace")[-400:]}'
        )
    data = json.loads(result.stdout)
    streams = data.get('streams') or []
    if not streams or not streams[0].get('sample_rate'):
        raise TranscodeError(f'ffprobe found no audio stream in {path}')
    fmt = data.get('format') or {}
    bit_rate = fmt.get('bit_rate')
    return {
        'sample_rate': int(streams[0]['sample_rate']),
        'sample_fmt': streams[0].get('sample_fmt') or '',
        'bitrate_kbps': int(bit_rate) // 1000 if bit_rate else 0,
        'duration_ms': int(round(float(fmt['duration']) * 1000)),
    }


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
    track, not let one bad file abort an entire sync.

    Source sample rate is clamped to _MAX_IPOD_SAMPLE_RATE when it exceeds
    it (see that constant's docstring for why); 44.1/48kHz sources are left
    exactly as before, untouched. Bit depth is always forced down to
    _TARGET_SAMPLE_FMT (16-bit) regardless of source, since click-wheel
    iPods only decode 24-bit ALAC via an unreliable on-device truncation
    (see that constant's docstring).
    """
    src_probe = probe_audio(src_path)
    cmd = [ffmpeg_executable(), '-y', '-i', str(src_path), '-c:a', 'alac', '-vn']
    if src_probe['sample_rate'] > _MAX_IPOD_SAMPLE_RATE:
        cmd += ['-ar', str(_MAX_IPOD_SAMPLE_RATE)]
    cmd += [
        # Forces 16-bit output with proper triangular dither applied
        # during the same conversion - a bare -sample_fmt would truncate
        # without dithering. dither_method=triangular_hp is a standard,
        # uncontroversial choice for a lossless-to-16-bit-lossless step.
        '-af', f'aresample=osf={_TARGET_SAMPLE_FMT}:dither_method=triangular_hp',
        # +faststart moves the moov atom to the front of the file, matching
        # what real iTunes produced for iPod-bound files. Confirmed via afinfo
        # every ffmpeg-transcoded file was "not optimized" (moov after mdat)
        # before this - a real (if lower-confidence than bit depth) source of
        # extra seek latency at track-open on the 5th Gen's mechanical HDD.
        '-movflags', '+faststart',
        # -f mp4 forced explicitly: ffmpeg otherwise sniffs the output
        # container from the destination filename's extension, and the
        # temp path used during a safe write (name.m4a.tmp) ends in
        # .tmp, not .m4a - without this it fails to find a muxer at all.
        '-f', 'mp4', str(dest_path),
    ]
    result = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if result.returncode != 0 or not Path(dest_path).exists():
        stderr_tail = result.stderr.decode('utf-8', errors='replace')[-800:]
        raise TranscodeError(f'ffmpeg failed for {src_path}: {stderr_tail}')

    # Defensive verification: a "successful" ffmpeg run (exit 0, file
    # exists) that still produced an out-of-range, wrong-bit-depth, or
    # truncated file would otherwise be written straight into the iTunesDB
    # with no error surfaced anywhere - exactly what let the un-clamped
    # sample rate go unnoticed before that fix, and the same class of bug
    # this bit-depth check exists to catch. Duration tolerance is generous
    # since ALAC framing can shift the reported length slightly from the
    # source.
    out_probe = probe_audio(dest_path)
    if out_probe['sample_rate'] > _MAX_IPOD_SAMPLE_RATE:
        raise TranscodeError(
            f'transcode of {src_path} produced {out_probe["sample_rate"]}Hz ALAC, '
            f'above the {_MAX_IPOD_SAMPLE_RATE}Hz iPod playback ceiling'
        )
    if not out_probe['sample_fmt'].startswith('s16'):
        raise TranscodeError(
            f'transcode of {src_path} produced {out_probe["sample_fmt"]!r} ALAC, '
            f'expected 16-bit ({_TARGET_SAMPLE_FMT})'
        )
    if out_probe['duration_ms'] <= 0 or (
        src_probe['duration_ms'] > 0
        and abs(out_probe['duration_ms'] - src_probe['duration_ms']) > 2000
    ):
        raise TranscodeError(
            f'transcode of {src_path} has implausible duration '
            f'({out_probe["duration_ms"]}ms vs source {src_probe["duration_ms"]}ms)'
        )


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
    dest = cache_dir / f'{h}_v{TRANSCODE_FORMAT_VERSION}.m4a'
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
