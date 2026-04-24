"""
TuneBridge SQLite data access layer.

Thread-local connections, WAL mode, all CRUD operations.
Replaces JSON file reads/writes in app.py.
"""

import sqlite3
import threading
import json
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Connection management
# ---------------------------------------------------------------------------

_local = threading.local()
DB_PATH: Path = None


def init_db(data_dir: Path):
    """Set the database path. Call once at startup before any queries."""
    global DB_PATH
    DB_PATH = data_dir / 'tunebridge.db'


def get_conn() -> sqlite3.Connection:
    """Return a thread-local SQLite connection with WAL mode."""
    conn = getattr(_local, 'conn', None)
    if conn is None:
        conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.row_factory = sqlite3.Row
        _local.conn = conn
    return conn


def close_conn():
    """Close the thread-local connection if open."""
    conn = getattr(_local, 'conn', None)
    if conn:
        try:
            conn.close()
        except Exception:
            pass
        _local.conn = None


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

SCHEMA_VERSION = 5

# ---------------------------------------------------------------------------
# Migrations
# ---------------------------------------------------------------------------
# Ordered list of ALTER TABLE (or other additive) migrations applied AFTER
# the base schema is bootstrapped. create_schema() handles fresh installs via
# CREATE TABLE IF NOT EXISTS; these entries patch existing databases.
#
# Each entry: (version: int, description: str, sql: list[str] | None)
#   version  — must be > SCHEMA_VERSION and consecutive
#   sql      — list of SQL statements; None if the change is a new table only
#              (new tables are handled by create_schema() automatically)
#
# HOW TO ADD A NEW MIGRATION
#   1. Add the column/table to _SCHEMA_SQL below (fresh-install path)
#   2. Append an entry here:
#      (3, 'Add colour to playlists', ['ALTER TABLE playlists ADD COLUMN colour TEXT'])
#   3. Bump SCHEMA_VERSION to match the highest version in _MIGRATIONS
_MIGRATIONS: list[tuple] = [
    (3, 'Add disc_number to tracks',
        ['ALTER TABLE tracks ADD COLUMN disc_number INTEGER']),
    (4, 'Add ReplayGain columns to tracks', [
        'ALTER TABLE tracks ADD COLUMN rg_track_gain REAL',
        'ALTER TABLE tracks ADD COLUMN rg_album_gain REAL',
        'ALTER TABLE tracks ADD COLUMN rg_track_peak REAL',
        'ALTER TABLE tracks ADD COLUMN rg_album_peak REAL',
    ]),
    (5, 'Add sync discrepancy ignore table', None),
]

_SCHEMA_SQL = """
-- Schema versioning
CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL,
    description TEXT
);

-- Tracks (library)
CREATE TABLE IF NOT EXISTS tracks (
    id              TEXT PRIMARY KEY,
    path            TEXT NOT NULL,
    filename        TEXT,
    title           TEXT,
    artist          TEXT,
    album_artist    TEXT,
    album           TEXT,
    track_number    INTEGER,
    disc_number     INTEGER,
    year            INTEGER,
    genre           TEXT,
    duration        REAL,
    artwork_key     TEXT,
    bitrate         INTEGER,
    format          TEXT,
    sample_rate     INTEGER,
    bits_per_sample INTEGER,
    date_added      INTEGER,
    rg_track_gain   REAL,
    rg_album_gain   REAL,
    rg_track_peak   REAL,
    rg_album_peak   REAL
);

CREATE INDEX IF NOT EXISTS idx_tracks_artist       ON tracks(artist COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tracks_album_artist ON tracks(album_artist COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tracks_album        ON tracks(album COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tracks_genre        ON tracks(genre COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tracks_title        ON tracks(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tracks_year         ON tracks(year);
CREATE INDEX IF NOT EXISTS idx_tracks_date_added   ON tracks(date_added);
CREATE INDEX IF NOT EXISTS idx_tracks_artist_album ON tracks(album_artist COLLATE NOCASE, album COLLATE NOCASE);

-- Playlists
CREATE TABLE IF NOT EXISTS playlists (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    TEXT NOT NULL,
    position    INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, position)
);

CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track ON playlist_tracks(track_id);

-- Favourites
CREATE TABLE IF NOT EXISTS favourites (
    category    TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    added_at    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (category, item_id)
);

CREATE TABLE IF NOT EXISTS favourite_dap_exports (
    dap_id      TEXT NOT NULL,
    exported_at INTEGER NOT NULL,
    PRIMARY KEY (dap_id)
);

-- DAPs
CREATE TABLE IF NOT EXISTS daps (
    id                        TEXT PRIMARY KEY,
    name                      TEXT NOT NULL,
    model                     TEXT DEFAULT '',
    mount_path                TEXT DEFAULT '',
    export_folder             TEXT DEFAULT '',
    path_prefix               TEXT DEFAULT '',
    peq_folder                TEXT DEFAULT 'PEQ',
    storage_type              TEXT DEFAULT 'sd',
    music_root                TEXT DEFAULT 'Music',
    path_template             TEXT DEFAULT '%artist%/%album%/%track% - %title%',
    mount_volume_uuid         TEXT DEFAULT '',
    mount_disk_uuid           TEXT DEFAULT '',
    mount_device_identifier   TEXT DEFAULT '',
    sync_summary              TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS dap_playlist_exports (
    dap_id      TEXT NOT NULL REFERENCES daps(id) ON DELETE CASCADE,
    playlist_id TEXT NOT NULL,
    exported_at INTEGER NOT NULL,
    PRIMARY KEY (dap_id, playlist_id)
);

-- Sync manifest (per-DAP file signatures for fast/stable delta decisions)
CREATE TABLE IF NOT EXISTS sync_manifest (
    dap_id           TEXT NOT NULL REFERENCES daps(id) ON DELETE CASCADE,
    target_rel_key   TEXT NOT NULL,
    target_rel       TEXT NOT NULL,
    local_rel        TEXT DEFAULT '',
    local_size       INTEGER DEFAULT 0,
    local_mtime_ns   INTEGER DEFAULT 0,
    local_hash       TEXT DEFAULT '',
    device_size      INTEGER DEFAULT 0,
    device_mtime_ns  INTEGER DEFAULT 0,
    device_hash      TEXT DEFAULT '',
    updated_at       INTEGER DEFAULT 0,
    PRIMARY KEY (dap_id, target_rel_key)
);

CREATE INDEX IF NOT EXISTS idx_sync_manifest_dap ON sync_manifest(dap_id);

-- Per-DAP ignored sync discrepancies ("Don't remind me" state)
CREATE TABLE IF NOT EXISTS sync_ignored_discrepancies (
    dap_id            TEXT NOT NULL REFERENCES daps(id) ON DELETE CASCADE,
    rel_key           TEXT NOT NULL,
    rel_path          TEXT NOT NULL,
    discrepancy_type  TEXT NOT NULL,
    note              TEXT DEFAULT '',
    created_at        INTEGER NOT NULL DEFAULT 0,
    updated_at        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (dap_id, rel_key, discrepancy_type)
);

CREATE INDEX IF NOT EXISTS idx_sync_ignored_dap ON sync_ignored_discrepancies(dap_id);

-- IEMs
CREATE TABLE IF NOT EXISTS iems (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    type                TEXT DEFAULT 'IEM',
    primary_source_id   TEXT,
    squig_url           TEXT DEFAULT '',
    squig_subdomain     TEXT DEFAULT '',
    squig_file_key      TEXT DEFAULT '',
    measurement_L       TEXT,
    measurement_R       TEXT
);

CREATE TABLE IF NOT EXISTS iem_squig_sources (
    iem_id              TEXT NOT NULL REFERENCES iems(id) ON DELETE CASCADE,
    source_id           TEXT NOT NULL,
    label               TEXT DEFAULT '',
    url                 TEXT DEFAULT '',
    squig_subdomain     TEXT DEFAULT '',
    squig_file_key      TEXT DEFAULT '',
    measurement_L       TEXT,
    measurement_R       TEXT,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (iem_id, source_id)
);

CREATE TABLE IF NOT EXISTS iem_peq_profiles (
    id          TEXT PRIMARY KEY,
    iem_id      TEXT NOT NULL REFERENCES iems(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    preamp_db   REAL DEFAULT 0.0,
    raw_txt     TEXT DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_peq_profiles_iem ON iem_peq_profiles(iem_id);

CREATE TABLE IF NOT EXISTS iem_peq_filters (
    profile_id  TEXT NOT NULL REFERENCES iem_peq_profiles(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    type        TEXT NOT NULL DEFAULT 'PK',
    enabled     INTEGER NOT NULL DEFAULT 1,
    fc          REAL NOT NULL,
    gain        REAL NOT NULL,
    q           REAL NOT NULL,
    PRIMARY KEY (profile_id, position)
);

-- Baselines (FR tuning targets)
CREATE TABLE IF NOT EXISTS baselines (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    url         TEXT DEFAULT '',
    color       TEXT DEFAULT '',
    measurement TEXT
);

-- Track features (audio analysis cache)
CREATE TABLE IF NOT EXISTS track_features (
    track_id          TEXT PRIMARY KEY,
    analysis_version  INTEGER,
    failed            INTEGER DEFAULT 0,
    reason            TEXT,
    brightness        REAL,
    energy            REAL,
    band_energy       TEXT,
    cluster           TEXT,
    source_path       TEXT,
    source_mtime      INTEGER DEFAULT 0,
    analysed_at       INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_features_version ON track_features(analysis_version);

-- Settings (key-value)
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Player state (key-value)
CREATE TABLE IF NOT EXISTS player_state (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Match matrix (singleton computed cache)
CREATE TABLE IF NOT EXISTS match_matrix (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    generated_at    INTEGER,
    target_id       TEXT,
    data            TEXT NOT NULL
);

-- Genre families
CREATE TABLE IF NOT EXISTS genre_families (
    base_genre      TEXT PRIMARY KEY,
    related_genres  TEXT NOT NULL
);

-- Playlist generation config
CREATE TABLE IF NOT EXISTS playlist_gen_config (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Insights config
CREATE TABLE IF NOT EXISTS insights_config (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Tag edit history (soft audit trail; enables future undo)
CREATE TABLE IF NOT EXISTS tag_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id    TEXT NOT NULL,
    field       TEXT NOT NULL,
    old_value   TEXT,
    new_value   TEXT,
    changed_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tag_history_track ON tag_history(track_id);

-- Artist images
CREATE TABLE IF NOT EXISTS artist_images (
    artist_key  TEXT PRIMARY KEY,
    artist_name TEXT NOT NULL,
    image_path  TEXT NOT NULL,
    source      TEXT,
    fetched_at  INTEGER NOT NULL
);

-- Local playback history for Home personalization
CREATE TABLE IF NOT EXISTS play_events (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id                TEXT NOT NULL,
    played_at               INTEGER NOT NULL,
    play_seconds            REAL DEFAULT 0,
    track_duration_seconds  REAL DEFAULT 0,
    completed               INTEGER DEFAULT 0,
    skipped                 INTEGER DEFAULT 0,
    valid_listen            INTEGER DEFAULT 0,
    source_type             TEXT DEFAULT 'unknown',
    source_id               TEXT DEFAULT '',
    source_label            TEXT DEFAULT '',
    artist                  TEXT DEFAULT '',
    album                   TEXT DEFAULT '',
    title                   TEXT DEFAULT '',
    format                  TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_play_events_played_at ON play_events(played_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_events_track_id  ON play_events(track_id);
CREATE INDEX IF NOT EXISTS idx_play_events_artist    ON play_events(artist COLLATE NOCASE);
"""

# FTS5 must be created separately (can't use IF NOT EXISTS with virtual tables the same way)
_FTS_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
    title, artist, album, album_artist,
    content='tracks',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);
"""

_FTS_TRIGGERS_SQL = """
CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
    INSERT INTO tracks_fts(rowid, title, artist, album, album_artist)
    VALUES (new.rowid, new.title, new.artist, new.album, new.album_artist);
END;

CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, album_artist)
    VALUES ('delete', old.rowid, old.title, old.artist, old.album, old.album_artist);
END;

CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, album_artist)
    VALUES ('delete', old.rowid, old.title, old.artist, old.album, old.album_artist);
    INSERT INTO tracks_fts(rowid, title, artist, album, album_artist)
    VALUES (new.rowid, new.title, new.artist, new.album, new.album_artist);
END;
"""


def create_schema():
    """Create all tables, indexes, and triggers."""
    conn = get_conn()
    conn.executescript(_SCHEMA_SQL)
    conn.executescript(_FTS_SQL)
    conn.executescript(_FTS_TRIGGERS_SQL)
    conn.commit()


def get_schema_version():
    """Return current schema version, or 0 if not yet migrated."""
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT MAX(version) FROM schema_version"
        ).fetchone()
        return row[0] or 0
    except sqlite3.OperationalError:
        return 0


def set_schema_version(version, description=''):
    conn = get_conn()
    conn.execute(
        "INSERT OR REPLACE INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)",
        (version, int(time.time()), description)
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Helper: coerce track number
# ---------------------------------------------------------------------------

def _coerce_track_number(val):
    """Convert track_number string to int. Handles '01', '1/12', None."""
    if val is None:
        return None
    s = str(val).strip()
    if '/' in s:
        s = s.split('/')[0]
    try:
        return int(s)
    except (ValueError, TypeError):
        return None


def _coerce_disc_number(val):
    """Convert disc_number string to int. Handles '1', '1/4', None."""
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    if '/' in s:
        s = s.split('/')[0]
    try:
        n = int(s)
        return n if n > 0 else None
    except (ValueError, TypeError):
        return None


def _coerce_year(val):
    """Convert year to int. Handles '2024', None, ''."""
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    try:
        return int(s[:4])
    except (ValueError, TypeError):
        return None


def _format_duration(seconds):
    try:
        s = int(float(seconds or 0))
    except (ValueError, TypeError):
        s = 0
    m, s = divmod(max(0, s), 60)
    return f"{m}:{s:02d}"


# ---------------------------------------------------------------------------
# Tracks (Library)
# ---------------------------------------------------------------------------

def db_save_library(tracks):
    """Replace all tracks in the database. Called after do_scan()."""
    conn = get_conn()
    conn.execute("DELETE FROM tracks")
    conn.execute("DELETE FROM tracks_fts")
    conn.executemany(
        """INSERT INTO tracks (id, path, filename, title, artist, album_artist,
           album, track_number, disc_number, year, genre, duration, artwork_key, bitrate,
           format, sample_rate, bits_per_sample, date_added,
           rg_track_gain, rg_album_gain, rg_track_peak, rg_album_peak)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (
                t['id'], t.get('path', ''), t.get('filename', ''),
                t.get('title'), t.get('artist'), t.get('album_artist'),
                t.get('album'), _coerce_track_number(t.get('track_number')),
                _coerce_disc_number(t.get('disc_number')),
                _coerce_year(t.get('year')), t.get('genre'),
                t.get('duration'), t.get('artwork_key'),
                t.get('bitrate'), t.get('format'),
                t.get('sample_rate'), t.get('bits_per_sample'),
                t.get('date_added'),
                t.get('rg_track_gain'), t.get('rg_album_gain'),
                t.get('rg_track_peak'), t.get('rg_album_peak'),
            )
            for t in tracks
        ]
    )
    # Rebuild FTS index
    conn.execute("INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild')")
    conn.commit()


def _row_to_track(row):
    """Convert a sqlite3.Row to a track dict matching the JSON format."""
    d = dict(row)
    # Restore string track_number for API compat
    if d.get('track_number') is not None:
        d['track_number'] = str(d['track_number'])
    if d.get('disc_number') is not None:
        d['disc_number'] = str(d['disc_number'])
    if d.get('year') is not None:
        d['year'] = str(d['year'])
    # DB schema stores numeric duration only; frontend expects duration_fmt too.
    d['duration_fmt'] = _format_duration(d.get('duration'))
    return d


def db_load_library():
    """Load all tracks from the database. Returns list of track dicts."""
    conn = get_conn()
    rows = conn.execute("SELECT * FROM tracks").fetchall()
    return [_row_to_track(r) for r in rows]


def db_update_rg_batch(updates):
    """Batch-update ReplayGain fields without touching the rest of the track row.
    updates: list of (rg_track_gain, rg_album_gain, rg_track_peak, rg_album_peak, track_id)
    """
    conn = get_conn()
    conn.executemany(
        'UPDATE tracks SET rg_track_gain=?, rg_album_gain=?, rg_track_peak=?, rg_album_peak=? WHERE id=?',
        updates
    )
    conn.commit()


def db_get_track(track_id):
    """Fetch a single track by ID. Returns dict or None."""
    conn = get_conn()
    row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
    return _row_to_track(row) if row else None


def db_get_tracks(search='', artist_filter='', album_filter=''):
    """Query tracks with optional search/filter. Replaces get_tracks() route logic."""
    conn = get_conn()

    if search:
        # Use FTS5 for text search
        fts_query = search.replace('"', '""')
        # Use prefix matching for partial word search
        fts_terms = ' '.join(f'"{w}"*' for w in fts_query.split() if w)
        if not fts_terms:
            return []

        sql = """
            SELECT t.* FROM tracks t
            JOIN tracks_fts fts ON t.rowid = fts.rowid
            WHERE tracks_fts MATCH ?
        """
        params = [fts_terms]

        if artist_filter:
            sql += " AND (LOWER(t.artist) = LOWER(?) OR LOWER(t.album_artist) = LOWER(?))"
            params.extend([artist_filter, artist_filter])
        if album_filter:
            sql += " AND LOWER(t.album) = LOWER(?)"
            params.append(album_filter)

        sql += " ORDER BY t.artist COLLATE NOCASE, t.album COLLATE NOCASE, t.track_number"
        rows = conn.execute(sql, params).fetchall()
    else:
        conditions = []
        params = []

        if artist_filter:
            conditions.append("(LOWER(artist) = LOWER(?) OR LOWER(album_artist) = LOWER(?))")
            params.extend([artist_filter, artist_filter])
        if album_filter:
            conditions.append("LOWER(album) = LOWER(?)")
            params.append(album_filter)

        sql = "SELECT * FROM tracks"
        if conditions:
            sql += " WHERE " + " AND ".join(conditions)
        sql += " ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, track_number"
        rows = conn.execute(sql, params).fetchall()

    return [_row_to_track(r) for r in rows]


def db_get_artists():
    """Aggregate artists from tracks. Returns list of artist dicts."""
    conn = get_conn()
    rows = conn.execute("""
        SELECT COALESCE(album_artist, artist, 'Unknown Artist') as name,
               COUNT(DISTINCT album) as album_count,
               COUNT(*) as track_count
        FROM tracks
        GROUP BY LOWER(COALESCE(album_artist, artist, 'Unknown Artist'))
    """).fetchall()

    # Get artwork keys separately (first non-null per artist)
    artist_art = {}
    art_rows = conn.execute("""
        SELECT COALESCE(album_artist, artist, 'Unknown Artist') as name, artwork_key
        FROM tracks WHERE artwork_key IS NOT NULL
    """).fetchall()
    for r in art_rows:
        key = r['name'].lower()
        if key not in artist_art:
            artist_art[key] = r['artwork_key']

    result = []
    for r in rows:
        result.append({
            'name': r['name'],
            'album_count': r['album_count'],
            'track_count': r['track_count'],
            'artwork_key': artist_art.get(r['name'].lower()),
        })
    return result


def db_get_albums(artist_filter=''):
    """Aggregate albums from tracks. Returns list of album dicts."""
    conn = get_conn()

    conditions = []
    params = []
    if artist_filter:
        conditions.append("(LOWER(artist) = LOWER(?) OR LOWER(album_artist) = LOWER(?))")
        params.extend([artist_filter, artist_filter])

    where = (" WHERE " + " AND ".join(conditions)) if conditions else ""

    rows = conn.execute(f"""
        SELECT COALESCE(album_artist, artist, 'Unknown Artist') as artist_name,
               COALESCE(album, 'Unknown Album') as album_name,
               MIN(year) as year,
               MIN(genre) as genre,
               COUNT(*) as track_count,
               MAX(artwork_key) as artwork_key
        FROM tracks
        {where}
        GROUP BY LOWER(COALESCE(album_artist, artist, 'Unknown Artist')),
                 LOWER(COALESCE(album, 'Unknown Album'))
    """, params).fetchall()

    return [
        {
            'name': r['album_name'],
            'artist': r['artist_name'],
            'year': str(r['year']) if r['year'] else None,
            'genre': r['genre'],
            'track_count': r['track_count'],
            'artwork_key': r['artwork_key'],
        }
        for r in rows
    ]


def db_get_songs(q='', sort_by='title', order='asc'):
    """Full library song list with sort/filter. Replaces library_songs() route logic."""
    conn = get_conn()

    sort_map = {
        'title': 'title COLLATE NOCASE',
        'artist': 'artist COLLATE NOCASE',
        'album': 'album COLLATE NOCASE',
        'year': 'year',
        'genre': 'genre COLLATE NOCASE',
        'duration': 'duration',
        'date_added': 'date_added',
        'album_artist': 'COALESCE(album_artist, artist) COLLATE NOCASE',
        'format': 'format COLLATE NOCASE',
        'bitrate': 'bitrate',
        'disc_number': 'disc_number',
    }
    sort_col = sort_map.get(sort_by, 'title COLLATE NOCASE')
    direction = 'DESC' if order == 'desc' else 'ASC'

    if q:
        fts_query = q.replace('"', '""')
        fts_terms = ' '.join(f'"{w}"*' for w in fts_query.split() if w)
        if not fts_terms:
            return []
        sql = f"""
            SELECT t.* FROM tracks t
            JOIN tracks_fts fts ON t.rowid = fts.rowid
            WHERE tracks_fts MATCH ?
            ORDER BY {sort_col} {direction}
        """
        rows = conn.execute(sql, [fts_terms]).fetchall()
    else:
        sql = f"SELECT * FROM tracks ORDER BY {sort_col} {direction}"
        rows = conn.execute(sql).fetchall()

    return [_row_to_track(r) for r in rows]


def db_track_count():
    """Return total track count without loading all data."""
    conn = get_conn()
    return conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]


# ---------------------------------------------------------------------------
# Playlists
# ---------------------------------------------------------------------------

def db_load_playlists():
    """Load all playlists with their track IDs. Returns {pid: playlist_dict}."""
    conn = get_conn()
    rows = conn.execute("SELECT * FROM playlists").fetchall()

    result = {}
    for r in rows:
        pid = r['id']
        track_rows = conn.execute(
            "SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position",
            (pid,)
        ).fetchall()
        result[pid] = {
            'id': pid,
            'name': r['name'],
            'created_at': r['created_at'],
            'updated_at': r['updated_at'],
            'tracks': [tr['track_id'] for tr in track_rows],
        }
    return result


def db_save_playlists(playlists):
    """Full replace of all playlists. Used during migration and import."""
    conn = get_conn()
    conn.execute("DELETE FROM playlist_tracks")
    conn.execute("DELETE FROM playlists")
    for pid, pl in playlists.items():
        conn.execute(
            "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (pid, pl['name'], pl.get('created_at', 0), pl.get('updated_at', 0))
        )
        tracks = pl.get('tracks', [])
        conn.executemany(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)",
            [(pid, tid if isinstance(tid, str) else tid.get('id', ''), i) for i, tid in enumerate(tracks)]
        )
    conn.commit()


def db_create_playlist(pid, name, created_at, updated_at):
    conn = get_conn()
    conn.execute(
        "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (pid, name, created_at, updated_at)
    )
    conn.commit()


def db_update_playlist(pid, name=None, updated_at=None):
    conn = get_conn()
    if name is not None:
        conn.execute("UPDATE playlists SET name = ? WHERE id = ?", (name, pid))
    if updated_at is not None:
        conn.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", (updated_at, pid))
    conn.commit()


def db_delete_playlist(pid):
    conn = get_conn()
    conn.execute("DELETE FROM playlists WHERE id = ?", (pid,))
    conn.commit()


def db_get_playlist_tracks(pid):
    """Return ordered list of track IDs for a playlist."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position",
        (pid,)
    ).fetchall()
    return [r['track_id'] for r in rows]


def db_set_playlist_tracks(pid, track_ids, updated_at=None):
    """Replace all tracks for a playlist with new ordered list."""
    conn = get_conn()
    conn.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?", (pid,))
    conn.executemany(
        "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)",
        [(pid, tid, i) for i, tid in enumerate(track_ids)]
    )
    if updated_at is not None:
        conn.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", (updated_at, pid))
    conn.commit()


def db_add_playlist_tracks(pid, track_ids, updated_at=None):
    """Append track IDs to end of playlist."""
    conn = get_conn()
    row = conn.execute(
        "SELECT COALESCE(MAX(position), -1) FROM playlist_tracks WHERE playlist_id = ?",
        (pid,)
    ).fetchone()
    start_pos = row[0] + 1
    conn.executemany(
        "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)",
        [(pid, tid, start_pos + i) for i, tid in enumerate(track_ids)]
    )
    if updated_at is not None:
        conn.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", (updated_at, pid))
    conn.commit()


def db_remove_playlist_track(pid, track_id, updated_at=None):
    """Remove first occurrence of track_id from playlist and reindex positions."""
    conn = get_conn()
    # Find the position of the track to remove
    row = conn.execute(
        "SELECT position FROM playlist_tracks WHERE playlist_id = ? AND track_id = ? ORDER BY position LIMIT 1",
        (pid, track_id)
    ).fetchone()
    if row:
        pos = row[0]
        conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ? AND position = ?",
            (pid, pos)
        )
        # Shift remaining positions down
        conn.execute(
            "UPDATE playlist_tracks SET position = position - 1 WHERE playlist_id = ? AND position > ?",
            (pid, pos)
        )
    if updated_at is not None:
        conn.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", (updated_at, pid))
    conn.commit()


def db_playlist_exists(pid):
    conn = get_conn()
    row = conn.execute("SELECT 1 FROM playlists WHERE id = ?", (pid,)).fetchone()
    return row is not None


def db_get_playlist_meta(pid):
    """Get playlist metadata without tracks."""
    conn = get_conn()
    row = conn.execute("SELECT * FROM playlists WHERE id = ?", (pid,)).fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# Favourites
# ---------------------------------------------------------------------------

def db_load_favourites():
    """Load favourites in the same structure as the JSON format."""
    conn = get_conn()
    result = {'songs': [], 'albums': [], 'artists': [], 'dap_exports': {}}

    for cat in ('songs', 'albums', 'artists'):
        rows = conn.execute(
            "SELECT item_id, added_at FROM favourites WHERE category = ? ORDER BY added_at DESC",
            (cat,)
        ).fetchall()
        result[cat] = [{'id': r['item_id'], 'added_at': r['added_at']} for r in rows]

    exp_rows = conn.execute("SELECT dap_id, exported_at FROM favourite_dap_exports").fetchall()
    result['dap_exports'] = {r['dap_id']: r['exported_at'] for r in exp_rows}
    return result


def db_save_favourites(favourites):
    """Full replace of favourites."""
    conn = get_conn()
    conn.execute("DELETE FROM favourites")
    conn.execute("DELETE FROM favourite_dap_exports")
    for cat in ('songs', 'albums', 'artists'):
        items = favourites.get(cat, [])
        conn.executemany(
            "INSERT OR IGNORE INTO favourites (category, item_id, added_at) VALUES (?, ?, ?)",
            [(cat, item['id'], item.get('added_at', 0)) for item in items if item.get('id')]
        )
    for dap_id, ts in favourites.get('dap_exports', {}).items():
        conn.execute(
            "INSERT OR REPLACE INTO favourite_dap_exports (dap_id, exported_at) VALUES (?, ?)",
            (dap_id, ts)
        )
    conn.commit()


def db_add_favourite(category, item_id, added_at=None):
    conn = get_conn()
    conn.execute(
        "INSERT OR REPLACE INTO favourites (category, item_id, added_at) VALUES (?, ?, ?)",
        (category, item_id, added_at or int(time.time()))
    )
    conn.commit()


def db_remove_favourite(category, item_id):
    conn = get_conn()
    conn.execute("DELETE FROM favourites WHERE category = ? AND item_id = ?", (category, item_id))
    conn.commit()


def db_is_favourite(category, item_id):
    conn = get_conn()
    row = conn.execute(
        "SELECT 1 FROM favourites WHERE category = ? AND item_id = ?",
        (category, item_id)
    ).fetchone()
    return row is not None


# ---------------------------------------------------------------------------
# Settings (key-value)
# ---------------------------------------------------------------------------

def db_load_settings(defaults=None):
    """Load settings as a flat dict, merged with defaults."""
    conn = get_conn()
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    stored = {}
    for r in rows:
        try:
            stored[r['key']] = json.loads(r['value'])
        except (json.JSONDecodeError, TypeError):
            stored[r['key']] = r['value']
    if defaults:
        return {**defaults, **stored}
    return stored


def db_save_settings(settings_dict):
    """Full replace of all settings."""
    conn = get_conn()
    conn.execute("DELETE FROM settings")
    conn.executemany(
        "INSERT INTO settings (key, value) VALUES (?, ?)",
        [(k, json.dumps(v)) for k, v in settings_dict.items()]
    )
    conn.commit()


def db_set_setting(key, value):
    conn = get_conn()
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        (key, json.dumps(value))
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Player state (key-value)
# ---------------------------------------------------------------------------

def db_get_player_state():
    conn = get_conn()
    rows = conn.execute("SELECT key, value FROM player_state").fetchall()
    result = {}
    for r in rows:
        try:
            result[r['key']] = json.loads(r['value'])
        except (json.JSONDecodeError, TypeError):
            result[r['key']] = r['value']
    return result


def db_save_player_state(state_dict):
    conn = get_conn()
    conn.execute("DELETE FROM player_state")
    if state_dict:
        conn.executemany(
            "INSERT INTO player_state (key, value) VALUES (?, ?)",
            [(k, json.dumps(v)) for k, v in state_dict.items()]
        )
    conn.commit()


# ---------------------------------------------------------------------------
# Insights config (key-value)
# ---------------------------------------------------------------------------

def db_load_insights_config():
    conn = get_conn()
    rows = conn.execute("SELECT key, value FROM insights_config").fetchall()
    result = {}
    for r in rows:
        try:
            result[r['key']] = json.loads(r['value'])
        except (json.JSONDecodeError, TypeError):
            result[r['key']] = r['value']
    return result


def db_save_insights_config(cfg):
    conn = get_conn()
    conn.execute("DELETE FROM insights_config")
    if cfg:
        conn.executemany(
            "INSERT INTO insights_config (key, value) VALUES (?, ?)",
            [(k, json.dumps(v)) for k, v in cfg.items()]
        )
    conn.commit()


# ---------------------------------------------------------------------------
# DAPs
# ---------------------------------------------------------------------------

def db_load_daps():
    """Load all DAPs with their playlist_exports. Returns list of dicts."""
    conn = get_conn()
    rows = conn.execute("SELECT * FROM daps").fetchall()
    result = []
    for r in rows:
        d = dict(r)
        # Parse sync_summary from JSON blob
        try:
            d['sync_summary'] = json.loads(d['sync_summary']) if d['sync_summary'] else {}
        except (json.JSONDecodeError, TypeError):
            d['sync_summary'] = {}
        # Load playlist exports
        exp_rows = conn.execute(
            "SELECT playlist_id, exported_at FROM dap_playlist_exports WHERE dap_id = ?",
            (d['id'],)
        ).fetchall()
        d['playlist_exports'] = {er['playlist_id']: er['exported_at'] for er in exp_rows}
        result.append(d)
    return result


def db_save_daps(daps):
    """Full replace of all DAPs."""
    conn = get_conn()
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
                d.get('path_template', ''), d.get('mount_volume_uuid', ''),
                d.get('mount_disk_uuid', ''), d.get('mount_device_identifier', ''),
                json.dumps(d.get('sync_summary', {})),
            )
        )
        for pid, ts in d.get('playlist_exports', {}).items():
            conn.execute(
                "INSERT INTO dap_playlist_exports (dap_id, playlist_id, exported_at) VALUES (?, ?, ?)",
                (d['id'], pid, ts)
            )
    conn.commit()


def db_save_single_dap(d):
    """Insert or update a single DAP."""
    conn = get_conn()
    conn.execute(
        """INSERT OR REPLACE INTO daps (id, name, model, mount_path, export_folder, path_prefix,
           peq_folder, storage_type, music_root, path_template,
           mount_volume_uuid, mount_disk_uuid, mount_device_identifier, sync_summary)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            d['id'], d.get('name', ''), d.get('model', ''),
            d.get('mount_path', ''), d.get('export_folder', ''),
            d.get('path_prefix', ''), d.get('peq_folder', 'PEQ'),
            d.get('storage_type', 'sd'), d.get('music_root', 'Music'),
            d.get('path_template', ''), d.get('mount_volume_uuid', ''),
            d.get('mount_disk_uuid', ''), d.get('mount_device_identifier', ''),
            json.dumps(d.get('sync_summary', {})),
        )
    )
    # Update playlist exports
    conn.execute("DELETE FROM dap_playlist_exports WHERE dap_id = ?", (d['id'],))
    for pid, ts in d.get('playlist_exports', {}).items():
        conn.execute(
            "INSERT INTO dap_playlist_exports (dap_id, playlist_id, exported_at) VALUES (?, ?, ?)",
            (d['id'], pid, ts)
        )
    conn.commit()


def db_delete_dap(did):
    conn = get_conn()
    conn.execute("DELETE FROM daps WHERE id = ?", (did,))
    conn.commit()


def db_record_dap_export(dap_id, playlist_id, exported_at=None):
    conn = get_conn()
    conn.execute(
        "INSERT OR REPLACE INTO dap_playlist_exports (dap_id, playlist_id, exported_at) VALUES (?, ?, ?)",
        (dap_id, playlist_id, exported_at or int(time.time()))
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Sync manifest
# ---------------------------------------------------------------------------

def db_load_sync_manifest(dap_id):
    """Return manifest rows keyed by target_rel_key for a single DAP."""
    conn = get_conn()
    rows = conn.execute(
        """SELECT target_rel_key, target_rel, local_rel, local_size, local_mtime_ns,
                  local_hash, device_size, device_mtime_ns, device_hash, updated_at
           FROM sync_manifest
           WHERE dap_id = ?""",
        (str(dap_id),)
    ).fetchall()
    out = {}
    for r in rows:
        d = dict(r)
        key = str(d.pop('target_rel_key') or '')
        if not key:
            continue
        out[key] = d
    return out


def db_upsert_sync_manifest(dap_id, records, prune_to_keys=None):
    """
    Upsert manifest entries for one DAP.

    records: dict[target_rel_key] -> entry dict
    prune_to_keys: optional iterable of keys to retain (others deleted)
    """
    conn = get_conn()
    did = str(dap_id)
    recs = records if isinstance(records, dict) else {}
    now = int(time.time())

    rows = []
    for key, entry in recs.items():
        if not key:
            continue
        e = entry if isinstance(entry, dict) else {}
        rows.append((
            did,
            str(key),
            str(e.get('target_rel') or ''),
            str(e.get('local_rel') or ''),
            int(e.get('local_size') or 0),
            int(e.get('local_mtime_ns') or 0),
            str(e.get('local_hash') or ''),
            int(e.get('device_size') or 0),
            int(e.get('device_mtime_ns') or 0),
            str(e.get('device_hash') or ''),
            int(e.get('updated_at') or now),
        ))

    if rows:
        conn.executemany(
            """INSERT OR REPLACE INTO sync_manifest (
                   dap_id, target_rel_key, target_rel, local_rel,
                   local_size, local_mtime_ns, local_hash,
                   device_size, device_mtime_ns, device_hash, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            rows
        )

    if prune_to_keys is not None:
        allowed = [str(k) for k in prune_to_keys if str(k)]
        if allowed:
            placeholders = ','.join('?' for _ in allowed)
            conn.execute(
                f"DELETE FROM sync_manifest WHERE dap_id = ? AND target_rel_key NOT IN ({placeholders})",
                [did] + allowed
            )
        else:
            conn.execute("DELETE FROM sync_manifest WHERE dap_id = ?", (did,))

    conn.commit()


def db_list_sync_ignored_discrepancies(dap_id):
    """Return ignored sync discrepancies for one DAP."""
    conn = get_conn()
    rows = conn.execute(
        """SELECT dap_id, rel_key, rel_path, discrepancy_type, note, created_at, updated_at
           FROM sync_ignored_discrepancies
           WHERE dap_id = ?
           ORDER BY discrepancy_type, rel_path COLLATE NOCASE""",
        (str(dap_id),)
    ).fetchall()
    return [dict(r) for r in rows]


def db_upsert_sync_ignored_discrepancies(dap_id, rows):
    """
    Upsert ignored discrepancy rows for one DAP.

    rows: list[dict] with keys: rel_key, rel_path, discrepancy_type, note?
    """
    conn = get_conn()
    did = str(dap_id)
    now = int(time.time())
    payload = []
    for row in (rows or []):
        rel_key = str((row or {}).get('rel_key') or '').strip()
        rel_path = str((row or {}).get('rel_path') or '').strip()
        discrepancy_type = str((row or {}).get('discrepancy_type') or '').strip()
        if not rel_key or not rel_path or not discrepancy_type:
            continue
        note = str((row or {}).get('note') or '').strip()
        payload.append((did, rel_key, rel_path, discrepancy_type, note, now, now))
    if not payload:
        return
    conn.executemany(
        """INSERT INTO sync_ignored_discrepancies (
               dap_id, rel_key, rel_path, discrepancy_type, note, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(dap_id, rel_key, discrepancy_type) DO UPDATE SET
               rel_path = excluded.rel_path,
               note = excluded.note,
               updated_at = excluded.updated_at""",
        payload
    )
    conn.commit()


def db_remove_sync_ignored_discrepancies(dap_id, rows):
    """
    Remove ignored discrepancy rows for one DAP.

    rows: list[dict] with keys: rel_key, discrepancy_type
    """
    conn = get_conn()
    did = str(dap_id)
    payload = []
    for row in (rows or []):
        rel_key = str((row or {}).get('rel_key') or '').strip()
        discrepancy_type = str((row or {}).get('discrepancy_type') or '').strip()
        if not rel_key or not discrepancy_type:
            continue
        payload.append((did, rel_key, discrepancy_type))
    if not payload:
        return 0
    conn.executemany(
        "DELETE FROM sync_ignored_discrepancies WHERE dap_id = ? AND rel_key = ? AND discrepancy_type = ?",
        payload
    )
    conn.commit()
    return conn.total_changes


# ---------------------------------------------------------------------------
# IEMs
# ---------------------------------------------------------------------------

def db_load_iems():
    """Load all IEMs with squig_sources and peq_profiles. Returns list of full dicts."""
    conn = get_conn()
    rows = conn.execute("SELECT * FROM iems ORDER BY name COLLATE NOCASE").fetchall()
    result = []
    for r in rows:
        iem = dict(r)
        # Parse measurement JSON blobs
        for key in ('measurement_L', 'measurement_R'):
            if iem[key]:
                try:
                    iem[key] = json.loads(iem[key])
                except (json.JSONDecodeError, TypeError):
                    iem[key] = None
            else:
                iem[key] = None

        # Load squig sources
        src_rows = conn.execute(
            "SELECT * FROM iem_squig_sources WHERE iem_id = ? ORDER BY sort_order",
            (iem['id'],)
        ).fetchall()
        sources = []
        for sr in src_rows:
            src = dict(sr)
            del src['iem_id']
            del src['sort_order']
            # Rename source_id -> id
            src['id'] = src.pop('source_id')
            for key in ('measurement_L', 'measurement_R'):
                if src[key]:
                    try:
                        src[key] = json.loads(src[key])
                    except (json.JSONDecodeError, TypeError):
                        src[key] = None
                else:
                    src[key] = None
            sources.append(src)
        iem['squig_sources'] = sources

        # Load PEQ profiles
        peq_rows = conn.execute(
            "SELECT * FROM iem_peq_profiles WHERE iem_id = ? ORDER BY sort_order",
            (iem['id'],)
        ).fetchall()
        profiles = []
        for pr in peq_rows:
            profile = {
                'id': pr['id'],
                'name': pr['name'],
                'preamp_db': pr['preamp_db'],
                'raw_txt': pr['raw_txt'],
            }
            # Load filters
            filter_rows = conn.execute(
                "SELECT * FROM iem_peq_filters WHERE profile_id = ? ORDER BY position",
                (pr['id'],)
            ).fetchall()
            profile['filters'] = [
                {
                    'type': fr['type'],
                    'enabled': bool(fr['enabled']),
                    'fc': fr['fc'],
                    'gain': fr['gain'],
                    'q': fr['q'],
                }
                for fr in filter_rows
            ]
            profiles.append(profile)
        iem['peq_profiles'] = profiles
        result.append(iem)
    return result


def db_save_iems(iems):
    """Full replace of all IEMs."""
    conn = get_conn()
    conn.execute("DELETE FROM iem_peq_filters")
    conn.execute("DELETE FROM iem_peq_profiles")
    conn.execute("DELETE FROM iem_squig_sources")
    conn.execute("DELETE FROM iems")

    for iem in iems:
        _db_insert_iem(conn, iem)
    conn.commit()


def _db_insert_iem(conn, iem):
    """Insert a single IEM and its children. Does NOT commit."""
    conn.execute(
        """INSERT INTO iems (id, name, type, primary_source_id,
           squig_url, squig_subdomain, squig_file_key,
           measurement_L, measurement_R)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            iem['id'], iem.get('name', ''), iem.get('type', 'IEM'),
            iem.get('primary_source_id'),
            iem.get('squig_url', ''), iem.get('squig_subdomain', ''),
            iem.get('squig_file_key', ''),
            json.dumps(iem.get('measurement_L')) if iem.get('measurement_L') else None,
            json.dumps(iem.get('measurement_R')) if iem.get('measurement_R') else None,
        )
    )
    # Squig sources
    for i, src in enumerate(iem.get('squig_sources', [])):
        conn.execute(
            """INSERT INTO iem_squig_sources (iem_id, source_id, label, url,
               squig_subdomain, squig_file_key, measurement_L, measurement_R, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                iem['id'], src.get('id', ''), src.get('label', ''),
                src.get('url', ''), src.get('squig_subdomain', ''),
                src.get('squig_file_key', ''),
                json.dumps(src.get('measurement_L')) if src.get('measurement_L') else None,
                json.dumps(src.get('measurement_R')) if src.get('measurement_R') else None,
                i,
            )
        )
    # PEQ profiles
    for i, peq in enumerate(iem.get('peq_profiles', [])):
        conn.execute(
            """INSERT INTO iem_peq_profiles (id, iem_id, name, preamp_db, raw_txt, sort_order)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                peq.get('id', ''), iem['id'], peq.get('name', ''),
                peq.get('preamp_db', 0.0), peq.get('raw_txt', ''), i,
            )
        )
        for j, filt in enumerate(peq.get('filters', [])):
            conn.execute(
                """INSERT INTO iem_peq_filters (profile_id, position, type, enabled, fc, gain, q)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    peq['id'], j, filt.get('type', 'PK'),
                    1 if filt.get('enabled', True) else 0,
                    filt.get('fc', 0), filt.get('gain', 0), filt.get('q', 0),
                )
            )


def db_save_single_iem(iem):
    """Insert or replace a single IEM and all its children."""
    conn = get_conn()
    # Delete existing if present
    conn.execute("DELETE FROM iems WHERE id = ?", (iem['id'],))
    _db_insert_iem(conn, iem)
    conn.commit()


def db_delete_iem(iid):
    conn = get_conn()
    conn.execute("DELETE FROM iems WHERE id = ?", (iid,))
    conn.commit()


def db_add_peq_profile(iem_id, profile):
    """Add a PEQ profile to an IEM."""
    conn = get_conn()
    # Get next sort_order
    row = conn.execute(
        "SELECT COALESCE(MAX(sort_order), -1) FROM iem_peq_profiles WHERE iem_id = ?",
        (iem_id,)
    ).fetchone()
    sort_order = row[0] + 1

    conn.execute(
        "INSERT INTO iem_peq_profiles (id, iem_id, name, preamp_db, raw_txt, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
        (profile['id'], iem_id, profile.get('name', ''),
         profile.get('preamp_db', 0.0), profile.get('raw_txt', ''), sort_order)
    )
    for j, filt in enumerate(profile.get('filters', [])):
        conn.execute(
            "INSERT INTO iem_peq_filters (profile_id, position, type, enabled, fc, gain, q) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (profile['id'], j, filt.get('type', 'PK'),
             1 if filt.get('enabled', True) else 0,
             filt.get('fc', 0), filt.get('gain', 0), filt.get('q', 0))
        )
    conn.commit()


def db_delete_peq_profile(profile_id):
    conn = get_conn()
    conn.execute("DELETE FROM iem_peq_profiles WHERE id = ?", (profile_id,))
    conn.commit()


# ---------------------------------------------------------------------------
# Baselines
# ---------------------------------------------------------------------------

def db_load_baselines():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM baselines").fetchall()
    result = []
    for r in rows:
        d = dict(r)
        if d['measurement']:
            try:
                d['measurement'] = json.loads(d['measurement'])
            except (json.JSONDecodeError, TypeError):
                d['measurement'] = None
        result.append(d)
    return result


def db_save_baselines(baselines):
    conn = get_conn()
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
    conn.commit()


def db_add_baseline(baseline):
    conn = get_conn()
    conn.execute(
        "INSERT INTO baselines (id, name, url, color, measurement) VALUES (?, ?, ?, ?, ?)",
        (baseline['id'], baseline.get('name', ''), baseline.get('url', ''),
         baseline.get('color', ''),
         json.dumps(baseline.get('measurement')) if baseline.get('measurement') else None)
    )
    conn.commit()


def db_delete_baseline(bid):
    conn = get_conn()
    conn.execute("DELETE FROM baselines WHERE id = ?", (bid,))
    conn.commit()


# ---------------------------------------------------------------------------
# Track features
# ---------------------------------------------------------------------------

def db_load_feature_entries():
    """Load all feature entries. Returns list of dicts."""
    conn = get_conn()
    rows = conn.execute("SELECT * FROM track_features").fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d['failed'] = bool(d['failed'])
        if d['band_energy']:
            try:
                d['band_energy'] = json.loads(d['band_energy'])
            except (json.JSONDecodeError, TypeError):
                d['band_energy'] = None
        return_entry = {
            'track_id': d['track_id'],
            'analysis_version': d['analysis_version'],
            'failed': d['failed'],
            'reason': d['reason'],
            'brightness': d['brightness'],
            'energy': d['energy'],
            'band_energy': d['band_energy'],
            'cluster': d['cluster'],
            'source_path': d['source_path'],
            'source_mtime': d['source_mtime'],
            'analysed_at': d['analysed_at'],
        }
        result.append(return_entry)
    return result


def db_load_feature_map():
    """Load features as {track_id: feature_dict}."""
    entries = db_load_feature_entries()
    return {e['track_id']: e for e in entries}


def db_save_feature_entries(entries):
    """Full replace of all feature entries."""
    conn = get_conn()
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
            for e in entries
        ]
    )
    conn.commit()


def db_upsert_feature(entry):
    """Insert or update a single feature entry."""
    conn = get_conn()
    conn.execute(
        """INSERT OR REPLACE INTO track_features (track_id, analysis_version, failed, reason,
           brightness, energy, band_energy, cluster, source_path, source_mtime, analysed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            entry['track_id'], entry.get('analysis_version'),
            1 if entry.get('failed') else 0, entry.get('reason'),
            entry.get('brightness'), entry.get('energy'),
            json.dumps(entry['band_energy']) if entry.get('band_energy') else None,
            entry.get('cluster'),
            entry.get('source_path'), entry.get('source_mtime', 0),
            entry.get('analysed_at', 0),
        )
    )
    conn.commit()


def db_upsert_features_batch(entries):
    """Bulk upsert feature entries (used during analysis flush)."""
    conn = get_conn()
    conn.executemany(
        """INSERT OR REPLACE INTO track_features (track_id, analysis_version, failed, reason,
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
            for e in entries
        ]
    )
    conn.commit()


def db_get_feature(track_id):
    """Get a single feature entry by track_id."""
    conn = get_conn()
    row = conn.execute("SELECT * FROM track_features WHERE track_id = ?", (track_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d['failed'] = bool(d['failed'])
    if d['band_energy']:
        try:
            d['band_energy'] = json.loads(d['band_energy'])
        except (json.JSONDecodeError, TypeError):
            d['band_energy'] = None
    return d


# ---------------------------------------------------------------------------
# Match matrix
# ---------------------------------------------------------------------------

def db_load_match_data():
    conn = get_conn()
    row = conn.execute("SELECT data FROM match_matrix WHERE id = 1").fetchone()
    if not row:
        return None
    try:
        return json.loads(row['data'])
    except (json.JSONDecodeError, TypeError):
        return None


def db_save_match_data(data):
    conn = get_conn()
    conn.execute(
        "INSERT OR REPLACE INTO match_matrix (id, generated_at, target_id, data) VALUES (1, ?, ?, ?)",
        (data.get('generated_at', int(time.time())), data.get('target_id'), json.dumps(data))
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Genre families
# ---------------------------------------------------------------------------

def db_load_genre_families():
    conn = get_conn()
    rows = conn.execute("SELECT base_genre, related_genres FROM genre_families").fetchall()
    result = {}
    for r in rows:
        try:
            result[r['base_genre']] = json.loads(r['related_genres'])
        except (json.JSONDecodeError, TypeError):
            result[r['base_genre']] = []
    return result


def db_save_genre_families(families):
    conn = get_conn()
    conn.execute("DELETE FROM genre_families")
    conn.executemany(
        "INSERT INTO genre_families (base_genre, related_genres) VALUES (?, ?)",
        [(base, json.dumps(related)) for base, related in families.items()]
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Playlist generation config
# ---------------------------------------------------------------------------

def db_load_playlist_gen_config():
    conn = get_conn()
    rows = conn.execute("SELECT key, value FROM playlist_gen_config").fetchall()
    result = {}
    for r in rows:
        try:
            result[r['key']] = json.loads(r['value'])
        except (json.JSONDecodeError, TypeError):
            result[r['key']] = r['value']
    return result


def db_save_playlist_gen_config(cfg):
    conn = get_conn()
    conn.execute("DELETE FROM playlist_gen_config")

    def _flatten(d, prefix=''):
        for k, v in d.items():
            key = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                _flatten(v, key)
            else:
                conn.execute(
                    "INSERT INTO playlist_gen_config (key, value) VALUES (?, ?)",
                    (key, json.dumps(v))
                )

    _flatten(cfg)
    conn.commit()


# ---------------------------------------------------------------------------
# Tag history
# ---------------------------------------------------------------------------

def db_snapshot_tags(track_id, field_values: dict):
    """Record old tag values before a write. field_values = {field: old_value}."""
    conn = get_conn()
    now = int(time.time())
    conn.executemany(
        "INSERT INTO tag_history (track_id, field, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, ?)",
        [(track_id, field, old, None, now) for field, old in field_values.items()]
    )
    conn.commit()


def db_record_tag_changes(track_id, changes: dict, old_values: dict):
    """Record each changed field with its old and new value."""
    conn = get_conn()
    now = int(time.time())
    rows = [
        (track_id, field, str(old_values.get(field, '')), str(new_val), now)
        for field, new_val in changes.items()
        if new_val is not None
    ]
    if rows:
        conn.executemany(
            "INSERT INTO tag_history (track_id, field, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, ?)",
            rows
        )
        conn.commit()


def db_update_track_tags(track_id, changes: dict):
    """Update specific tag fields in the tracks table."""
    allowed = {'title', 'artist', 'album_artist', 'album', 'track_number', 'disc_number', 'year', 'genre'}
    clean = {k: v for k, v in changes.items() if k in allowed}
    if not clean:
        return
    if 'track_number' in clean:
        clean['track_number'] = _coerce_track_number(clean.get('track_number'))
    if 'disc_number' in clean:
        clean['disc_number'] = _coerce_disc_number(clean.get('disc_number'))
    if 'year' in clean:
        clean['year'] = _coerce_year(clean.get('year'))
    conn = get_conn()
    sets = ', '.join(f"{k} = ?" for k in clean)
    vals = list(clean.values()) + [track_id]
    conn.execute(f"UPDATE tracks SET {sets} WHERE id = ?", vals)
    conn.commit()


# ---------------------------------------------------------------------------
# Artist images
# ---------------------------------------------------------------------------

def db_get_artist_image(artist_key: str):
    """Return artist image record or None."""
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM artist_images WHERE artist_key = ?", (artist_key,)
    ).fetchone()
    return dict(row) if row else None


def db_save_artist_image(artist_key: str, artist_name: str, image_path: str, source: str):
    """Insert or replace an artist image record."""
    conn = get_conn()
    conn.execute(
        """INSERT OR REPLACE INTO artist_images (artist_key, artist_name, image_path, source, fetched_at)
           VALUES (?, ?, ?, ?, ?)""",
        (artist_key, artist_name, image_path, source, int(time.time()))
    )
    conn.commit()


def db_delete_artist_image(artist_key: str):
    """Remove an artist image record."""
    conn = get_conn()
    conn.execute("DELETE FROM artist_images WHERE artist_key = ?", (artist_key,))
    conn.commit()


def db_get_all_artist_image_keys() -> set:
    """Return a set of all artist_key values that have a saved image."""
    conn = get_conn()
    rows = conn.execute("SELECT artist_key FROM artist_images").fetchall()
    return {r['artist_key'] for r in rows}


# ---------------------------------------------------------------------------
# Playback history (Home)
# ---------------------------------------------------------------------------

def db_insert_play_events(events):
    """Insert a batch of playback events."""
    if not events:
        return
    rows = []
    for e in events:
        rows.append((
            str(e.get('track_id') or ''),
            int(e.get('played_at') or 0),
            float(e.get('play_seconds') or 0.0),
            float(e.get('track_duration_seconds') or 0.0),
            1 if e.get('completed') else 0,
            1 if e.get('skipped') else 0,
            1 if e.get('valid_listen') else 0,
            str(e.get('source_type') or 'unknown'),
            str(e.get('source_id') or ''),
            str(e.get('source_label') or ''),
            str(e.get('artist') or ''),
            str(e.get('album') or ''),
            str(e.get('title') or ''),
            str(e.get('format') or ''),
        ))
    conn = get_conn()
    conn.executemany(
        """INSERT INTO play_events (
               track_id, played_at, play_seconds, track_duration_seconds,
               completed, skipped, valid_listen, source_type, source_id, source_label,
               artist, album, title, format
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        rows
    )
    conn.commit()


def db_prune_play_events(cutoff_ts: int):
    """Delete playback events older than cutoff timestamp."""
    conn = get_conn()
    conn.execute("DELETE FROM play_events WHERE played_at < ?", (int(cutoff_ts),))
    conn.commit()


def db_clear_play_events():
    """Delete all playback history."""
    conn = get_conn()
    conn.execute("DELETE FROM play_events")
    conn.commit()


def db_load_play_events_since(since_ts: int, limit: int = 20000):
    """Return playback events from since_ts (descending by played_at)."""
    conn = get_conn()
    rows = conn.execute(
        """SELECT * FROM play_events
           WHERE played_at >= ?
           ORDER BY played_at DESC, id DESC
           LIMIT ?""",
        (int(since_ts), int(limit))
    ).fetchall()
    return [dict(r) for r in rows]


def db_get_features_batch(track_ids):
    """Fetch track_features rows for a list of track_ids in one query. Returns {track_id: feature_dict}."""
    if not track_ids:
        return {}
    conn = get_conn()
    placeholders = ','.join('?' for _ in track_ids)
    rows = conn.execute(
        f"SELECT * FROM track_features WHERE track_id IN ({placeholders})",
        list(track_ids)
    ).fetchall()
    result = {}
    for row in rows:
        d = dict(row)
        d['failed'] = bool(d['failed'])
        if d['band_energy']:
            try:
                d['band_energy'] = json.loads(d['band_energy'])
            except (json.JSONDecodeError, TypeError):
                d['band_energy'] = None
        result[d['track_id']] = d
    return result
