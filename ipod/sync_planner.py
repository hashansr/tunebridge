"""Diff planner: TuneBridge's local library/playlists vs the last-scanned
state of an iPod's on-device library.

Read-only — computes what a sync *would* do, doesn't do anything.
Matching is by (title, artist, album), case/whitespace-normalized —
the same fuzzy key TuneBridge's own duplicate-track detection already
uses (see CLAUDE.md's Organizer/duplicate-detection notes), reused
here rather than inventing a second convention. Device-side and
local-side records don't share an ID scheme (local `tracks.id` is an
MD5 of path; on-device track_id is reassigned on every iTunesDB
write), so a content-based key is the only thing that's actually
stable across both.
"""
from __future__ import annotations


def match_key(title: str, artist: str, album: str) -> tuple:
    return (
        (title or '').strip().lower(),
        (artist or '').strip().lower(),
        (album or '').strip().lower(),
    )


def compute_sync_plan(local_tracks: list, local_playlists: list, ipod_tracks: list, ipod_playlists: list) -> dict:
    """
    local_tracks: rows from TuneBridge's `tracks` table (dicts with at
        least id/title/artist/album/path)
    local_playlists: list of {id, name, track_ids: [local track id, ...]}
        (playlist_tracks joined in by the caller)
    ipod_tracks: rows from db_load_ipod_tracks() (device_track_id/title/
        artist/album/...)
    ipod_playlists: rows from db_load_ipod_playlists() (device_playlist_id/
        name/is_master/track_order/...)

    Returns:
        {
          'tracks_to_add': [local track dict, ...],          # not on device yet
          'tracks_already_on_device': int,
          'playlists_to_create': [local playlist dict, ...], # no matching device playlist by name
          'playlists_to_update': [{'playlist': local playlist dict,
                                    'missing_track_ids': [...]}, ...],
          'playlists_already_synced': int,
        }
    """
    device_track_keys = {
        match_key(t.get('title'), t.get('artist'), t.get('album'))
        for t in ipod_tracks
    }

    tracks_to_add = []
    local_key_to_id = {}
    for t in local_tracks:
        key = match_key(t.get('title'), t.get('artist'), t.get('album'))
        local_key_to_id[t['id']] = key
        if key not in device_track_keys:
            tracks_to_add.append(t)

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
        'tracks_already_on_device': len(local_tracks) - len(tracks_to_add),
        'playlists_to_create': playlists_to_create,
        'playlists_to_update': playlists_to_update,
        'playlists_already_synced': already_synced,
    }
