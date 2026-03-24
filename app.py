from flask import Flask, jsonify, request, send_file, Response
from flask_cors import CORS
import os
import json
import uuid
import threading
import time
import shutil
from pathlib import Path
from mutagen.flac import FLAC
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4
import hashlib
from PIL import Image

app = Flask(__name__, static_folder='static', static_url_path='')
CORS(app)

MUSIC_BASE = Path('/Volumes/Storage/Music/FLAC')
DATA_DIR = Path(__file__).parent / 'data'
PLAYLIST_FILE = DATA_DIR / 'playlists.json'
LIBRARY_CACHE = DATA_DIR / 'library.json'
ARTWORK_DIR = DATA_DIR / 'artwork'
PLAYLIST_ARTWORK_DIR = DATA_DIR / 'playlist_artwork'
SETTINGS_FILE = DATA_DIR / 'settings.json'

DEFAULT_SETTINGS = {
    'poweramp_mount':   '/Volumes/FIIO M21',
    'ap80_mount':       '/Volumes/AP80',
    'poweramp_prefix':  '',   # internal device path, e.g. /storage/sdcard0
    'ap80_prefix':      '',   # internal device path, e.g. /mnt/sdcard
}

DATA_DIR.mkdir(exist_ok=True)
ARTWORK_DIR.mkdir(exist_ok=True)
PLAYLIST_ARTWORK_DIR.mkdir(exist_ok=True)

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
    rel_path = str(filepath.relative_to(MUSIC_BASE))
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
        }
    except Exception as e:
        print(f"Error scanning {filepath}: {e}")
        return None


def do_scan():
    global library, scan_state

    prev_count = len(library)
    scan_state.update({'status': 'scanning', 'message': 'Finding music files...', 'progress': 0, 'total': 0, 'new_tracks': 0})

    if not MUSIC_BASE.exists():
        scan_state.update({'status': 'error', 'message': f'Music folder not found: {MUSIC_BASE}'})
        return

    files = []
    for root, dirs, filenames in os.walk(MUSIC_BASE):
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
        tracks = [t for t in tracks if t.get('artist') == artist_filter or t.get('album_artist') == artist_filter]
    if album_filter:
        tracks = [t for t in tracks if t.get('album') == album_filter]
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
        if name not in artists:
            artists[name] = {'name': name, 'albums': set(), 'track_count': 0, 'artwork_key': None}
        artists[name]['albums'].add(t.get('album'))
        artists[name]['track_count'] += 1
        if not artists[name]['artwork_key'] and t.get('artwork_key'):
            artists[name]['artwork_key'] = t['artwork_key']

    result = [
        {'name': k, 'album_count': len(v['albums']), 'track_count': v['track_count'], 'artwork_key': v['artwork_key']}
        for k, v in sorted(artists.items())
    ]
    return jsonify(result)


@app.route('/api/library/albums')
def get_albums():
    artist_filter = request.args.get('artist', '')

    with library_lock:
        tracks = library[:]

    if artist_filter:
        tracks = [t for t in tracks if t.get('artist') == artist_filter or t.get('album_artist') == artist_filter]

    albums = {}
    for t in tracks:
        artist = t.get('album_artist') or t.get('artist') or 'Unknown Artist'
        album = t.get('album') or 'Unknown Album'
        key = f"{artist}||{album}"
        if key not in albums:
            albums[key] = {
                'name': album, 'artist': artist,
                'year': t.get('year'), 'genre': t.get('genre'),
                'track_count': 0, 'artwork_key': t.get('artwork_key'),
            }
        albums[key]['track_count'] += 1
        if not albums[key]['artwork_key'] and t.get('artwork_key'):
            albums[key]['artwork_key'] = t['artwork_key']

    result = sorted(albums.values(), key=lambda x: (x['artist'], x['year'] or '0', x['name']))
    return jsonify(result)


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
    for p in result:
        p['has_artwork'] = has_playlist_artwork(p['id'])
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
    return jsonify(load_settings())


@app.route('/api/settings', methods=['PUT'])
def put_settings():
    data = request.json or {}
    settings = load_settings()
    for key in DEFAULT_SETTINGS:
        if key in data:
            settings[key] = data[key]
    save_settings(settings)
    return jsonify(settings)


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

def get_device_music_path(device):
    settings = load_settings()
    if device == 'poweramp':
        return Path(settings.get('poweramp_mount', '/Volumes/FIIO M21')) / 'Music'
    elif device == 'ap80':
        return Path(settings.get('ap80_mount', '/Volumes/AP80')) / 'Music'
    return None

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
    device = data.get('device')
    if device not in ('poweramp', 'ap80'):
        return jsonify({'error': 'Invalid device'}), 400

    device_path = get_device_music_path(device)
    if not device_path or not device_path.exists():
        return jsonify({'error': 'Device not mounted or Music folder not found'}), 400

    sync_state = {
        'status': 'scanning',
        'device': device,
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
            local_files = set(walk_music_files(MUSIC_BASE))
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
    device = sync_state['device']
    device_path = get_device_music_path(device)

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
            src = MUSIC_BASE / rel
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
            dst = MUSIC_BASE / rel
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


if __name__ == '__main__':
    load_library()
    app.run(debug=True, port=5001, use_reloader=False)
