"""ArtworkDB read/write orchestration for click-wheel iPods (Phase 4).

Mirrors ipod/itunesdb_writer.py's approach: vendors and orchestrates the
lower-level per-chunk pieces directly (see _vendor/NOTICE.md's "Phase 4"
section for exactly what's vendored and why), rather than importing
iOpenPod's own higher-level artwork_writer.py — that module does much
more than TuneBridge needs (ThreadPoolExecutor batch processing across
a whole library, podcast artwork grouping) and isn't cleanly separated
from iopenpod.device.

Nothing in this module talks to a mounted device beyond the .ithmb
files it appends to directly (there's no atomic-replace equivalent for
"append a new image to a 500MB file" the way there is for a single
binary blob) - the ArtworkDB file itself is backed up and written with
the same backup_itunesdb()/write_ipod_itunesdb_atomic() helpers already
used for iTunesDB, reused here since both just take a path and bytes.
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

# In a PyInstaller bundle, __file__ doesn't point at a real path on disk for
# modules loaded from the frozen archive — _vendor must be found relative to
# sys._MEIPASS instead (same idiom as _BUNDLE_DIR in app.py).
_VENDOR_DIR = Path(sys._MEIPASS) / 'ipod' / '_vendor' if (getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS')) \
    else Path(__file__).parent / '_vendor'
if str(_VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(_VENDOR_DIR))

from iopenpod.artworkdb_shared.binary import read_chunk_header, read_u16, read_u32  # noqa: E402
from iopenpod.artworkdb_shared.constants import ArtworkDatasetType  # noqa: E402
from iopenpod.artworkdb_shared.ithmb_paths import ithmb_filename  # noqa: E402
from iopenpod.artworkdb_writer.art_extractor import art_hash, extract_art_with_folder  # noqa: E402
from iopenpod.artworkdb_writer.artwork_types import (  # noqa: E402
    ArtworkEntry, IthmbLocation, PassthroughFormatRef,
)
from iopenpod.artworkdb_writer.artworkdb_chunks import build_artworkdb, read_existing_artwork  # noqa: E402
from iopenpod.artworkdb_writer.ithmb_codecs import encode_image_for_format  # noqa: E402
from iopenpod.artworkdb_writer.rgb565 import image_from_bytes  # noqa: E402
from iopenpod.device import ArtworkFormat, capabilities_for_family_gen  # noqa: E402

extract_art = extract_art_with_folder
art_content_hash = art_hash


def cover_art_formats_for_device(device_class: str) -> dict[int, ArtworkFormat]:
    """`device_class` is 'family|generation' (e.g. 'iPod|5th Gen'), the
    format ipods.device_class is stored in - see app.py's Add/Edit iPod
    model dropdown. Returns {} if unknown or the model has no ArtworkDB
    (in which case callers should skip artwork entirely, same as a
    device with no embedded art)."""
    family, _, generation = (device_class or '').partition('|')
    if not family:
        return {}
    caps = capabilities_for_family_gen(family, generation)
    if not caps or not caps.supports_artwork:
        return {}
    return {fmt.format_id: fmt for fmt in caps.cover_art_formats}


def read_artworkdb_reference(artworkdb_path) -> dict:
    """Reference fields to preserve across a rewrite - same role as
    itunesdb_writer.extract_db_info() for iTunesDB."""
    p = Path(artworkdb_path)
    if not p.exists():
        return {'next_mhii_id': 1, 'reference_mhfd': None, 'existing_format_ids': []}
    data = p.read_bytes()
    if len(data) < 32 or data[:4] != b'mhfd':
        return {'next_mhii_id': 1, 'reference_mhfd': None, 'existing_format_ids': []}
    header_size = struct.unpack_from('<I', data, 4)[0]
    next_mhii_id = struct.unpack_from('<I', data, 28)[0]
    return {
        'next_mhii_id': max(1, next_mhii_id),
        'reference_mhfd': bytes(data[:header_size]),
        'existing_format_ids': _extract_format_ids_and_sizes(data),
    }


def _extract_format_ids_and_sizes(data: bytes) -> dict[int, int]:
    """Format id -> stored image size, read from the existing MHLF/MHIF
    file-list dataset. Used so a rewrite preserves the size entry for any
    format this run doesn't touch (e.g. a Photos-app format we don't
    generate) instead of silently dropping it from the file list -
    mirrors iopenpod.artworkdb_shared.mhlf.extract_format_ids(), which
    reads format_id but not size.
    """
    if len(data) < 32 or data[:4] != b'mhfd':
        return {}
    result: dict[int, int] = {}
    mhfd_header = read_chunk_header(data, 0)
    child_count = read_u32(data, 20)
    offset = mhfd_header.header_size
    for _ in range(child_count):
        if offset + 14 > len(data) or data[offset:offset + 4] != b'mhsd':
            break
        mhsd_header = read_chunk_header(data, offset)
        mhsd_total = mhsd_header.length_or_count
        ds_type = read_u16(data, offset + 12)
        if offset + mhsd_total > len(data):
            break
        if ds_type == ArtworkDatasetType.FILE_LIST:
            dataset_end = offset + mhsd_total
            mhlf_offset = offset + mhsd_header.header_size
            if mhlf_offset + 12 <= dataset_end and data[mhlf_offset:mhlf_offset + 4] == b'mhlf':
                mhlf_header = read_chunk_header(data, mhlf_offset)
                mhif_count = mhlf_header.length_or_count
                mhif_offset = mhlf_offset + mhlf_header.header_size
                for _ in range(mhif_count):
                    if mhif_offset + 24 > dataset_end or data[mhif_offset:mhif_offset + 4] != b'mhif':
                        break
                    mhif_size = read_u32(data, mhif_offset + 4)
                    if mhif_size < 24 or mhif_offset + mhif_size > dataset_end:
                        break
                    fmt_id = read_u32(data, mhif_offset + 16)
                    img_size = read_u32(data, mhif_offset + 20)
                    result[fmt_id] = img_size
                    mhif_offset += mhif_size
        offset += mhsd_total
    return result


def _append_ithmb_bytes(path: Path, data: bytes) -> int:
    """Appends to (or creates) an .ithmb file. Returns the byte offset the
    new data starts at. Never truncates or rewrites existing bytes -
    an interrupted append leaves prior entries' offsets valid and only
    risks a harmless trailing partial write that nothing references yet
    (the ArtworkDB itself, which is what actually points at these
    offsets, isn't written until every append in this batch succeeds).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    offset = path.stat().st_size if path.exists() else 0
    with open(path, 'ab') as f:
        f.write(data)
    return offset


def build_artwork_update(
    artworkdb_path,
    artwork_dir,
    format_defs: dict[int, ArtworkFormat],
    new_art_by_db_track_id: dict[int, bytes],
) -> tuple[bytes, dict[int, int]]:
    """Builds updated ArtworkDB bytes: all existing entries preserved
    byte-for-byte via passthrough (no re-encoding, no ithmb data moved),
    plus one new MHII entry *per track* in `new_art_by_db_track_id` - even
    when many tracks share pixel-identical art (the common case: every
    track on an album usually carries the same embedded cover, and the
    iPod sync's artwork step now also prefers one shared per-album cache
    file, making identical bytes across many tracks routine rather than
    incidental). Each MHII's own db_track_id must match the track that
    actually uses it: wikiPodLinux documents this field as what the
    firmware's "Now Playing" screen joins art to, and it was confirmed
    empirically against a real iPod Classic 5th Gen this session - tracks
    sharing a *single* deduplicated MHII (one image, one fixed
    db_track_id, N tracks pointed at it via their own mhii_link) showed
    correct, byte-valid artwork data on every check *except* actual
    on-device "Now Playing" rendering, which stayed blank for every track
    other than whichever one happened to own that MHII's db_track_id.
    Real iTunes-written libraries follow the same one-MHII-per-track
    shape, so this isn't a scale concern - Only the underlying pixel
    bytes/ithmb storage are deduplicated by content hash (within this
    batch only - see module docstring in the caller for why cross-batch
    dedup against the full existing library isn't attempted); the MHII
    metadata entries themselves are not.

    Returns (new_artworkdb_bytes, {db_track_id: img_id}) - the mapping
    is what the caller wires into each new track's TrackInfo.mhii_link.
    Does not write anything to `artworkdb_path` itself; does append new
    pixel data directly to the relevant .ithmb files under `artwork_dir`.
    """
    artworkdb_path = Path(artworkdb_path)
    artwork_dir = Path(artwork_dir)
    ref = read_artworkdb_reference(artworkdb_path)

    existing = read_existing_artwork(str(artworkdb_path), str(artwork_dir)) if artworkdb_path.exists() else {}

    entries: list[ArtworkEntry] = []
    format_locations_map: dict[int, dict[int, IthmbLocation]] = {}

    for img_id, rec in existing.items():
        formats = {}
        locations = {}
        for fmt_id, existing_ref in rec['formats'].items():
            formats[fmt_id] = PassthroughFormatRef.from_existing_ref(existing_ref)
            locations[fmt_id] = IthmbLocation(
                existing_ref.ithmb_filename or ithmb_filename(fmt_id),
                existing_ref.ithmb_offset,
            )
        entries.append(ArtworkEntry(
            img_id=img_id, db_track_id=rec['song_id'], art_hash=None,
            src_img_size=rec['src_img_size'], formats=formats,
        ))
        format_locations_map[img_id] = locations

    # hash -> (formats, locations, src_img_size) for the *pixel storage*
    # only - reused across tracks so identical art is never re-encoded or
    # re-appended to the .ithmb files twice. Deliberately NOT a hash ->
    # img_id map: every track still gets its own MHII entry/img_id (see
    # docstring above for why one shared entry breaks Now Playing art for
    # every track except its one recorded owner).
    hash_to_payload: dict[str, tuple[dict[int, object], dict[int, IthmbLocation], int]] = {}
    db_track_id_to_img_id: dict[int, int] = {}
    next_img_id = ref['next_mhii_id']

    ithmb_paths = {fmt_id: (artwork_dir / ithmb_filename(fmt_id)) for fmt_id in format_defs}

    for db_track_id, art_bytes in new_art_by_db_track_id.items():
        if not art_bytes:
            continue
        h = art_hash(art_bytes)
        cached = hash_to_payload.get(h)
        if cached is None:
            img = image_from_bytes(art_bytes)
            if img is None:
                continue
            formats = {}
            locations = {}
            for fmt_id, fmt in format_defs.items():
                payload = encode_image_for_format(img, fmt_id, fmt_override=fmt)
                offset = _append_ithmb_bytes(ithmb_paths[fmt_id], payload.data)
                formats[fmt_id] = payload
                locations[fmt_id] = IthmbLocation(ithmb_paths[fmt_id].name, offset)
            cached = (formats, locations, len(art_bytes))
            hash_to_payload[h] = cached

        formats, locations, src_img_size = cached
        img_id = next_img_id
        next_img_id += 1
        db_track_id_to_img_id[db_track_id] = img_id

        # A fresh ArtworkEntry per track (own img_id, own db_track_id) even
        # though `formats`/`locations` - and thus the actual pixel bytes on
        # disk - are shared/reused verbatim across every track with this
        # same hash. `formats` holds the already-encoded payload objects
        # from the first track that hit this hash; passing the identical
        # objects again here is intentional (no data is copied or
        # re-appended) - only the MHII metadata differs per entry.
        entries.append(ArtworkEntry(
            img_id=img_id, db_track_id=db_track_id, art_hash=h,
            src_img_size=src_img_size, formats=formats,
        ))
        format_locations_map[img_id] = locations

    image_sizes = dict(ref['existing_format_ids'])
    for fmt_id, fmt in format_defs.items():
        image_sizes[fmt_id] = fmt.row_bytes * fmt.height
    format_ids = sorted(image_sizes.keys())

    new_bytes = build_artworkdb(
        entries=entries,
        format_locations_map=format_locations_map,
        format_ids=format_ids,
        image_sizes=image_sizes,
        next_mhii_id=next_img_id,
        reference_mhfd=ref['reference_mhfd'],
    )
    return new_bytes, db_track_id_to_img_id
