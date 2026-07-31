"""Binary iTunesDB serialization for TuneBridge.

Phase 2 concern: given a track/playlist list, produce valid iTunesDB
bytes. This is a from-scratch orchestrator, not a call into iOpenPod's
own `itunesdb_writer/mhbd_writer.py::write_mhbd()` — that function is
only importable together with the whole `iopenpod.device` package
(USB backends, write-safety guards, capability detection), which is
far more than this needs and was explicitly avoided when Phase 1
vendored only the parser. The *lower-level* per-chunk writers
(mhit_writer, mhyp_writer, mhla_writer, mhli_writer, mhod_writer,
mhsd_writer, mhlt_writer, mhlp_writer, mhip_writer) are clean of that
coupling — confirmed by import, same as the Phase 1 parser check —
so this module vendors and orchestrates those directly, faithfully
reproducing write_mhbd()'s logic with `capabilities` fixed at `None`
throughout (every capabilities-guarded branch in the original has a
`capabilities is None` fallback path; this module always takes it).

Nothing in this module talks to a mounted device — it only turns
in-memory track/playlist data into bytes. Device I/O (backup, atomic
write) lives in the /api/ipods/<id>/write* route layer, not here, so
this stays testable against a plain file path.
"""
from __future__ import annotations

import os
import random
import struct
import sys
import time
import zlib
from pathlib import Path

# In a PyInstaller bundle, __file__ doesn't point at a real path on disk for
# modules loaded from the frozen archive — _vendor must be found relative to
# sys._MEIPASS instead (same idiom as _BUNDLE_DIR in app.py).
_VENDOR_DIR = Path(sys._MEIPASS) / 'ipod' / '_vendor' if (getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS')) \
    else Path(__file__).parent / '_vendor'
if str(_VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(_VENDOR_DIR))

from iopenpod.itunesdb_shared.field_base import (  # noqa: E402
    read_fields,
    write_fields,
    write_generic_header,
)
from iopenpod.itunesdb_shared.mhbd_defs import MHBD_HEADER_SIZE  # noqa: E402
from iopenpod.itunesdb_writer.hash58 import write_hash58  # noqa: E402
from iopenpod.itunesdb_writer.mhit_writer import TrackInfo  # noqa: E402
from iopenpod.itunesdb_writer.mhla_writer import write_mhla  # noqa: E402
from iopenpod.itunesdb_writer.mhli_writer import write_mhli  # noqa: E402
from iopenpod.itunesdb_writer.mhlp_writer import (  # noqa: E402
    write_mhlp_smart,
    write_mhlp_with_playlists,
    write_mhlp_with_playlists_type3,
)
from iopenpod.itunesdb_writer.mhlt_writer import write_mhlt  # noqa: E402
from iopenpod.itunesdb_writer.mhsd_writer import (  # noqa: E402
    write_mhsd_empty_stub,
    write_mhsd_smart_type5,
    write_mhsd_type1,
    write_mhsd_type2,
    write_mhsd_type3,
    write_mhsd_type4,
    write_mhsd_type8,
)
from iopenpod.itunesdb_writer.mhyp_writer import (  # noqa: E402
    PlaylistInfo,
    generate_playlist_id,
)

from .checksum import ChecksumType, checksum_type_for  # noqa: E402
from .models import IpodPlaylist, IpodTrack  # noqa: E402

DATABASE_VERSION_DEFAULT = 0x4F

_WRITER_FILETYPE_EXTS = ('mp3', 'm4a', 'm4p', 'm4b', 'm4v', 'mp4', 'wav', 'aif', 'aiff', 'aac')


def _short_filetype_from_path(device_path: str) -> str:
    ext = device_path.rsplit('.', 1)[-1].lower() if '.' in device_path else 'm4a'
    return ext if ext in _WRITER_FILETYPE_EXTS else 'm4a'


def ipod_track_to_track_info(t: IpodTrack) -> TrackInfo:
    """The single conversion path from a parsed IpodTrack to the TrackInfo
    the writer needs — centralized here (not left as ad-hoc per-script
    code) specifically because an early ad-hoc version of this exact
    conversion silently dropped artwork_count/has_artwork/mhii_link/
    sound_check/filetype_desc/comment on a real, live device before
    that gap was caught. Every IpodTrack field that has a TrackInfo
    counterpart must be wired through here — see
    ipod/tests (or the Phase 2 field-diff check) for the fidelity net
    that should catch a future omission before any live write.
    """
    return TrackInfo(
        title=t.title or 'Untitled',
        location=(':' + t.device_path.replace('/', ':')) if t.device_path else ':iPod_Control:Music:F00:UNKNOWN.m4a',
        size=t.size_bytes, length=t.duration_ms,
        filetype=_short_filetype_from_path(t.device_path or ''),
        filetype_desc=t.filetype or None,
        bitrate=t.bitrate, sample_rate=t.sample_rate or 44100,
        artist=t.artist or None, album=t.album or None,
        album_artist=t.album_artist or None, genre=t.genre or None,
        composer=t.composer or None, comment=t.comment or None,
        year=t.year, track_number=t.track_number, total_tracks=t.total_tracks,
        disc_number=t.disc_number, total_discs=t.total_discs,
        rating=t.rating, play_count=t.play_count,
        date_added=t.date_added or 0, last_played=t.last_played,
        # Bug fix: this used to be t.track_id (the sequential 32-bit MHIT
        # slot position, offset 0x10), which build_itunesdb_bytes()
        # renumbers on every rewrite. Writing that back out as the
        # persistent 64-bit dbid (offset 0x70) silently replaced every
        # kept/existing track's real dbid with its current slot number on
        # every single sync - severing the dbid match ArtworkDB's MHII
        # songId field relies on to find a track's artwork (confirmed via
        # a live device: every existing track's on-disk db_track_id had
        # collapsed to equal its track_id, while the ArtworkDB entry its
        # own artwork_id_ref pointed to still carried the *original*,
        # correct 64-bit id in songId - a mismatch that breaks artwork
        # for any track surviving a second sync). t.track_id remains only
        # as a defensive fallback for a track parsed with db_track_id
        # unset (0), which should not happen for a normally-parsed record.
        db_track_id=t.db_track_id or t.track_id,
        artwork_count=t.artwork_count, mhii_link=t.mhii_link,
        sound_check=t.sound_check,
    )


def ipod_playlist_to_playlist_info(p: IpodPlaylist) -> PlaylistInfo:
    return PlaylistInfo(name=p.name, track_ids=list(p.track_ids))


# ── Small helpers ported from mhbd_writer.py (struct/zlib only, no
#    iopenpod.device dependency in their bodies — see module docstring) ──

def _maybe_decompress_cdb(itdb_data: bytes) -> bytes:
    hdr_len = struct.unpack('<I', itdb_data[4:8])[0]
    if (len(itdb_data) > hdr_len + 2
            and struct.unpack('<H', itdb_data[0xA8:0xAA])[0] == 1
            and itdb_data[hdr_len] == 0x78):
        try:
            decompressed = zlib.decompress(itdb_data[hdr_len:])
            return itdb_data[:hdr_len] + decompressed
        except zlib.error:
            pass
    return itdb_data


def extract_db_info(itdb_path: str) -> dict:
    """Reference fields (db_id, hashing_scheme, language, ...) to preserve
    across a rewrite. Same field_defs key names the parser uses."""
    with open(itdb_path, 'rb') as f:
        data = f.read(MHBD_HEADER_SIZE)
    if data[:4] != b'mhbd':
        raise ValueError(f'Not an iTunesDB file: {itdb_path}')
    header_length = struct.unpack_from('<I', data, 4)[0]
    return read_fields(data, 0, 'mhbd', header_length)


def extract_mhsd_types_and_order(itdb_data: bytes) -> tuple[set, list]:
    """Which MHSD dataset types the existing database uses, and in what
    order — needed so the rewritten file stays compatible with whatever
    this specific device's firmware already expects."""
    if len(itdb_data) < 24 or itdb_data[:4] != b'mhbd':
        return set(), []
    header_length = struct.unpack('<I', itdb_data[4:8])[0]
    itdb_data = _maybe_decompress_cdb(itdb_data)
    children_count = struct.unpack('<I', itdb_data[0x14:0x18])[0]

    types: set = set()
    order: list = []
    offset = header_length
    for _ in range(children_count):
        if offset + 16 > len(itdb_data):
            break
        if itdb_data[offset:offset + 4] != b'mhsd':
            break
        mhsd_total = struct.unpack('<I', itdb_data[offset + 8:offset + 12])[0]
        mhsd_type = struct.unpack('<I', itdb_data[offset + 12:offset + 16])[0]
        types.add(mhsd_type)
        order.append(mhsd_type)
        offset += mhsd_total
    return types, order


def extract_preserved_mhsd_blobs(itdb_data: bytes) -> list[bytes]:
    """Raw MHSD blobs for dataset types this writer doesn't generate
    (everything except 1/2/3/4/5/6/8/10) - e.g. type 9, an opaque
    iTunes/Genius blob observed on the real test device. Ported from
    mhbd_writer.py::extract_preserved_mhsd_blobs(); struct-only, no
    iopenpod.device dependency in the original body either.

    Appending these verbatim after the generated datasets is what
    closes the fidelity gap the Phase 2 round-trip proof flagged:
    without this, a rewrite silently drops whatever iTunes-generated
    data the device's firmware/companion app put there.
    """
    if len(itdb_data) < 24 or itdb_data[:4] != b'mhbd':
        return []
    header_length = struct.unpack('<I', itdb_data[4:8])[0]
    itdb_data = _maybe_decompress_cdb(itdb_data)
    children_count = struct.unpack('<I', itdb_data[0x14:0x18])[0]

    generated_types = {1, 2, 3, 4, 5, 6, 8, 10}
    blobs: list[bytes] = []
    offset = header_length
    for _ in range(children_count):
        if offset + 16 > len(itdb_data):
            break
        if itdb_data[offset:offset + 4] != b'mhsd':
            break
        mhsd_total = struct.unpack('<I', itdb_data[offset + 8:offset + 12])[0]
        mhsd_type = struct.unpack('<I', itdb_data[offset + 12:offset + 16])[0]
        if mhsd_type not in generated_types:
            blobs.append(bytes(itdb_data[offset:offset + mhsd_total]))
        offset += mhsd_total
    return blobs


def generate_database_id() -> int:
    return random.getrandbits(64)


def build_itunesdb_bytes(
    tracks: list[TrackInfo],
    playlists_type2: list[PlaylistInfo] | None = None,
    reference_info: dict | None = None,
    ref_types: set | None = None,
    ref_order: list | None = None,
    preserved_mhsd_blobs: list[bytes] | None = None,
    db_id: int | None = None,
    language: str = 'en',
    master_playlist_name: str = 'iPod',
    master_playlist_id: int | None = None,
) -> bytes:
    """Faithful, capabilities-free port of write_mhbd(). See module
    docstring for why this exists instead of importing the original."""
    if db_id is None:
        db_id = reference_info.get('db_id') if reference_info else None
        if db_id is None:
            db_id = generate_database_id()

    db_id_2 = (reference_info or {}).get('db_id_2') or random.getrandbits(64)

    # Album (type 4) and artist (type 8) index datasets, and per-track
    # album_id/artist_id/composer_id assignment — same order write_mhbd()
    # uses, since later datasets (tracks, playlists) reference these ids.
    global_id_start_index = 1
    mhla_data, album_map, last_id = write_mhla(tracks, starting_index_for_album_id=global_id_start_index)
    mhsd_type4 = write_mhsd_type4(mhla_data)

    mhli_data, artist_map, last_id = write_mhli(tracks, starting_index_for_artist_id=last_id + 1)
    mhsd_type8 = write_mhsd_type8(mhli_data)

    composer_map: dict = {}
    composer_id = last_id + 1
    for track in tracks:
        composer_name = track.composer or ''
        if not composer_name:
            continue
        key = composer_name.lower()
        if key not in composer_map:
            composer_map[key] = composer_id
            composer_id += 1
    last_id = composer_id - 1 if composer_map else last_id

    from iopenpod.itunesdb_shared.album_identity import album_identity_from_track
    for track in tracks:
        if not track.album_id:
            identity = album_identity_from_track(track)
            key = (identity.album or '', identity.album_artist or identity.artist or '')
            track.album_id = album_map.get(key, 0)
        if track.artist:
            track.artist_id = artist_map.get(track.artist.lower(), 0)
        if track.composer:
            track.composer_id = composer_map.get(track.composer.lower(), 0)

    ref_version = reference_info.get('version', 0) if reference_info else 0
    db_version = ref_version or DATABASE_VERSION_DEFAULT

    mhlt_data, next_track_id = write_mhlt(
        tracks, db_id_2=db_id_2, capabilities=None,
        db_version=db_version, start_track_id=last_id + 1,
    )
    mhsd_type1 = write_mhsd_type1(mhlt_data)
    track_ids = list(range(last_id + 1, next_track_id))

    # PlaylistInfo.track_ids carries db_track_id (stable 64-bit id);
    # MHIP entries need the sequential 32-bit track_id assigned above.
    db_track_id_to_track_id: dict = {}
    for i, track in enumerate(tracks):
        if track.db_track_id:
            db_track_id_to_track_id[track.db_track_id] = i + last_id + 1

    from dataclasses import replace as _dc_replace

    def _remap_playlist(pl: PlaylistInfo) -> PlaylistInfo:
        new_ids = [db_track_id_to_track_id[tid] for tid in pl.track_ids if tid in db_track_id_to_track_id]
        return _dc_replace(pl, track_ids=new_ids)

    remapped_playlists = [_remap_playlist(pl) for pl in (playlists_type2 or [])]
    if master_playlist_id is None:
        master_playlist_id = generate_playlist_id()
    mhsd_type2_data = write_mhlp_with_playlists(
        track_ids, playlists=remapped_playlists, tracks=tracks,
        db_id_2=db_id_2, capabilities=None,
        master_playlist_name=master_playlist_name,
        master_playlist_id=master_playlist_id,
    )
    mhsd_type2 = write_mhsd_type2(mhsd_type2_data)

    # Type 3 (podcast-list mirror): no explicit podcast list is supported
    # yet, so — matching write_mhbd()'s own default fallback — clone the
    # same user playlists from type 2 into type 3. This is what closes
    # the fidelity gap the first round-trip proof found: the real test
    # device's file had a type-3 dataset and a rewrite that omitted it
    # entirely was a structural difference from the original, even
    # though no distinct podcast data was actually being lost.
    track_album_map: dict = {}
    for i, track in enumerate(tracks):
        track_album_map[i + last_id + 1] = track.album or ''
    mhsd_type3_data = write_mhlp_with_playlists_type3(
        track_ids, playlists=remapped_playlists, db_id_2=db_id_2,
        track_album_map=track_album_map, tracks=tracks, capabilities=None,
        master_playlist_name=master_playlist_name,
        next_mhip_id_start=next_track_id,
        master_playlist_id=generate_playlist_id(),
    )
    mhsd_type3 = write_mhsd_type3(mhsd_type3_data)

    mhsd_type5 = write_mhsd_smart_type5(write_mhlp_smart([], db_id_2=db_id_2))
    mhsd_type6 = write_mhsd_empty_stub(6)
    mhsd_type10 = write_mhsd_empty_stub(10)

    type_to_data = {
        1: mhsd_type1, 2: mhsd_type2, 3: mhsd_type3, 4: mhsd_type4,
        5: mhsd_type5, 6: mhsd_type6, 8: mhsd_type8, 10: mhsd_type10,
    }

    # Preserve the reference database's dataset order/selection where we
    # can, otherwise fall back to the libgpod-compatible default order.
    dataset_entries: list[tuple[int, bytes]] = []
    if ref_order:
        seen = set()
        for dtype in ref_order:
            if dtype in type_to_data and dtype not in seen and type_to_data[dtype]:
                dataset_entries.append((dtype, type_to_data[dtype]))
                seen.add(dtype)
        for dtype in (1, 3, 2, 4):
            if dtype not in seen:
                dataset_entries.append((dtype, type_to_data[dtype]))
    else:
        for dtype in (1, 3, 2, 4, 8, 6, 10, 5):
            if type_to_data.get(dtype):
                dataset_entries.append((dtype, type_to_data[dtype]))

    all_datasets = b''.join(data for _, data in dataset_entries)
    child_count = len(dataset_entries)

    # Append preserved opaque blobs (e.g. type 9) verbatim, after the
    # datasets we generate ourselves — same placement write_mhbd() uses.
    for blob in (preserved_mhsd_blobs or []):
        all_datasets += blob
        child_count += 1

    total_length = MHBD_HEADER_SIZE + len(all_datasets)

    unk0x32 = b'\x00' * 20
    if reference_info and isinstance(reference_info.get('unk0x32'), (bytes, bytearray)) and len(reference_info['unk0x32']) == 20:
        unk0x32 = bytes(reference_info['unk0x32'])

    lang_val = (reference_info.get('language') if reference_info else None) or language
    if isinstance(lang_val, str):
        lang_val = lang_val.encode('utf-8')[:2].ljust(2, b'\x00')

    lib_pid = (reference_info or {}).get('db_persistent_id') or db_id
    tz_offset = (reference_info or {}).get('timezone_offset')
    if tz_offset is None:
        tz_offset = -time.altzone if time.daylight else -time.timezone
    hash_type_ind = (reference_info or {}).get('hash_type_indicator', 0)
    platform_flag = (reference_info or {}).get('platform', 2)
    if platform_flag not in (1, 2):
        platform_flag = 2

    header = bytearray(MHBD_HEADER_SIZE)
    write_generic_header(header, 0, b'mhbd', MHBD_HEADER_SIZE, total_length)
    values = {
        'compressed': 1,
        'version': db_version,
        'child_count': child_count,
        'db_id': db_id,
        'platform': platform_flag,
        'unk0x22': (reference_info or {}).get('unk0x22', 611),
        'db_id_2': db_id_2,
        'unk0x2c': 0,
        'hashing_scheme': 0,  # patched by apply_checksum() below, if needed
        'unk0x32': unk0x32,
        'language': lang_val,
        'db_persistent_id': lib_pid,
        'unk0x50': (reference_info or {}).get('unk0x50', 1),
        'unk0x54': (reference_info or {}).get('unk0x54', 15),
        'timezone_offset': tz_offset,
        'hash_type_indicator': hash_type_ind,
    }
    if reference_info:
        for key in ('audio_language', 'subtitle_language', 'unk0xa4', 'unk0xa6', 'cdb_flag'):
            if key in reference_info:
                values[key] = reference_info[key]
    write_fields(header, 0, 'mhbd', values, MHBD_HEADER_SIZE)

    return bytes(header) + all_datasets


def backup_itunesdb(itdb_path: str, backup_dir: Path) -> Path:
    """Copy the current on-device iTunesDB to local disk (not back onto the
    device - if a write corrupts the device's filesystem, a same-device
    backup could be corrupted too) before any write is attempted.

    Non-negotiable per the plan's Phase 2 requirement: a bad on-device
    write has far higher blast radius than the existing file-copy DAP
    sync, so this must happen before build_itunesdb_bytes() output is
    ever written to a mounted device - not added as later polish.

    Returns the backup file path. Caller is responsible for recording it
    in the ipod_itunesdb_backups table (kept out of this module so it
    stays free of any app.py/db.py import, consistent with the rest of
    ipod/).
    """
    backup_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime('%Y%m%dT%H%M%S')
    dest = backup_dir / f'{ts}_iTunesDB.bak'
    with open(itdb_path, 'rb') as src, open(dest, 'wb') as out:
        out.write(src.read())
    return dest


def write_ipod_itunesdb_atomic(itdb_path: str, itdb_bytes: bytes) -> None:
    """Replace the on-device iTunesDB without ever leaving it truncated.

    Writes to a temp file in the SAME directory (cross-filesystem
    os.replace() isn't atomic - a temp file in TuneBridge's own local
    temp dir would defeat the purpose), fsyncs it, then os.replace()s
    it onto the real path. If anything is interrupted before the
    replace - unplugged mid-write, app crash, power loss - the
    original iTunesDB is untouched and only an orphaned temp file is
    left behind, instead of a half-written, unreadable database.

    Call backup_itunesdb() before this, not after - the whole point is
    a known-good copy exists before the real file is touched at all.
    """
    itdb_path = Path(itdb_path)
    tmp_path = itdb_path.with_name(f'.{itdb_path.name}.tunebridge-tmp')
    try:
        with open(tmp_path, 'wb') as f:
            f.write(itdb_bytes)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, itdb_path)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise


def apply_checksum(itdb_bytes: bytes, hashing_scheme: int, firewire_id: bytes | None) -> bytes:
    """Apply the device's required checksum, if any. NONE (pre-2007
    iPods, hashing_scheme=0) needs no action - the majority of what
    Phase 0/1 validated against real hardware falls in this bucket."""
    scheme = checksum_type_for(hashing_scheme)
    if scheme == ChecksumType.NONE:
        return itdb_bytes
    if scheme == ChecksumType.HASH58:
        if not firewire_id:
            raise ValueError('HASH58 requires a firewire_id and none was provided')
        data = bytearray(itdb_bytes)
        write_hash58(data, firewire_id)
        return bytes(data)
    raise NotImplementedError(f'Checksum scheme {scheme.name} is not implemented yet (out of scope for this device generation)')
