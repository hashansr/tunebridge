"""
TuneBridge JSON → SQLite migration.

Reads existing JSON files, populates SQLite database, verifies counts.
JSON files are never modified or deleted — they become static backups.
"""

import json
import time
from pathlib import Path

import db


def ensure_db(data_dir: Path) -> bool:
    """
    Ensure the SQLite database is ready.

    - If tunebridge.db exists with current schema: no-op.
    - If tunebridge.db does not exist: create schema, migrate from JSON.
    - On error: log and return False (caller can fall back to JSON).

    Returns True if database is ready.
    """
    db.init_db(data_dir)

    try:
        current_version = db.get_schema_version()
    except Exception:
        current_version = 0

    if current_version >= db.SCHEMA_VERSION:
        return True

    print(f"[migrate] Database schema version {current_version} → {db.SCHEMA_VERSION}")

    try:
        db.create_schema()

        if current_version == 0:
            _migrate_from_json(data_dir)

        db.set_schema_version(db.SCHEMA_VERSION, 'Initial migration from JSON')
        print("[migrate] Migration complete.")
        return True

    except Exception as e:
        print(f"[migrate] ERROR during migration: {e}")
        import traceback
        traceback.print_exc()
        return False


def _load_json(path: Path, default=None):
    """Safely load a JSON file, returning default on any error."""
    if not path.exists():
        return default if default is not None else None
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        print(f"[migrate] Warning: could not load {path.name}: {e}")
        return default if default is not None else None


def _migrate_from_json(data_dir: Path):
    """Read all JSON files and populate SQLite tables."""
    conn = db.get_conn()

    # ── Settings ──────────────────────────────────────────────────────────
    settings = _load_json(data_dir / 'settings.json', {})
    if settings:
        conn.execute("DELETE FROM settings")
        conn.executemany(
            "INSERT INTO settings (key, value) VALUES (?, ?)",
            [(k, json.dumps(v)) for k, v in settings.items()]
        )
        print(f"[migrate]   settings: {len(settings)} keys")

    # ── Player state ──────────────────────────────────────────────────────
    player_state = _load_json(data_dir / 'player_state.json', {})
    if player_state:
        conn.execute("DELETE FROM player_state")
        conn.executemany(
            "INSERT INTO player_state (key, value) VALUES (?, ?)",
            [(k, json.dumps(v)) for k, v in player_state.items()]
        )
        print(f"[migrate]   player_state: {len(player_state)} keys")

    # ── Insights config ───────────────────────────────────────────────────
    insights_cfg = _load_json(data_dir / 'insights_config.json', {})
    if insights_cfg:
        conn.execute("DELETE FROM insights_config")
        conn.executemany(
            "INSERT INTO insights_config (key, value) VALUES (?, ?)",
            [(k, json.dumps(v)) for k, v in insights_cfg.items()]
        )
        print(f"[migrate]   insights_config: {len(insights_cfg)} keys")

    # ── Library (tracks) ──────────────────────────────────────────────────
    tracks = _load_json(data_dir / 'library.json', [])
    if tracks and isinstance(tracks, list):
        conn.execute("DELETE FROM tracks")
        conn.execute("DELETE FROM tracks_fts")
        conn.executemany(
            """INSERT INTO tracks (id, path, filename, title, artist, album_artist,
               album, track_number, year, genre, duration, artwork_key, bitrate,
               format, sample_rate, bits_per_sample, date_added)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    t['id'], t.get('path', ''), t.get('filename', ''),
                    t.get('title'), t.get('artist'), t.get('album_artist'),
                    t.get('album'), db._coerce_track_number(t.get('track_number')),
                    db._coerce_year(t.get('year')), t.get('genre'),
                    t.get('duration'), t.get('artwork_key'),
                    t.get('bitrate'), t.get('format'),
                    t.get('sample_rate'), t.get('bits_per_sample'),
                    t.get('date_added'),
                )
                for t in tracks
            ]
        )
        conn.execute("INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild')")
        print(f"[migrate]   tracks: {len(tracks)} rows")

    # ── Playlists ─────────────────────────────────────────────────────────
    playlists = _load_json(data_dir / 'playlists.json', {})
    if playlists and isinstance(playlists, dict):
        conn.execute("DELETE FROM playlist_tracks")
        conn.execute("DELETE FROM playlists")
        for pid, pl in playlists.items():
            conn.execute(
                "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (pid, pl.get('name', ''), pl.get('created_at', 0),
                 pl.get('updated_at', pl.get('created_at', 0)))
            )
            track_list = pl.get('tracks', [])
            conn.executemany(
                "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)",
                [(pid, tid if isinstance(tid, str) else str(tid), i)
                 for i, tid in enumerate(track_list)]
            )
        print(f"[migrate]   playlists: {len(playlists)} playlists")

    # ── Favourites ────────────────────────────────────────────────────────
    favourites = _load_json(data_dir / 'favourites.json')
    if favourites and isinstance(favourites, dict):
        conn.execute("DELETE FROM favourites")
        conn.execute("DELETE FROM favourite_dap_exports")
        for cat in ('songs', 'albums', 'artists'):
            items = favourites.get(cat, [])
            for item in items:
                if isinstance(item, dict) and item.get('id'):
                    conn.execute(
                        "INSERT OR IGNORE INTO favourites (category, item_id, added_at) VALUES (?, ?, ?)",
                        (cat, item['id'], item.get('added_at', 0))
                    )
                elif isinstance(item, str) and item:
                    conn.execute(
                        "INSERT OR IGNORE INTO favourites (category, item_id, added_at) VALUES (?, ?, ?)",
                        (cat, item, 0)
                    )
        for dap_id, ts in favourites.get('dap_exports', {}).items():
            conn.execute(
                "INSERT OR REPLACE INTO favourite_dap_exports (dap_id, exported_at) VALUES (?, ?)",
                (dap_id, int(ts) if ts else 0)
            )
        fav_count = sum(len(favourites.get(c, [])) for c in ('songs', 'albums', 'artists'))
        print(f"[migrate]   favourites: {fav_count} items")

    # ── DAPs ──────────────────────────────────────────────────────────────
    daps = _load_json(data_dir / 'daps.json', [])
    if daps and isinstance(daps, list):
        conn.execute("DELETE FROM dap_playlist_exports")
        conn.execute("DELETE FROM daps")
        for d in daps:
            conn.execute(
                """INSERT INTO daps (id, name, model, mount_path, export_folder, path_prefix,
                   peq_folder, storage_type, music_root, path_template,
                   mount_volume_uuid, mount_disk_uuid, mount_device_identifier, sync_summary)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    d['id'], d.get('name', ''), d.get('model', ''),
                    d.get('mount_path', ''), d.get('export_folder', ''),
                    d.get('path_prefix', ''), d.get('peq_folder', 'PEQ'),
                    d.get('storage_type', 'sd'), d.get('music_root', 'Music'),
                    d.get('path_template', ''),
                    d.get('mount_volume_uuid', ''), d.get('mount_disk_uuid', ''),
                    d.get('mount_device_identifier', ''),
                    json.dumps(d.get('sync_summary', {})),
                )
            )
            for pid, ts in d.get('playlist_exports', {}).items():
                conn.execute(
                    "INSERT INTO dap_playlist_exports (dap_id, playlist_id, exported_at) VALUES (?, ?, ?)",
                    (d['id'], pid, int(ts) if ts else 0)
                )
        print(f"[migrate]   daps: {len(daps)} devices")

    # ── Baselines ─────────────────────────────────────────────────────────
    baselines = _load_json(data_dir / 'baselines.json', [])
    if baselines and isinstance(baselines, list):
        conn.execute("DELETE FROM baselines")
        conn.executemany(
            "INSERT INTO baselines (id, name, url, color, measurement) VALUES (?, ?, ?, ?, ?)",
            [
                (b['id'], b.get('name', ''), b.get('url', ''),
                 b.get('color', ''),
                 json.dumps(b.get('measurement')) if b.get('measurement') else None)
                for b in baselines
            ]
        )
        print(f"[migrate]   baselines: {len(baselines)} targets")

    # ── IEMs ──────────────────────────────────────────────────────────────
    iems = _load_json(data_dir / 'iems.json', [])
    if iems and isinstance(iems, list):
        conn.execute("DELETE FROM iem_peq_filters")
        conn.execute("DELETE FROM iem_peq_profiles")
        conn.execute("DELETE FROM iem_squig_sources")
        conn.execute("DELETE FROM iems")
        for iem in iems:
            db._db_insert_iem(conn, iem)
        print(f"[migrate]   iems: {len(iems)} devices")

    # ── Track features ────────────────────────────────────────────────────
    feat_path = data_dir / 'features' / 'track_features.json'
    features = _load_json(feat_path, [])
    if features and isinstance(features, list):
        conn.execute("DELETE FROM track_features")
        conn.executemany(
            """INSERT INTO track_features (track_id, analysis_version, failed, reason,
               brightness, energy, band_energy, cluster, source_path, source_mtime, analysed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    e['track_id'], e.get('analysis_version'),
                    1 if e.get('failed') else 0, e.get('reason'),
                    e.get('brightness'), e.get('energy'),
                    json.dumps(e['band_energy']) if e.get('band_energy') else None,
                    e.get('cluster'),
                    e.get('source_path'), e.get('source_mtime', 0),
                    e.get('analysed_at', 0),
                )
                for e in features
            ]
        )
        print(f"[migrate]   track_features: {len(features)} entries")

    # ── Match matrix ──────────────────────────────────────────────────────
    match_data = _load_json(data_dir / 'match-matrix.json')
    if match_data and isinstance(match_data, dict):
        conn.execute("DELETE FROM match_matrix")
        conn.execute(
            "INSERT INTO match_matrix (id, generated_at, target_id, data) VALUES (1, ?, ?, ?)",
            (match_data.get('generated_at', 0), match_data.get('target_id'),
             json.dumps(match_data))
        )
        print("[migrate]   match_matrix: loaded")

    # ── Genre families ────────────────────────────────────────────────────
    genre_fam = _load_json(data_dir / 'genre_families.json', {})
    if genre_fam and isinstance(genre_fam, dict):
        conn.execute("DELETE FROM genre_families")
        conn.executemany(
            "INSERT INTO genre_families (base_genre, related_genres) VALUES (?, ?)",
            [(base, json.dumps(related)) for base, related in genre_fam.items()]
        )
        print(f"[migrate]   genre_families: {len(genre_fam)} genres")

    # ── Playlist gen config ───────────────────────────────────────────────
    gen_cfg = _load_json(data_dir / 'playlist_gen_config.json', {})
    if gen_cfg and isinstance(gen_cfg, dict):
        conn.execute("DELETE FROM playlist_gen_config")
        _flatten_insert_kv(conn, 'playlist_gen_config', gen_cfg)
        print(f"[migrate]   playlist_gen_config: loaded")

    # ── Commit everything ─────────────────────────────────────────────────
    conn.commit()

    # ── Verify counts ─────────────────────────────────────────────────────
    _verify_migration(conn, data_dir, tracks, playlists, daps, iems, baselines, features)


def _flatten_insert_kv(conn, table, d, prefix=''):
    """Flatten a nested dict into key-value rows."""
    for k, v in d.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            _flatten_insert_kv(conn, table, v, key)
        else:
            conn.execute(
                f"INSERT INTO {table} (key, value) VALUES (?, ?)",
                (key, json.dumps(v))
            )


def _verify_migration(conn, data_dir, tracks, playlists, daps, iems, baselines, features):
    """Verify row counts after migration."""
    checks = []
    if tracks:
        actual = conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]
        checks.append(('tracks', len(tracks), actual))
    if playlists:
        actual = conn.execute("SELECT COUNT(*) FROM playlists").fetchone()[0]
        checks.append(('playlists', len(playlists), actual))
    if daps:
        actual = conn.execute("SELECT COUNT(*) FROM daps").fetchone()[0]
        checks.append(('daps', len(daps), actual))
    if iems:
        actual = conn.execute("SELECT COUNT(*) FROM iems").fetchone()[0]
        checks.append(('iems', len(iems), actual))
    if baselines:
        actual = conn.execute("SELECT COUNT(*) FROM baselines").fetchone()[0]
        checks.append(('baselines', len(baselines), actual))
    if features:
        actual = conn.execute("SELECT COUNT(*) FROM track_features").fetchone()[0]
        checks.append(('track_features', len(features), actual))

    all_ok = True
    for table, expected, actual in checks:
        if expected != actual:
            print(f"[migrate]   WARNING: {table} count mismatch — expected {expected}, got {actual}")
            all_ok = False
        else:
            print(f"[migrate]   OK: {table} = {actual} rows")

    if all_ok:
        print("[migrate] All counts verified.")
