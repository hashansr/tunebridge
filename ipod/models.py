"""Clean, TuneBridge-native shapes for click-wheel iPod data.

Decouples the rest of the app from the vendored parser's raw mhit/mhod/
mhip dicts (see ipod/_vendor/) — only ipod/itunesdb_reader.py should
ever touch that raw shape; everything else works with these.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class IpodTrack:
    track_id: int
    # The MHIT chunk's own persistent 64-bit id (raw field name:
    # db_track_id, offset 0x70) - NOT the same value as track_id above,
    # which is the sequential 32-bit slot position (offset 0x10) and is
    # reassigned every time build_itunesdb_bytes() renumbers tracks.
    # wikiPodLinux documents this 64-bit id as the value that "joins an
    # iTunesDB mhit with an ArtworkDB mhii" (ArtworkDB's MHII songId
    # field) - losing it on every round-trip silently breaks the
    # artwork link for any track that survives a second sync, even
    # though artwork_id_ref/mhii_link (below) still round-trips fine.
    # Defaults to 0 only for callers that construct an IpodTrack without
    # having parsed a real device record (there is no legitimate 0 value
    # once parsed - see ipod/itunesdb_reader.py::_build_track()).
    db_track_id: int = 0
    title: str = ''
    artist: str = ''
    album: str = ''
    album_artist: str = ''
    genre: str = ''
    composer: str = ''
    device_path: str = ''          # normalized, e.g. iPod_Control/Music/F39/YBLR.m4a
    size_bytes: int = 0
    duration_ms: int = 0
    bitrate: int = 0
    sample_rate: int = 0
    track_number: int = 0
    total_tracks: int = 0
    disc_number: int = 0
    total_discs: int = 0
    year: int = 0
    rating: int = 0
    play_count: int = 0
    date_added: int = 0            # unix timestamp
    last_played: int = 0           # unix timestamp
    filetype: str = ''             # e.g. "Apple Lossless audio file"
    comment: str = ''
    # Artwork/volume fields — small in count but near-universal on real
    # libraries (confirmed 3,251/3,286 and 3,286/3,286 respectively on the
    # Phase 2 test device). A round-trip that silently zeroes these is a
    # real regression (lost art linkage, lost volume normalization), not
    # cosmetic — found only by inspecting the live device after a write,
    # not by the narrower title/count round-trip checks that came first.
    artwork_count: int = 0
    has_artwork: int = 0
    mhii_link: int = 0              # raw field name: artwork_id_ref
    sound_check: int = 0            # ReplayGain-derived volume normalization value


@dataclass
class IpodPlaylist:
    playlist_id: int
    name: str = ''
    is_master: bool = False
    track_ids: list = field(default_factory=list)   # ordered list[int], joins to IpodTrack.track_id

    @property
    def track_count(self) -> int:
        return len(self.track_ids)


@dataclass
class IpodDeviceInfo:
    db_id: int = 0
    itunesdb_version: int = 0
    hashing_scheme: int = 0        # raw mhbd value; see checksum.ChecksumType for meaning
    language: str = ''
    track_count: int = 0
    playlist_count: int = 0
