"""High-level, read-only iTunesDB access for TuneBridge.

Wraps the vendored parser (ipod/_vendor/iopenpod/itunesdb_parser) and
converts its raw mhbd/mhsd/mhlt/mhit/mhlp/mhyp/mhip/mhod chunk-tree
dicts into the clean dataclasses in ipod/models.py. Nothing outside
this module should import from ipod._vendor.iopenpod directly.

Chunk tree shape (as returned by the vendored parser, confirmed
against a real, populated iTunesDB during Phase 1):
    lib                                          dict, mhbd fields at top level
      lib['children']                            list of mhsd sections
        mhsd['data']['dataset_type'] == 1         tracks section
          -> ['data']['children'][0]              the mhlt chunk
             -> ['data']                          list of mhit dicts (tracks)
                mhit['data']['children']          list of mhod dicts (string fields)
        mhsd['data']['dataset_type'] == 2         playlists section
          -> ['data']['children'][0]              the mhlp chunk
             -> ['data']                          list of mhyp dicts (playlists)
                mhyp['data']['mhod_children']     list of mhod dicts (name etc.)
                mhyp['data']['mhip_children']     list of mhip dicts (track refs)

Track/playlist string fields are keyed by MHOD_TYPE_* (see
ipod/_vendor/iopenpod/itunesdb_shared/constants.py) — TITLE=1,
LOCATION=2, ALBUM=3, ARTIST=4, GENRE=5, FILETYPE=6, COMPOSER=12,
ALBUM_ARTIST=22.

Date fields (date_added, last_played) and sample_rate_1 already come
back Unix-epoch / plain-Hz — the vendored parser applies those
transforms at parse time (see mhit_defs.py read_transform=), so no
conversion is needed here.
"""
from __future__ import annotations

import sys
from pathlib import Path

# In a PyInstaller bundle, __file__ doesn't point at a real path on disk for
# modules loaded from the frozen archive — _vendor must be found relative to
# sys._MEIPASS instead (same idiom as _BUNDLE_DIR in app.py).
_VENDOR_DIR = Path(sys._MEIPASS) / 'ipod' / '_vendor' if (getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS')) \
    else Path(__file__).parent / '_vendor'
if str(_VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(_VENDOR_DIR))

from iopenpod.itunesdb_parser import parse_itunesdb  # noqa: E402

from .models import IpodDeviceInfo, IpodPlaylist, IpodTrack  # noqa: E402

MHOD_TITLE = 1
MHOD_LOCATION = 2
MHOD_ALBUM = 3
MHOD_ARTIST = 4
MHOD_GENRE = 5
MHOD_FILETYPE = 6
MHOD_COMMENT = 8
MHOD_COMPOSER = 12
MHOD_ALBUM_ARTIST = 22


def _mhit_strings(mhit_data: dict) -> dict:
    strings = {}
    for mhod in mhit_data.get('children', []) or []:
        d = mhod.get('data')
        if isinstance(d, dict) and d.get('string'):
            strings[d.get('mhod_type')] = d['string']
    return strings


def _device_path(raw_location: str) -> str:
    """':iPod_Control:Music:F39:YBLR.m4a' -> 'iPod_Control/Music/F39/YBLR.m4a'"""
    if not raw_location:
        return ''
    return raw_location.lstrip(':').replace(':', '/')


def _build_track(mhit: dict) -> IpodTrack | None:
    d = mhit.get('data')
    if not isinstance(d, dict):
        return None
    track_id = d.get('track_id')
    if track_id is None:
        return None
    strings = _mhit_strings(d)
    return IpodTrack(
        track_id=track_id,
        title=strings.get(MHOD_TITLE, ''),
        artist=strings.get(MHOD_ARTIST, ''),
        album=strings.get(MHOD_ALBUM, ''),
        album_artist=strings.get(MHOD_ALBUM_ARTIST, ''),
        genre=strings.get(MHOD_GENRE, ''),
        composer=strings.get(MHOD_COMPOSER, ''),
        device_path=_device_path(strings.get(MHOD_LOCATION, '')),
        size_bytes=d.get('size', 0) or 0,
        duration_ms=d.get('length', 0) or 0,
        bitrate=d.get('bitrate', 0) or 0,
        sample_rate=d.get('sample_rate_1', 0) or 0,
        track_number=d.get('track_number', 0) or 0,
        total_tracks=d.get('total_tracks', 0) or 0,
        disc_number=d.get('disc_number', 0) or 0,
        total_discs=d.get('total_discs', 0) or 0,
        year=d.get('year', 0) or 0,
        rating=d.get('rating', 0) or 0,
        play_count=d.get('play_count_1', 0) or 0,
        date_added=d.get('date_added', 0) or 0,
        last_played=d.get('last_played', 0) or 0,
        filetype=strings.get(MHOD_FILETYPE, ''),
        comment=strings.get(MHOD_COMMENT, ''),
        artwork_count=d.get('artwork_count', 0) or 0,
        has_artwork=d.get('has_artwork', 0) or 0,
        mhii_link=d.get('artwork_id_ref', 0) or 0,
        sound_check=d.get('sound_check', 0) or 0,
    )


def _build_playlist(mhyp: dict) -> IpodPlaylist | None:
    d = mhyp.get('data')
    if not isinstance(d, dict):
        return None
    name = ''
    for mhod in d.get('mhod_children', []) or []:
        md = mhod.get('data')
        if isinstance(md, dict) and md.get('mhod_type') == MHOD_TITLE and md.get('string'):
            name = md['string']
            break
    track_ids = []
    for mhip in d.get('mhip_children', []) or []:
        ipd = mhip.get('data')
        if isinstance(ipd, dict) and ipd.get('track_id') is not None:
            track_ids.append(ipd['track_id'])
    return IpodPlaylist(
        playlist_id=d.get('playlist_id', 0) or 0,
        name=name,
        is_master=bool(d.get('master_flag')),
        track_ids=track_ids,
    )


def parse_ipod_library(itunesdb_path: str) -> tuple[IpodDeviceInfo, list[IpodTrack], list[IpodPlaylist]]:
    """Parse a real, on-device iTunesDB file. Read-only — never writes.

    Raises whatever ipod._vendor.iopenpod.itunesdb_parser raises on a
    corrupt/unrecognized file (ITunesDBParseError and subclasses) —
    callers should catch and surface those, not swallow them here.
    """
    lib = parse_itunesdb(itunesdb_path)

    tracks: list[IpodTrack] = []
    playlists: list[IpodPlaylist] = []

    for section in lib.get('children', []) or []:
        sdata = section.get('data')
        if not isinstance(sdata, dict):
            continue
        dataset_type = sdata.get('dataset_type')

        if dataset_type == 1:  # tracks (mhlt)
            mhlt_children = sdata.get('children') or []
            if mhlt_children:
                for mhit in mhlt_children[0].get('data') or []:
                    track = _build_track(mhit)
                    if track is not None:
                        tracks.append(track)

        elif dataset_type == 2:  # playlists (mhlp)
            mhlp_children = sdata.get('children') or []
            if mhlp_children:
                for mhyp in mhlp_children[0].get('data') or []:
                    playlist = _build_playlist(mhyp)
                    if playlist is not None:
                        playlists.append(playlist)

    info = IpodDeviceInfo(
        db_id=lib.get('db_id', 0) or 0,
        itunesdb_version=lib.get('version', 0) or 0,
        hashing_scheme=lib.get('hashing_scheme', 0) or 0,
        language=(lib.get('language') or b'').decode('ascii', 'ignore') if isinstance(lib.get('language'), bytes) else (lib.get('language') or ''),
        track_count=len(tracks),
        playlist_count=len(playlists),
    )
    return info, tracks, playlists
