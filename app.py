from flask import Flask, jsonify, request, send_file, Response
import os
import sys
import json
import io
import zipfile
import subprocess
try:
    from waitress import serve as waitress_serve
    HAS_WAITRESS = True
except ImportError:
    HAS_WAITRESS = False
import uuid
import threading
import time
import shutil
import math
from pathlib import Path
from urllib.request import urlopen
from urllib.parse import urlparse, parse_qs, quote as urlquote
from urllib.request import Request as UrlRequest
from mutagen.flac import FLAC
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4
import hashlib
import re
from PIL import Image

app = Flask(__name__, static_folder='static', static_url_path='')
app.config['MAX_CONTENT_LENGTH'] = 10 * 1024 * 1024  # 10 MB upload limit

_ARTICLE_RE = re.compile(r'^(the|a|an)\s+', re.IGNORECASE)

def artist_sort_key(name):
    """Return sort key that ignores leading articles (The, A, An)."""
    return _ARTICLE_RE.sub('', name).lower()

# In bundled .app mode, store user data in ~/Library/Application Support/TuneBridge/
# so it survives app updates and works even when app is in /Applications (read-only).
_BUNDLED = os.environ.get('TUNEBRIDGE_BUNDLED') == '1'
DATA_DIR = (
    Path.home() / 'Library' / 'Application Support' / 'TuneBridge'
    if _BUNDLED else
    Path(__file__).parent / 'data'
)
PLAYLIST_FILE = DATA_DIR / 'playlists.json'
LIBRARY_CACHE = DATA_DIR / 'library.json'
ARTWORK_DIR = DATA_DIR / 'artwork'
PLAYLIST_ARTWORK_DIR = DATA_DIR / 'playlist_artwork'
SETTINGS_FILE = DATA_DIR / 'settings.json'
DAP_FILE = DATA_DIR / 'daps.json'
IEM_FILE = DATA_DIR / 'iems.json'
BASELINES_FILE = DATA_DIR / 'baselines.json'
PLAYER_STATE_FILE = DATA_DIR / 'player_state.json'

DEFAULT_SETTINGS = {
    'library_path':     str(Path.home() / 'Music'),
    'poweramp_mount':   '/Volumes/FIIO M21',
    'ap80_mount':       '/Volumes/AP80',
    'poweramp_prefix':  '',   # internal device path, e.g. /storage/sdcard0
    'ap80_prefix':      '',   # internal device path, e.g. /mnt/sdcard
}


def get_music_base():
    settings = load_settings()
    return Path(settings.get('library_path', DEFAULT_SETTINGS['library_path']))

DATA_DIR.mkdir(parents=True, exist_ok=True)
ARTWORK_DIR.mkdir(exist_ok=True)
PLAYLIST_ARTWORK_DIR.mkdir(exist_ok=True)


def _migrate_legacy_data():
    """
    One-time migration: copy user data from the old project-relative data/
    folder into ~/Library/Application Support/TuneBridge/ the first time the
    bundled app runs.

    Triggered when: running as a bundled .app AND playlists.json is missing
    from DATA_DIR (i.e. fresh Application Support folder) AND a legacy data/
    folder exists next to app.py (i.e. the user previously ran from source).
    """
    if not _BUNDLED:
        return
    if PLAYLIST_FILE.exists():
        return  # already migrated or started fresh — nothing to do

    legacy_dir = Path(__file__).parent / 'data'
    if not legacy_dir.is_dir():
        return  # no legacy data to migrate

    _DATA_FILES = [
        'playlists.json', 'playlists.bak.json',
        'settings.json', 'daps.json', 'iems.json', 'baselines.json',
    ]
    migrated = []
    for fname in _DATA_FILES:
        src = legacy_dir / fname
        dst = DATA_DIR / fname
        if src.exists() and not dst.exists():
            shutil.copy2(src, dst)
            migrated.append(fname)

    # Migrate playlist artwork (custom covers)
    legacy_art = legacy_dir / 'playlist_artwork'
    if legacy_art.is_dir():
        for item in legacy_art.iterdir():
            dst = PLAYLIST_ARTWORK_DIR / item.name
            if not dst.exists():
                shutil.copy2(item, dst)
                migrated.append(f'playlist_artwork/{item.name}')

    if migrated:
        print(f'[TuneBridge] Migrated {len(migrated)} item(s) from legacy data/ folder.')


_migrate_legacy_data()

DEVICE_PATHS = {
    'poweramp': Path('/Volumes/FIIO M21'),
    'ap80': Path('/Volumes/AP80'),
}

scan_state = {
    'status': 'idle',
    'progress': 0,
    'total': 0,
    'message': '',
}

sync_state = {
    'status': 'idle',   # idle | scanning | ready | copying | done | error
    'device': None,
    'message': '',
    'progress': 0,
    'total': 0,
    'local_only': [],
    'device_only': [],
    'errors': [],
    'current': '',
}

library = []
library_lock = threading.Lock()


def format_duration(seconds):
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def get_artwork_key(artist, album):
    return hashlib.md5(f"{artist}||{album}".encode()).hexdigest()


def get_flac_tag(tags, *keys):
    if not tags:
        return None
    for key in keys:
        for k in [key, key.upper(), key.lower()]:
            val = tags.get(k)
            if val:
                return str(val[0]) if isinstance(val, list) else str(val)
    return None


def scan_file(filepath):
    filepath = Path(filepath)
    rel_path = str(filepath.relative_to(get_music_base()))
    filename = filepath.name

    try:
        if filename.lower().endswith('.flac'):
            audio = FLAC(str(filepath))
            tags = audio.tags
            duration = int(audio.info.length)

            artist = get_flac_tag(tags, 'ARTIST')
            album_artist = get_flac_tag(tags, 'ALBUMARTIST', 'ALBUM ARTIST')
            album = get_flac_tag(tags, 'ALBUM')
            title = get_flac_tag(tags, 'TITLE')
            track_num = get_flac_tag(tags, 'TRACKNUMBER')
            year = get_flac_tag(tags, 'DATE', 'YEAR')
            genre = get_flac_tag(tags, 'GENRE')

            artwork_key = None
            eff_artist = album_artist or artist
            if eff_artist and album:
                artwork_key = get_artwork_key(eff_artist, album)
                artwork_path = ARTWORK_DIR / f"{artwork_key}.jpg"
                if not artwork_path.exists() and audio.pictures:
                    try:
                        with open(artwork_path, 'wb') as f:
                            f.write(audio.pictures[0].data)
                    except Exception:
                        artwork_key = None
                elif not artwork_path.exists():
                    artwork_key = None

        elif filename.lower().endswith('.mp3'):
            audio = MP3(str(filepath))
            tags = audio.tags
            duration = int(audio.info.length)

            def mp3_tag(key):
                if tags and key in tags:
                    v = str(tags[key])
                    return v.strip() if v.strip() else None
                return None

            artist = mp3_tag('TPE1')
            album_artist = mp3_tag('TPE2')
            album = mp3_tag('TALB')
            title = mp3_tag('TIT2')
            track_num = mp3_tag('TRCK')
            year = mp3_tag('TDRC') or mp3_tag('TYER')
            genre = mp3_tag('TCON')

            artwork_key = None
            eff_artist = album_artist or artist
            if eff_artist and album and tags:
                for key, val in tags.items():
                    if key.startswith('APIC'):
                        artwork_key = get_artwork_key(eff_artist, album)
                        artwork_path = ARTWORK_DIR / f"{artwork_key}.jpg"
                        if not artwork_path.exists():
                            try:
                                with open(artwork_path, 'wb') as f:
                                    f.write(val.data)
                            except Exception:
                                artwork_key = None
                        break
        elif filename.lower().endswith(('.m4a', '.aac', '.mp4')):
            audio = MP4(str(filepath))
            tags = audio.tags or {}
            duration = int(audio.info.length)

            def mp4_tag(key):
                if key in tags:
                    v = tags[key]
                    if isinstance(v, list) and v:
                        return str(v[0]).strip() or None
                return None

            artist = mp4_tag('\xa9ART')
            album_artist = mp4_tag('aART')
            album = mp4_tag('\xa9alb')
            title = mp4_tag('\xa9nam')
            trkn = tags.get('trkn')
            if trkn and isinstance(trkn[0], tuple):
                track_num = str(trkn[0][0])
            elif trkn:
                track_num = str(trkn[0])
            else:
                track_num = None
            year = mp4_tag('\xa9day')
            genre = mp4_tag('\xa9gen')

            artwork_key = None
            eff_artist = album_artist or artist
            if eff_artist and album and 'covr' in tags and tags['covr']:
                artwork_key = get_artwork_key(eff_artist, album)
                artwork_path = ARTWORK_DIR / f"{artwork_key}.jpg"
                if not artwork_path.exists():
                    try:
                        with open(artwork_path, 'wb') as f:
                            f.write(bytes(tags['covr'][0]))
                    except Exception:
                        artwork_key = None
            elif eff_artist and album:
                k = get_artwork_key(eff_artist, album)
                artwork_key = k if (ARTWORK_DIR / f"{k}.jpg").exists() else None

        else:
            return None

        parts = Path(rel_path).parts
        if len(parts) >= 1:
            artist = artist or parts[0]
        if len(parts) >= 2:
            album = album or parts[1]
        title = title or filepath.stem

        if track_num and '/' in str(track_num):
            track_num = str(track_num).split('/')[0]

        if year:
            year = str(year)[:4]

        # Compute bitrate (kbps) and capture lossless metadata
        bitrate = None
        sample_rate = None
        bits_per_sample = None
        try:
            sample_rate = getattr(audio.info, 'sample_rate', None)
            bits_per_sample = getattr(audio.info, 'bits_per_sample', None)
            if hasattr(audio.info, 'bitrate') and audio.info.bitrate:
                bitrate = int(audio.info.bitrate / 1000)
            elif sample_rate and bits_per_sample:
                channels = getattr(audio.info, 'channels', 2)
                bitrate = int(sample_rate * bits_per_sample * channels / 1000)
        except Exception:
            pass

        # File format from extension
        file_format = filepath.suffix.lstrip('.').upper() or None

        # Date added (file modification time)
        try:
            date_added = int(filepath.stat().st_mtime)
        except Exception:
            date_added = None

        return {
            'id': hashlib.md5(rel_path.encode('utf-8')).hexdigest(),
            'path': rel_path,
            'filename': filename,
            'title': title,
            'artist': artist or 'Unknown Artist',
            'album_artist': album_artist,
            'album': album or 'Unknown Album',
            'track_number': track_num,
            'year': year,
            'genre': genre,
            'duration': duration,
            'duration_fmt': format_duration(duration),
            'artwork_key': artwork_key,
            'bitrate': bitrate,
            'format': file_format,
            'sample_rate': sample_rate,
            'bits_per_sample': bits_per_sample,
            'date_added': date_added,
        }
    except Exception as e:
        print(f"Error scanning {filepath}: {e}")
        return None


def do_scan():
    global library, scan_state

    prev_count = len(library)
    scan_state.update({'status': 'scanning', 'message': 'Finding music files...', 'progress': 0, 'total': 0, 'new_tracks': 0})

    music_base = get_music_base()
    if not music_base.exists():
        scan_state.update({'status': 'error', 'message': f'Music folder not found: {music_base}'})
        return

    files = []
    for root, dirs, filenames in os.walk(music_base):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.'))
        for fn in sorted(filenames):
            if fn.startswith('.') or fn.startswith('._'):
                continue
            if fn.lower().endswith(('.flac', '.mp3', '.m4a', '.aac', '.mp4')):
                files.append(Path(root) / fn)

    scan_state['total'] = len(files)
    scan_state['message'] = f'Scanning {len(files)} files...'

    tracks = []
    for i, filepath in enumerate(files):
        scan_state['progress'] = i + 1
        track = scan_file(filepath)
        if track:
            tracks.append(track)

    with library_lock:
        library = tracks

    try:
        with open(LIBRARY_CACHE, 'w') as f:
            json.dump(tracks, f)
    except Exception as e:
        print(f"Error saving library cache: {e}")

    new_count = len(tracks) - prev_count
    scan_state.update({'status': 'done', 'message': f'Library ready — {len(tracks)} tracks', 'progress': len(files), 'total': len(files), 'new_tracks': new_count, 'total_tracks': len(tracks)})
    print(f"Scan complete: {len(tracks)} tracks ({new_count:+d} new)")


def load_library():
    global library
    if LIBRARY_CACHE.exists():
        try:
            with open(LIBRARY_CACHE) as f:
                data = json.load(f)
            with library_lock:
                library = data
            scan_state.update({'status': 'done', 'message': f'Library ready — {len(data)} tracks', 'total': len(data), 'progress': len(data), 'new_tracks': 0, 'total_tracks': len(data)})
            print(f"Loaded {len(data)} tracks from cache")
        except Exception as e:
            print(f"Error loading library cache: {e}")
            threading.Thread(target=do_scan, daemon=True).start()
    else:
        threading.Thread(target=do_scan, daemon=True).start()


def load_settings():
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE) as f:
                return {**DEFAULT_SETTINGS, **json.load(f)}
        except Exception:
            pass
    return dict(DEFAULT_SETTINGS)


def save_settings(s):
    with open(SETTINGS_FILE, 'w') as f:
        json.dump(s, f, indent=2)


PLAYLIST_BACKUP_FILE = DATA_DIR / 'playlists.bak.json'


def load_playlists():
    for candidate in (PLAYLIST_FILE, PLAYLIST_BACKUP_FILE):
        if candidate.exists():
            try:
                with open(candidate) as f:
                    data = json.load(f)
                if not isinstance(data, dict):
                    raise ValueError("Playlist file is not a dict")
                # Backfill updated_at for playlists created before the field existed
                changed = False
                for pl in data.values():
                    if 'updated_at' not in pl:
                        pl['updated_at'] = pl.get('created_at', 0)
                        changed = True
                if changed:
                    save_playlists(data)
                if candidate == PLAYLIST_BACKUP_FILE:
                    print(f"WARNING: Loaded playlists from backup file {candidate}")
                return data
            except Exception as e:
                print(f"WARNING: Could not load playlists from {candidate}: {e}")
    return {}


def save_playlists(playlists):
    # Write atomically: temp file → rename so a crash never corrupts the file
    tmp = PLAYLIST_FILE.with_suffix('.tmp.json')
    with open(tmp, 'w') as f:
        json.dump(playlists, f, indent=2)
    # Rotate current → backup before replacing
    if PLAYLIST_FILE.exists():
        shutil.copy2(PLAYLIST_FILE, PLAYLIST_BACKUP_FILE)
    os.replace(tmp, PLAYLIST_FILE)


# ── Routes ──────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_file('static/index.html')


@app.route('/api/library/status')
def library_status():
    return jsonify(scan_state)


@app.route('/api/library/scan', methods=['POST'])
def trigger_scan():
    if scan_state['status'] == 'scanning':
        return jsonify({'message': 'Already scanning'}), 400
    if request.args.get('clean') == 'true':
        try:
            if LIBRARY_CACHE.exists():
                LIBRARY_CACHE.unlink()
            with library_lock:
                global library
                library = []
            scan_state.update({'message': 'Cache cleared — rescanning…'})
        except Exception as e:
            print(f"Error clearing cache: {e}")
    threading.Thread(target=do_scan, daemon=True).start()
    return jsonify({'message': 'Scan started'})


@app.route('/api/library/tracks')
def get_tracks():
    search = request.args.get('q', '').lower().strip()
    artist_filter = request.args.get('artist', '')
    album_filter = request.args.get('album', '')

    with library_lock:
        tracks = library[:]

    if artist_filter:
        af = artist_filter.lower()
        tracks = [t for t in tracks if (t.get('artist') or '').lower() == af or (t.get('album_artist') or '').lower() == af]
    if album_filter:
        tracks = [t for t in tracks if (t.get('album') or '').lower() == album_filter.lower()]
    if search:
        tracks = [t for t in tracks if
                  search in (t.get('title') or '').lower() or
                  search in (t.get('artist') or '').lower() or
                  search in (t.get('album') or '').lower()]

    # Sort by artist → album → track number
    def sort_key(t):
        tn = t.get('track_number') or '999'
        try:
            tn = int(tn)
        except Exception:
            tn = 999
        return (t.get('artist') or '', t.get('album') or '', tn)

    tracks.sort(key=sort_key)
    return jsonify(tracks)


@app.route('/api/library/artists')
def get_artists():
    with library_lock:
        tracks = library[:]

    artists = {}
    for t in tracks:
        name = t.get('album_artist') or t.get('artist') or 'Unknown Artist'
        key = name.lower()
        if key not in artists:
            artists[key] = {'name': name, 'albums': set(), 'track_count': 0, 'artwork_key': None}
        artists[key]['albums'].add(t.get('album'))
        artists[key]['track_count'] += 1
        if not artists[key]['artwork_key'] and t.get('artwork_key'):
            artists[key]['artwork_key'] = t['artwork_key']

    result = [
        {'name': v['name'], 'album_count': len(v['albums']), 'track_count': v['track_count'], 'artwork_key': v['artwork_key']}
        for v in sorted(artists.values(), key=lambda v: artist_sort_key(v['name']))
    ]
    return jsonify(result)


@app.route('/api/library/albums')
def get_albums():
    artist_filter = request.args.get('artist', '')

    with library_lock:
        tracks = library[:]

    if artist_filter:
        af = artist_filter.lower()
        tracks = [t for t in tracks if (t.get('artist') or '').lower() == af or (t.get('album_artist') or '').lower() == af]

    albums = {}
    for t in tracks:
        artist = t.get('album_artist') or t.get('artist') or 'Unknown Artist'
        album = t.get('album') or 'Unknown Album'
        key = f"{artist.lower()}||{album.lower()}"
        if key not in albums:
            albums[key] = {
                'name': album, 'artist': artist,
                'year': t.get('year'), 'genre': t.get('genre'),
                'track_count': 0, 'artwork_key': t.get('artwork_key'),
            }
        albums[key]['track_count'] += 1
        if not albums[key]['artwork_key'] and t.get('artwork_key'):
            albums[key]['artwork_key'] = t['artwork_key']

    result = sorted(albums.values(), key=lambda x: artist_sort_key(x['name']))
    return jsonify(result)


@app.route('/api/library/songs')
def library_songs():
    q = request.args.get('q', '').strip().lower()
    sort_by = request.args.get('sort', 'title')
    order = request.args.get('order', 'asc')

    with library_lock:
        tracks = library[:]

    if q:
        tracks = [t for t in tracks if q in (t.get('title', '') + ' ' + t.get('artist', '') + ' ' + t.get('album', '')).lower()]

    sort_keys = {
        'title': lambda t: (t.get('title') or '').lower(),
        'artist': lambda t: artist_sort_key(t.get('artist') or ''),
        'album': lambda t: (t.get('album') or '').lower(),
        'year': lambda t: t.get('year') or '0000',
        'genre': lambda t: (t.get('genre') or '').lower(),
        'duration': lambda t: t.get('duration') or 0,
        'date_added': lambda t: t.get('date_added') or 0,
        'album_artist': lambda t: artist_sort_key(t.get('album_artist') or t.get('artist') or ''),
        'format': lambda t: (t.get('format') or '').lower(),
        'bitrate': lambda t: t.get('bitrate') or 0,
    }

    key_fn = sort_keys.get(sort_by, sort_keys['title'])
    tracks.sort(key=key_fn, reverse=(order == 'desc'))

    return jsonify(tracks)


@app.route('/api/artwork/<key>')
def get_artwork(key):
    # Sanitize key to prevent path traversal
    if not key.replace('-', '').isalnum():
        return '', 400
    artwork_path = ARTWORK_DIR / f"{key}.jpg"
    if artwork_path.exists():
        return send_file(str(artwork_path), mimetype='image/jpeg')
    return '', 404


def has_playlist_artwork(pid):
    return (PLAYLIST_ARTWORK_DIR / f'{pid}.jpg').exists()


@app.route('/api/playlists', methods=['GET'])
def get_playlists():
    playlists = load_playlists()
    result = sorted(playlists.values(), key=lambda p: p.get('created_at', 0))
    with library_lock:
        lib_map = {t['id']: t for t in library}
    for p in result:
        p['has_artwork'] = has_playlist_artwork(p['id'])
        p['track_count'] = len(p.get('tracks', []))
        # Gather up to 4 unique artwork keys for cover mosaic
        seen = []
        for entry in p.get('tracks', []):
            tid = entry if isinstance(entry, str) else entry.get('id')
            track = lib_map.get(tid)
            if track and track.get('artwork_key') and track['artwork_key'] not in seen:
                seen.append(track['artwork_key'])
                if len(seen) >= 4:
                    break
        p['artwork_keys'] = seen
    return jsonify(result)


@app.route('/api/playlists', methods=['POST'])
def create_playlist():
    data = request.json or {}
    playlists = load_playlists()
    pid = str(uuid.uuid4())
    playlist = {'id': pid, 'name': data.get('name', 'New Playlist'), 'created_at': int(time.time()), 'updated_at': int(time.time()), 'tracks': []}
    playlists[pid] = playlist
    save_playlists(playlists)
    return jsonify(playlist), 201


@app.route('/api/playlists/<pid>', methods=['GET'])
def get_playlist(pid):
    playlists = load_playlists()
    playlist = playlists.get(pid)
    if not playlist:
        return jsonify({'error': 'Not found'}), 404

    with library_lock:
        lib_map = {t['id']: t for t in library}

    enriched = []
    for entry in playlist.get('tracks', []):
        tid = entry if isinstance(entry, str) else entry.get('id')
        track = lib_map.get(tid)
        if track:
            enriched.append(track)

    return jsonify({**playlist, 'tracks': enriched, 'has_artwork': has_playlist_artwork(pid)})


@app.route('/api/playlists/<pid>/artwork', methods=['POST'])
def upload_playlist_artwork(pid):
    playlists = load_playlists()
    if pid not in playlists:
        return jsonify({'error': 'Not found'}), 404
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    f = request.files['file']
    if not f.filename:
        return jsonify({'error': 'No file selected'}), 400
    img = Image.open(f.stream).convert('RGB')
    img.thumbnail((800, 800), Image.LANCZOS)
    out_path = PLAYLIST_ARTWORK_DIR / f'{pid}.jpg'
    img.save(out_path, 'JPEG', quality=90)
    return jsonify({'ok': True, 'has_artwork': True})


@app.route('/api/playlists/<pid>/artwork', methods=['GET'])
def get_playlist_artwork(pid):
    art_path = PLAYLIST_ARTWORK_DIR / f'{pid}.jpg'
    if not art_path.exists():
        return jsonify({'error': 'No artwork'}), 404
    return send_file(str(art_path), mimetype='image/jpeg')


@app.route('/api/playlists/<pid>/artwork/download', methods=['GET'])
def download_playlist_artwork(pid):
    playlists = load_playlists()
    playlist = playlists.get(pid)
    if not playlist:
        return jsonify({'error': 'Not found'}), 404
    art_path = PLAYLIST_ARTWORK_DIR / f'{pid}.jpg'
    if not art_path.exists():
        return jsonify({'error': 'No artwork'}), 404
    name = playlist.get('name', 'playlist')
    return send_file(str(art_path), mimetype='image/jpeg',
                     as_attachment=True, download_name=f'{name}.jpg')


@app.route('/api/playlists/<pid>/artwork', methods=['DELETE'])
def delete_playlist_artwork(pid):
    art_path = PLAYLIST_ARTWORK_DIR / f'{pid}.jpg'
    if art_path.exists():
        art_path.unlink()
    return jsonify({'ok': True, 'has_artwork': False})


@app.route('/api/playlists/<pid>', methods=['PUT'])
def update_playlist(pid):
    data = request.json or {}
    playlists = load_playlists()
    if pid not in playlists:
        return jsonify({'error': 'Not found'}), 404

    playlist = playlists[pid]
    if 'name' in data:
        playlist['name'] = data['name']
    if 'tracks' in data:
        playlist['tracks'] = [t if isinstance(t, str) else t.get('id') for t in data['tracks']]

    playlist['updated_at'] = int(time.time())
    save_playlists(playlists)
    return jsonify(playlist)


@app.route('/api/playlists/<pid>', methods=['DELETE'])
def delete_playlist(pid):
    playlists = load_playlists()
    if pid not in playlists:
        return jsonify({'error': 'Not found'}), 404
    del playlists[pid]
    save_playlists(playlists)
    return '', 204


@app.route('/api/playlists/<pid>/tracks', methods=['POST'])
def add_track(pid):
    data = request.json or {}
    track_ids = data.get('track_ids', [])
    if isinstance(track_ids, str):
        track_ids = [track_ids]

    playlists = load_playlists()
    if pid not in playlists:
        return jsonify({'error': 'Not found'}), 404

    force = data.get('force', False)

    existing = set(playlists[pid]['tracks'])
    duplicates = []
    new_ids = []
    for tid in track_ids:
        if tid in existing:
            duplicates.append(tid)
        else:
            new_ids.append(tid)

    # If there are duplicates and not forcing, return them for the client to confirm
    if duplicates and not force:
        with library_lock:
            lib_map = {t['id']: t for t in library}
        dup_info = [
            {'id': tid, 'title': lib_map.get(tid, {}).get('title', ''), 'artist': lib_map.get(tid, {}).get('artist', '')}
            for tid in duplicates
        ]
        return jsonify({
            'added': 0,
            'duplicates': dup_info,
            'new_count': len(new_ids),
            'new_ids': new_ids,
        })

    # force=True: add everything including duplicates; otherwise add only new
    to_add = track_ids if force else new_ids
    for tid in to_add:
        playlists[pid]['tracks'].append(tid)

    playlists[pid]['updated_at'] = int(time.time())
    save_playlists(playlists)
    return jsonify({'added': len(to_add), 'duplicates': [], 'total': len(playlists[pid]['tracks'])})


@app.route('/api/playlists/<pid>/tracks/<track_id>', methods=['DELETE'])
def remove_track(pid, track_id):
    playlists = load_playlists()
    if pid not in playlists:
        return jsonify({'error': 'Not found'}), 404

    tracks = playlists[pid]['tracks']
    if track_id in tracks:
        tracks.remove(track_id)
    playlists[pid]['updated_at'] = int(time.time())
    save_playlists(playlists)
    return jsonify({'total': len(tracks)})


def parse_m3u(content):
    """Return list of {path, title, artist, duration} from M3U/M3U8 text."""
    entries = []
    current_info = {}
    for raw in content.splitlines():
        line = raw.strip()
        if not line or line.startswith('#EXTM3U') or line.startswith('#PLAYLIST:'):
            continue
        if line.startswith('#EXTINF:'):
            rest = line[8:]
            parts = rest.split(',', 1)
            try:
                current_info['duration'] = int(parts[0])
            except Exception:
                pass
            if len(parts) > 1:
                info = parts[1].strip()
                if ' - ' in info:
                    artist, title = info.split(' - ', 1)
                    current_info['artist'] = artist.strip()
                    current_info['title'] = title.strip()
                else:
                    current_info['title'] = info
        elif not line.startswith('#'):
            entry = {'path': line, **current_info}
            entries.append(entry)
            current_info = {}
    return entries


def match_track(entry, lib_by_path, lib_by_title, lib_by_filename):
    """Try to match an M3U entry to a library track."""
    raw = entry.get('path', '').replace('\\', '/')

    # Normalise: strip leading Music/ prefix variants
    for prefix in ('Music/', '/Music/', './Music/'):
        if raw.startswith(prefix):
            raw = raw[len(prefix):]
            break
    # Strip Android-style absolute paths up to the Music folder
    if '/Music/' in raw:
        raw = raw.split('/Music/', 1)[1]

    # 1. Exact relative-path match
    if raw in lib_by_path:
        return lib_by_path[raw]

    # 2. Match last 3 path components (artist/album/filename)
    parts = [p for p in raw.split('/') if p]
    if len(parts) >= 3:
        suffix = '/'.join(parts[-3:])
        for k, t in lib_by_path.items():
            if k.endswith(suffix):
                return t

    # 3. Filename-only match
    filename = parts[-1] if parts else ''
    if filename in lib_by_filename:
        return lib_by_filename[filename]

    # 4. Artist + title from #EXTINF
    artist = (entry.get('artist') or '').strip().lower()
    title  = (entry.get('title')  or '').strip().lower()
    if artist and title:
        key = f"{artist}||{title}"
        if key in lib_by_title:
            return lib_by_title[key]

    return None


@app.route('/api/playlists/import', methods=['POST'])
def import_playlist():
    data    = request.json or {}
    content = data.get('content', '')
    name    = data.get('name', 'Imported Playlist').strip() or 'Imported Playlist'
    create  = data.get('create', False)

    entries = parse_m3u(content)

    with library_lock:
        lib_by_path     = {t['path']: t for t in library}
        lib_by_title    = {f"{(t.get('artist') or '').lower()}||{(t.get('title') or '').lower()}": t for t in library}
        lib_by_filename = {t['filename']: t for t in library}

    matched   = []
    unmatched = []
    seen_ids  = set()
    for entry in entries:
        track = match_track(entry, lib_by_path, lib_by_title, lib_by_filename)
        if track and track['id'] not in seen_ids:
            matched.append(track)
            seen_ids.add(track['id'])
        elif not track:
            unmatched.append({'path': entry.get('path', ''), 'title': entry.get('title', ''), 'artist': entry.get('artist', '')})

    result = {
        'name': name,
        'matched': len(matched),
        'unmatched': len(unmatched),
        'unmatched_entries': unmatched[:30],
        'matched_track_ids': [t['id'] for t in matched],
    }

    if create:
        playlists = load_playlists()
        pid = str(uuid.uuid4())
        now = int(time.time())
        playlists[pid] = {
            'id': pid, 'name': name,
            'created_at': now, 'updated_at': now,
            'tracks': [t['id'] for t in matched],
        }
        save_playlists(playlists)
        result['playlist_id'] = pid

    return jsonify(result)


def generate_m3u(tracks, playlist_name, path_prefix=''):
    """
    Generate M3U content.
    path_prefix: if set (e.g. '/mnt/sdcard'), paths are absolute: {prefix}/Music/{rel}
                 if empty, paths are relative: Music/{rel}
    """
    lines = ['#EXTM3U', f'#PLAYLIST:{playlist_name}', '']
    prefix = path_prefix.rstrip('/') if path_prefix else ''
    for t in tracks:
        duration = t.get('duration', -1)
        artist = t.get('artist', '')
        title = t.get('title', '')
        rel = (t.get('path') or '').replace('\\', '/')
        track_path = f'{prefix}/Music/{rel}' if prefix else f'Music/{rel}'
        lines.append(f'#EXTINF:{duration},{artist} - {title}')
        lines.append(track_path)
        lines.append('')
    return '\n'.join(lines)


@app.route('/api/playlists/<pid>/export/<fmt>')
def export_playlist(pid, fmt):
    playlists = load_playlists()
    playlist = playlists.get(pid)
    if not playlist:
        return jsonify({'error': 'Not found'}), 404

    with library_lock:
        lib_map = {t['id']: t for t in library}

    tracks = [lib_map[e if isinstance(e, str) else e.get('id')]
              for e in playlist.get('tracks', [])
              if (e if isinstance(e, str) else e.get('id')) in lib_map]

    settings = load_settings()
    if fmt == 'poweramp':
        filename = f"{playlist['name']}.m3u"
        prefix = settings.get('poweramp_prefix', '')
    elif fmt == 'ap80':
        # AP80 expects M3U files in playlist_data/ at the SD root.
        # Paths must be relative from that folder to Music/, so prefix is '..'.
        filename = f"{playlist['name']}.m3u"
        prefix = '..'
    else:
        return jsonify({'error': 'Unknown format'}), 400

    content = generate_m3u(tracks, playlist['name'], path_prefix=prefix)

    return Response(
        content,
        mimetype='audio/x-mpegurl',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'}
    )


@app.route('/api/settings', methods=['GET'])
def get_settings():
    s = load_settings()
    s['_data_dir'] = str(DATA_DIR)
    return jsonify(s)


@app.route('/api/settings', methods=['PUT'])
def put_settings():
    data = request.json or {}
    settings = load_settings()
    for key in DEFAULT_SETTINGS:
        if key in data:
            settings[key] = data[key]
    save_settings(settings)
    return jsonify(settings)


@app.route('/api/health')
def health():
    return jsonify({'status': 'ok'})


# ── Player state persistence ───────────────────────────────────────────────
# Survives WKWebView restarts where localStorage is ephemeral.

@app.route('/api/player/state', methods=['GET'])
def get_player_state():
    if PLAYER_STATE_FILE.exists():
        try:
            with open(PLAYER_STATE_FILE) as f:
                return jsonify(json.load(f))
        except Exception:
            pass
    return jsonify({})

@app.route('/api/player/state', methods=['POST'])
def save_player_state():
    data = request.get_json(force=True) or {}
    tmp = str(PLAYER_STATE_FILE) + '.tmp'
    try:
        with open(tmp, 'w') as f:
            json.dump(data, f, separators=(',', ':'))
        os.replace(tmp, str(PLAYER_STATE_FILE))
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    return jsonify({'ok': True})


@app.route('/api/health/status')
def health_status():
    import time as _time
    result = {}

    # 1. Local library
    music_path = get_music_base()
    lib_ok = music_path.exists()
    with library_lock:
        track_count = len(library)
    cache_age = None
    if LIBRARY_CACHE.exists():
        cache_age = round((_time.time() - LIBRARY_CACHE.stat().st_mtime) / 3600, 1)
    result['library'] = {
        'ok': lib_ok,
        'path': str(music_path),
        'tracks': track_count,
        'cache_age_hours': cache_age,
    }

    # 2. squig.link connectivity
    import urllib.request as _req
    try:
        r = _req.urlopen('https://squig.link', timeout=4)
        result['squig'] = {'ok': True, 'status': r.status}
    except Exception as e:
        result['squig'] = {'ok': False, 'error': str(e)}

    # 3. DAPs
    daps = load_daps()
    for d in daps:
        d['mounted'] = Path(d.get('mount_path', '')).exists()
    result['daps'] = [{'id': d['id'], 'name': d['name'], 'mounted': d['mounted']} for d in daps]

    # 4. Data files
    files = {
        'playlists': PLAYLIST_FILE,
        'settings': SETTINGS_FILE,
        'iems': IEM_FILE,
    }
    result['data_files'] = {k: v.exists() and os.access(v, os.R_OK | os.W_OK) for k, v in files.items()}

    return jsonify(result)


@app.route('/api/restart', methods=['POST'])
def restart_server():
    def do_restart():
        time.sleep(1.2)  # let response flush
        subprocess.Popen([sys.executable] + sys.argv,
                         close_fds=True, start_new_session=True)
        time.sleep(0.8)  # new process imports before we release the port
        os._exit(0)
    threading.Thread(target=do_restart, daemon=False).start()
    return jsonify({'message': 'Restarting…'})


@app.route('/api/devices/status')
def devices_status():
    settings = load_settings()
    return jsonify({
        'poweramp': Path(settings['poweramp_mount']).exists(),
        'ap80':     Path(settings['ap80_mount']).exists(),
    })


@app.route('/api/devices/export', methods=['POST'])
def export_to_device():
    data = request.json or {}
    pid = data.get('playlist_id')
    device = data.get('device')

    if device not in ('poweramp', 'ap80'):
        return jsonify({'error': 'Unknown device'}), 400

    settings = load_settings()
    device_root = Path(settings[f'{device}_mount'])
    if not device_root.exists():
        return jsonify({'error': f'Device not mounted at {device_root}'}), 404

    playlists = load_playlists()
    playlist = playlists.get(pid)
    if not playlist:
        return jsonify({'error': 'Playlist not found'}), 404

    with library_lock:
        lib_map = {t['id']: t for t in library}

    tracks = [lib_map[e if isinstance(e, str) else e.get('id')]
              for e in playlist.get('tracks', [])
              if (e if isinstance(e, str) else e.get('id')) in lib_map]

    settings = load_settings()

    if device == 'ap80':
        # AP80 firmware requires playlists in playlist_data/ at the SD card root,
        # with relative paths (../Music/...) since M3U lives one level above Music/.
        playlists_dir = device_root / 'playlist_data'
        prefix = '..'
    else:
        playlists_dir = device_root / 'Playlists'
        prefix = settings.get('poweramp_prefix', '')

    playlists_dir.mkdir(exist_ok=True)

    out_path = playlists_dir / f"{playlist['name']}.m3u"
    content = generate_m3u(tracks, playlist['name'], path_prefix=prefix)

    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(content)

    # Copy custom playlist artwork to device Pictures folder if available
    art_src = PLAYLIST_ARTWORK_DIR / f'{pid}.jpg'
    art_copied = False
    if art_src.exists():
        pics_dir = device_root / 'Pictures'
        pics_dir.mkdir(exist_ok=True)
        art_dst = pics_dir / f"{playlist['name']}.jpg"
        shutil.copy2(art_src, art_dst)
        art_copied = True

    return jsonify({
        'message': f"Exported to {out_path}",
        'path': str(out_path),
        'artwork_copied': art_copied,
    })



# ── Music Sync ────────────────────────────────────────────────────────────────

SYNC_EXTENSIONS = {'.flac', '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.wv'}

def get_dap_music_path(dap_id):
    """Return Path to Music folder on the DAP identified by dap_id."""
    dap = next((d for d in load_daps() if d['id'] == dap_id), None)
    if not dap:
        return None
    return Path(dap['mount_path']) / 'Music'

def walk_music_files(root):
    """Return sorted list of relative path strings for all music files under root."""
    root = Path(root)
    files = []
    if not root.exists():
        return files
    for dirpath, dirnames, filenames in os.walk(root):
        # Skip hidden directories
        dirnames[:] = [d for d in dirnames if not d.startswith('.')]
        for fn in filenames:
            if fn.startswith('.') or fn.startswith('._'):
                continue
            ext = Path(fn).suffix.lower()
            if ext in SYNC_EXTENSIONS:
                rel = os.path.relpath(os.path.join(dirpath, fn), root)
                files.append(rel)
    return sorted(files)

@app.route('/api/sync/scan', methods=['POST'])
def sync_scan():
    global sync_state
    if sync_state['status'] in ('scanning', 'copying'):
        return jsonify({'error': 'Sync already in progress'}), 400

    data = request.json or {}
    dap_id = data.get('dap_id')
    if not dap_id:
        return jsonify({'error': 'dap_id required'}), 400

    device_path = get_dap_music_path(dap_id)
    if not device_path or not device_path.exists():
        return jsonify({'error': 'Device not mounted or Music folder not found'}), 400

    sync_state = {
        'status': 'scanning',
        'dap_id': dap_id,
        'message': 'Scanning files…',
        'progress': 0,
        'total': 0,
        'local_only': [],
        'device_only': [],
        'errors': [],
        'current': '',
    }

    def do_scan():
        global sync_state
        try:
            sync_state['current'] = 'Scanning local library…'
            local_files = set(walk_music_files(get_music_base()))
            sync_state['current'] = 'Scanning device…'
            device_files = set(walk_music_files(device_path))

            local_only = sorted(local_files - device_files)
            device_only = sorted(device_files - local_files)

            sync_state.update({
                'status': 'ready',
                'local_only': local_only,
                'device_only': device_only,
                'total': len(local_only) + len(device_only),
                'current': '',
                'message': (
                    f'{len(local_only)} file(s) to copy to device, '
                    f'{len(device_only)} file(s) to copy to local'
                ),
            })
        except Exception as e:
            sync_state['status'] = 'error'
            sync_state['message'] = str(e)

    threading.Thread(target=do_scan, daemon=True).start()
    return jsonify({'ok': True})


@app.route('/api/sync/status')
def sync_status_route():
    return jsonify(sync_state)


@app.route('/api/sync/execute', methods=['POST'])
def sync_execute():
    global sync_state
    if sync_state['status'] not in ('ready',):
        return jsonify({'error': 'Run scan first'}), 400

    data = request.json or {}
    local_paths = data.get('local_paths', [])   # copy local → device
    device_paths = data.get('device_paths', []) # copy device → local
    dap_id = sync_state['dap_id']
    device_path = get_dap_music_path(dap_id)

    if not device_path or not device_path.exists():
        return jsonify({'error': 'Device not mounted'}), 400

    total = len(local_paths) + len(device_paths)
    if total == 0:
        return jsonify({'error': 'No files selected'}), 400

    sync_state.update({
        'status': 'copying',
        'progress': 0,
        'total': total,
        'errors': [],
        'current': '',
        'message': f'Copying 0 / {total} files…',
    })

    def do_copy():
        global sync_state
        errors = []
        progress = 0

        for rel in local_paths:
            src = get_music_base() / rel
            dst = device_path / rel
            sync_state['current'] = f'→ Device: {rel}'
            try:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
            except Exception as e:
                errors.append(f'{rel}: {e}')
            progress += 1
            sync_state['progress'] = progress
            sync_state['message'] = f'Copying {progress} / {total} files…'

        for rel in device_paths:
            src = device_path / rel
            dst = get_music_base() / rel
            sync_state['current'] = f'← Local: {rel}'
            try:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
            except Exception as e:
                errors.append(f'{rel}: {e}')
            progress += 1
            sync_state['progress'] = progress
            sync_state['message'] = f'Copying {progress} / {total} files…'

        copied = total - len(errors)
        sync_state.update({
            'status': 'done',
            'errors': errors,
            'current': '',
            'message': (
                f'Done — {copied} file(s) copied.'
                + (f' {len(errors)} error(s).' if errors else '')
            ),
        })

    threading.Thread(target=do_copy, daemon=True).start()
    return jsonify({'ok': True})


@app.route('/api/sync/reset', methods=['POST'])
def sync_reset():
    global sync_state
    sync_state = {
        'status': 'idle', 'device': None, 'message': '',
        'progress': 0, 'total': 0, 'local_only': [], 'device_only': [],
        'errors': [], 'current': '',
    }
    return jsonify({'ok': True})


# ── DAP Management ────────────────────────────────────────────────────────────

def load_daps():
    if DAP_FILE.exists():
        try:
            return json.load(open(DAP_FILE))
        except Exception:
            pass
    return []


def save_daps(daps):
    with open(DAP_FILE, 'w') as f:
        json.dump(daps, f, indent=2)


@app.route('/api/daps', methods=['GET'])
def get_daps():
    daps = load_daps()
    playlists = load_playlists()
    for d in daps:
        d['mounted'] = Path(d.get('mount_path', '')).exists()
        # Count out-of-date playlists
        exports = d.get('playlist_exports', {})
        d['stale_count'] = sum(
            1 for pl in playlists.values()
            if pl['id'] in exports and pl.get('updated_at', 0) > exports[pl['id']]
        )
        d['never_exported'] = sum(
            1 for pl in playlists.values() if pl['id'] not in exports
        )
    return jsonify(daps)


@app.route('/api/daps', methods=['POST'])
def create_dap():
    data = request.json or {}
    model = data.get('model', 'generic')
    # Model-specific defaults
    model_defaults = {
        'poweramp': {'export_folder': 'Playlists',         'path_prefix': ''},
        'hiby':     {'export_folder': 'HiByMusic/Playlist','path_prefix': ''},
        'fiio':     {'export_folder': 'Playlists',         'path_prefix': ''},
        'ap80':     {'export_folder': 'playlist_data',     'path_prefix': '..'},
        'other':    {'export_folder': 'Playlists',         'path_prefix': ''},
    }
    defaults = model_defaults.get(model, model_defaults['other'])
    dap = {
        'id': str(uuid.uuid4()),
        'name': data.get('name', 'New DAP'),
        'model': model,
        'icon': data.get('icon', '📱'),
        'mount_path': data.get('mount_path', ''),
        'export_folder': data.get('export_folder') or defaults['export_folder'],
        'path_prefix': data.get('path_prefix', defaults['path_prefix']),
        'peq_folder': data.get('peq_folder', 'PEQ'),
        'playlist_exports': {},
    }
    daps = load_daps()
    daps.append(dap)
    save_daps(daps)
    dap['mounted'] = Path(dap['mount_path']).exists()
    return jsonify(dap), 201


@app.route('/api/daps/<did>', methods=['GET'])
def get_dap(did):
    dap = next((d for d in load_daps() if d['id'] == did), None)
    if not dap:
        return jsonify({'error': 'Not found'}), 404
    dap['mounted'] = Path(dap.get('mount_path', '')).exists()
    return jsonify(dap)


@app.route('/api/daps/<did>', methods=['PUT'])
def update_dap(did):
    data = request.json or {}
    daps = load_daps()
    dap = next((d for d in daps if d['id'] == did), None)
    if not dap:
        return jsonify({'error': 'Not found'}), 404
    for k in ('name', 'model', 'icon', 'mount_path', 'export_folder', 'path_prefix', 'peq_folder'):
        if k in data:
            dap[k] = data[k]
    save_daps(daps)
    dap['mounted'] = Path(dap.get('mount_path', '')).exists()
    return jsonify(dap)


@app.route('/api/daps/<did>', methods=['DELETE'])
def delete_dap(did):
    save_daps([d for d in load_daps() if d['id'] != did])
    return '', 204


@app.route('/api/daps/<did>/export/<pid>/download')
def dap_download_playlist(did, pid):
    """Return the M3U file as a download, using the DAP's path config."""
    daps = load_daps()
    dap = next((d for d in daps if d['id'] == did), None)
    if not dap:
        return jsonify({'error': 'DAP not found'}), 404

    playlists = load_playlists()
    playlist = playlists.get(pid)
    if not playlist:
        return jsonify({'error': 'Playlist not found'}), 404

    with library_lock:
        lib_map = {t['id']: t for t in library}

    tracks = [lib_map[e if isinstance(e, str) else e.get('id')]
              for e in playlist.get('tracks', [])
              if (e if isinstance(e, str) else e.get('id')) in lib_map]

    prefix = dap.get('path_prefix', '')
    if dap.get('model') == 'ap80':
        prefix = prefix or '..'

    content = generate_m3u(tracks, playlist['name'], path_prefix=prefix)
    safe_name = playlist['name'].replace('/', '-')
    return Response(
        content,
        mimetype='audio/x-mpegurl',
        headers={'Content-Disposition': f'attachment; filename="{safe_name}.m3u"'}
    )


@app.route('/api/daps/<did>/export/<pid>', methods=['POST'])
def dap_export_playlist(did, pid):
    daps = load_daps()
    dap = next((d for d in daps if d['id'] == did), None)
    if not dap:
        return jsonify({'error': 'DAP not found'}), 404

    device_root = Path(dap['mount_path'])
    if not device_root.exists():
        return jsonify({'error': f"Device not mounted at {dap['mount_path']}"}), 404

    playlists = load_playlists()
    playlist = playlists.get(pid)
    if not playlist:
        return jsonify({'error': 'Playlist not found'}), 404

    with library_lock:
        lib_map = {t['id']: t for t in library}

    tracks = [lib_map[e if isinstance(e, str) else e.get('id')]
              for e in playlist.get('tracks', [])
              if (e if isinstance(e, str) else e.get('id')) in lib_map]

    prefix = dap.get('path_prefix', '')
    if dap.get('model') == 'ap80':
        prefix = prefix or '..'

    out_dir = device_root / dap.get('export_folder', 'Playlists')
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        content = generate_m3u(tracks, playlist['name'], path_prefix=prefix)
        safe_name = playlist['name'].replace('/', '-').replace(':', '-')
        with open(out_dir / f"{safe_name}.m3u", 'w', encoding='utf-8') as f:
            f.write(content)
    except OSError as e:
        import errno as _errno
        if e.errno == _errno.EROFS:
            return jsonify({'error': f"Device is mounted read-only. Eject and reconnect {dap['name']}, then try again."}), 409
        return jsonify({'error': f"Could not write to device: {e.strerror}"}), 409

    if 'playlist_exports' not in dap:
        dap['playlist_exports'] = {}
    dap['playlist_exports'][pid] = int(time.time())
    save_daps(daps)
    return jsonify({'exported_at': dap['playlist_exports'][pid]})


# ── IEM Management ────────────────────────────────────────────────────────────

def load_iems():
    if IEM_FILE.exists():
        try:
            return json.load(open(IEM_FILE))
        except Exception:
            pass
    return []


def save_iems(iems):
    with open(IEM_FILE, 'w') as f:
        json.dump(iems, f, indent=2)


def load_baselines():
    if BASELINES_FILE.exists():
        try:
            return json.load(open(BASELINES_FILE))
        except Exception:
            pass
    return []


def save_baselines(baselines):
    with open(BASELINES_FILE, 'w') as f:
        json.dump(baselines, f, indent=2)


def parse_rew_file(text):
    """Parse REW space-separated measurement file. Returns [[freq, spl], ...]."""
    points = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('*'):
            continue
        parts = line.split()
        if len(parts) >= 2:
            try:
                freq = float(parts[0])
                spl = float(parts[1])
                if 20.0 <= freq <= 20000.0:
                    points.append((freq, spl))
            except ValueError:
                pass
    return _downsample(points, 300)


def _downsample(points, n=300):
    """Downsample to n log-spaced points 20Hz–20kHz via linear interpolation."""
    if not points:
        return []
    points = sorted(points, key=lambda p: p[0])
    freqs = [p[0] for p in points]
    spls = [p[1] for p in points]
    result = []
    for i in range(n):
        tf = 20.0 * (20000.0 / 20.0) ** (i / (n - 1))
        if tf <= freqs[0]:
            result.append([round(tf, 2), round(spls[0], 3)])
        elif tf >= freqs[-1]:
            result.append([round(tf, 2), round(spls[-1], 3)])
        else:
            lo, hi = 0, len(freqs) - 1
            while lo < hi - 1:
                mid = (lo + hi) // 2
                if freqs[mid] <= tf:
                    lo = mid
                else:
                    hi = mid
            t = (tf - freqs[lo]) / (freqs[hi] - freqs[lo])
            result.append([round(tf, 2), round(spls[lo] + t * (spls[hi] - spls[lo]), 3)])
    return result


def _squig_headers(host):
    """Build request headers for squig.link data files using the actual hostname."""
    return {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': f'https://{host}/',
        'Accept': '*/*',
    }


def _squig_fetch_url(url, host):
    """Fetch and parse a single squig.link data file. Returns points or None."""
    try:
        req = UrlRequest(url, headers=_squig_headers(host))
        with urlopen(req, timeout=15) as r:
            return parse_rew_file(r.read().decode('utf-8', errors='replace'))
    except Exception as e:
        print(f"squig fetch error ({url}): {e}")
        return None


def fetch_squig_target(squig_url):
    """Fetch a single-channel tuning target from a squig.link share URL.

    squig.link stores target files as '{name} Target.txt' (graphtool.js appends ' Target').
    The share URL may or may not include '_Target' in the key, so we try multiple variants.
    Falls back to '{file_key} L.txt' for stereo measurements used as targets.
    Uses the actual netloc (supports both subdomain.squig.link and squig.link).
    """
    parsed = urlparse(squig_url)
    host = parsed.netloc                        # e.g. "ducbloke.squig.link" or "squig.link"
    share = parse_qs(parsed.query).get('share', [''])[0]
    file_key = share.replace('_', ' ')          # e.g. "Harman Target" or "Harman"
    base = f"https://{host}/data/"              # use actual host, not reconstructed subdomain

    candidates = [
        urlquote(f"{file_key}.txt"),             # exact match (share key already has ' Target')
        urlquote(f"{file_key} Target.txt"),      # share key missing ' Target' suffix
        urlquote(f"{file_key} L.txt"),           # stereo measurement used as target
    ]

    for i, suffix in enumerate(candidates):
        url = base + suffix
        print(f"fetch_squig_target: [{i+1}/{len(candidates)}] trying {url}")
        data = _squig_fetch_url(url, host)
        if data:
            print(f"fetch_squig_target: success with variant {i+1}, got {len(data)} points")
            return data

    print(f"fetch_squig_target: all attempts failed for key='{file_key}' on {host}")
    return None


def fetch_squig_measurement(squig_url):
    """Fetch L/R REW measurements from a squig.link share URL."""
    parsed = urlparse(squig_url)
    host = parsed.netloc                        # e.g. ducbloke.squig.link
    share = parse_qs(parsed.query).get('share', [''])[0]  # e.g. Crinear_Daybreak
    file_key = share.replace('_', ' ')          # e.g. Crinear Daybreak
    base = f"https://{host}/data/"              # use actual host

    def fetch_ch(ch):
        url = base + urlquote(f"{file_key} {ch}.txt")
        return _squig_fetch_url(url, host)

    return {'L': fetch_ch('L'), 'R': fetch_ch('R'), 'file_key': file_key, 'host': host, 'subdomain': host}


def parse_peq_txt(text):
    """Parse APO/AutoEQ parametric EQ .txt file."""
    preamp_db = 0.0
    filters = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        lo = line.lower()
        if lo.startswith('preamp:'):
            try:
                preamp_db = float(line.split(':', 1)[1].strip().split()[0])
            except Exception:
                pass
        elif lo.startswith('filter'):
            parts = line.split()
            try:
                state_idx = next((i for i, p in enumerate(parts) if p.upper() in ('ON', 'OFF')), None)
                if state_idx is None:
                    continue
                enabled = parts[state_idx].upper() == 'ON'
                ftype = parts[state_idx + 1].upper() if state_idx + 1 < len(parts) else 'PK'
                fc = gain = q = None
                for i, p in enumerate(parts):
                    if p == 'Fc' and i + 1 < len(parts):
                        try: fc = float(parts[i + 1])
                        except Exception: pass
                    elif p == 'Gain' and i + 1 < len(parts):
                        try: gain = float(parts[i + 1])
                        except Exception: pass
                    elif p == 'Q' and i + 1 < len(parts):
                        try: q = float(parts[i + 1])
                        except Exception: pass
                if fc is not None:
                    filters.append({'type': ftype, 'enabled': enabled,
                                    'fc': fc, 'gain': gain or 0.0, 'q': q or 1.0})
            except Exception:
                pass
    return {'preamp_db': preamp_db, 'filters': filters}


def _biquad_gain_db(f, ftype, f0, gain_db, Q):
    """Compute magnitude response in dB of an analog biquad EQ filter."""
    if f <= 0 or f0 <= 0:
        return 0.0
    w = 2 * math.pi * f
    w0 = 2 * math.pi * f0
    s = complex(0, w)
    if ftype == 'PK':
        if gain_db == 0:
            return 0.0
        A = 10.0 ** (gain_db / 40.0)
        num = s*s + s*(A/Q)*w0 + w0*w0
        den = s*s + s*(1.0/(A*Q))*w0 + w0*w0
    elif ftype in ('LS', 'LSC'):
        A = 10.0 ** (gain_db / 40.0)
        sqA = A ** 0.5
        num = A*(s*s + s*(sqA/Q)*w0 + A*w0*w0)
        den = A*s*s + s*(sqA/Q)*w0 + w0*w0
    elif ftype in ('HS', 'HSC'):
        A = 10.0 ** (gain_db / 40.0)
        sqA = A ** 0.5
        num = A*(A*s*s + s*(sqA/Q)*w0 + w0*w0)
        den = s*s + s*(sqA/Q)*w0 + A*w0*w0
    else:
        return 0.0
    mag = abs(num / den)
    return 20 * math.log10(mag) if mag > 0 else -120.0


def _apply_peq(measurement, peq_profile):
    """Return measurement with PEQ filters applied."""
    if not measurement or not peq_profile:
        return measurement
    preamp = peq_profile.get('preamp_db', 0.0)
    active = [f for f in peq_profile.get('filters', []) if f.get('enabled', True)]
    result = []
    for freq, spl in measurement:
        adj = spl + preamp
        for f in active:
            adj += _biquad_gain_db(freq, f['type'], f['fc'], f['gain'], f['q'])
        result.append([round(freq, 2), round(adj, 3)])
    return result


@app.route('/api/iems', methods=['GET'])
def get_iems():
    # Omit large measurement arrays from list view; sort alphabetically by name
    result = sorted(
        [{k: v for k, v in iem.items() if k not in ('measurement_L', 'measurement_R')}
         for iem in load_iems()],
        key=lambda i: i.get('name', '').lower()
    )
    return jsonify(result)


@app.route('/api/iems', methods=['POST'])
def create_iem():
    data = request.json or {}
    squig_url = data.get('squig_url', '').strip()
    iem = {
        'id': str(uuid.uuid4()),
        'name': data.get('name', '').strip() or 'New IEM',
        'type': data.get('type', 'IEM'),
        'squig_url': squig_url,
        'squig_subdomain': '',
        'squig_file_key': '',
        'measurement_L': None,
        'measurement_R': None,
        'peq_profiles': [],
    }
    if squig_url:
        try:
            result = fetch_squig_measurement(squig_url)
            if not result['L'] and not result['R']:
                return jsonify({'error': 'Could not fetch measurement data from squig.link. Check the URL and try again.'}), 400
            iem['measurement_L'] = result['L']
            iem['measurement_R'] = result['R']
            iem['squig_subdomain'] = result['subdomain']
            iem['squig_file_key'] = result['file_key']
            if not data.get('name'):
                iem['name'] = result['file_key']
        except Exception as e:
            return jsonify({'error': f'Failed to fetch measurement: {e}'}), 400

    iems = load_iems()
    iems.append(iem)
    save_iems(iems)
    return jsonify({k: v for k, v in iem.items() if k not in ('measurement_L', 'measurement_R')}), 201


@app.route('/api/iems/<iid>', methods=['GET'])
def get_iem(iid):
    iem = next((i for i in load_iems() if i['id'] == iid), None)
    if not iem:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(iem)


@app.route('/api/iems/<iid>', methods=['PUT'])
def update_iem(iid):
    data = request.json or {}
    iems = load_iems()
    iem = next((i for i in iems if i['id'] == iid), None)
    if not iem:
        return jsonify({'error': 'Not found'}), 404
    for k in ('name', 'type'):
        if k in data:
            iem[k] = data[k]
    if 'squig_url' in data and (data['squig_url'] != iem.get('squig_url') or data.get('force_refetch') or not iem.get('measurement_L')):
        iem['squig_url'] = data['squig_url']
        try:
            result = fetch_squig_measurement(data['squig_url'])
            if not result['L'] and not result['R']:
                return jsonify({'error': 'Could not fetch measurement data from squig.link. Check the URL and try again.'}), 400
            iem['measurement_L'] = result['L']
            iem['measurement_R'] = result['R']
            iem['squig_subdomain'] = result['subdomain']
            iem['squig_file_key'] = result['file_key']
        except Exception as e:
            return jsonify({'error': f'Failed to fetch measurement: {e}'}), 400
    save_iems(iems)
    return jsonify({k: v for k, v in iem.items() if k not in ('measurement_L', 'measurement_R')})


@app.route('/api/iems/<iid>', methods=['DELETE'])
def delete_iem(iid):
    save_iems([i for i in load_iems() if i['id'] != iid])
    return '', 204


NORM_REF_DB = 75.0  # All curves normalised to this SPL at 1 kHz


def _spl_at_1khz(points):
    """Return the SPL of the point closest to 1 kHz."""
    if not points:
        return None
    return min(points, key=lambda p: abs(p[0] - 1000))[1]


def _shift(points, offset):
    """Add a constant dB offset to every point."""
    return [[p[0], p[1] + offset] for p in points]


@app.route('/api/iems/<iid>/graph')
def iem_graph(iid):
    iems = load_iems()
    iem = next((i for i in iems if i['id'] == iid), None)
    if not iem:
        return jsonify({'error': 'Not found'}), 404

    peq_id = request.args.get('peq', '')
    compare_ids = request.args.getlist('compare')
    palette = ['#5b8dee', '#e05c5c', '#4caf8f', '#e8a838', '#9c6dd8', '#e05ca0']

    curves = []
    targets = [iem] + [i for i in iems if i['id'] in compare_ids]

    for idx, cur in enumerate(targets):
        color = palette[idx % len(palette)]
        name = cur['name']
        mL = cur.get('measurement_L')
        mR = cur.get('measurement_R')

        # Normalise: use L-channel 1 kHz as reference, apply same offset to R & PEQ
        ref_spl = _spl_at_1khz(mL or mR)
        offset = (NORM_REF_DB - ref_spl) if ref_spl is not None else 0.0

        if mL:
            curves.append({'id': f"{cur['id']}-L", 'label': f"{name} (L)",
                           'color': color, 'dash': False, 'data': _shift(mL, offset)})
        if mR:
            curves.append({'id': f"{cur['id']}-R", 'label': f"{name} (R)",
                           'color': color, 'dash': False, 'data': _shift(mR, offset)})

        # Apply PEQ for primary IEM only (same offset keeps PEQ effect relative to normalised curve)
        if idx == 0 and peq_id:
            peq = next((p for p in cur.get('peq_profiles', []) if p['id'] == peq_id), None)
            if peq:
                peq_color = palette[(len(targets)) % len(palette)]
                if mL:
                    curves.append({'id': f"{cur['id']}-peq-L",
                                   'label': f"{name} + {peq['name']} (L)",
                                   'color': peq_color, 'dash': False,
                                   'data': _shift(_apply_peq(mL, peq), offset)})
                if mR:
                    curves.append({'id': f"{cur['id']}-peq-R",
                                   'label': f"{name} + {peq['name']} (R)",
                                   'color': peq_color, 'dash': False,
                                   'data': _shift(_apply_peq(mR, peq), offset)})

    # Append baseline/target curves — each normalised independently
    for bl in load_baselines():
        m = bl.get('measurement')
        if m:
            ref_spl = _spl_at_1khz(m)
            offset = (NORM_REF_DB - ref_spl) if ref_spl is not None else 0.0
            curves.append({
                'id': f"baseline-{bl['id']}",
                'label': bl['name'],
                'color': bl.get('color', '#f0b429'),
                'dash': True,
                'data': _shift(m, offset),
            })

    return jsonify({'curves': curves, 'iem_name': iem['name']})


@app.route('/api/iems/<iid>/peq', methods=['POST'])
def add_peq_profile(iid):
    iems = load_iems()
    iem = next((i for i in iems if i['id'] == iid), None)
    if not iem:
        return jsonify({'error': 'Not found'}), 404

    if 'file' in request.files:
        f = request.files['file']
        text = f.read().decode('utf-8', errors='replace')
        name = request.form.get('name') or Path(f.filename).stem
    else:
        body = request.json or {}
        text = body.get('content', '')
        name = body.get('name', 'PEQ Profile')

    if not text.strip():
        return jsonify({'error': 'No content'}), 400

    parsed = parse_peq_txt(text)
    profile = {
        'id': str(uuid.uuid4()),
        'name': name,
        'preamp_db': parsed['preamp_db'],
        'filters': parsed['filters'],
        'raw_txt': text,
    }
    iem.setdefault('peq_profiles', []).append(profile)
    save_iems(iems)
    return jsonify({k: v for k, v in profile.items() if k != 'raw_txt'}), 201


@app.route('/api/iems/<iid>/peq/<peq_id>', methods=['DELETE'])
def delete_peq_profile(iid, peq_id):
    iems = load_iems()
    iem = next((i for i in iems if i['id'] == iid), None)
    if not iem:
        return jsonify({'error': 'Not found'}), 404
    iem['peq_profiles'] = [p for p in iem.get('peq_profiles', []) if p['id'] != peq_id]
    save_iems(iems)
    return '', 204


@app.route('/api/iems/<iid>/peq/<peq_id>/copy', methods=['POST'])
def copy_peq_to_dap(iid, peq_id):
    iems = load_iems()
    iem = next((i for i in iems if i['id'] == iid), None)
    if not iem:
        return jsonify({'error': 'IEM not found'}), 404
    peq = next((p for p in iem.get('peq_profiles', []) if p['id'] == peq_id), None)
    if not peq:
        return jsonify({'error': 'PEQ profile not found'}), 404

    dap_id = (request.json or {}).get('dap_id')
    dap = next((d for d in load_daps() if d['id'] == dap_id), None)
    if not dap:
        return jsonify({'error': 'DAP not found'}), 404

    device_root = Path(dap['mount_path'])
    if not device_root.exists():
        return jsonify({'error': f"Device not mounted at {dap['mount_path']}"}), 404

    peq_dir = device_root / dap.get('peq_folder', 'PEQ')
    peq_dir.mkdir(exist_ok=True)

    raw = peq.get('raw_txt', '')
    if not raw:
        lines = [f"Preamp: {peq['preamp_db']:.1f} dB"]
        for i, flt in enumerate(peq.get('filters', []), 1):
            state = 'ON' if flt.get('enabled', True) else 'OFF'
            lines.append(f"Filter {i}: {state} {flt['type']} Fc {flt['fc']} Hz Gain {flt['gain']} dB Q {flt['q']}")
        raw = '\n'.join(lines)

    out_path = peq_dir / f"{iem['name']} - {peq['name']}.txt"
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(raw)
    return jsonify({'message': f"Copied to {out_path}"})


@app.route('/api/iems/<iid>/peq/<peq_id>/download')
def download_peq(iid, peq_id):
    iems = load_iems()
    iem = next((i for i in iems if i['id'] == iid), None)
    if not iem:
        return jsonify({'error': 'Not found'}), 404
    peq = next((p for p in iem.get('peq_profiles', []) if p['id'] == peq_id), None)
    if not peq:
        return jsonify({'error': 'Profile not found'}), 404
    raw = peq.get('raw_txt', '')
    if not raw:
        lines = [f"Preamp: {peq.get('preamp_db', 0):.1f} dB"]
        for i, flt in enumerate(peq.get('filters', []), 1):
            state = 'ON' if flt.get('enabled', True) else 'OFF'
            lines.append(f"Filter {i}: {state} {flt['type']} Fc {flt['fc']} Hz Gain {flt['gain']} dB Q {flt['q']}")
        raw = '\n'.join(lines)
    safe_name = peq['name'].replace('/', '-').replace('\\', '-')
    return Response(
        raw,
        mimetype='text/plain',
        headers={'Content-Disposition': f'attachment; filename="{safe_name}.txt"'}
    )


## ── Baselines (FR tuning targets) ─────────────────────────────────────

BASELINE_PALETTE = ['#f0b429', '#a78bfa', '#fb923c', '#38bdf8', '#f472b6', '#34d399', '#ff6b6b', '#4ecdc4']

def _baseline_color(bid):
    """Deterministic colour from baseline ID."""
    h = 0
    for c in bid:
        h = (h * 31 + ord(c)) & 0xffffffff
    return BASELINE_PALETTE[h % len(BASELINE_PALETTE)]


@app.route('/api/baselines', methods=['GET'])
def get_baselines():
    return jsonify(load_baselines())


@app.route('/api/baselines', methods=['POST'])
def create_baseline():
    data = request.json or {}
    name = data.get('name', '').strip()
    url = data.get('url', '').strip()
    if not name or not url:
        return jsonify({'error': 'Name and URL are required'}), 400

    print(f"create_baseline: name='{name}' url='{url}'")
    measurement = fetch_squig_target(url)
    if not measurement:
        return jsonify({'error': 'Could not fetch measurement data from squig.link. Check the URL.'}), 400

    bid = hashlib.md5(url.encode()).hexdigest()[:12]
    # Use user-supplied color if provided and looks like a valid hex color
    user_color = data.get('color', '').strip()
    color = user_color if (user_color and user_color.startswith('#') and len(user_color) in (4, 7)) else _baseline_color(bid)
    baseline = {
        'id': bid,
        'name': name,
        'url': url,
        'color': color,
        'measurement': measurement,
    }
    baselines = [b for b in load_baselines() if b['id'] != bid]
    baselines.append(baseline)
    save_baselines(baselines)
    return jsonify(baseline), 201


@app.route('/api/baselines/<bid>', methods=['DELETE'])
def delete_baseline(bid):
    baselines = [b for b in load_baselines() if b['id'] != bid]
    save_baselines(baselines)
    return jsonify({'ok': True})


def _get_track_by_id(tid):
    """Look up a track in the in-memory library by its ID."""
    with library_lock:
        for t in library:
            if t.get('id') == tid:
                return t
    return None


_AUDIO_MIMES = {
    'flac': 'audio/flac',
    'mp3':  'audio/mpeg',
    'm4a':  'audio/mp4',
    'aac':  'audio/aac',
    'mp4':  'audio/mp4',
    'wav':  'audio/wav',
    'ogg':  'audio/ogg',
    'opus': 'audio/ogg; codecs=opus',
}


@app.route('/api/stream/<track_id>')
def stream_track(track_id):
    """Stream an audio file with HTTP Range request support (required for seeking)."""
    track = _get_track_by_id(track_id)
    if not track:
        return jsonify({'error': 'Track not found'}), 404

    path = get_music_base() / track['path']
    if not path.exists():
        return jsonify({'error': 'Audio file not found on disk'}), 404

    ext  = path.suffix.lstrip('.').lower()
    mime = _AUDIO_MIMES.get(ext, 'application/octet-stream')
    file_size = path.stat().st_size
    range_header = request.headers.get('Range')

    if not range_header:
        resp = send_file(str(path), mimetype=mime, conditional=True)
        resp.headers['Accept-Ranges'] = 'bytes'
        return resp

    # Parse "bytes=start-[end]"
    m = re.match(r'bytes=(\d+)-(\d*)', range_header)
    if not m:
        return Response(status=416, headers={'Content-Range': f'bytes */{file_size}'})

    byte1 = int(m.group(1))
    byte2 = int(m.group(2)) if m.group(2) else file_size - 1
    byte2 = min(byte2, file_size - 1)

    if byte1 > byte2 or byte1 >= file_size:
        return Response(status=416, headers={'Content-Range': f'bytes */{file_size}'})

    length = byte2 - byte1 + 1

    def _generate():
        with open(str(path), 'rb') as f:
            f.seek(byte1)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))  # 64 KB chunks
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    rv = Response(_generate(), 206, mimetype=mime, direct_passthrough=True)
    rv.headers['Content-Range']  = f'bytes {byte1}-{byte2}/{file_size}'
    rv.headers['Accept-Ranges']  = 'bytes'
    rv.headers['Content-Length'] = str(length)
    rv.headers['Cache-Control']  = 'no-cache'
    return rv


@app.route('/api/backup/export', methods=['GET'])
def export_backup():
    buf = io.BytesIO()
    timestamp = time.strftime('%Y%m%d_%H%M%S')
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for fname in ['playlists.json', 'settings.json', 'daps.json',
                      'iems.json', 'baselines.json']:
            p = DATA_DIR / fname
            if p.exists():
                zf.write(p, fname)
        art = DATA_DIR / 'playlist_artwork'
        if art.is_dir():
            for item in art.iterdir():
                if item.is_file():
                    zf.write(item, f'playlist_artwork/{item.name}')
    buf.seek(0)
    return send_file(buf, mimetype='application/zip',
                     as_attachment=True,
                     download_name=f'tunebridge_backup_{timestamp}.zip')


@app.route('/api/backup/import', methods=['POST'])
def import_backup():
    f = request.files.get('file')
    if not f:
        return jsonify({'error': 'No file provided'}), 400
    try:
        raw = f.read()
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            names = zf.namelist()
            for fname in ['playlists.json', 'settings.json', 'daps.json',
                          'iems.json', 'baselines.json']:
                if fname in names:
                    content = json.loads(zf.read(fname))   # validate JSON
                    dest = DATA_DIR / fname
                    tmp = str(dest) + '.import.tmp'
                    with open(tmp, 'w') as out:
                        json.dump(content, out, indent=2)
                    Path(tmp).replace(dest)
            art_dir = DATA_DIR / 'playlist_artwork'
            art_dir.mkdir(exist_ok=True)
            for name in names:
                if name.startswith('playlist_artwork/') and not name.endswith('/'):
                    dest = art_dir / Path(name).name
                    dest.write_bytes(zf.read(name))
        return jsonify({'ok': True})
    except zipfile.BadZipFile:
        return jsonify({'error': 'Invalid ZIP file — is this a TuneBridge backup?'}), 400
    except json.JSONDecodeError as e:
        return jsonify({'error': f'Corrupt JSON in backup: {e}'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/browse/folder', methods=['POST'])
def browse_folder():
    try:
        import webview
        wins = webview.windows
        if not wins:
            return jsonify({'error': 'No window available'}), 400
        result = wins[0].create_file_dialog(webview.FOLDER_DIALOG)
        if result:
            return jsonify({'path': result[0]})
        return jsonify({'path': None})
    except ImportError:
        return jsonify({'error': 'Browse not available in dev mode — type path manually'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500



# ═══════════════════════════════════════════════════════════════════════════════
# Insights — Phase 1: Library Overview + Tag Health
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/api/insights/overview')
def insights_overview():
    tracks = library
    if not tracks:
        return jsonify({'error': 'Library is empty or not scanned'}), 404

    artist_set = set()
    album_set = set()
    formats = {}
    sample_rates = {}
    bit_depths = {}

    for t in tracks:
        a = (t.get('album_artist') or t.get('artist') or '').strip()
        if a and a.lower() not in ('unknown artist',):
            artist_set.add(a.lower())
        alb = (t.get('album') or '').strip()
        if alb and alb.lower() not in ('unknown album',):
            album_set.add(f"{a.lower()}||{alb.lower()}")

        fmt = t.get('format') or 'Unknown'
        formats[fmt] = formats.get(fmt, 0) + 1

        sr = t.get('sample_rate')
        if sr:
            k = f"{sr // 1000} kHz" if sr % 1000 == 0 else f"{sr / 1000:.1f} kHz"
            sample_rates[k] = sample_rates.get(k, 0) + 1
        else:
            sample_rates['Unknown'] = sample_rates.get('Unknown', 0) + 1

        bd = t.get('bits_per_sample')
        if bd:
            bit_depths[f"{bd}-bit"] = bit_depths.get(f"{bd}-bit", 0) + 1
        else:
            bit_depths['Unknown'] = bit_depths.get('Unknown', 0) + 1

    def _sr_num(k):
        try:
            return float(k.replace(' kHz', ''))
        except Exception:
            return 9999.0

    sample_rates = dict(sorted(sample_rates.items(), key=lambda x: _sr_num(x[0])))
    bit_depths   = dict(sorted(bit_depths.items()))

    return jsonify({
        'total_tracks':  len(tracks),
        'total_albums':  len(album_set),
        'total_artists': len(artist_set),
        'formats':       formats,
        'sample_rates':  sample_rates,
        'bit_depths':    bit_depths,
    })


@app.route('/api/insights/tag-health')
def insights_tag_health():
    from collections import defaultdict
    tracks = library
    if not tracks:
        return jsonify({'error': 'Library is empty'}), 404

    total = len(tracks)

    def _missing(t, field, sentinel=None):
        v = t.get(field)
        return not v or (sentinel is not None and v == sentinel)

    field_defs = [
        ('title',  None),
        ('artist', 'Unknown Artist'),
        ('album',  'Unknown Album'),
        ('year',   None),
        ('genre',  None),
    ]

    completeness = {}
    for field, sentinel in field_defs:
        n_missing = sum(1 for t in tracks if _missing(t, field, sentinel))
        present   = total - n_missing
        completeness[field] = {
            'present': present,
            'missing': n_missing,
            'pct':     round(present / total * 100, 1),
        }

    artist_groups = defaultdict(list)
    for t in tracks:
        raw = (t.get('album_artist') or t.get('artist') or '').strip()
        if raw and raw.lower() != 'unknown artist':
            norm = re.sub(r'\s+', ' ', raw.lower())
            artist_groups[norm].append(raw)

    duplicates = []
    for norm, raw_list in artist_groups.items():
        variants = list(dict.fromkeys(raw_list))
        if len(variants) > 1:
            duplicates.append({
                'normalized':  norm,
                'variants':    variants,
                'track_count': len(raw_list),
            })
    duplicates.sort(key=lambda x: -x['track_count'])

    problem_tracks = []
    for t in tracks:
        issues = []
        if _missing(t, 'title'):                    issues.append('title')
        if _missing(t, 'artist', 'Unknown Artist'): issues.append('artist')
        if _missing(t, 'album',  'Unknown Album'):  issues.append('album')
        if _missing(t, 'year'):                     issues.append('year')
        if _missing(t, 'genre'):                    issues.append('genre')
        if issues:
            problem_tracks.append({
                'id':     t['id'],
                'title':  t.get('title') or t.get('filename', '?'),
                'artist': t.get('artist', ''),
                'album':  t.get('album', ''),
                'path':   t.get('path', ''),
                'issues': issues,
            })
    problem_tracks.sort(key=lambda x: -len(x['issues']))

    return jsonify({
        'total':                total,
        'completeness':         completeness,
        'artist_duplicates':    duplicates[:50],
        'problem_tracks':       problem_tracks[:100],
        'problem_track_count':  len(problem_tracks),
    })


# ═══════════════════════════════════════════════════════════════════════════════
# Insights — Phase 2: Background Audio Analysis
# ═══════════════════════════════════════════════════════════════════════════════

analysis_state = {
    'status':       'idle',   # idle | running | done | error
    'done':         0,
    'total':        0,
    'started_at':   None,
    'completed_at': None,
    'error':        None,
}

_FEATURES_FILE = None   # resolved lazily after DATA_DIR is set


def _features_file():
    p = DATA_DIR / 'features'
    p.mkdir(parents=True, exist_ok=True)
    return p / 'track_features.json'


def _run_analysis():
    global analysis_state
    try:
        import soundfile as sf
        import numpy as np
    except ImportError:
        analysis_state.update({'status': 'error', 'error': 'soundfile / numpy not installed. Run: pip install soundfile numpy'})
        return

    tracks = library
    analysis_state.update({
        'status':     'running',
        'done':       0,
        'total':      len(tracks),
        'started_at': int(time.time()),
        'error':      None,
    })

    feat_path = _features_file()

    # Load existing results for incremental re-use
    existing = {}
    if feat_path.exists():
        try:
            for f in json.loads(feat_path.read_text()):
                existing[f['track_id']] = f
        except Exception:
            existing = {}

    music_base = get_music_base()
    results = []

    for i, track in enumerate(tracks):
        if analysis_state['status'] != 'running':
            break  # allow external cancellation in future

        analysis_state['done'] = i
        tid = track['id']

        # Cache is valid only if band_energy (10 bands) is already present
        cached = existing.get(tid)
        if cached and cached.get('brightness') is not None \
                and cached.get('band_energy') and len(cached['band_energy']) == 10:
            results.append(cached)
            continue

        try:
            path = Path(music_base) / track['path']
            data, sr = sf.read(str(path), dtype='float32', always_2d=True)
            mono = data[:, 0]

            # RMS energy (full track)
            rms = float(np.sqrt(np.mean(mono ** 2)))

            # Spectral centroid + per-band power fractions (first ~1.5 s)
            n     = min(len(mono), 65536)
            frame = mono[:n] * np.hanning(n)
            fft_mag = np.abs(np.fft.rfft(frame))
            freqs   = np.fft.rfftfreq(n, d=1.0 / sr)
            centroid = float(np.sum(freqs * fft_mag) / (np.sum(fft_mag) + 1e-8))

            power       = fft_mag ** 2
            total_power = power.sum() + 1e-12
            band_energy = [
                round(float(power[(freqs >= f_lo) & (freqs < f_hi)].sum() / total_power), 6)
                for _, f_lo, f_hi, _, _ in _FREQ_BANDS
            ]

            results.append({
                'track_id':   tid,
                'brightness': round(centroid, 2),
                'energy':     round(rms, 6),
                'band_energy': band_energy,
                'cluster':    None,
            })
        except Exception:
            results.append({'track_id': tid, 'brightness': None, 'energy': None,
                            'band_energy': None, 'cluster': None})

        # Flush to disk every 200 tracks so progress survives a crash
        if i > 0 and i % 200 == 0:
            try:
                feat_path.write_text(json.dumps(results))
            except Exception:
                pass

    if analysis_state['status'] == 'running':
        # Normal completion
        feat_path.write_text(json.dumps(results))
        analysis_state.update({
            'status':       'done',
            'done':         len(results),
            'completed_at': int(time.time()),
        })
    else:
        # Cancelled — save partial results so incremental re-run can resume
        if results:
            feat_path.write_text(json.dumps(results))
        analysis_state.update({'status': 'idle', 'done': 0, 'total': 0, 'error': None})


@app.route('/api/insights/analyse', methods=['POST'])
def insights_start_analysis():
    if analysis_state['status'] == 'running':
        return jsonify({'error': 'Analysis already running'}), 409
    t = threading.Thread(target=_run_analysis, daemon=True)
    t.start()
    return jsonify({'ok': True, 'total': len(library)})


@app.route('/api/insights/analyse/cancel', methods=['POST'])
def insights_cancel_analysis():
    if analysis_state['status'] == 'running':
        analysis_state['status'] = 'cancelled'
        return jsonify({'ok': True})
    return jsonify({'error': 'No analysis is currently running'}), 409


@app.route('/api/insights/analyse/status')
def insights_analysis_status():
    return jsonify(analysis_state)


# ═══════════════════════════════════════════════════════════════════════════════
# Insights — Phase 2 & 3: Sonic Profile + Gear Fit
# ═══════════════════════════════════════════════════════════════════════════════

_FREQ_BANDS = [
    ('sub_bass',       20,    40,    28,   'Sub-bass'),
    ('bass',           40,    80,    57,   'Bass'),
    ('mid_bass',       80,   160,   113,   'Mid-bass'),
    ('lower_mids',    160,   320,   226,   'Lower mids'),
    ('mids',          320,  1000,   566,   'Mids'),
    ('upper_mids',   1000,  2500,  1581,   'Upper mids'),
    ('presence',     2500,  5000,  3536,   'Presence'),
    ('lower_treble', 5000,  8000,  6325,   'Lower treble'),
    ('upper_treble', 8000, 12000,  9798,   'Upper treble'),
    ('air',         12000, 20000, 15492,   'Air'),
]


def _load_features():
    p = _features_file()
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text())
    except Exception:
        return []


def _library_salience(features):
    """
    Per-band salience weights derived from actual track band energies.
    S_b = 0.7 * normalised(L_b) + 0.3 * normalised(V_b)
    where L_b = mean band energy fraction, V_b = std across tracks.
    Returns None if no tracks have 10-band data (analysis needs re-run).
    """
    import numpy as np
    valid = [f for f in features
             if f.get('band_energy') and len(f['band_energy']) == 10]
    if not valid:
        return None
    matrix = np.array([f['band_energy'] for f in valid], dtype=float)  # (N, 10)
    L_b = matrix.mean(axis=0)
    V_b = matrix.std(axis=0)
    # Normalise each to [0, 1] before combining so scales are comparable
    def _norm01(arr):
        rng = arr.max() - arr.min()
        return (arr - arr.min()) / (rng + 1e-12)
    S_b = 0.7 * _norm01(L_b) + 0.3 * _norm01(V_b)
    S_b = S_b / (S_b.sum() + 1e-12)  # normalise to sum = 1
    return {b[0]: round(float(v), 6) for b, v in zip(_FREQ_BANDS, S_b)}


def _iem_features(measurement):
    """
    Per-band deviation from neutral (75 dB flat) and roughness (within-band SPL std).
    Normalises the raw measurement to 75 dB at 1 kHz first (raw stored data is un-normalised).
    Returns {'deviation': {band: dB}, 'roughness': {band: dB}} or None.
    """
    import numpy as np
    if not measurement or len(measurement) < 50:
        return None
    # Normalise to 75 dB at 1 kHz — raw iems.json data is not pre-normalised
    ref = _spl_at_1khz(measurement)
    if ref is not None:
        measurement = _shift(measurement, NORM_REF_DB - ref)
    freqs = np.array([p[0] for p in measurement], dtype=float)
    spls  = np.array([p[1] for p in measurement], dtype=float)
    deviation = {}
    roughness = {}
    for key, f_lo, f_hi, _, _ in _FREQ_BANDS:
        mask = (freqs >= f_lo) & (freqs < f_hi)
        if mask.any():
            band_spls        = spls[mask]
            deviation[key]   = round(float(band_spls.mean()) - 75.0, 2)
            roughness[key]   = round(float(band_spls.std()), 2)
        else:
            deviation[key]   = 0.0
            roughness[key]   = 0.0
    return {'deviation': deviation, 'roughness': roughness}


def _iem_character_label(deviation):
    """Human-readable tonal character from 10-band deviation dict."""
    low_end  = (deviation.get('sub_bass', 0) + deviation.get('bass', 0)
                + deviation.get('mid_bass', 0)) / 3
    body     = (deviation.get('lower_mids', 0) + deviation.get('mids', 0)) / 2
    detail   = (deviation.get('upper_mids', 0) + deviation.get('presence', 0)) / 2
    bright   = (deviation.get('lower_treble', 0) + deviation.get('upper_treble', 0)
                + deviation.get('air', 0)) / 3
    tags = []
    if   low_end >  4:  tags.append('bass-heavy')
    elif low_end >  2:  tags.append('warm')
    elif low_end < -3:  tags.append('bass-light')
    if   body    >  3:  tags.append('full-bodied')
    elif body    < -3:  tags.append('lean mids')
    if   detail  >  4:  tags.append('forward presence')
    elif detail  < -3:  tags.append('smooth mids')
    if   bright  >  4:  tags.append('bright')
    elif bright  >  2:  tags.append('airy')
    elif bright  < -4:  tags.append('dark')
    if not tags:        tags.append('neutral')
    return ', '.join(tags)


def _library_character_label(salience):
    """Top-band description of the library's spectral salience profile."""
    top = max(salience, key=salience.get)
    return {
        'sub_bass':      'sub-bass heavy',
        'bass':          'bass-driven',
        'mid_bass':      'warm and punchy',
        'lower_mids':    'full lower midrange',
        'mids':          'mid-centric and vocal',
        'upper_mids':    'detail and clarity focused',
        'presence':      'presence-forward',
        'lower_treble':  'bright lower treble',
        'upper_treble':  'upper treble emphasis',
        'air':           'airy and extended',
    }.get(top, 'balanced')


def _apply_peq(measurement, peq_profile):
    """
    Apply a PEQ profile to a [[freq, spl], ...] measurement.
    Uses biquad filter math (Audio EQ Cookbook coefficients) evaluated at each
    measurement frequency via z = e^(j·2π·f/Fs) with a high virtual Fs for
    near-analog accuracy.  Re-normalises to 75 dB at 1 kHz afterwards so the
    returned curve stays on the same reference as the base measurement.
    """
    import numpy as np
    if not measurement or not peq_profile:
        return measurement

    freqs = np.array([p[0] for p in measurement], dtype=float)
    spls  = np.array([p[1] for p in measurement], dtype=float).copy()

    spls += float(peq_profile.get('preamp_db') or 0.0)

    Fs = 192000.0   # high virtual sample rate → near-analog accuracy below ~20 kHz

    for filt in (peq_profile.get('filters') or []):
        if not filt.get('enabled', True):
            continue
        ftype = (filt.get('type') or 'PK').upper()
        if ftype in ('NO', 'AP'):
            continue        # notch / all-pass: negligible magnitude change
        fc   = float(filt.get('fc')   or 1000.0)
        gain = float(filt.get('gain') or 0.0)
        q    = float(filt.get('q')    or 0.707)
        if q <= 0:        q = 0.707
        if fc <= 0 or fc >= Fs / 2:
            continue

        w0 = 2 * np.pi * fc / Fs
        cw = np.cos(w0);  sw = np.sin(w0)
        A  = 10 ** (gain / 40.0)
        al = sw / (2 * q)

        if ftype == 'PK':
            b0, b1, b2 = 1 + al*A,  -2*cw, 1 - al*A
            a0, a1, a2 = 1 + al/A,  -2*cw, 1 - al/A
        elif ftype in ('LSC', 'LS'):
            sqA = np.sqrt(A)
            b0 =    A * ((A+1) - (A-1)*cw + 2*sqA*al)
            b1 = 2*A  * ((A-1) - (A+1)*cw)
            b2 =    A * ((A+1) - (A-1)*cw - 2*sqA*al)
            a0 =        (A+1)  + (A-1)*cw + 2*sqA*al
            a1 =   -2 * ((A-1) + (A+1)*cw)
            a2 =        (A+1)  + (A-1)*cw - 2*sqA*al
        elif ftype in ('HSC', 'HS'):
            sqA = np.sqrt(A)
            b0 =    A * ((A+1) + (A-1)*cw + 2*sqA*al)
            b1 = -2*A * ((A-1) + (A+1)*cw)
            b2 =    A * ((A+1) + (A-1)*cw - 2*sqA*al)
            a0 =        (A+1)  - (A-1)*cw + 2*sqA*al
            a1 =    2 * ((A-1) - (A+1)*cw)
            a2 =        (A+1)  - (A-1)*cw - 2*sqA*al
        elif ftype in ('LPQ', 'LP', 'LPF'):
            b0 = (1 - cw) / 2;  b1 = 1 - cw;   b2 = (1 - cw) / 2
            a0 = 1 + al;         a1 = -2 * cw;   a2 = 1 - al
        elif ftype in ('HPQ', 'HP', 'HPF'):
            b0 = (1 + cw) / 2;  b1 = -(1 + cw); b2 = (1 + cw) / 2
            a0 = 1 + al;         a1 = -2 * cw;   a2 = 1 - al
        else:
            continue

        # Evaluate |H(e^jω)| at each measurement frequency
        # H(z) = (b0 + b1·z⁻¹ + b2·z⁻²) / (a0 + a1·z⁻¹ + a2·z⁻²)
        omega = 2 * np.pi * freqs / Fs
        zin   = np.exp(-1j * omega)
        num   = b0 + b1 * zin + b2 * zin**2
        den   = a0 + a1 * zin + a2 * zin**2
        spls += 20 * np.log10(np.abs(num / den) + 1e-12)

    # Re-normalise to 75 dB at 1 kHz (same convention as base measurement)
    ref_idx = int(np.argmin(np.abs(freqs - 1000.0)))
    spls   += 75.0 - spls[ref_idx]

    return [[float(freqs[i]), float(spls[i])] for i in range(len(freqs))]


def _fit_score(salience, iem_feat):
    """
    Option A scoring: ideal IEM = flat (deviation = 0 for all bands).
    Loss = Σ(S_b · |D_b|)
    Raw  = 100 · exp(−0.22 · Loss)
    Penalties: treble roughness, extreme deviation (> ±5 dB).
    """
    import numpy as np
    band_keys = [b[0] for b in _FREQ_BANDS]
    S = np.array([salience.get(k, 0.0)                    for k in band_keys])
    D = np.array([iem_feat['deviation'].get(k, 0.0)        for k in band_keys])
    R = np.array([iem_feat['roughness'].get(k, 0.0)        for k in band_keys])

    loss    = float((S * np.abs(D)).sum())
    # k=0.06: neutral IEM (~3 dB avg dev) → ~83%; V-shaped (~10 dB avg dev) → ~55%
    raw     = 100.0 * np.exp(-0.06 * loss)

    # Roughness penalty — weighted by salience on lower & upper treble (bands 7, 8)
    p_rough   = 6.0 * float(S[7] * R[7] + S[8] * R[8])
    # Extreme deviation penalty — only beyond ±12 dB (severe coloring)
    p_extreme = 2.0 * float((S * np.maximum(0, np.abs(D) - 12.0)).sum())

    return round(float(np.clip(raw - p_rough - p_extreme, 0.0, 100.0)), 1)


def _blindspot_analysis(salience, iem_results):
    """
    Per-band coverage = how close the nearest IEM is to neutral in that band.
    Overall = salience-weighted mean coverage.
    """
    import numpy as np
    if not iem_results:
        return None
    band_keys = [b[0] for b in _FREQ_BANDS]
    band_cov  = {}
    for k in band_keys:
        min_dev       = min(abs(r['deviation'].get(k, 0)) for r in iem_results)
        band_cov[k]   = round(float(100.0 * np.exp(-0.35 * min_dev)), 1)
    S       = np.array([salience.get(k, 0.0) for k in band_keys])
    cov_arr = np.array([band_cov[k]          for k in band_keys])
    overall = round(float((S * cov_arr).sum()), 1)   # already 0-100 weighted
    # Surface the two weakest bands for UI callouts
    weakest = sorted(band_keys, key=lambda k: band_cov[k])[:2]
    return {'band_coverage': band_cov, 'overall': overall, 'weakest_bands': weakest}


def _recommendations(salience, iem_results, blindspot):
    """Plain-English recommendations from salience + blindspot analysis."""
    band_full = {
        'sub_bass': 'sub-bass extension', 'bass': 'bass', 'mid_bass': 'mid-bass warmth',
        'lower_mids': 'lower midrange', 'mids': 'midrange', 'upper_mids': 'upper mids',
        'presence': 'presence region', 'lower_treble': 'lower treble',
        'upper_treble': 'upper treble', 'air': 'air / extension',
    }
    band_labels = {b[0]: b[4] for b in _FREQ_BANDS}
    if not iem_results:
        return ['Add IEMs or headphones to your Gear library to see personalised recommendations.']

    recs = []
    lib_char = _library_character_label(salience)

    if blindspot:
        for bk in blindspot.get('weakest_bands', []):
            cov = blindspot['band_coverage'].get(bk, 100)
            sal = salience.get(bk, 0)
            if cov < 55 and sal > 0.08:
                recs.append(
                    f"Your collection has limited coverage in the {band_full[bk]} region "
                    f"({cov:.0f}% coverage), yet your library exercises it notably. "
                    f"A more neutral IEM in this band would improve fidelity here."
                )

    band_keys = [b[0] for b in _FREQ_BANDS]
    avg_dev = {k: sum(r['deviation'].get(k, 0) for r in iem_results) / len(iem_results)
               for k in band_keys}

    bright_sal = salience.get('lower_treble', 0) + salience.get('upper_treble', 0)
    bright_dev = avg_dev.get('lower_treble', 0) + avg_dev.get('upper_treble', 0)
    if bright_sal > 0.20 and bright_dev > 3.0:
        recs.append(
            "Your library and your gear both lean bright. "
            "A smoother, more neutral signature in the treble could reduce fatigue on long sessions."
        )

    mid_sal = salience.get('mids', 0) + salience.get('upper_mids', 0)
    mid_dev = avg_dev.get('mids', 0) + avg_dev.get('upper_mids', 0)
    if mid_sal > 0.25 and mid_dev < -3.0:
        recs.append(
            "Your library is vocal and mid-forward, but your gear trends towards recessed mids on average. "
            "A more neutral or mid-forward tuning would let vocals cut through better."
        )

    if not recs:
        recs.append(
            f"Your gear collection is well-matched to your {lib_char} library. "
            "No significant gaps detected across your current lineup."
        )
    return recs


@app.route('/api/insights/sonic-profile')
def insights_sonic_profile():
    import numpy as np, random as _rnd
    features = _load_features()
    valid = [f for f in features if f.get('brightness') and f.get('energy') is not None]
    if not valid:
        return jsonify({'error': 'Run audio analysis first'}), 404

    brightness = np.array([f['brightness'] for f in valid], dtype=float)
    energy     = np.array([f['energy']     for f in valid], dtype=float)

    def _hist(arr, n=25):
        counts, edges = np.histogram(arr, bins=n)
        mids = [(edges[i] + edges[i+1]) / 2 for i in range(len(edges) - 1)]
        return {'counts': counts.tolist(), 'midpoints': [round(m, 2) for m in mids]}

    def _stats(arr):
        return {k: round(float(v), 2) for k, v in {
            'min': arr.min(), 'max': arr.max(), 'mean': arr.mean(),
            'median': np.median(arr), 'p25': np.percentile(arr, 25),
            'p75': np.percentile(arr, 75),
        }.items()}

    sample = _rnd.sample(valid, min(600, len(valid)))
    scatter = [{'x': round(f['brightness'], 0), 'y': round(f['energy'], 5)} for f in sample]

    return jsonify({
        'track_count': len(valid),
        'brightness':  {'histogram': _hist(brightness), 'stats': _stats(brightness)},
        'energy':      {'histogram': _hist(energy),     'stats': _stats(energy)},
        'scatter':     scatter,
    })


@app.route('/api/insights/gear-fit')
def insights_gear_fit():
    features = _load_features()
    salience = _library_salience(features)
    if not salience:
        return jsonify({
            'error': 'Re-run audio analysis to compute 10-band library features.'
        }), 404

    iems_path = DATA_DIR / 'iems.json'
    iems = json.loads(iems_path.read_text()) if iems_path.exists() else []

    iem_results = []
    for iem in iems:
        measurement = iem.get('measurement_L')
        feat = _iem_features(measurement)
        if not feat:
            continue

        # PEQ variants — apply PEQ, re-compute features and score
        peq_variants = []
        for peq in (iem.get('peq_profiles') or []):
            peq_meas = _apply_peq(measurement, peq)
            peq_feat = _iem_features(peq_meas)
            if not peq_feat:
                continue
            peq_variants.append({
                'peq_id':   peq['id'],
                'name':     peq.get('name', 'PEQ'),
                'deviation': peq_feat['deviation'],
                'roughness': peq_feat['roughness'],
                'character': _iem_character_label(peq_feat['deviation']),
                'fit_score': _fit_score(salience, peq_feat),
            })

        iem_results.append({
            'id':          iem['id'],
            'name':        iem['name'],
            'deviation':   feat['deviation'],
            'roughness':   feat['roughness'],
            'character':   _iem_character_label(feat['deviation']),
            'fit_score':   _fit_score(salience, feat),
            'peq_variants': peq_variants,
        })
    iem_results.sort(key=lambda x: -x['fit_score'])

    blindspot = _blindspot_analysis(salience, iem_results)

    return jsonify({
        'salience':          salience,
        'library_character': _library_character_label(salience),
        'band_labels':       {b[0]: b[4] for b in _FREQ_BANDS},
        'iems':              iem_results,
        'blindspot':         blindspot,
        'recommendations':   _recommendations(salience, iem_results, blindspot),
    })


load_library()

if __name__ == '__main__':
    port = int(os.environ.get('TUNEBRIDGE_PORT', 5001))
    if HAS_WAITRESS:
        print(f' * TuneBridge running on http://127.0.0.1:{port}')
        waitress_serve(app, host='127.0.0.1', port=port, threads=4)
    else:
        app.run(debug=False, host='127.0.0.1', port=port, use_reloader=False)
