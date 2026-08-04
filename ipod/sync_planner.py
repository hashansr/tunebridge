"""Diff planner: TuneBridge's local library/playlists vs the last-scanned
state of an iPod's on-device library.

Read-only — computes what a sync *would* do, doesn't do anything.

Two matching mechanisms, tried in order:
  1. A persistent (ipod_id, local_track_id) -> device_track_id mapping
     (ipod_sync_manifest, loaded by the caller and passed in as
     `ipod_manifest`). This is keyed on IpodTrack.db_track_id (the MHIT's
     persistent 64-bit id), NOT the cached ipod_tracks.device_track_id
     column, which is the sequential slot position and gets reassigned on
     every iTunesDB rebuild — see ipod/models.py::IpodTrack for why the
     distinction matters. This is what lets a local track that's already on
     the device get flagged for a tag *update* rather than either being
     silently skipped forever or duplicated as a new add.
  2. Falling back to (title, artist, album), case/whitespace-normalized —
     the same fuzzy key TuneBridge's own duplicate-track detection already
     uses (see CLAUDE.md's Organizer/duplicate-detection notes) — for local
     tracks with no manifest entry yet (reconciling pre-existing/legacy
     device content). A match here doesn't get flagged as an update (no
     baseline fingerprint exists to compare against); the caller backfills
     the manifest for it instead, via `tracks_matched_unlinked`, so the
     *next* sync can detect drift for it too.
  3. If (2) fails, a SECOND fallback: the same fields with any "feat./ft./
     featuring ..." annotation stripped out of title and artist first, only
     accepted when it identifies exactly one device track (never on an
     ambiguous tie). This exists because local tag-cleanup tools (e.g.
     TuneBridge's own artist-grouping normalization) commonly move a
     featured-artist credit out of `artist`/`title` and into `album_artist`,
     or reformat its punctuation — while a device synced before that cleanup
     still carries the old, credit-inclusive form. Without this, every track
     on an album full of "feat." credits (verified against a real device:
     an entire 17-track album) permanently fails to link via (2), so it can
     never be detected as "already on device, tags changed" — it just looks
     new forever, risking a duplicate add instead of an update.
"""
from __future__ import annotations

import re

_FEAT_RE = re.compile(r'[\(\[]?\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]*[\)\]]?', re.IGNORECASE)


def match_key(title: str, artist: str, album: str) -> tuple:
    return (
        (title or '').strip().lower(),
        (artist or '').strip().lower(),
        (album or '').strip().lower(),
    )


def _strip_feat_credit(s: str) -> str:
    out = _FEAT_RE.sub('', s or '')
    return re.sub(r'\s+', ' ', out).strip().lower()


def _feat_stripped_match_key(title: str, artist: str, album: str) -> tuple:
    return (_strip_feat_credit(title), _strip_feat_credit(artist), (album or '').strip().lower())


def compute_sync_plan(
    local_tracks: list,
    local_playlists: list,
    ipod_tracks: list,
    ipod_playlists: list,
    ipod_manifest: dict | None = None,
    local_fingerprints: dict | None = None,
) -> dict:
    """
    local_tracks: rows from TuneBridge's `tracks` table (dicts with at
        least id/title/artist/album/path)
    local_playlists: list of {id, name, track_ids: [local track id, ...]}
        (playlist_tracks joined in by the caller)
    ipod_tracks: rows from db_load_ipod_tracks() (device_track_id/db_track_id/
        title/artist/album/...)
    ipod_playlists: rows from db_load_ipod_playlists() (device_playlist_id/
        name/is_master/track_order/...)
    ipod_manifest: dict[local_track_id] -> {device_track_id, local_hash, ...}
        from db_load_ipod_sync_manifest(), or None/{} if not available.
    local_fingerprints: dict[local_track_id] -> tag fingerprint string
        (same fingerprint scheme the caller records into the manifest), or
        None/{} to skip update-detection entirely (behaves like the
        manifest wasn't provided).

    Returns:
        {
          'tracks_to_add': [local track dict, ...],          # not on device yet
          'tracks_to_update': [{'local_track': dict, 'device_track_id': int,
                                 'local_track_id': str}, ...], # on device, tags drifted
          'tracks_matched_unlinked': [{'local_track': dict, 'device_track_id': int,
                                        'local_track_id': str}, ...],
              # matched only via the fuzzy key, no manifest entry yet — caller
              # should backfill ipod_sync_manifest for these so future syncs
              # can detect drift without relying on the fuzzy key again.
          'tracks_already_on_device': int,
          'playlists_to_create': [local playlist dict, ...], # no matching device playlist by name
          'playlists_to_update': [{'playlist': local playlist dict,
                                    'missing_track_ids': [...]}, ...],
          'playlists_already_synced': int,
        }
    """
    ipod_manifest = ipod_manifest or {}
    local_fingerprints = local_fingerprints or {}

    device_track_keys = {
        match_key(t.get('title'), t.get('artist'), t.get('album'))
        for t in ipod_tracks
    }
    # Last-write-wins on a duplicate key is fine here — same tolerance the
    # existing device_track_id_to_key lookup below already has.
    device_track_by_key = {
        match_key(t.get('title'), t.get('artist'), t.get('album')): t
        for t in ipod_tracks
    }
    device_row_by_db_id = {
        int(t['db_track_id']): t
        for t in ipod_tracks if t.get('db_track_id')
    }

    # Fallback index for the feat.-stripped match (mechanism 3, see module
    # docstring). Grouped rather than last-write-wins: a normalized key that
    # collapses two DISTINCT device tracks together (e.g. a "Song" and a
    # separate "Song (feat. X)" that happen to share everything else) must
    # never be treated as a match — that would silently link the wrong
    # track. Only keys with exactly one device row are usable.
    _feat_groups: dict[tuple, list] = {}
    for t in ipod_tracks:
        nk = _feat_stripped_match_key(t.get('title'), t.get('artist'), t.get('album'))
        _feat_groups.setdefault(nk, []).append(t)
    device_track_by_feat_stripped_key = {
        nk: rows[0] for nk, rows in _feat_groups.items() if len(rows) == 1
    }

    tracks_to_add = []
    tracks_to_update = []
    tracks_matched_unlinked = []
    local_key_to_id = {}
    for t in local_tracks:
        key = match_key(t.get('title'), t.get('artist'), t.get('album'))
        local_key_to_id[t['id']] = key

        manifest_entry = ipod_manifest.get(t['id'])
        linked_device_row = None
        if manifest_entry and manifest_entry.get('device_track_id'):
            linked_device_row = device_row_by_db_id.get(int(manifest_entry['device_track_id']))

        if linked_device_row is not None:
            # Already linked to a device track that's still present. Compare
            # the current local tags fingerprint against what was recorded
            # at last add/update time; a mismatch means an update is needed.
            current_fp = local_fingerprints.get(t['id']) or ''
            last_fp = manifest_entry.get('local_hash') or ''
            if current_fp and last_fp and current_fp != last_fp:
                tracks_to_update.append({
                    'local_track': t,
                    'device_track_id': int(manifest_entry['device_track_id']),
                    'local_track_id': t['id'],
                })
            continue  # matched (updated or unchanged) — not a new add

        device_row = device_track_by_key.get(key) if key in device_track_keys else None
        if device_row is None:
            # Exact key missed — try the feat.-stripped fallback before
            # concluding this is genuinely new (mechanism 3, see module
            # docstring). Only accepted when unambiguous.
            nk = _feat_stripped_match_key(t.get('title'), t.get('artist'), t.get('album'))
            device_row = device_track_by_feat_stripped_key.get(nk)

        if device_row is None:
            tracks_to_add.append(t)
        else:
            # Matched only by fuzzy key — no persistent link yet (legacy
            # content, or a device that predates ipod_sync_manifest). Not an
            # add and not flagged for update (no baseline to diff against),
            # but worth backfilling so future syncs get real drift detection.
            if device_row.get('db_track_id'):
                tracks_matched_unlinked.append({
                    'local_track': t,
                    'device_track_id': int(device_row['db_track_id']),
                    'local_track_id': t['id'],
                })

    device_playlists_by_name = {
        (p.get('name') or '').strip(): p
        for p in ipod_playlists if not p.get('is_master')
    }
    # Device-side playlist track membership, by match-key (not raw device
    # track id — those get reassigned on every write, so they're not a
    # stable membership test across a rescan).
    device_track_id_to_key = {
        t.get('device_track_id'): match_key(t.get('title'), t.get('artist'), t.get('album'))
        for t in ipod_tracks
    }

    playlists_to_create = []
    playlists_to_update = []
    already_synced = 0

    for pl in local_playlists:
        device_pl = device_playlists_by_name.get((pl.get('name') or '').strip())
        local_keys = {local_key_to_id.get(tid) for tid in pl.get('track_ids', []) if tid in local_key_to_id}
        local_keys.discard(None)

        if device_pl is None:
            playlists_to_create.append(pl)
            continue

        device_keys = {
            device_track_id_to_key.get(dtid)
            for dtid in (device_pl.get('track_order') or [])
        }
        device_keys.discard(None)

        missing_keys = local_keys - device_keys
        if not missing_keys:
            already_synced += 1
            continue

        missing_track_ids = [
            tid for tid in pl.get('track_ids', [])
            if local_key_to_id.get(tid) in missing_keys
        ]
        playlists_to_update.append({'playlist': pl, 'missing_track_ids': missing_track_ids})

    return {
        'tracks_to_add': tracks_to_add,
        'tracks_to_update': tracks_to_update,
        'tracks_matched_unlinked': tracks_matched_unlinked,
        'tracks_already_on_device': len(local_tracks) - len(tracks_to_add),
        'playlists_to_create': playlists_to_create,
        'playlists_to_update': playlists_to_update,
        'playlists_already_synced': already_synced,
    }
