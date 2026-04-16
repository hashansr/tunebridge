from flask import Flask, jsonify, request, send_file, Response
import os
import sys
import json
import io
import zipfile
import subprocess
import plistlib
import sqlite3
import tempfile
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
import random
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

import db as _db
import migrate as _migrate

_mpv_lib = None
MPV_AVAILABLE = False
_mpv_import_error = None
_mpv_import_lock = threading.Lock()


def _runtime_env():
    """Build a process env with common Homebrew locations available in PATH.

    GUI-launched macOS apps often have a minimal PATH that does not include
    /opt/homebrew/bin or /usr/local/bin, which breaks command discovery.
    """
    env = os.environ.copy()
    path_entries = [p for p in str(env.get('PATH', '')).split(':') if p]
    preferred = [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/opt/homebrew/sbin',
        '/usr/local/sbin',
    ]
    for p in preferred:
        if p not in path_entries:
            path_entries.append(p)
    env['PATH'] = ':'.join(path_entries)
    return env


def _find_executable(name):
    """Resolve executable path, tolerant of GUI PATH limitations."""
    env = _runtime_env()
    found = shutil.which(name, path=env.get('PATH'))
    if found:
        return found
    fallbacks = {
        'brew': ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'],
        'mpv': ['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv'],
    }
    for p in fallbacks.get(name, []):
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def _find_libmpv_path():
    """Best-effort discovery for libmpv.dylib across common Homebrew layouts."""
    candidates = [
        '/opt/homebrew/lib/libmpv.dylib',
        '/usr/local/lib/libmpv.dylib',
        '/opt/homebrew/opt/mpv/lib/libmpv.dylib',
        '/usr/local/opt/mpv/lib/libmpv.dylib',
    ]
    for p in candidates:
        if os.path.isfile(p):
            return p
    for root in ('/opt/homebrew/Cellar/mpv', '/usr/local/Cellar/mpv'):
        if not os.path.isdir(root):
            continue
        try:
            versions = sorted(os.listdir(root), reverse=True)
        except Exception:
            versions = []
        for v in versions:
            p = os.path.join(root, v, 'lib', 'libmpv.dylib')
            if os.path.isfile(p):
                return p
    return None


def _ensure_python_mpv_installed():
    """Ensure python-mpv is importable in the current interpreter.

    Returns (ok: bool, error_message: Optional[str]).
    """
    try:
        import importlib
        importlib.import_module('mpv')
        return True, None
    except Exception:
        pass
    try:
        proc = subprocess.run(
            [sys.executable, '-m', 'pip', 'install', 'python-mpv'],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=600,
            env=_runtime_env(),
        )
    except subprocess.TimeoutExpired:
        return False, 'python-mpv install timed out'
    except Exception as e:
        return False, f'python-mpv install failed: {e}'
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or 'pip install python-mpv failed').strip()
        return False, msg[-1200:]
    return True, None


def _refresh_mpv_backend(force=False):
    """Try to (re)load python-mpv + libmpv at runtime."""
    global _mpv_lib, MPV_AVAILABLE, _mpv_import_error
    if MPV_AVAILABLE and not force:
        return True
    with _mpv_import_lock:
        if MPV_AVAILABLE and not force:
            return True
        try:
            import importlib
            import ctypes.util as _ctypes_util
            _orig_find_library = _ctypes_util.find_library

            def _patched_find_library(name):
                result = _orig_find_library(name)
                if result is None and name == 'mpv':
                    _p = _find_libmpv_path()
                    if _p:
                        return _p
                return result

            _ctypes_util.find_library = _patched_find_library
            _mpv_lib = importlib.import_module('mpv')
            MPV_AVAILABLE = True
            _mpv_import_error = None
        except (ImportError, OSError) as e:
            MPV_AVAILABLE = False
            _mpv_import_error = str(e)
        finally:
            try:
                _ctypes_util.find_library = _orig_find_library
            except Exception:
                pass
    return MPV_AVAILABLE


def _mpv_runtime_status():
    """Snapshot mpv runtime readiness components for UI diagnostics."""
    py_ok = True
    py_err = None
    try:
        import importlib
        importlib.import_module('mpv')
    except Exception as e:
        py_ok = False
        py_err = str(e)
    lib_path = _find_libmpv_path()
    brew_path = _find_executable('brew')
    mpv_bin = _find_executable('mpv')
    return {
        'python_mpv_ok': py_ok,
        'python_mpv_error': py_err,
        'libmpv_path': lib_path,
        'brew_path': brew_path,
        'mpv_binary_path': mpv_bin,
    }


_refresh_mpv_backend(force=True)

app = Flask(__name__, static_folder='static', static_url_path='')
app.config['MAX_CONTENT_LENGTH'] = 10 * 1024 * 1024  # 10 MB upload limit

# Prevent WKWebView (pywebview) from aggressively caching JS/CSS across app launches.
# Without this, updated static files are invisible until the WKWebView disk cache expires.
@app.after_request
def add_cache_headers(response):
    if request.path.endswith(('.css', '.js', '.html')) or request.path == '/':
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
    return response

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
ARTWORK_DIR = DATA_DIR / 'artwork'
PLAYLIST_ARTWORK_DIR = DATA_DIR / 'playlist_artwork'
ARTIST_ARTWORK_DIR = DATA_DIR / 'artist_artwork'

DEFAULT_SETTINGS = {
    'library_path':     str(Path.home() / 'Music'),
    'library_structure': 'artist_album_track',
    'preferred_audio_format': 'flac',
    'onboarding_completed': False,
    'poweramp_mount':   '/Volumes/FIIO M21',
    'ap80_mount':       '/Volumes/AP80',
    'poweramp_prefix':  '',   # internal device path, e.g. /storage/sdcard0
    'ap80_prefix':      '',   # internal device path, e.g. /mnt/sdcard
    'exclusive_mode':   False,  # CoreAudio exclusive (bit-perfect, requires mpv); off by default for first-time users
    'audio_device':     'auto', # mpv audio device name; 'auto' = system default
    # Artist image service settings
    'artist_image_service': 'itunes',  # 'itunes' | 'lastfm' | 'fanart'
    'lastfm_api_key':   '',
    'fanart_api_key':   '',
    'listening_tracking_enabled': True,
}

_DEFAULT_GEAR_PROFILES = {
    'dap_profiles': [
        {'model': 'android_generic',  'name': 'Android (Generic DAP OS - FiiO / Sony / iBasso / HiBy)', 'playlist_format': '.m3u8', 'export_folder': 'Playlists',            'path_prefix': '',  'mount_name': 'MyDAP'},
        {'model': 'uapp',             'name': 'USB Audio Player Pro',                                     'playlist_format': '.m3u8', 'export_folder': 'Music/Playlists',      'path_prefix': '',  'mount_name': 'MyDAP'},
        {'model': 'poweramp',         'name': 'Poweramp',                                                  'playlist_format': '.m3u8', 'export_folder': 'Music/Playlists',      'path_prefix': '',  'mount_name': 'MyDAP'},
        {'model': 'hiby_music',       'name': 'HiBy Music',                                                'playlist_format': '.m3u8', 'export_folder': 'HibyMusic/Playlists',  'path_prefix': '',  'mount_name': 'HiBy'},
        {'model': 'neutron',          'name': 'Neutron Music Player',                                      'playlist_format': '.m3u8', 'export_folder': 'NeutronMP/Playlists',  'path_prefix': '',  'mount_name': 'MyDAP'},
        {'model': 'foobar2000',       'name': 'Foobar2000',                                                'playlist_format': '.m3u8', 'export_folder': 'foobar2000',           'path_prefix': '',  'mount_name': 'MyDAP'},
        {'model': 'mango_os',         'name': 'Mango OS (iBasso Pure Mode)',                              'playlist_format': '.m3u',  'export_folder': 'Music',                'path_prefix': '',  'mount_name': 'iBasso'},
        {'model': 'fiio_pure_music',  'name': 'FiiO Pure Music Mode',                                      'playlist_format': '.m3u8', 'export_folder': 'FiiOMusic/playlist',   'path_prefix': '',  'mount_name': 'FiiO'},
        {'model': 'sony_walkman',     'name': 'Sony Walkman App',                                          'playlist_format': '.m3u8', 'export_folder': 'Music/Playlists',      'path_prefix': '',  'mount_name': 'WALKMAN'},
        {'model': 'rockbox',          'name': 'Rockbox',                                                   'playlist_format': '.m3u8', 'export_folder': 'Playlists',            'path_prefix': '',  'mount_name': 'Rockbox'},
        {'model': 'hidizs_ap80',      'name': 'Hidizs AP80 Pro Max (Hidizs OS)',                          'playlist_format': '.m3u',  'export_folder': 'playlist_data',        'path_prefix': '..','mount_name': 'AP80'},
    ],
    'iem_types': ['IEM', 'Headphone'],
}

_DEFAULT_GENRE_FAMILIES = {
    'ambient': ['dark ambient', 'drone', 'new age'],
    'blues': ['blues rock', 'delta blues', 'electric blues'],
    'classical': ['baroque', 'romantic', 'orchestral', 'chamber'],
    'country': ['alt-country', 'americana', 'country rock'],
    'electronic': ['edm', 'house', 'techno', 'trance', 'drum and bass', 'ambient electronic', 'downtempo'],
    'folk': ['indie folk', 'traditional folk', 'singer-songwriter'],
    'hip hop': ['rap', 'trap', 'boom bap', 'lo-fi hip hop'],
    'jazz': ['vocal jazz', 'jazz fusion', 'contemporary jazz', 'bebop', 'soul jazz'],
    'metal': ['heavy metal', 'nu metal', 'death metal', 'black metal', 'progressive metal', 'metalcore'],
    'pop': ['synthpop', 'indie pop', 'dance pop', 'electropop'],
    'r&b': ['neo soul', 'soul', 'funk'],
    'reggae': ['dub', 'dancehall', 'ska'],
    'rock': ['alternative rock', 'hard rock', 'classic rock', 'progressive rock', 'indie rock', 'punk rock'],
}

_DEFAULT_PLAYLIST_GEN_CONFIG = {
    'max_library_tracks': 5000,
    'candidate_pool_cap': 1500,
    'default_playlist_length': 20,
    'min_playlist_length': 8,
    'max_playlist_length': 80,
    'deterministic_default': True,
    'weights': {
        'similarity': 0.35,
        'genre': 0.2,
        'mood': 0.2,
        'sound': 0.1,
        'diversity': 0.15,
    },
    'transition_weights': {
        'energy': 0.4,
        'brightness': 0.25,
        'year': 0.15,
        'genre': 0.2,
    },
}

_DEFAULT_FAVOURITES = {
    'songs': [],
    'albums': [],
    'artists': [],
    'dap_exports': {},
}


def get_music_base():
    settings = load_settings()
    return Path(settings.get('library_path', DEFAULT_SETTINGS['library_path']))

DATA_DIR.mkdir(parents=True, exist_ok=True)
ARTWORK_DIR.mkdir(exist_ok=True)
PLAYLIST_ARTWORK_DIR.mkdir(exist_ok=True)
ARTIST_ARTWORK_DIR.mkdir(exist_ok=True)

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
    'warnings': [],
    'errors': [],
    'current': '',
    'local_copy_map': {},
    'local_only_sizes': {},
    'local_only_copy_sizes': {},
    'local_only_existing_sizes': {},
    'local_only_reasons': {},
    'device_only_reasons': {},
    'music_out_of_sync_count': 0,
    'music_to_add_count': 0,
    'music_to_remove_count': 0,
    'space_available_bytes': None,
    'space_total_bytes': None,
    'space_required_bytes': 0,
    'space_shortfall_bytes': 0,
    'space_ok': True,
}
sync_check_lock = threading.Lock()
sync_check_inflight = set()

LISTEN_WINDOW_SECONDS = 365 * 24 * 60 * 60
VALID_LISTEN_SECONDS = 30.0
VALID_LISTEN_RATIO = 0.4

library = []
library_lock = threading.Lock()

# ── Performance caches ────────────────────────────────────────────────────────
_home_cache = {'data': None, 'ts': 0}       # /api/home — 60s TTL
_home_cache_lock = threading.Lock()
_meta_maps_cache = None                     # _music_meta_maps() result, cleared on rescan


def format_duration(seconds):
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def get_artwork_key(artist, album):
    return hashlib.md5(f"{artist}||{album}".encode()).hexdigest()


def get_artist_image_key(artist_name):
    """MD5 of lowercased, stripped artist name — mirrors album art key pattern."""
    return hashlib.md5(artist_name.lower().strip().encode()).hexdigest()


# ── Artist image processing ──────────────────────────────────────────────────

def _process_artist_image(data: bytes) -> bytes:
    """
    Resize and compress raw image bytes to a 600×600 square progressive JPEG.
    Steps: decode → thumbnail 600px → centre-crop to square → save quality 85.
    """
    img = Image.open(io.BytesIO(data)).convert('RGB')
    img.thumbnail((600, 600), Image.LANCZOS)
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top  = (h - side) // 2
    img = img.crop((left, top, left + side, top + side))
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=85, progressive=True, optimize=True)
    return buf.getvalue()


_PRIVATE_IP_RE = re.compile(
    r'^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|localhost)',
    re.IGNORECASE
)
_ALLOWED_IMAGE_DOMAINS = {
    'i.last.fm', 'lastfm.freetls.fastly.net',
    'assets.fanart.tv', 'fanart.tv',
    'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com',
    'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com',
    'a1.mzstatic.com', 'a2.mzstatic.com', 'a3.mzstatic.com',
}


def _validate_image_url(url: str):
    """
    SSRF guard: only allow http(s) to known image CDNs.
    Returns (ok: bool, error_msg: str | None).
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return False, 'Invalid URL'
    if parsed.scheme not in ('http', 'https'):
        return False, 'Only http/https URLs are allowed'
    host = parsed.hostname or ''
    if _PRIVATE_IP_RE.match(host):
        return False, 'Private/loopback addresses are not allowed'
    # Allow known CDN domains (exact match or subdomain)
    for allowed in _ALLOWED_IMAGE_DOMAINS:
        if host == allowed or host.endswith('.' + allowed):
            return True, None
    return False, f'Image host "{host}" is not in the allowed list'


# ── Artist image search helpers ──────────────────────────────────────────────

_LASTFM_PLACEHOLDER_HASH = '2a96cbd8b46e442fc41c2b86b821562f'

import difflib as _difflib

def _name_matches(searched: str, found: str, threshold: float = 0.6) -> bool:
    """
    Return True if `found` is a plausible match for the searched artist name.
    Checks (in order): exact, substring containment, significant word overlap,
    and finally fuzzy sequence similarity. This prevents e.g. "Corey Taylor"
    matching "Taylor Swift" when both contain the token "taylor".
    """
    s = searched.lower().strip()
    f = found.lower().strip()
    if not s or not f:
        return False
    if s == f:
        return True
    # Substring: the full searched name must appear inside found (or vice versa)
    # but NOT just a single shared token — require at least 2 words to share
    s_words = [w for w in s.split() if len(w) > 2]  # ignore tiny stop-words
    f_words = set(f.split())
    if s_words:
        overlap = sum(1 for w in s_words if w in f_words)
        # Need ALL (or all-but-one for long names) search words to appear in found
        required = len(s_words) if len(s_words) <= 2 else len(s_words) - 1
        if overlap >= required:
            return True
    # Fuzzy similarity on the full name string
    return _difflib.SequenceMatcher(None, s, f).ratio() >= threshold


def _search_itunes(artist_name: str) -> list:
    """
    Search iTunes for artist-representative images.
    iTunes doesn't expose artist portraits, so we search for the artist's albums
    and return unique album artworks as portrait candidates.
    """
    try:
        url = (
            f"https://itunes.apple.com/search?"
            f"term={urlquote(artist_name)}&entity=album&limit=20&media=music&attribute=artistTerm"
        )
        req = UrlRequest(url, headers={'User-Agent': 'TuneBridge/1.0'})
        with urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode('utf-8'))
        candidates = []
        seen_thumbs = set()
        for item in data.get('results', []):
            artist_match = (item.get('artistName') or '').strip()
            # Strict name check — must actually be the right artist
            if not _name_matches(artist_name, artist_match):
                continue
            thumb = item.get('artworkUrl100', '')
            if not thumb or thumb in seen_thumbs:
                continue
            seen_thumbs.add(thumb)
            full = thumb.replace('100x100bb', '600x600bb').replace('100x100', '600x600')
            candidates.append({
                'url': full,
                'thumbnail_url': thumb,
                'source': 'itunes',
                'label': item.get('collectionName', artist_name),
            })
            if len(candidates) >= 6:
                break
        return candidates
    except Exception as e:
        print(f"[artist-img] iTunes search error: {e}")
        return []


def _search_lastfm(artist_name: str, api_key: str) -> list:
    """Search Last.fm for artist images."""
    try:
        url = (
            f"https://ws.audioscrobbler.com/2.0/?method=artist.getinfo"
            f"&artist={urlquote(artist_name)}&api_key={urlquote(api_key)}&format=json"
        )
        req = UrlRequest(url, headers={'User-Agent': 'TuneBridge/1.0'})
        with urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode('utf-8'))

        artist_data = data.get('artist', {})

        # Verify Last.fm returned the right artist (it can redirect to similar names)
        returned_name = artist_data.get('name', '')
        if returned_name and not _name_matches(artist_name, returned_name):
            print(f"[artist-img] Last.fm name mismatch: searched '{artist_name}', got '{returned_name}'")
            return []

        images = artist_data.get('image', [])
        candidates = []
        seen = set()
        for img in reversed(images):  # largest first
            img_url = img.get('#text', '').strip()
            if not img_url or _LASTFM_PLACEHOLDER_HASH in img_url:
                continue
            if img_url in seen:
                continue
            seen.add(img_url)
            thumb = next(
                (x.get('#text', '') for x in images if x.get('size') in ('large', 'medium')),
                img_url
            )
            candidates.append({
                'url': img_url,
                'thumbnail_url': thumb or img_url,
                'source': 'lastfm',
                'label': returned_name or artist_name,
            })
            if len(candidates) >= 3:
                break
        return candidates
    except Exception as e:
        print(f"[artist-img] Last.fm search error: {e}")
        return []


def _search_fanart(artist_name: str, api_key: str) -> list:
    """Search Fanart.tv for artist images (requires MusicBrainz MBID lookup first)."""
    try:
        # Step 1: MusicBrainz lookup — use Lucene phrase search ("corey taylor")
        # to avoid token-splitting that causes wrong matches (e.g. Taylor Swift for Corey Taylor)
        phrase = f'"{artist_name}"'
        mb_url = (
            f"https://musicbrainz.org/ws/2/artist/"
            f"?query=artist:{urlquote(phrase)}&fmt=json&limit=5"
        )
        req = UrlRequest(mb_url, headers={
            'User-Agent': 'TuneBridge/1.0 (https://github.com/hashansr/tunebridge)',
            'Accept': 'application/json',
        })
        with urlopen(req, timeout=10) as r:
            mb_data = json.loads(r.read().decode('utf-8'))

        # Pick the first result whose name actually matches the search
        mbid = None
        for mb_artist in mb_data.get('artists', []):
            mb_name = mb_artist.get('name', '')
            if _name_matches(artist_name, mb_name):
                mbid = mb_artist.get('id', '')
                print(f"[artist-img] MusicBrainz matched '{mb_name}' (MBID {mbid}) for '{artist_name}'")
                break

        if not mbid:
            print(f"[artist-img] MusicBrainz: no confident match for '{artist_name}'")
            return []

        # Step 2: fetch Fanart.tv using the verified MBID
        ft_url = f"https://webservice.fanart.tv/v3/music/{mbid}?api_key={urlquote(api_key)}"
        req2 = UrlRequest(ft_url, headers={'User-Agent': 'TuneBridge/1.0'})
        with urlopen(req2, timeout=10) as r2:
            ft_data = json.loads(r2.read().decode('utf-8'))

        candidates = []
        for img in ft_data.get('artistthumb', [])[:6]:
            img_url = img.get('url', '').strip()
            if img_url:
                candidates.append({
                    'url': img_url,
                    'thumbnail_url': img_url,
                    'source': 'fanart',
                    'label': artist_name,
                })
        # Fall back to artist backgrounds if no portrait thumbs
        if not candidates:
            for img in ft_data.get('artistbackground', [])[:3]:
                img_url = img.get('url', '').strip()
                if img_url:
                    candidates.append({
                        'url': img_url,
                        'thumbnail_url': img_url,
                        'source': 'fanart',
                        'label': artist_name,
                    })
        return candidates
    except Exception as e:
        print(f"[artist-img] Fanart.tv search error: {e}")
        return []


# ── ID3 tag writing ──────────────────────────────────────────────────────────

from mutagen.id3 import ID3, TIT2, TPE1, TPE2, TALB, TRCK, TDRC, TCON, TCOM, TPOS, COMM, TXXX, error as ID3Error


def _write_tags_to_file(filepath: Path, changes: dict) -> None:
    """
    Write changed tag fields to a FLAC, MP3, or M4A file using mutagen.
    Only writes fields present in `changes`. Raises on error.
    """
    ext = filepath.suffix.lower()

    if ext == '.flac':
        audio = FLAC(str(filepath))
        if audio.tags is None:
            audio.add_tags()
        mapping = {
            'title': 'TITLE', 'artist': 'ARTIST', 'album_artist': 'ALBUMARTIST',
            'album': 'ALBUM', 'track_number': 'TRACKNUMBER', 'year': 'DATE', 'genre': 'GENRE',
            'comment': 'COMMENT', 'composer': 'COMPOSER', 'disc_number': 'DISCNUMBER', 'compilation': 'COMPILATION',
        }
        for field, tag in mapping.items():
            if field in changes and changes[field] is not None:
                audio.tags[tag] = [str(changes[field])]
        audio.save()

    elif ext == '.mp3':
        try:
            audio = MP3(str(filepath), ID3=ID3)
            if audio.tags is None:
                audio.add_tags()
        except ID3Error:
            audio = MP3(str(filepath))
            audio.add_tags()

        frame_map = {
            'title': (TIT2, {}),
            'artist': (TPE1, {}),
            'album_artist': (TPE2, {}),
            'album': (TALB, {}),
            'track_number': (TRCK, {}),
            'year': (TDRC, {}),
            'genre': (TCON, {}),
            'composer': (TCOM, {}),
            'disc_number': (TPOS, {}),
        }
        for field, (FrameCls, kwargs) in frame_map.items():
            if field in changes and changes[field] is not None:
                audio.tags.add(FrameCls(encoding=3, text=str(changes[field]), **kwargs))
        if 'comment' in changes and changes['comment'] is not None:
            audio.tags.setall('COMM', [COMM(encoding=3, lang='eng', desc='', text=str(changes['comment']))])
        if 'compilation' in changes and changes['compilation'] is not None:
            val = str(changes['compilation']).strip().lower()
            normalized = '1' if val in ('1', 'true', 'yes', 'on') else '0'
            audio.tags.setall('TXXX:TCMP', [TXXX(encoding=3, desc='TCMP', text=normalized)])
        audio.save()

    elif ext in ('.m4a', '.aac', '.mp4'):
        audio = MP4(str(filepath))
        if audio.tags is None:
            audio.add_tags()
        mp4_map = {
            'title': '\xa9nam', 'artist': '\xa9ART', 'album_artist': 'aART',
            'album': '\xa9alb', 'year': '\xa9day', 'genre': '\xa9gen',
            'comment': '\xa9cmt', 'composer': '\xa9wrt',
        }
        for field, tag in mp4_map.items():
            if field in changes and changes[field] is not None:
                audio.tags[tag] = [str(changes[field])]
        if 'track_number' in changes and changes['track_number'] is not None:
            try:
                tn = int(str(changes['track_number']).split('/')[0])
                audio.tags['trkn'] = [(tn, 0)]
            except (ValueError, TypeError):
                pass
        if 'disc_number' in changes and changes['disc_number'] is not None:
            try:
                raw = str(changes['disc_number'])
                dn = int(raw.split('/')[0].strip())
                total = 0
                if '/' in raw:
                    try:
                        total = int(raw.split('/')[1].strip())
                    except Exception:
                        total = 0
                audio.tags['disk'] = [(dn, total)]
            except (ValueError, TypeError):
                pass
        if 'compilation' in changes and changes['compilation'] is not None:
            val = str(changes['compilation']).strip().lower()
            audio.tags['cpil'] = [1 if val in ('1', 'true', 'yes', 'on') else 0]
        audio.save()

    else:
        raise ValueError(f"Unsupported file format: {ext}")


def _update_library_track(track_id: str, changes: dict):
    """Update the in-memory library list after a tag write."""
    with library_lock:
        for t in library:
            if t.get('id') == track_id:
                t.update({k: v for k, v in changes.items() if v is not None})
                # Recompute duration_fmt if needed (not affected by tag changes)
                break


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
        _db.db_save_library(tracks)
    except Exception as e:
        print(f"Error saving library cache: {e}")

    new_count = len(tracks) - prev_count
    scan_state.update({'status': 'done', 'message': f'Library ready — {len(tracks)} tracks', 'progress': len(files), 'total': len(files), 'new_tracks': new_count, 'total_tracks': len(tracks)})
    print(f"Scan complete: {len(tracks)} tracks ({new_count:+d} new)")
    _invalidate_home_cache()
    global _meta_maps_cache, _stream_track_cache
    _meta_maps_cache = None
    _stream_track_cache = {}


def load_library():
    global library
    try:
        data = _db.db_load_library()
        if data:
            with library_lock:
                library = data
            scan_state.update({'status': 'done', 'message': f'Library ready — {len(data)} tracks', 'total': len(data), 'progress': len(data), 'new_tracks': 0, 'total_tracks': len(data)})
            print(f"Loaded {len(data)} tracks from SQLite")
            return
    except Exception as e:
        print(f"Error loading library from SQLite: {e}")
    threading.Thread(target=do_scan, daemon=True).start()


def load_settings():
    return _db.db_load_settings(DEFAULT_SETTINGS)


def save_settings(s):
    _db.db_save_settings(s)


def load_playlists():
    return _db.db_load_playlists()


def save_playlists(playlists):
    _db.db_save_playlists(playlists)
    _invalidate_home_cache()


def _normalize_favourite_rows(rows):
    out = []
    seen = set()
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, dict):
            rid = str(row.get('id') or '').strip()
            added_at = int(row.get('added_at') or 0)
        else:
            rid = str(row or '').strip()
            added_at = 0
        if not rid or rid in seen:
            continue
        seen.add(rid)
        out.append({
            'id': rid,
            'added_at': added_at if added_at > 0 else int(time.time()),
        })
    return out


def _normalize_favourites_payload(payload):
    base = dict(_DEFAULT_FAVOURITES)
    src = payload if isinstance(payload, dict) else {}
    base['songs'] = _normalize_favourite_rows(src.get('songs'))
    base['albums'] = _normalize_favourite_rows(src.get('albums'))
    base['artists'] = _normalize_favourite_rows(src.get('artists'))

    exports = {}
    raw_exports = src.get('dap_exports') if isinstance(src.get('dap_exports'), dict) else {}
    for k, v in raw_exports.items():
        key = str(k or '').strip()
        if not key:
            continue
        try:
            ts = int(v or 0)
        except Exception:
            ts = 0
        if ts > 0:
            exports[key] = ts
    base['dap_exports'] = exports
    return base


def load_favourites():
    return _db.db_load_favourites()


def save_favourites(favourites):
    normalized = _normalize_favourites_payload(favourites)
    _db.db_save_favourites(normalized)


def _favourites_latest_song_ts(favourites):
    rows = favourites.get('songs') or []
    if not rows:
        return 0
    return max(int(r.get('added_at') or 0) for r in rows)


def _resolve_favourite_tracks(rows):
    with library_lock:
        lib_map = {t.get('id'): t for t in library if t.get('id')}

    out = []
    orphaned = 0
    for row in rows:
        tid = row.get('id')
        track = lib_map.get(tid)
        if track:
            out.append(track)
        else:
            orphaned += 1
    return out, orphaned


# ── Routes ──────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    response = send_file('static/index.html')
    # Prevent WKWebView from caching the HTML page across app launches.
    # If the HTML is cached, the browser never sees updated ?v= query strings
    # on JS/CSS assets, so new builds appear unchanged on cold start.
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    return response


@app.route('/api/library/status')
def library_status():
    return jsonify(scan_state)


@app.route('/api/library/scan', methods=['POST'])
def trigger_scan():
    if scan_state['status'] == 'scanning':
        return jsonify({'message': 'Already scanning'}), 400
    if request.args.get('clean') == 'true':
        try:
            _db.db_save_library([])
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

    # Pre-load artist image keys so we can annotate each artist
    artist_image_keys = _db.db_get_all_artist_image_keys()

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

    result = []
    for v in sorted(artists.values(), key=lambda v: artist_sort_key(v['name'])):
        img_key = get_artist_image_key(v['name'])
        result.append({
            'name': v['name'],
            'album_count': len(v['albums']),
            'track_count': v['track_count'],
            'artwork_key': v['artwork_key'],
            'image_key': img_key if img_key in artist_image_keys else None,
        })
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


# ── Home / listening history ────────────────────────────────────────────────

def _to_bool(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    return str(v).strip().lower() in ('1', 'true', 'yes', 'on')


def _normalize_source_type(v):
    raw = str(v or '').strip().lower()
    allowed = {'playlist', 'album', 'artist', 'songs', 'favourites'}
    return raw if raw in allowed else 'unknown'


def _current_listen_cutoff():
    return int(time.time()) - LISTEN_WINDOW_SECONDS


def _music_meta_maps():
    global _meta_maps_cache
    if _meta_maps_cache is not None:
        return _meta_maps_cache

    with library_lock:
        tracks = list(library)
    track_by_id = {str(t.get('id')): t for t in tracks if t.get('id')}
    albums = {}
    artists = {}
    artist_image_keys = _db.db_get_all_artist_image_keys()
    for t in tracks:
        artist = (t.get('album_artist') or t.get('artist') or 'Unknown Artist').strip()
        album = (t.get('album') or 'Unknown Album').strip()
        key = f"{artist.lower()}||{album.lower()}"
        slot = albums.get(key)
        if slot is None:
            slot = {
                'artist': artist,
                'album': album,
                'artwork_key': t.get('artwork_key'),
                'track_count': 0,
                'year': t.get('year'),
                'date_added': int(t.get('date_added') or 0),
                'genre': t.get('genre') or '',
            }
            albums[key] = slot
        slot['track_count'] += 1
        if not slot.get('artwork_key') and t.get('artwork_key'):
            slot['artwork_key'] = t.get('artwork_key')
        slot['date_added'] = max(slot.get('date_added', 0), int(t.get('date_added') or 0))
        if not slot.get('genre') and t.get('genre'):
            slot['genre'] = t.get('genre')
        ak = artist.lower()
        if ak not in artists:
            img_key = get_artist_image_key(artist)
            artists[ak] = {
                'artist': artist,
                'artwork_key': t.get('artwork_key'),
                'image_key': img_key if img_key in artist_image_keys else None,
            }
        elif not artists[ak].get('artwork_key') and t.get('artwork_key'):
            artists[ak]['artwork_key'] = t.get('artwork_key')
    result = (tracks, track_by_id, albums, artists)
    _meta_maps_cache = result
    return result


def _recently_added_items(tracks, albums, playlists, limit=10):
    now = int(time.time())
    seven_days_ago = now - 7 * 86400
    track_by_id = {str(t.get('id')): t for t in tracks if t.get('id')}
    album_items = sorted(albums.values(), key=lambda a: int(a.get('date_added') or 0), reverse=True)
    album_cards = [{
        'kind': 'album',
        'artist': a['artist'],
        'album': a['album'],
        'title': a['album'],
        'subtitle': a['artist'],
        'meta': f"{a.get('track_count', 0)} songs",
        'artwork_key': a.get('artwork_key'),
        'date_added': int(a.get('date_added') or 0),
        'is_new': int(a.get('date_added') or 0) >= seven_days_ago,
    } for a in album_items[:max(1, limit)]]

    playlist_cards = []
    for pl in sorted((playlists or {}).values(), key=lambda p: int(p.get('updated_at') or 0), reverse=True):
        ids = pl.get('tracks') or []
        first = next((track_by_id.get(str(tid)) for tid in ids if track_by_id.get(str(tid))), None)
        created_at = int(pl.get('created_at') or 0)
        playlist_cards.append({
            'kind': 'playlist',
            'playlist_id': pl.get('id'),
            'title': pl.get('name') or 'Playlist',
            'subtitle': f"{len(ids)} songs",
            'meta': '',
            'artwork_key': first.get('artwork_key') if first else None,
            'date_added': created_at,
            'is_new': created_at >= seven_days_ago,
        })
    return (album_cards + playlist_cards)[:limit]


def _home_relative_time(ts):
    """Return a human-readable relative time string for a Unix timestamp."""
    if not ts:
        return ''
    diff = int(time.time()) - int(ts)
    if diff < 60:
        return 'Just now'
    if diff < 3600:
        m = diff // 60
        return f"{m} minute{'s' if m != 1 else ''} ago"
    if diff < 86400:
        h = diff // 3600
        return f"{h} hour{'s' if h != 1 else ''} ago"
    if diff < 7 * 86400:
        d = diff // 86400
        return f"{d} day{'s' if d != 1 else ''} ago"
    if diff < 30 * 86400:
        w = diff // (7 * 86400)
        return f"{w} week{'s' if w != 1 else ''} ago"
    return 'A while ago'


def _resolve_context_item(kind, source_id, source_label, track_id, artist, album, artwork_key,
                          track_by_id, albums, artists_map, playlists):
    """
    Resolve a playback context descriptor into a home card dict.
    Returns None if unresolvable. Adds '_dedup_key' used by callers for deduplication.
    """
    if kind == 'playlist':
        key = f"playlist:{source_id or source_label}"
        pl = (playlists or {}).get(source_id) if source_id else None
        if pl:
            ids = pl.get('tracks') or []
            first = next((track_by_id.get(str(tid)) for tid in ids if track_by_id.get(str(tid))), None)
            return {
                '_dedup_key': key, 'kind': 'playlist', 'playlist_id': source_id,
                'title': pl.get('name') or 'Playlist',
                'subtitle': f"{len(ids)} songs",
                'artwork_key': (first.get('artwork_key') if first else None) or artwork_key,
            }
        title = (source_label or '').replace('Playlist · ', '').strip() or 'Playlist'
        return {
            '_dedup_key': key, 'kind': 'playlist', 'playlist_id': source_id,
            'title': title, 'subtitle': '', 'artwork_key': artwork_key,
        }

    elif kind == 'artist':
        name = source_id or artist or (source_label or '').replace('Artist · ', '').strip()
        if not name:
            return None
        key = f"artist:{name.lower()}"
        info = artists_map.get(name.lower(), {'artist': name, 'artwork_key': artwork_key, 'image_key': None})
        return {
            '_dedup_key': key, 'kind': 'artist',
            'artist': info.get('artist') or name,
            'title': info.get('artist') or name,
            'subtitle': 'Artist',
            'image_key': info.get('image_key'),
            'artwork_key': info.get('artwork_key') or artwork_key,
        }

    else:
        # album or unknown → resolve to album card
        if not album and track_id and track_id in track_by_id:
            t = track_by_id[track_id]
            album = (t.get('album') or album or '').strip()
            artist = (t.get('album_artist') or t.get('artist') or artist or '').strip()
            artwork_key = artwork_key or t.get('artwork_key')
        if not album:
            return None
        info = albums.get(f"{artist.lower()}||{album.lower()}") if artist else None
        if info is None and track_id and track_id in track_by_id:
            t = track_by_id[track_id]
            ta = (t.get('album_artist') or t.get('artist') or '').strip()
            tb = (t.get('album') or '').strip()
            if ta and tb:
                info = albums.get(f"{ta.lower()}||{tb.lower()}")
                artist = ta or artist
                album = tb or album
                artwork_key = artwork_key or t.get('artwork_key')
        resolved_artist = (info or {}).get('artist') or artist or 'Unknown Artist'
        resolved_album = (info or {}).get('album') or album
        key = f"album:{resolved_artist.lower()}||{resolved_album.lower()}"
        return {
            '_dedup_key': key, 'kind': 'album',
            'artist': resolved_artist, 'album': resolved_album,
            'title': resolved_album, 'subtitle': resolved_artist,
            'artwork_key': (info or {}).get('artwork_key') or artwork_key,
        }


def _home_continue_listening(recent_contexts, events, albums, artists_map, playlists, track_by_id,
                              player_state, limit=10):
    """
    Merged Continue Listening: client-side recentContexts first, then server-side play_events.
    Deduplicates across both sources. Falls back to current queue item if both are empty.
    """
    now = int(time.time())
    out, seen = [], set()

    # Phase 1: client-side recentContexts (most fresh — survives across sessions)
    for raw in (recent_contexts or []):
        if not isinstance(raw, dict):
            continue
        kind = str(raw.get('kind') or '').strip().lower()
        item = _resolve_context_item(
            kind,
            str(raw.get('source_id') or '').strip(),
            str(raw.get('source_label') or '').strip(),
            str(raw.get('track_id') or '').strip(),
            (raw.get('artist') or '').strip(),
            (raw.get('album') or '').strip(),
            raw.get('artwork_key'),
            track_by_id, albums, artists_map, playlists,
        )
        if not item:
            continue
        dk = item.pop('_dedup_key')
        if dk in seen:
            continue
        seen.add(dk)
        item['meta'] = _home_relative_time(int(raw.get('played_at') or 0))
        out.append(item)
        if len(out) >= limit:
            return out

    # Phase 2: server-side play_events (fills remaining slots, last 60 days)
    sixty_days_ago = now - 60 * 86400
    for e in events:
        if int(e.get('played_at') or 0) < sixty_days_ago:
            break
        st = _normalize_source_type(e.get('source_type'))
        item = _resolve_context_item(
            st,
            str(e.get('source_id') or '').strip(),
            str(e.get('source_label') or '').strip(),
            str(e.get('track_id') or '').strip(),
            (e.get('artist') or '').strip(),
            (e.get('album') or '').strip(),
            None,
            track_by_id, albums, artists_map, playlists,
        )
        if not item:
            continue
        dk = item.pop('_dedup_key')
        if dk in seen:
            continue
        seen.add(dk)
        item['meta'] = _home_relative_time(int(e.get('played_at') or 0))
        out.append(item)
        if len(out) >= limit:
            return out

    # Phase 3: current queue fallback (active session not yet flushed as event)
    if not out:
        queue = player_state.get('queue') if isinstance(player_state.get('queue'), list) else []
        q_idx = int(player_state.get('queueIdx') or -1)
        if queue and 0 <= q_idx < len(queue):
            t = queue[q_idx] or {}
            a = (t.get('album_artist') or t.get('artist') or '').strip()
            al = (t.get('album') or '').strip()
            if a and al:
                info = albums.get(f"{a.lower()}||{al.lower()}")
                out.append({
                    'kind': 'album',
                    'artist': (info or {}).get('artist') or a,
                    'album': (info or {}).get('album') or al,
                    'title': (info or {}).get('album') or al,
                    'subtitle': (info or {}).get('artist') or a,
                    'meta': 'Now playing',
                    'artwork_key': (info or {}).get('artwork_key') or t.get('artwork_key'),
                })

    return out


def _home_top_picks(events, albums, track_by_id, continue_keys=None, limit=5):
    """
    Multi-factor Top Picks: recency, frequency, novelty, genre affinity, sonic affinity (optional).
    Returns up to `limit` album cards, each with a human-readable `reason` string.
    """
    import math, random as _random

    valid_events = [e for e in events if int(e.get('valid_listen') or 0)]
    now = int(time.time())
    exclude = set(continue_keys or [])

    # --- Cold start: metadata fallback ---
    if len(valid_events) < 5:
        items, artists_seen = [], set()
        for info in sorted(albums.values(), key=lambda a: int(a.get('date_added') or 0), reverse=True):
            ak = (info.get('artist') or '').lower()
            if ak in artists_seen:
                continue
            artists_seen.add(ak)
            key = f"{(info.get('artist') or '').lower()}||{(info.get('album') or '').lower()}"
            if key in exclude:
                continue
            items.append({
                'kind': 'album',
                'artist': info.get('artist') or 'Unknown Artist',
                'album': info.get('album') or 'Unknown Album',
                'title': info.get('album') or 'Unknown Album',
                'subtitle': info.get('artist') or 'Unknown Artist',
                'artwork_key': info.get('artwork_key'),
                'reason': 'Based on your library',
            })
            if len(items) >= limit:
                break
        return items

    # --- Build per-album play profiles ---
    profiles = {}
    for e in valid_events:
        artist = (e.get('artist') or '').strip()
        album_name = (e.get('album') or '').strip()
        if not artist or not album_name:
            continue
        key = f"{artist.lower()}||{album_name.lower()}"
        if key not in profiles:
            profiles[key] = {'plays': 0, 'total_seconds': 0.0, 'last_played_at': 0}
        p = profiles[key]
        p['plays'] += 1
        p['total_seconds'] += float(e.get('play_seconds') or 0.0)
        p['last_played_at'] = max(p['last_played_at'], int(e.get('played_at') or 0))

    if not profiles:
        return []

    max_plays = max(p['plays'] for p in profiles.values()) or 1

    # --- Genre affinity from last 30 days ---
    thirty_days_ago = now - 30 * 86400
    recent_genre_counts = {}
    for e in valid_events:
        if int(e.get('played_at') or 0) < thirty_days_ago:
            continue
        info = albums.get(f"{(e.get('artist') or '').lower()}||{(e.get('album') or '').lower()}")
        g = (info.get('genre') or '').lower() if info else ''
        if g:
            recent_genre_counts[g] = recent_genre_counts.get(g, 0) + 1
    total_recent_genre = sum(recent_genre_counts.values()) or 1

    # --- Sonic affinity: recent listening profile ---
    recent_tids = list(dict.fromkeys(
        e['track_id'] for e in valid_events
        if int(e.get('played_at') or 0) >= thirty_days_ago and e.get('track_id')
    ))[:200]
    recent_features = _db.db_get_features_batch(recent_tids) if recent_tids else {}
    recent_bands = [f['band_energy'] for f in recent_features.values()
                    if f and f.get('band_energy') and len(f['band_energy']) == 12 and not f.get('failed')]
    recent_sonic = ([sum(b[i] for b in recent_bands) / len(recent_bands) for i in range(12)]
                    if recent_bands else None)

    # --- Initial scoring (no sonic) to get top 20 candidates ---
    def _basic_score(key, p):
        days_since = max(0.0, (now - p['last_played_at']) / 86400.0)
        recency = math.exp(-days_since / 30.0)
        frequency = math.log(1 + p['plays']) / math.log(1 + max_plays)
        novelty = math.exp(-0.5 * ((math.log(1 + p['plays']) - math.log(6)) ** 2) / 1.5)
        info = albums.get(key)
        g = (info.get('genre') or '').lower() if info else ''
        genre_aff = min((recent_genre_counts.get(g, 0) / total_recent_genre) * 5.0, 1.0) if g else 0.0
        return 0.30 * recency + 0.25 * frequency + 0.25 * genre_aff + 0.20 * novelty

    candidates = [
        (key, p, _basic_score(key, p))
        for key, p in profiles.items()
        if key not in exclude and albums.get(key)
    ]
    candidates.sort(key=lambda x: x[2], reverse=True)
    top_candidates = candidates[:20]

    # --- Batch-load sonic features for top 20 candidates ---
    if recent_sonic:
        cand_track_ids = []
        for key, _, _ in top_candidates:
            for t in track_by_id.values():
                a_key = f"{(t.get('album_artist') or t.get('artist') or '').lower()}||{(t.get('album') or '').lower()}"
                if a_key == key:
                    cand_track_ids.append(str(t.get('id') or ''))
        cand_features = _db.db_get_features_batch(cand_track_ids) if cand_track_ids else {}
    else:
        cand_features = {}

    # --- Build album→band_energy map for candidates ---
    album_sonic = {}
    for t in track_by_id.values():
        tid = str(t.get('id') or '')
        f = cand_features.get(tid)
        if not f or not f.get('band_energy') or len(f['band_energy']) != 12 or f.get('failed'):
            continue
        a_key = f"{(t.get('album_artist') or t.get('artist') or '').lower()}||{(t.get('album') or '').lower()}"
        if a_key not in album_sonic:
            album_sonic[a_key] = []
        album_sonic[a_key].append(f['band_energy'])

    def _cosine(a, b):
        dot = sum(a[i] * b[i] for i in range(len(a)))
        ma = math.sqrt(sum(x * x for x in a))
        mb = math.sqrt(sum(x * x for x in b))
        return dot / (ma * mb) if ma > 0 and mb > 0 else 0.0

    # --- Final scoring with sonic for top candidates ---
    scored = []
    for key, p, _ in top_candidates:
        info = albums[key]
        days_since = max(0.0, (now - p['last_played_at']) / 86400.0)
        recency  = math.exp(-days_since / 30.0)
        frequency = math.log(1 + p['plays']) / math.log(1 + max_plays)
        novelty  = math.exp(-0.5 * ((math.log(1 + p['plays']) - math.log(6)) ** 2) / 1.5)
        g = (info.get('genre') or '').lower()
        genre_aff = min((recent_genre_counts.get(g, 0) / total_recent_genre) * 5.0, 1.0) if g else 0.0

        sonic_bands = album_sonic.get(key, [])
        sonic_aff = 0.0
        has_sonic = False
        if recent_sonic and sonic_bands:
            avg_bands = [sum(b[i] for b in sonic_bands) / len(sonic_bands) for i in range(12)]
            sonic_aff = _cosine(avg_bands, recent_sonic)
            has_sonic = True

        if has_sonic:
            score = 0.30 * recency + 0.25 * frequency + 0.20 * genre_aff + 0.15 * novelty + 0.10 * sonic_aff
            factors = {'recency': 0.30 * recency, 'frequency': 0.25 * frequency,
                       'genre': 0.20 * genre_aff, 'novelty': 0.15 * novelty, 'sonic': 0.10 * sonic_aff}
        else:
            score = 0.30 * recency + 0.25 * frequency + 0.25 * genre_aff + 0.20 * novelty
            factors = {'recency': 0.30 * recency, 'frequency': 0.25 * frequency,
                       'genre': 0.25 * genre_aff, 'novelty': 0.20 * novelty, 'sonic': 0.0}

        dominant = max(factors, key=lambda k: factors[k])
        genre_label = info.get('genre') or ''
        reasons = {
            'recency':   "You've been listening to similar albums lately",
            'frequency': "One of your most-played albums recently",
            'genre':     f"Matches your recent {genre_label} listening" if genre_label else "Fits your recent listening taste",
            'novelty':   "Worth revisiting — you haven't listened in a while",
            'sonic':     "Similar tonal profile to your recent listening",
        }
        scored.append({'key': key, 'score': score, 'info': info, 'reason': reasons[dominant]})

    if not scored:
        return []

    # Diversity: shuffle top-10, then pick ≤2 per artist
    scored.sort(key=lambda x: x['score'], reverse=True)
    pool = scored[:10]
    _random.shuffle(pool)
    pool.sort(key=lambda x: x['score'], reverse=True)

    picks, artist_counts = [], {}
    for s in pool:
        ak = (s['info'].get('artist') or '').lower()
        if artist_counts.get(ak, 0) >= 2:
            continue
        artist_counts[ak] = artist_counts.get(ak, 0) + 1
        picks.append(s)
        if len(picks) >= limit:
            break

    return [{
        'kind': 'album',
        'artist': s['info'].get('artist') or 'Unknown Artist',
        'album': s['info'].get('album') or 'Unknown Album',
        'title': s['info'].get('album') or 'Unknown Album',
        'subtitle': s['info'].get('artist') or 'Unknown Artist',
        'artwork_key': s['info'].get('artwork_key'),
        'reason': s['reason'],
    } for s in picks]


def _home_listen_next_artists(events, artists_map, limit=10):
    """
    Recency-weighted artist ranking from valid listening events.
    Returns artist cards for the Home "Listen Next" rail.
    """
    now = int(time.time())
    scores = {}
    for e in events:
        if not int(e.get('valid_listen') or 0):
            continue
        name = (e.get('artist') or '').strip()
        if not name:
            continue
        played_at = int(e.get('played_at') or 0)
        if played_at <= 0:
            continue
        days_since = max(0.0, (now - played_at) / 86400.0)
        # 30-day decay keeps recent taste strong while still considering older habits.
        recency_weight = math.exp(-days_since / 30.0)
        play_seconds = max(1.0, float(e.get('play_seconds') or 0.0))
        # Damp very long tracks; avoid one track dominating artist rank.
        duration_weight = min(play_seconds / 240.0, 1.5)
        key = name.lower()
        scores[key] = scores.get(key, 0.0) + recency_weight * duration_weight

    if not scores:
        return []

    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[: max(1, int(limit))]
    out = []
    for artist_key, _score in ranked:
        info = artists_map.get(artist_key) or {}
        artist_name = info.get('artist') or artist_key
        out.append({
            'kind': 'artist',
            'artist': artist_name,
            'title': artist_name,
            'subtitle': 'Artist',
            'image_key': info.get('image_key'),
            'artwork_key': info.get('artwork_key'),
        })
    return out


def _home_stats_aggregate(events, albums):
    """Aggregate listening stats from a list of play_events dicts. Returns metrics dict."""
    valid = [e for e in events if int(e.get('valid_listen') or 0)]
    if not valid:
        return {
            'total_minutes': 0, 'track_count': 0, 'album_count': 0,
            'artist_count': 0, 'active_days': 0,
            'top_artist': None, 'top_album': None, 'top_track': None, 'top_genre': None,
        }
    total_seconds = sum(float(e.get('play_seconds') or 0.0) for e in valid)
    unique_tracks  = len({str(e.get('track_id') or '') for e in valid if e.get('track_id')})
    unique_albums  = len({(e.get('album') or '').strip().lower() for e in valid if (e.get('album') or '').strip()})
    unique_artists = len({(e.get('artist') or '').strip().lower() for e in valid if (e.get('artist') or '').strip()})
    active_days    = len({time.strftime('%Y-%m-%d', time.localtime(int(e['played_at']))) for e in valid})

    artist_counts, album_counts, track_counts, genre_counts = {}, {}, {}, {}
    for e in valid:
        a = (e.get('artist') or '').strip()
        al = (e.get('album') or '').strip()
        ti = (e.get('title') or '').strip()
        if a:
            artist_counts[a] = artist_counts.get(a, 0) + 1
        if al:
            album_counts[al] = album_counts.get(al, 0) + 1
        if ti:
            track_counts[ti] = track_counts.get(ti, 0) + 1
        if a and al:
            info = albums.get(f"{a.lower()}||{al.lower()}")
            g = (info.get('genre') or '') if info else ''
            if g:
                genre_counts[g] = genre_counts.get(g, 0) + 1

    return {
        'total_minutes': round(total_seconds / 60.0, 1),
        'track_count':   unique_tracks,
        'album_count':   unique_albums,
        'artist_count':  unique_artists,
        'active_days':   active_days,
        'top_artist':    max(artist_counts, key=artist_counts.get) if artist_counts else None,
        'top_album':     max(album_counts,  key=album_counts.get)  if album_counts  else None,
        'top_track':     max(track_counts,  key=track_counts.get)  if track_counts  else None,
        'top_genre':     max(genre_counts,  key=genre_counts.get)  if genre_counts  else None,
    }


def _invalidate_home_cache():
    """Call after any mutation that should bust the home payload cache."""
    with _home_cache_lock:
        _home_cache['ts'] = 0


@app.route('/api/home')
def home():
    """Main home payload for Home v2 (legacy + spec-aligned keys)."""
    global _home_cache
    # Serve from cache if fresh (60s TTL)
    with _home_cache_lock:
        if _home_cache['data'] is not None and (time.time() - _home_cache['ts']) < 60:
            return jsonify(_home_cache['data'])

    settings = load_settings()
    player_state = _db.db_get_player_state()
    try:
        cutoff = _current_listen_cutoff()
        _db.db_prune_play_events(cutoff)
        tracks, track_by_id, albums, artists_map = _music_meta_maps()
        playlists = load_playlists()
        events = _db.db_load_play_events_since(cutoff, limit=20000)
        recent_contexts = (player_state.get('recentContexts')
                           if isinstance(player_state.get('recentContexts'), list) else [])

        continue_items = _home_continue_listening(
            recent_contexts, events, albums, artists_map, playlists, track_by_id, player_state, limit=10)

        # Build set of album keys already in Continue Listening (for Top Picks exclusion)
        continue_keys = set()
        for item in continue_items:
            if item.get('kind') == 'album':
                continue_keys.add(
                    f"{(item.get('artist') or '').lower()}||{(item.get('album') or '').lower()}")

        top_picks = _home_top_picks(events, albums, track_by_id, continue_keys=continue_keys, limit=10)
        listen_next_artists = _home_listen_next_artists(events, artists_map, limit=10)
        because_you_listened = top_picks[:10]
        recently_added = _recently_added_items(tracks, albums, playlists, limit=10)

        # Library summary for header strip
        with library_lock:
            total_tracks = len(library)
        total_albums = len(albums)
        total_artists = len(artists_map)
        total_playlists = len(playlists)
        last_scan = settings.get('last_scan_at') or 0

        # Latest playlist (for Quick Actions)
        sorted_playlists = sorted(playlists.values(), key=lambda p: int(p.get('created_at') or 0), reverse=True)
        latest_playlist = sorted_playlists[0] if sorted_playlists else None

        valid_events = [e for e in events if int(e.get('valid_listen') or 0)]
        has_history = len(valid_events) > 0
        latest_event_at = max((int(e.get('played_at') or 0) for e in events), default=0)
        data_health = {
            'total_events': len(events),
            'valid_events': len(valid_events),
            'latest_event_at': latest_event_at,
            'history_fresh': (int(time.time()) - latest_event_at) < (72 * 3600) if latest_event_at else False,
        }

    except Exception as exc:
        print(f"[home] error: {exc}")
        import traceback; traceback.print_exc()
        continue_items = []
        top_picks = []
        listen_next_artists = []
        because_you_listened = []
        recently_added = []
        total_tracks = total_albums = total_artists = total_playlists = 0
        last_scan = 0
        latest_playlist = None
        has_history = False
        data_health = {
            'total_events': 0,
            'valid_events': 0,
            'latest_event_at': 0,
            'history_fresh': False,
        }

    payload = {
        'tracking_enabled': _to_bool(settings.get('listening_tracking_enabled', True)),
        'has_history': has_history,
        # Spec-aligned names
        'jump_back_in': continue_items,
        'listen_next_artists': listen_next_artists,
        'because_you_listened': because_you_listened,
        'music_stats_window': '12m',
        'data_health': data_health,
        # Legacy keys (kept for backwards compatibility while UI migrates)
        'continue_listening': continue_items,
        'top_picks': top_picks,
        'recently_added': recently_added,
        'library_summary': {
            'tracks': total_tracks,
            'albums': total_albums,
            'artists': total_artists,
            'playlists': total_playlists,
        },
        'last_scan': int(last_scan),
        'quick_actions': {
            'latest_playlist_id': latest_playlist.get('id') if latest_playlist else None,
            'latest_playlist_name': latest_playlist.get('name') if latest_playlist else None,
            'has_continue': len(continue_items) > 0,
        },
    }
    with _home_cache_lock:
        _home_cache['data'] = payload
        _home_cache['ts'] = time.time()
    return jsonify(payload)


@app.route('/api/home/stats')
def home_stats():
    """Listening stats for a given period. ?period=week|month|year|all"""
    period = request.args.get('period', 'month')
    now = int(time.time())
    period_seconds = {'week': 7 * 86400, 'month': 30 * 86400, 'year': 365 * 86400}
    secs = period_seconds.get(period)

    if secs:
        since_ts = now - secs
        prev_since_ts = now - 2 * secs
        prev_until_ts = since_ts
    else:
        # all time — no previous period comparison
        since_ts = 0
        prev_since_ts = None
        prev_until_ts = None

    try:
        tracks, track_by_id, albums, artists_map = _music_meta_maps()
        # Load enough events to cover both current and previous periods
        load_since = prev_since_ts if prev_since_ts is not None else since_ts
        all_events = _db.db_load_play_events_since(load_since, limit=50000)

        current_events = [e for e in all_events if int(e.get('played_at') or 0) >= since_ts]
        current = _home_stats_aggregate(current_events, albums)

        if prev_since_ts is not None and prev_until_ts is not None:
            prev_events = [e for e in all_events
                           if prev_since_ts <= int(e.get('played_at') or 0) < prev_until_ts]
            previous = _home_stats_aggregate(prev_events, albums)
            # Compute percentage changes for key metrics
            def _pct(curr, prev):
                if not prev:
                    return None
                return round((curr - prev) / prev * 100, 1)
            comparison = {
                'minutes_change': _pct(current['total_minutes'], previous['total_minutes']),
                'tracks_change':  _pct(current['track_count'],   previous['track_count']),
            }
        else:
            previous = None
            comparison = {}

    except Exception as exc:
        print(f"[home/stats] error: {exc}")
        current = {
            'total_minutes': 0, 'track_count': 0, 'album_count': 0,
            'artist_count': 0, 'active_days': 0,
            'top_artist': None, 'top_album': None, 'top_track': None, 'top_genre': None,
        }
        previous = None
        comparison = {}

    return jsonify({
        'period': period,
        'current': current,
        'previous': previous,
        'comparison': comparison,
    })


# ─── (legacy alias kept for any cached client requests) ──────────────────────
@app.route('/api/home/overview')
def home_overview():
    return home()


# ── ID3 Tag Editing ──────────────────────────────────────────────────────────

_EDITABLE_FIELDS = {
    'title', 'artist', 'album_artist', 'album', 'track_number', 'year', 'genre',
    'comment', 'composer', 'disc_number', 'compilation'
}
_BATCH_ALBUM_FIELDS = {
    'title', 'artist', 'album_artist', 'album', 'track_number', 'year', 'genre',
    'comment', 'composer', 'disc_number', 'compilation'
}


def _apply_tag_edit(track_id: str, changes: dict):
    """
    Core helper: validate path, snapshot history, write tags to file,
    update SQLite and in-memory library.
    Returns (updated_track_dict, error_message | None).
    """
    track = _db.db_get_track(track_id)
    if not track:
        return None, 'Track not found'

    music_base = get_music_base()
    abs_path = music_base / track['path']

    if not abs_path.exists():
        return None, f'File not found: {track["path"]}'
    if not os.access(str(abs_path), os.W_OK):
        return None, f'File is read-only: {track["path"]}'

    # Security: confirm resolved path is inside music_base
    try:
        abs_path.resolve().relative_to(music_base.resolve())
    except ValueError:
        return None, 'Path traversal detected'

    # Strip out None / empty values; only keep recognised fields
    clean = {
        k: v.strip() if isinstance(v, str) else v
        for k, v in changes.items()
        if k in _EDITABLE_FIELDS and v is not None and str(v).strip() != ''
    }
    if not clean:
        return track, None  # nothing to do

    # Snapshot old values to tag_history
    old_values = {field: track.get(field) for field in clean}
    _db.db_record_tag_changes(track_id, clean, old_values)

    # Write to file
    _write_tags_to_file(abs_path, clean)

    # Update SQLite cache
    _db.db_update_track_tags(track_id, clean)

    # Update in-memory library
    _update_library_track(track_id, clean)

    updated = _db.db_get_track(track_id)
    return updated, None


@app.route('/api/library/tracks/<track_id>/tags', methods=['PUT'])
def update_track_tags(track_id):
    """Edit ID3 tags on a single track."""
    data = request.json or {}
    changes = {k: data.get(k) for k in _EDITABLE_FIELDS if k in data}
    updated, err = _apply_tag_edit(track_id, changes)
    if err:
        code = 404 if 'not found' in err.lower() else 400
        return jsonify({'error': err}), code
    return jsonify(updated)


@app.route('/api/library/albums/tags', methods=['PUT'])
def update_album_tags():
    """Batch-edit shared tag fields across all tracks in an album."""
    artist = request.args.get('artist', '')
    album = request.args.get('album', '')
    if not artist or not album:
        return jsonify({'error': 'artist and album query params required'}), 400

    data = request.json or {}
    changes = {k: data.get(k) for k in _BATCH_ALBUM_FIELDS if k in data}
    if not changes:
        return jsonify({'error': 'No editable fields provided'}), 400

    with library_lock:
        tracks = [
            t for t in library
            if (t.get('album_artist') or t.get('artist') or '').lower() == artist.lower()
            and (t.get('album') or '').lower() == album.lower()
        ]

    if not tracks:
        return jsonify({'error': 'No tracks found for that artist/album'}), 404

    updated = 0
    errors = []
    for t in tracks:
        _, err = _apply_tag_edit(t['id'], changes)
        if err:
            errors.append({'track': t.get('title', t['id']), 'error': err})
        else:
            updated += 1

    return jsonify({'updated': updated, 'total': len(tracks), 'errors': errors})


@app.route('/api/library/artists/<path:artist>/tags', methods=['PUT'])
def update_artist_tags(artist):
    """Rename an artist across all their tracks (artist + album_artist fields)."""
    data = request.json or {}
    new_name = (data.get('artist') or '').strip()
    if not new_name:
        return jsonify({'error': 'artist name required'}), 400

    with library_lock:
        tracks = [
            t for t in library
            if (t.get('artist') or '').lower() == artist.lower()
            or (t.get('album_artist') or '').lower() == artist.lower()
        ]

    if not tracks:
        return jsonify({'error': 'No tracks found for that artist'}), 404

    if len(tracks) > 2000:
        return jsonify({'error': 'Too many tracks (>2000) — split into smaller batches'}), 400

    updated = 0
    errors = []
    for t in tracks:
        changes = {}
        if (t.get('artist') or '').lower() == artist.lower():
            changes['artist'] = new_name
        if (t.get('album_artist') or '').lower() == artist.lower():
            changes['album_artist'] = new_name
        _, err = _apply_tag_edit(t['id'], changes)
        if err:
            errors.append({'track': t.get('title', t['id']), 'error': err})
        else:
            updated += 1

    return jsonify({'updated': updated, 'total': len(tracks), 'errors': errors})


# ── Favourites ───────────────────────────────────────────────────────────────

def _fav_category_rows(favourites, category):
    if category not in ('songs', 'albums', 'artists'):
        return None
    return favourites.get(category, [])


def _add_favourite(category, item_id):
    favourites = load_favourites()
    rows = _fav_category_rows(favourites, category)
    if rows is None:
        return jsonify({'error': 'Unknown category'}), 400
    item = str(item_id or '').strip()
    if not item:
        return jsonify({'error': 'Missing id'}), 400
    if not any(r.get('id') == item for r in rows):
        rows.insert(0, {'id': item, 'added_at': int(time.time())})
        save_favourites(favourites)
    return jsonify(rows)


def _remove_favourite(category, item_id):
    favourites = load_favourites()
    rows = _fav_category_rows(favourites, category)
    if rows is None:
        return jsonify({'error': 'Unknown category'}), 400
    item = str(item_id or '').strip()
    if not item:
        return jsonify({'error': 'Missing id'}), 400
    favourites[category] = [r for r in rows if r.get('id') != item]
    save_favourites(favourites)
    return jsonify(favourites[category])


@app.route('/api/favourites', methods=['GET'])
def get_favourites():
    return jsonify(load_favourites())


@app.route('/api/favourites/songs/<track_id>', methods=['POST'])
def add_favourite_song(track_id):
    return _add_favourite('songs', track_id)


@app.route('/api/favourites/songs/<track_id>', methods=['DELETE'])
def remove_favourite_song(track_id):
    return _remove_favourite('songs', track_id)


@app.route('/api/favourites/albums/<album_id>', methods=['POST'])
def add_favourite_album(album_id):
    return _add_favourite('albums', album_id)


@app.route('/api/favourites/albums/<album_id>', methods=['DELETE'])
def remove_favourite_album(album_id):
    return _remove_favourite('albums', album_id)


@app.route('/api/favourites/artists/<path:artist_id>', methods=['POST'])
def add_favourite_artist(artist_id):
    return _add_favourite('artists', artist_id)


@app.route('/api/favourites/artists/<path:artist_id>', methods=['DELETE'])
def remove_favourite_artist(artist_id):
    return _remove_favourite('artists', artist_id)


@app.route('/api/favourites/<category>/reorder', methods=['PUT'])
def reorder_favourites(category):
    if category not in ('songs', 'albums', 'artists'):
        return jsonify({'error': 'Unknown category'}), 400
    payload = request.json or {}
    order = [str(x).strip() for x in (payload.get('order') or []) if str(x).strip()]

    favourites = load_favourites()
    current = favourites.get(category, [])
    current_map = {r.get('id'): r for r in current if r.get('id')}
    kept = []
    seen = set()

    for item_id in order:
        row = current_map.get(item_id)
        if row and item_id not in seen:
            kept.append(row)
            seen.add(item_id)
    for row in current:
        rid = row.get('id')
        if rid and rid not in seen:
            kept.append(row)
            seen.add(rid)

    favourites[category] = kept
    save_favourites(favourites)
    return jsonify(kept)


@app.route('/api/favourites/songs/tracks', methods=['GET'])
def get_favourite_song_tracks():
    favourites = load_favourites()
    tracks, orphaned = _resolve_favourite_tracks(favourites.get('songs') or [])
    return jsonify({
        'tracks': tracks,
        'orphaned_count': orphaned,
    })


@app.route('/api/favourites/songs/export/<fmt>', methods=['GET'])
def export_favourite_songs(fmt):
    favourites = load_favourites()
    tracks, _ = _resolve_favourite_tracks(favourites.get('songs') or [])

    settings = load_settings()
    if fmt == 'poweramp':
        filename = 'Favourite Songs.m3u'
        prefix = settings.get('poweramp_prefix', '')
    elif fmt == 'ap80':
        filename = 'Favourite Songs.m3u'
        prefix = '..'
    else:
        return jsonify({'error': 'Unknown format'}), 400

    content = generate_m3u(tracks, 'Favourite Songs', path_prefix=prefix)
    return Response(
        content,
        mimetype='audio/x-mpegurl',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'}
    )


@app.route('/api/artwork/<key>')
def get_artwork(key):
    # Sanitize key to prevent path traversal
    if not key.replace('-', '').isalnum():
        return '', 400
    artwork_path = ARTWORK_DIR / f"{key}.jpg"
    if artwork_path.exists():
        return send_file(str(artwork_path), mimetype='image/jpeg')
    return '', 404


# ── Album Artwork Management ──────────────────────────────────────────────────

def _search_album_itunes(artist: str, album: str) -> list:
    """Search iTunes for album cover candidates."""
    try:
        term = f"{artist} {album}"
        url  = (
            f"https://itunes.apple.com/search?"
            f"term={urlquote(term)}&entity=album&limit=20&media=music"
        )
        req = UrlRequest(url, headers={'User-Agent': 'TuneBridge/1.0'})
        with urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode('utf-8'))

        candidates = []
        seen = set()
        for item in data.get('results', []):
            itunes_artist = (item.get('artistName') or '').strip()
            itunes_album  = (item.get('collectionName') or '').strip()
            if not _name_matches(artist, itunes_artist):
                continue
            thumb = item.get('artworkUrl100', '')
            if not thumb or thumb in seen:
                continue
            seen.add(thumb)
            full = thumb.replace('100x100bb', '600x600bb').replace('100x100', '600x600')
            candidates.append({
                'url':           full,
                'thumbnail_url': thumb,
                'source':        'itunes',
                'label':         itunes_album,
            })
            if len(candidates) >= 8:
                break
        return candidates
    except Exception as e:
        print(f"[album-art] iTunes search error: {e}")
        return []


def _search_album_lastfm(artist: str, album: str, api_key: str) -> list:
    """Search Last.fm for album cover candidates via getinfo + album.search."""
    candidates = []
    seen = set()

    def _extract_images(images, label):
        """Pick largest non-placeholder image from a Last.fm image array."""
        for img in reversed(images):
            img_url = img.get('#text', '').strip()
            if not img_url or _LASTFM_PLACEHOLDER_HASH in img_url or img_url in seen:
                continue
            seen.add(img_url)
            thumb = next(
                (x.get('#text', '') for x in images if x.get('size') in ('large', 'medium') and x.get('#text')),
                img_url,
            )
            candidates.append({
                'url':           img_url,
                'thumbnail_url': thumb or img_url,
                'source':        'lastfm',
                'label':         label,
            })
            return  # one image per call

    # Method 1: album.getinfo — canonical image for this specific album
    try:
        url = (
            f"https://ws.audioscrobbler.com/2.0/?method=album.getinfo"
            f"&artist={urlquote(artist)}&album={urlquote(album)}"
            f"&api_key={urlquote(api_key)}&format=json"
        )
        req = UrlRequest(url, headers={'User-Agent': 'TuneBridge/1.0'})
        with urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode('utf-8'))
        album_data = data.get('album', {})
        _extract_images(album_data.get('image', []), album_data.get('name', album))
    except Exception as e:
        print(f"[album-art] Last.fm getinfo error: {e}")

    # Method 2: album.search — find more variants, filtered to this artist
    try:
        url = (
            f"https://ws.audioscrobbler.com/2.0/?method=album.search"
            f"&album={urlquote(album)}&api_key={urlquote(api_key)}&format=json&limit=10"
        )
        req = UrlRequest(url, headers={'User-Agent': 'TuneBridge/1.0'})
        with urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode('utf-8'))
        albums = data.get('results', {}).get('albummatches', {}).get('album', [])
        for a in albums:
            if len(candidates) >= 6:
                break
            a_artist = (a.get('artist') or '').strip()
            if a_artist and a_artist.lower() != 'various artists' and not _name_matches(artist, a_artist):
                continue
            _extract_images(a.get('image', []), a.get('name', album))
    except Exception as e:
        print(f"[album-art] Last.fm album.search error: {e}")

    return candidates[:6]


def _search_album_fanart(artist: str, album: str, api_key: str) -> list:
    """Search Fanart.tv for album covers via MusicBrainz release-group lookup."""
    try:
        # Step 1: MusicBrainz release-group lookup using Lucene phrase search
        phrase_album  = f'"{album}"'
        phrase_artist = f'"{artist}"'
        mb_url = (
            f"https://musicbrainz.org/ws/2/release-group/"
            f"?query=releasegroup:{urlquote(phrase_album)}+AND+artist:{urlquote(phrase_artist)}"
            f"&fmt=json&limit=5"
        )
        req = UrlRequest(mb_url, headers={
            'User-Agent': 'TuneBridge/1.0 (https://github.com/hashansr/tunebridge)',
            'Accept': 'application/json',
        })
        with urlopen(req, timeout=10) as r:
            mb_data = json.loads(r.read().decode('utf-8'))

        rgid = None
        for rg in mb_data.get('release-groups', []):
            rg_title  = rg.get('title', '')
            rg_artist = next(
                (ac.get('name', '') for ac in rg.get('artist-credit', []) if isinstance(ac, dict)),
                '',
            )
            if _name_matches(album, rg_title) and (not rg_artist or _name_matches(artist, rg_artist)):
                rgid = rg.get('id', '')
                print(f"[album-art] MusicBrainz RG matched '{rg_title}' ({rgid}) for '{artist} – {album}'")
                break

        if not rgid:
            print(f"[album-art] MusicBrainz: no confident release-group match for '{artist} – {album}'")
            return []

        # Step 2: Fanart.tv album covers for this release group
        ft_url = f"https://webservice.fanart.tv/v3/music/albums/{rgid}?api_key={urlquote(api_key)}"
        req2   = UrlRequest(ft_url, headers={'User-Agent': 'TuneBridge/1.0'})
        with urlopen(req2, timeout=10) as r2:
            ft_data = json.loads(r2.read().decode('utf-8'))

        candidates = []
        for rg_val in ft_data.get('albums', {}).values():
            for img in rg_val.get('albumcover', [])[:6]:
                img_url = img.get('url', '').strip()
                if img_url:
                    candidates.append({
                        'url':           img_url,
                        'thumbnail_url': img_url,
                        'source':        'fanart',
                        'label':         album,
                    })
        return candidates[:6]
    except Exception as e:
        print(f"[album-art] Fanart.tv album search error: {e}")
        return []


@app.route('/api/library/albums/artwork/search')
def search_album_artwork():
    """Search for album cover candidates from the chosen service."""
    artist  = request.args.get('artist',  '').strip()
    album   = request.args.get('album',   '').strip()
    service = request.args.get('service', 'itunes').strip().lower()
    if not artist or not album:
        return jsonify({'error': 'artist and album are required'}), 400

    settings   = load_settings()
    candidates = []

    if service == 'lastfm':
        api_key = (settings.get('lastfm_api_key') or '').strip()
        if not api_key:
            return jsonify({'error': 'Last.fm API key not configured. Add it in Settings → Artist Images.'}), 400
        candidates = _search_album_lastfm(artist, album, api_key)
    elif service == 'fanart':
        api_key = (settings.get('fanart_api_key') or '').strip()
        if not api_key:
            return jsonify({'error': 'Fanart.tv API key not configured. Add it in Settings → Artist Images.'}), 400
        candidates = _search_album_fanart(artist, album, api_key)
    else:
        candidates = _search_album_itunes(artist, album)

    return jsonify({'candidates': candidates})


@app.route('/api/library/albums/artwork', methods=['POST'])
def set_album_artwork():
    """Upload or fetch artwork for an album and save it to the artwork cache."""
    artist = request.args.get('artist', '').strip()
    album  = request.args.get('album',  '').strip()
    if not artist or not album:
        return jsonify({'error': 'artist and album are required'}), 400

    artwork_key  = get_artwork_key(artist, album)
    artwork_path = ARTWORK_DIR / f"{artwork_key}.jpg"

    try:
        if 'file' in request.files:
            # File upload
            f = request.files['file']
            raw = f.read()
        elif request.is_json and request.json.get('source_url'):
            # Fetch from URL (validated against allowlist)
            source_url = request.json['source_url']
            _validate_image_url(source_url)
            req = UrlRequest(source_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urlopen(req, timeout=15) as r:
                raw = r.read()
        else:
            return jsonify({'error': 'Provide a file upload or source_url'}), 400

        # Process: resize to 600×600 JPEG
        processed = _process_artist_image(raw)
        artwork_path.write_bytes(processed)
        size_kb = round(len(processed) / 1024, 1)

        # Invalidate in-memory library so next load picks up new artwork_key
        with library_lock:
            for t in library:
                ta = (t.get('album_artist') or t.get('artist') or '').strip()
                tl = (t.get('album') or '').strip()
                if get_artwork_key(ta, tl) == artwork_key or get_artwork_key(t.get('artist',''), tl) == artwork_key:
                    t['artwork_key'] = artwork_key

        return jsonify({'artwork_key': artwork_key, 'size_kb': size_kb})
    except Exception as e:
        print(f"[album-art] save error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/library/albums/artwork', methods=['DELETE'])
def delete_album_artwork():
    """Remove the cached artwork file for an album."""
    artist = request.args.get('artist', '').strip()
    album  = request.args.get('album',  '').strip()
    if not artist or not album:
        return jsonify({'error': 'artist and album are required'}), 400

    artwork_key  = get_artwork_key(artist, album)
    artwork_path = ARTWORK_DIR / f"{artwork_key}.jpg"
    if artwork_path.exists():
        artwork_path.unlink()

    # Clear from in-memory library
    with library_lock:
        for t in library:
            ta = (t.get('album_artist') or t.get('artist') or '').strip()
            tl = (t.get('album') or '').strip()
            if get_artwork_key(ta, tl) == artwork_key or get_artwork_key(t.get('artist',''), tl) == artwork_key:
                t['artwork_key'] = None

    return '', 204


# ── Artist Images ─────────────────────────────────────────────────────────────

@app.route('/api/artists/<artist_key>/image')
def get_artist_image(artist_key):
    """Serve a stored artist portrait JPEG."""
    if not re.fullmatch(r'[0-9a-f]{32}', artist_key):
        return '', 400
    img_path = ARTIST_ARTWORK_DIR / f"{artist_key}.jpg"
    if img_path.exists():
        return send_file(str(img_path), mimetype='image/jpeg')
    return '', 404


@app.route('/api/artists/by-name/image/search')
def search_artist_image_by_name():
    """Search for artist images by artist name (no key needed)."""
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify({'error': 'q (artist name) required'}), 400

    settings = load_settings()
    service = request.args.get('service', settings.get('artist_image_service', 'itunes'))

    if service == 'lastfm':
        api_key = settings.get('lastfm_api_key', '')
        if not api_key:
            return jsonify({'error': 'Last.fm API key not configured in Settings'}), 400
        candidates = _search_lastfm(q, api_key)
    elif service == 'fanart':
        api_key = settings.get('fanart_api_key', '')
        if not api_key:
            return jsonify({'error': 'Fanart.tv API key not configured in Settings'}), 400
        candidates = _search_fanart(q, api_key)
    else:
        candidates = _search_itunes(q)

    return jsonify({'candidates': candidates[:6]})


@app.route('/api/artists/<artist_key>/image/search')
def search_artist_image(artist_key):
    """
    Search a configured image service for artist portrait candidates.
    Query params: q=<artist_name>, service=<itunes|lastfm|fanart>
    Returns { candidates: [{url, thumbnail_url, source, label}] }
    """
    if not re.fullmatch(r'[0-9a-f]{32}', artist_key):
        return jsonify({'error': 'Invalid artist key'}), 400

    q = request.args.get('q', '').strip()
    if not q:
        return jsonify({'error': 'q (artist name) required'}), 400

    settings = load_settings()
    service = request.args.get('service', settings.get('artist_image_service', 'itunes'))

    if service == 'lastfm':
        api_key = settings.get('lastfm_api_key', '')
        if not api_key:
            return jsonify({'error': 'Last.fm API key not configured in Settings'}), 400
        candidates = _search_lastfm(q, api_key)
    elif service == 'fanart':
        api_key = settings.get('fanart_api_key', '')
        if not api_key:
            return jsonify({'error': 'Fanart.tv API key not configured in Settings'}), 400
        candidates = _search_fanart(q, api_key)
    else:
        candidates = _search_itunes(q)

    return jsonify({'candidates': candidates[:6]})


@app.route('/api/artists/<artist_key>/image', methods=['POST'])
def save_artist_image(artist_key):
    """
    Save an artist image. Accepts either:
    - JSON body: { source_url, artist_name, source }
    - Multipart: file field + artist_name field
    """
    if not re.fullmatch(r'[0-9a-f]{32}', artist_key):
        return jsonify({'error': 'Invalid artist key'}), 400

    artist_name = ''
    source = 'upload'
    image_data = None

    if request.files.get('file'):
        f = request.files['file']
        artist_name = request.form.get('artist_name', '')
        source = 'upload'
        image_data = f.read()
        if len(image_data) > 10 * 1024 * 1024:
            return jsonify({'error': 'File too large (max 10 MB)'}), 400
    else:
        body = request.json or {}
        source_url = (body.get('source_url') or '').strip()
        artist_name = (body.get('artist_name') or '').strip()
        source = body.get('source', 'upload')

        if not source_url:
            return jsonify({'error': 'source_url or file required'}), 400

        ok, err = _validate_image_url(source_url)
        if not ok:
            return jsonify({'error': err}), 400

        try:
            req = UrlRequest(source_url, headers={'User-Agent': 'TuneBridge/1.0'})
            with urlopen(req, timeout=15) as r:
                image_data = r.read()
        except Exception as e:
            return jsonify({'error': f'Failed to download image: {e}'}), 502

        if len(image_data) > 10 * 1024 * 1024:
            return jsonify({'error': 'Downloaded image too large (max 10 MB)'}), 400

    try:
        processed = _process_artist_image(image_data)
    except Exception as e:
        return jsonify({'error': f'Invalid image: {e}'}), 400

    img_path = ARTIST_ARTWORK_DIR / f"{artist_key}.jpg"
    img_path.write_bytes(processed)

    _db.db_save_artist_image(artist_key, artist_name, str(img_path), source)

    return jsonify({
        'artist_key': artist_key,
        'image_url': f'/api/artists/{artist_key}/image',
        'size_kb': round(len(processed) / 1024, 1),
    })


@app.route('/api/artists/<artist_key>/image', methods=['DELETE'])
def delete_artist_image(artist_key):
    """Remove a stored artist image."""
    if not re.fullmatch(r'[0-9a-f]{32}', artist_key):
        return jsonify({'error': 'Invalid artist key'}), 400

    img_path = ARTIST_ARTWORK_DIR / f"{artist_key}.jpg"
    if img_path.exists():
        img_path.unlink()
    _db.db_delete_artist_image(artist_key)
    return '', 204


@app.route('/api/artists/by-name/image', methods=['POST'])
def save_artist_image_by_name():
    """
    Save artist image by artist name (computes key server-side).
    Accepts multipart or JSON body with artist_name field.
    """
    artist_name = ''
    source = 'upload'
    image_data = None

    if request.files.get('file'):
        f = request.files['file']
        artist_name = (request.form.get('artist_name') or '').strip()
        source = 'upload'
        image_data = f.read()
        if len(image_data) > 10 * 1024 * 1024:
            return jsonify({'error': 'File too large (max 10 MB)'}), 400
    else:
        body = request.json or {}
        source_url = (body.get('source_url') or '').strip()
        artist_name = (body.get('artist_name') or '').strip()
        source = body.get('source', 'upload')

        if not source_url:
            return jsonify({'error': 'source_url or file required'}), 400

        ok, err = _validate_image_url(source_url)
        if not ok:
            return jsonify({'error': err}), 400

        try:
            req = UrlRequest(source_url, headers={'User-Agent': 'TuneBridge/1.0'})
            with urlopen(req, timeout=15) as r:
                image_data = r.read()
        except Exception as e:
            return jsonify({'error': f'Failed to download image: {e}'}), 502

        if len(image_data) > 10 * 1024 * 1024:
            return jsonify({'error': 'Downloaded image too large (max 10 MB)'}), 400

    if not artist_name:
        return jsonify({'error': 'artist_name required'}), 400

    try:
        processed = _process_artist_image(image_data)
    except Exception as e:
        return jsonify({'error': f'Invalid image: {e}'}), 400

    artist_key = get_artist_image_key(artist_name)
    img_path = ARTIST_ARTWORK_DIR / f"{artist_key}.jpg"
    img_path.write_bytes(processed)
    _db.db_save_artist_image(artist_key, artist_name, str(img_path), source)

    return jsonify({
        'artist_key': artist_key,
        'image_url': f'/api/artists/{artist_key}/image',
        'size_kb': round(len(processed) / 1024, 1),
    })


# ── Artist Image Batch Fetch ─────────────────────────────────────────────────

_artist_image_batch_state = {
    'status':   'idle',    # idle | running | done | error | cancelled
    'done':     0,         # artists processed so far
    'total':    0,         # total artists to process
    'fetched':  0,         # new images successfully saved
    'skipped':  0,         # already had images (skipped)
    'failed':   0,         # search returned nothing or error
    'service':  'itunes',  # which service is being used
    'errors':   [],        # [{artist, reason}, ...] capped at 20
}
_artist_image_batch_lock = threading.Lock()


def _run_artist_image_batch(service: str, overwrite: bool) -> None:
    """Background thread: fetch missing artist images for all artists in library."""
    global _artist_image_batch_state

    # Collect distinct artist names from the library
    with library_lock:
        all_artists = sorted({
            (t.get('album_artist') or t.get('artist') or '').strip()
            for t in library
        } - {''})

    settings = load_settings()
    api_key  = ''
    if service == 'lastfm':
        api_key = (settings.get('lastfm_api_key') or '').strip()
    elif service == 'fanart':
        api_key = (settings.get('fanart_api_key') or '').strip()

    with _artist_image_batch_lock:
        _artist_image_batch_state.update({
            'status':  'running',
            'done':    0,
            'total':   len(all_artists),
            'fetched': 0,
            'skipped': 0,
            'failed':  0,
            'service': service,
            'errors':  [],
        })

    existing_keys = _db.db_get_all_artist_image_keys()

    for i, artist_name in enumerate(all_artists):
        # Cancellation check
        if _artist_image_batch_state['status'] != 'running':
            break

        artist_key = get_artist_image_key(artist_name)

        # Skip if already has an image (unless overwrite requested)
        if not overwrite and artist_key in existing_keys:
            with _artist_image_batch_lock:
                _artist_image_batch_state['skipped'] += 1
                _artist_image_batch_state['done'] = i + 1
            continue

        # Search for candidates
        try:
            if service == 'lastfm' and api_key:
                candidates = _search_lastfm(artist_name, api_key)
            elif service == 'fanart' and api_key:
                candidates = _search_fanart(artist_name, api_key)
            else:
                candidates = _search_itunes(artist_name)
        except Exception as e:
            candidates = []
            print(f"[batch-img] search error for '{artist_name}': {e}")

        if not candidates:
            with _artist_image_batch_lock:
                _artist_image_batch_state['failed'] += 1
                _artist_image_batch_state['done'] = i + 1
                if len(_artist_image_batch_state['errors']) < 20:
                    _artist_image_batch_state['errors'].append(
                        {'artist': artist_name, 'reason': 'No results found'}
                    )
            # Rate-limit courtesy pause even on misses
            time.sleep(0.3)
            continue

        # Fetch and save the first (best) candidate
        chosen = candidates[0]
        try:
            ok, err = _validate_image_url(chosen['url'])
            if not ok:
                raise ValueError(err)
            req = UrlRequest(chosen['url'], headers={'User-Agent': 'TuneBridge/1.0'})
            with urlopen(req, timeout=15) as r:
                raw = r.read()
            if len(raw) > 10 * 1024 * 1024:
                raise ValueError('Image too large (> 10 MB)')
            processed = _process_artist_image(raw)
            img_path  = ARTIST_ARTWORK_DIR / f"{artist_key}.jpg"
            img_path.write_bytes(processed)
            _db.db_save_artist_image(artist_key, artist_name, str(img_path), chosen.get('source', service))
            existing_keys.add(artist_key)  # update local set so next iteration is correct
            with _artist_image_batch_lock:
                _artist_image_batch_state['fetched'] += 1
                _artist_image_batch_state['done'] = i + 1
        except Exception as e:
            print(f"[batch-img] save error for '{artist_name}': {e}")
            with _artist_image_batch_lock:
                _artist_image_batch_state['failed'] += 1
                _artist_image_batch_state['done'] = i + 1
                if len(_artist_image_batch_state['errors']) < 20:
                    _artist_image_batch_state['errors'].append(
                        {'artist': artist_name, 'reason': str(e)}
                    )

        # Rate-limit: be polite to external APIs
        # Fanart needs MusicBrainz first (already slowed by network), iTunes is lenient
        if service == 'fanart':
            time.sleep(1.2)   # MusicBrainz: 1 req/s guideline
        elif service == 'lastfm':
            time.sleep(0.5)
        else:
            time.sleep(0.25)  # iTunes: no published limit

    # Mark final state
    final_status = _artist_image_batch_state['status']
    with _artist_image_batch_lock:
        if final_status == 'running':
            _artist_image_batch_state['status'] = 'done'
        # if cancelled, leave status as 'cancelled'
    print(
        f"[batch-img] finished — "
        f"fetched={_artist_image_batch_state['fetched']} "
        f"skipped={_artist_image_batch_state['skipped']} "
        f"failed={_artist_image_batch_state['failed']}"
    )


@app.route('/api/artists/images/batch', methods=['POST'])
def start_artist_image_batch():
    """Start the background artist-image batch fetch job."""
    if _artist_image_batch_state['status'] == 'running':
        return jsonify({'error': 'Batch job is already running'}), 409

    settings  = load_settings()
    body      = request.json or {}
    service   = body.get('service', settings.get('artist_image_service', 'itunes')).strip().lower()
    overwrite = bool(body.get('overwrite', False))

    # Validate API key is present for keyed services
    if service == 'lastfm' and not (settings.get('lastfm_api_key') or '').strip():
        return jsonify({'error': 'Last.fm API key not configured. Add it in Settings → Artist Images.'}), 400
    if service == 'fanart' and not (settings.get('fanart_api_key') or '').strip():
        return jsonify({'error': 'Fanart.tv API key not configured. Add it in Settings → Artist Images.'}), 400

    threading.Thread(
        target=_run_artist_image_batch,
        args=(service, overwrite),
        daemon=True,
    ).start()

    return jsonify({'ok': True, 'service': service})


@app.route('/api/artists/images/batch/status')
def artist_image_batch_status():
    return jsonify(dict(_artist_image_batch_state))


@app.route('/api/artists/images/batch/cancel', methods=['POST'])
def cancel_artist_image_batch():
    if _artist_image_batch_state['status'] == 'running':
        with _artist_image_batch_lock:
            _artist_image_batch_state['status'] = 'cancelled'
    return jsonify({'ok': True})


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


# ── ML Playlist Generation (v1) ───────────────────────────────────────────────

def _norm_genre_text(s):
    return re.sub(r'\s+', ' ', str(s or '').strip().lower())


def _split_track_genres(raw):
    if not raw:
        return []
    chunks = re.split(r'[,/;|]', str(raw))
    out = []
    for c in chunks:
        g = _norm_genre_text(c)
        if g and g not in out:
            out.append(g)
    return out


def _build_genre_lookup(families):
    alias_to_base = {}
    for base, rel in families.items():
        b = _norm_genre_text(base)
        if not b:
            continue
        alias_to_base[b] = b
        for r in rel:
            rr = _norm_genre_text(r)
            if rr and rr not in alias_to_base:
                alias_to_base[rr] = b
    return alias_to_base


def _clamp(x, lo, hi):
    return max(lo, min(hi, x))


def _safe_float(v, fallback=None):
    try:
        if v is None:
            return fallback
        return float(v)
    except Exception:
        return fallback


def _load_track_feature_map():
    return _db.db_load_feature_map()


def _track_numeric_features(track, feat_map):
    """Return normalized generation features with graceful fallbacks."""
    f = feat_map.get(track.get('id'), {}) if feat_map else {}
    # Energy fallback: 0.5 center; if band profile exists use mean band energy.
    band = f.get('band_energy')
    if isinstance(band, list) and band:
        vals = [_safe_float(v) for v in band if _safe_float(v) is not None]
        energy = sum(vals) / len(vals) if vals else 0.5
        bass = sum(vals[:4]) / max(1, len(vals[:4]))
        treble = sum(vals[-4:]) / max(1, len(vals[-4:]))
    else:
        energy = 0.5
        bass = 0.5
        treble = 0.5

    # Brightness can be either normalized 0..1 or centroid in Hz.
    b = f.get('brightness')
    if isinstance(b, dict):
        b = b.get('centroid_hz') or b.get('median_hz') or b.get('value')
    bb = _safe_float(b)
    if bb is None:
        brightness = 0.5
    elif bb > 2.0:  # likely Hz scale
        brightness = _clamp((bb - 1500.0) / 5000.0, 0.0, 1.0)
    else:
        brightness = _clamp(bb, 0.0, 1.0)

    y = _safe_float(track.get('year'))
    year_norm = 0.5 if y is None else _clamp((y - 1950.0) / 90.0, 0.0, 1.0)
    dur = _safe_float(track.get('duration'), 180.0)
    dur_norm = _clamp((dur - 60.0) / 420.0, 0.0, 1.0)

    missing_penalty = 0.0
    if f.get('failed'):
        missing_penalty += 0.08
    if band is None:
        missing_penalty += 0.04
    if bb is None:
        missing_penalty += 0.03

    return {
        'energy': energy,
        'brightness': brightness,
        'bass': bass,
        'treble': treble,
        'year_norm': year_norm,
        'dur_norm': dur_norm,
        'missing_penalty': missing_penalty,
    }


def _genre_match_score(track_genres, target_genre, genre_mode, families):
    if not target_genre:
        return 0.5
    tg = _norm_genre_text(target_genre)
    if not tg:
        return 0.5
    alias = _build_genre_lookup(families)
    track_bases = set(alias.get(g, g) for g in track_genres)
    target_base = alias.get(tg, tg)
    if target_base in track_bases:
        return 1.0
    if genre_mode == 'strict':
        return 0.0
    # relaxed: adjacent family membership gets partial credit
    related = set([target_base] + families.get(target_base, []))
    if any(g in related or alias.get(g, g) in related for g in track_genres):
        return 0.72
    return 0.0


def _similarity_score(track_vec, seed_vec):
    if not seed_vec:
        return 0.5
    de = abs(track_vec['energy'] - seed_vec['energy'])
    db = abs(track_vec['brightness'] - seed_vec['brightness'])
    dy = abs(track_vec['year_norm'] - seed_vec['year_norm'])
    dd = abs(track_vec['dur_norm'] - seed_vec['dur_norm'])
    dist = (de * 0.45 + db * 0.3 + dy * 0.15 + dd * 0.1)
    return _clamp(1.0 - dist, 0.0, 1.0)


def _transition_score(prev_track, prev_vec, cur_track, cur_vec, tw, transition_smoothness):
    if not prev_track or not prev_vec:
        return 0.65
    energy_cont = 1.0 - abs(prev_vec['energy'] - cur_vec['energy'])
    bright_cont = 1.0 - abs(prev_vec['brightness'] - cur_vec['brightness'])
    year_cont = 1.0 - abs(prev_vec['year_norm'] - cur_vec['year_norm'])

    prev_genres = set(_split_track_genres(prev_track.get('genre')))
    cur_genres = set(_split_track_genres(cur_track.get('genre')))
    genre_cont = 1.0 if (prev_genres & cur_genres) else 0.45

    raw = (
        tw.get('energy', 0.4) * energy_cont
        + tw.get('brightness', 0.25) * bright_cont
        + tw.get('year', 0.15) * year_cont
        + tw.get('genre', 0.2) * genre_cont
    )
    smooth = _clamp(transition_smoothness if transition_smoothness is not None else 0.8, 0.0, 1.0)
    return _clamp((raw * smooth) + (0.5 * (1.0 - smooth)), 0.0, 1.0)


def _arc_target_energy(idx, total, start_energy, arc):
    if total <= 1:
        return start_energy
    t = idx / max(1, total - 1)
    s = _clamp(start_energy, 0.0, 1.0)
    if arc == 'gradual_build':
        return _clamp(s + 0.28 * t, 0.0, 1.0)
    if arc == 'peak_release':
        if t <= 0.55:
            return _clamp(s + 0.32 * (t / 0.55), 0.0, 1.0)
        return _clamp((s + 0.32) - 0.35 * ((t - 0.55) / 0.45), 0.0, 1.0)
    if arc == 'wind_down':
        return _clamp(s - 0.32 * t, 0.0, 1.0)
    return s  # steady


def _build_playlist_generation_preview(payload):
    cfg = load_playlist_gen_config()
    families = load_genre_families()
    weights = cfg.get('weights', {})
    tw = cfg.get('transition_weights', {})

    mode = str(payload.get('mode') or 'genre').strip().lower()
    if mode not in ('seed', 'genre', 'hybrid'):
        mode = 'genre'
    genre_mode = str(payload.get('genre_mode') or 'strict').strip().lower()
    if genre_mode not in ('strict', 'relaxed'):
        genre_mode = 'strict'

    with library_lock:
        lib_tracks = list(library)

    max_lib = int(cfg.get('max_library_tracks', 5000) or 5000)
    if len(lib_tracks) > max_lib:
        # Keep most recent-ish tracks first for predictable performance.
        lib_tracks = sorted(lib_tracks, key=lambda t: t.get('date_added') or 0, reverse=True)[:max_lib]

    lib_map = {t.get('id'): t for t in lib_tracks if t.get('id')}

    seed_ids = [str(x) for x in (payload.get('seed_track_ids') or []) if str(x)]
    seed_ids = [sid for sid in seed_ids if sid in lib_map]
    target_genre = payload.get('target_genre')
    playlist_length = int(payload.get('playlist_length') or cfg.get('default_playlist_length', 20))
    playlist_length = _clamp(playlist_length, int(cfg.get('min_playlist_length', 8)), int(cfg.get('max_playlist_length', 80)))
    year_range = payload.get('year_range') if isinstance(payload.get('year_range'), list) and len(payload.get('year_range')) == 2 else None
    energy_target = _safe_float(payload.get('energy_target'))
    brightness_target = _safe_float(payload.get('brightness_target'))
    mood = str(payload.get('mood') or '').strip().lower()
    mood_presets = {
        'focus': (0.42, 0.40),
        'late_night': (0.30, 0.35),
        'energetic': (0.78, 0.62),
        'warm_relaxed': (0.38, 0.28),
        'hype': (0.86, 0.70),
        'bright_bouncy': (0.72, 0.78),
        'dark_heavy': (0.68, 0.24),
    }
    if mood in mood_presets:
        m_energy, m_brightness = mood_presets[mood]
        if energy_target is None:
            energy_target = m_energy
        if brightness_target is None:
            brightness_target = m_brightness
    allow_repeat_artists = bool(payload.get('allow_repeat_artists', False))
    diversity_strength = _clamp(_safe_float(payload.get('diversity_strength'), 0.7), 0.0, 1.0)
    transition_smoothness = _clamp(_safe_float(payload.get('transition_smoothness'), 0.8), 0.0, 1.0)
    deterministic_default = bool(cfg.get('deterministic_default', True))
    deterministic = bool(payload.get('deterministic', deterministic_default))
    regenerate_mode = bool(payload.get('regenerate', False))
    arc = str(payload.get('playlist_arc') or 'steady').strip().lower()
    if arc not in ('steady', 'gradual_build', 'peak_release', 'wind_down'):
        arc = 'steady'
    excluded_track_ids = {str(x) for x in (payload.get('excluded_track_ids') or [])}
    excluded_artists = {_norm_genre_text(x) for x in (payload.get('excluded_artists') or []) if str(x).strip()}

    payload_seed = int(payload.get('seed', 1337))
    rng = random.Random(payload_seed if deterministic else time.time_ns())
    feat_map = _load_track_feature_map()

    # Seed centroid
    seed_vec = None
    if seed_ids:
        vectors = [_track_numeric_features(lib_map[sid], feat_map) for sid in seed_ids]
        seed_vec = {
            'energy': sum(v['energy'] for v in vectors) / len(vectors),
            'brightness': sum(v['brightness'] for v in vectors) / len(vectors),
            'year_norm': sum(v['year_norm'] for v in vectors) / len(vectors),
            'dur_norm': sum(v['dur_norm'] for v in vectors) / len(vectors),
        }

    # Candidate pool
    candidates = []
    for t in lib_tracks:
        tid = t.get('id')
        if not tid or tid in excluded_track_ids:
            continue
        if _norm_genre_text(t.get('artist')) in excluded_artists:
            continue
        if year_range:
            y = _safe_float(t.get('year'))
            if y is not None and (y < year_range[0] or y > year_range[1]):
                continue

        genres = _split_track_genres(t.get('genre'))
        gm = _genre_match_score(genres, target_genre, genre_mode, families)
        if mode in ('genre', 'hybrid') and target_genre:
            if genre_mode == 'strict' and gm <= 0:
                continue
            if genre_mode == 'relaxed' and gm < 0.72 and mode == 'genre':
                continue

        v = _track_numeric_features(t, feat_map)
        sim = _similarity_score(v, seed_vec) if mode in ('seed', 'hybrid') else 0.5
        mood_parts = []
        if energy_target is not None:
            mood_parts.append(1.0 - abs(v['energy'] - _clamp(energy_target, 0.0, 1.0)))
        if brightness_target is not None:
            mood_parts.append(1.0 - abs(v['brightness'] - _clamp(brightness_target, 0.0, 1.0)))
        mood = sum(mood_parts) / len(mood_parts) if mood_parts else 0.5
        sound = _clamp(1.0 - abs(v['bass'] - v['treble']) * 0.6, 0.0, 1.0)
        diversity = 0.55 + (0.25 * (1.0 - v['missing_penalty']))

        cand_score = (
            weights.get('similarity', 0.35) * sim
            + weights.get('genre', 0.2) * gm
            + weights.get('mood', 0.2) * mood
            + weights.get('sound', 0.1) * sound
            + weights.get('diversity', 0.15) * diversity
            - v['missing_penalty']
        )
        candidates.append({
            'track': t,
            'vec': v,
            'genres': genres,
            'scores': {
                'similarity': round(sim, 4),
                'genre_match': round(gm, 4),
                'mood_match': round(mood, 4),
                'sound_match': round(sound, 4),
                'diversity': round(diversity, 4),
            },
            'candidate_score': cand_score,
        })

    if not candidates:
        return {'tracks': [], 'explanations': [], 'summary': {'reason': 'No candidates matched filters.'}}

    candidates.sort(key=lambda c: c['candidate_score'], reverse=True)
    cap = int(cfg.get('candidate_pool_cap', 1500) or 1500)
    candidates = candidates[:cap]

    # Selection + sequencing
    selected = []
    selected_ids = set()
    artist_counts = {}
    album_counts = {}

    prev_track = None
    prev_vec = None
    base_start_energy = energy_target if energy_target is not None else (seed_vec['energy'] if seed_vec else 0.5)

    # If seeds exist, anchor the first one.
    if seed_ids and seed_ids[0] in lib_map:
        s0 = lib_map[seed_ids[0]]
        v0 = _track_numeric_features(s0, feat_map)
        selected.append({
            'track': s0,
            'candidate_score': 1.0,
            'transition_score': 0.7,
            'placement_score': 1.0,
            'reason': 'Seed anchor',
        })
        selected_ids.add(s0['id'])
        artist_counts[_norm_genre_text(s0.get('artist'))] = 1
        album_counts[_norm_genre_text(s0.get('album'))] = 1
        prev_track, prev_vec = s0, v0

    while len(selected) < playlist_length:
        best = None
        best_score = -1e9
        top_alternatives = []
        idx = len(selected)
        arc_target = _arc_target_energy(idx, playlist_length, base_start_energy, arc)
        for c in candidates:
            tid = c['track'].get('id')
            if not tid or tid in selected_ids:
                continue

            artist_k = _norm_genre_text(c['track'].get('artist'))
            album_k = _norm_genre_text(c['track'].get('album'))
            repeat_artist_pen = 0.0
            repeat_album_pen = 0.0
            if not allow_repeat_artists and artist_counts.get(artist_k, 0) > 0:
                repeat_artist_pen = 0.22 + 0.10 * artist_counts.get(artist_k, 0)
            if album_counts.get(album_k, 0) > 0:
                repeat_album_pen = 0.08 + 0.05 * album_counts.get(album_k, 0)

            trans = _transition_score(prev_track, prev_vec, c['track'], c['vec'], tw, transition_smoothness)
            arc_pen = abs(c['vec']['energy'] - arc_target) * 0.18
            diversity_pen = (repeat_artist_pen + repeat_album_pen) * diversity_strength
            placement = (c['candidate_score'] * (1.0 - transition_smoothness * 0.35)) + (trans * transition_smoothness) - diversity_pen - arc_pen

            # Deterministic mode still gets a reproducible tie-break jitter that changes
            # across run seeds (used by Regenerate). Non-deterministic uses true random jitter.
            if deterministic:
                key = f"{payload_seed}:{idx}:{tid or ''}"
                digest = hashlib.md5(key.encode()).digest()
                unit = int.from_bytes(digest[:4], 'big') / 0xFFFFFFFF
                placement += (unit - 0.5) * 0.016
            else:
                placement += rng.uniform(-0.012, 0.012)

            if placement > best_score:
                best_score = placement
                best = (c, trans, placement)
            top_alternatives.append((placement, c, trans))

        if not best:
            break

        # Regenerate mode intentionally explores the top-ranked window so each run
        # can return alternate but still high-quality sequences.
        if regenerate_mode and top_alternatives:
            top_alternatives.sort(key=lambda x: x[0], reverse=True)
            window = min(8, len(top_alternatives))
            pick_rank = int(rng.random() * window)
            placement, c, trans = top_alternatives[pick_rank]
        else:
            c, trans, placement = best
        t = c['track']
        selected.append({
            'track': t,
            'candidate_score': round(c['candidate_score'], 4),
            'transition_score': round(trans, 4),
            'placement_score': round(placement, 4),
            'reason': 'Genre fit' if c['scores']['genre_match'] >= 0.99 else ('Transition continuity' if trans >= 0.72 else 'Balanced fit'),
            'score_components': c['scores'],
        })
        selected_ids.add(t['id'])
        artist_counts[_norm_genre_text(t.get('artist'))] = artist_counts.get(_norm_genre_text(t.get('artist')), 0) + 1
        album_counts[_norm_genre_text(t.get('album'))] = album_counts.get(_norm_genre_text(t.get('album')), 0) + 1
        prev_track, prev_vec = t, c['vec']

    out_tracks = [s['track'] for s in selected]
    out_explain = [{
        'track_id': s['track'].get('id'),
        'candidate_score': s['candidate_score'],
        'transition_score': s['transition_score'],
        'placement_score': s['placement_score'],
        'reason': s['reason'],
        'score_components': s.get('score_components', {}),
    } for s in selected]

    return {
        'tracks': out_tracks,
        'explanations': out_explain,
        'summary': {
            'mode': mode,
            'genre_mode': genre_mode,
            'mood': mood,
            'target_genre': target_genre or '',
            'requested_length': playlist_length,
            'generated_length': len(out_tracks),
            'seed_count': len(seed_ids),
            'candidate_pool_size': len(candidates),
            'deterministic': deterministic,
            'arc': arc,
            'library_tracks_considered': len(lib_tracks),
            'max_library_tracks': max_lib,
            'note': 'Some tracks used fallback scoring due to missing audio features.',
        }
    }


@app.route('/api/playlists/generate/options', methods=['GET'])
def playlist_generate_options():
    with library_lock:
        tracks = list(library)
    genres = {}
    for t in tracks:
        for g in _split_track_genres(t.get('genre')):
            genres[g] = genres.get(g, 0) + 1
    top_genres = [g for g, _ in sorted(genres.items(), key=lambda kv: (-kv[1], kv[0]))[:80]]
    cfg = load_playlist_gen_config()
    return jsonify({
        'modes': ['seed', 'genre', 'hybrid'],
        'genre_modes': ['strict', 'relaxed'],
        'playlist_arcs': ['steady', 'gradual_build', 'peak_release', 'wind_down'],
        'genres': top_genres,
        'genre_families': load_genre_families(),
        'defaults': {
            'mode': 'genre',
            'genre_mode': 'strict',
            'playlist_length': cfg.get('default_playlist_length', 20),
            'deterministic': cfg.get('deterministic_default', True),
            'diversity_strength': 0.7,
            'transition_smoothness': 0.8,
            'playlist_arc': 'steady',
            'allow_repeat_artists': False,
        },
        'limits': {
            'playlist_length': [cfg.get('min_playlist_length', 8), cfg.get('max_playlist_length', 80)],
            'max_library_tracks': cfg.get('max_library_tracks', 5000),
            'candidate_pool_cap': cfg.get('candidate_pool_cap', 1500),
        }
    })


@app.route('/api/playlists/generate/preview', methods=['POST'])
def playlist_generate_preview():
    data = request.json or {}
    result = _build_playlist_generation_preview(data)
    return jsonify(result)


@app.route('/api/playlists/generate/save', methods=['POST'])
def playlist_generate_save():
    data = request.json or {}
    name = str(data.get('name') or '').strip() or f"Generated Playlist {time.strftime('%Y-%m-%d %H:%M')}"
    track_ids = data.get('track_ids') or []
    if not isinstance(track_ids, list):
        return jsonify({'error': 'track_ids must be a list'}), 400

    with library_lock:
        valid_ids = {t.get('id') for t in library}
    clean_ids = [str(tid) for tid in track_ids if str(tid) in valid_ids]
    if not clean_ids:
        return jsonify({'error': 'No valid tracks to save'}), 400

    playlists = load_playlists()
    pid = str(uuid.uuid4())
    now = int(time.time())
    playlists[pid] = {
        'id': pid,
        'name': name,
        'created_at': now,
        'updated_at': now,
        'tracks': clean_ids,
        'generator': 'ml_v1',
    }
    save_playlists(playlists)
    return jsonify({'id': pid, 'name': name, 'track_count': len(clean_ids)}), 201


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
    s['_settings_exists'] = True
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
    return jsonify({
        'status': 'ok',
        # Lets the GUI launcher verify it connected to the server instance
        # started by the current process (not a stale older process on the port).
        'instance_token': os.environ.get('TUNEBRIDGE_INSTANCE_TOKEN'),
        'pid': os.getpid(),
    })


# ── mpv audio engine ──────────────────────────────────────────────────────
# Provides bit-perfect CoreAudio output via libmpv.
# Requires: brew install mpv  (installs libmpv.dylib)

_mpv_instance         = None   # mpv.MPV singleton
_mpv_lock             = threading.Lock()
_mpv_track_ended      = False  # set by end-file(eof) event, consumed by /mpv_state
_mpv_current_track_id = None
_mpv_load_time        = 0.0    # epoch timestamp of last player_play() call (grace period)
_mpv_last_volume      = 1.0    # logical 0.0–1.0 volume persisted across reinit
_mpv_last_af          = ''     # last applied lavfi chain (PEQ) persisted across reinit


def _get_mpv():
    """Return the mpv.MPV singleton, creating it lazily (thread-safe)."""
    global _mpv_instance
    _refresh_mpv_backend()
    if not MPV_AVAILABLE:
        return None
    if _mpv_instance is None:
        with _mpv_lock:
            if _mpv_instance is None:
                _create_mpv_instance()
    return _mpv_instance


def _create_mpv_instance():
    """Create a new mpv.MPV instance with current settings. Must be called inside _mpv_lock."""
    global _mpv_instance, _mpv_track_ended, _mpv_last_volume, _mpv_last_af
    settings = load_settings()
    exclusive = settings.get('exclusive_mode', False)
    audio_device = settings.get('audio_device', 'auto') or 'auto'
    player = _mpv_lib.MPV(
        audio_exclusive='yes' if exclusive else 'no',
        audio_device=audio_device,
        video='no',
        # Log output silenced — uncomment for debugging:
        # log_handler=print,
        # loglevel='info',
    )

    # Use the end-file EVENT to detect natural track endings.
    # event.as_dict() returns e.g. {'reason': b'eof', 'playlist_entry_id': 1}
    # Reason values (bytes):
    #   b'eof'  — file played to completion naturally  → advance queue ✓
    #   b'stop' — stopped by loadfile/replace or stop() → do NOT advance ✗
    #   b'quit' / b'error' / b'redirect' / b'unknown'  → do NOT advance ✗
    # Note: MpvEvent has no .get() or .reason — must use event.as_dict().
    @player.event_callback('end-file')
    def _on_end_file(event):
        global _mpv_track_ended
        try:
            reason = event.as_dict().get('reason')
            # python-mpv returns bytes (b'eof', b'stop', …)
            if reason in (b'eof', 'eof'):
                _mpv_track_ended = True
        except Exception:
            pass

    _mpv_instance = player
    # Reapply runtime state after any reinit so audio behavior is consistent.
    try:
        player.volume = max(0.0, min(1.0, float(_mpv_last_volume))) * 100.0
    except Exception:
        pass
    try:
        player.af = _mpv_last_af or ''
    except Exception:
        pass


def _resolve_track_path_mpv(track_id):
    """Return the absolute filesystem path for a track_id, or None if not found."""
    track = _db.db_get_track(track_id)
    if not track:
        return None
    return str(get_music_base() / track['path'])


def _get_track_sample_rate(track_id):
    """Return the sample rate (Hz) for a track_id, or 0 if unknown."""
    track = _db.db_get_track(track_id)
    return int(track.get('sample_rate') or 0) if track else 0


def _mpv_safe_reinit():
    """Destroy and recreate the mpv singleton — safe for cross-thread use.

    Used when CoreAudio exclusive mode must fully release then reacquire
    the hardware lock (e.g. sample-rate change between tracks).

    Safety strategy:
      1. Under _mpv_lock: set _mpv_instance = None, then create new instance.
         After the lock is released every new _get_mpv() call sees the fresh
         instance — no caller can accidentally use the old one.
      2. Terminate the old instance AFTER releasing the lock so mpv's own
         event thread can exit without deadlocking on the lock.
      3. player_mpv_state() wraps all property reads in try/except, so any
         thread that already held a local reference to the old instance will
         just get a safe idle response rather than crashing.
    """
    global _mpv_instance
    old_instance = None
    with _mpv_lock:
        old_instance = _mpv_instance
        _mpv_instance = None          # null first — callers now wait on lock
        _create_mpv_instance()        # sets _mpv_instance = fresh player
    # Terminate old outside the lock so mpv's event thread can exit cleanly
    if old_instance is not None:
        try:
            old_instance.terminate()
        except Exception:
            pass


def _build_lavfi_peq(preamp_db, filters):
    """Translate an APO/AutoEQ PEQ profile into an mpv lavfi audio filter string."""
    parts = []
    preamp = float(preamp_db or 0)
    if abs(preamp) > 0.01:
        parts.append(f'volume={preamp}dB')
    for f in (filters or []):
        if not f.get('enabled', True):
            continue
        t   = str(f.get('type', 'PK')).upper()
        fc  = max(20.0, min(20000.0, float(f.get('fc',   1000))))
        g   = float(f.get('gain', 0))
        q   = max(0.1,  min(30.0,  float(f.get('q',     1.0))))
        if t in ('PK', 'PEQ'):
            parts.append(f'equalizer=f={fc}:width_type=q:width={q}:g={g}')
        elif t in ('LSC', 'LS', 'LSQ'):
            parts.append(f'lowshelf=f={fc}:width_type=s:width=1:g={g}')
        elif t in ('HSC', 'HS', 'HSQ'):
            parts.append(f'highshelf=f={fc}:width_type=s:width=1:g={g}')
        elif t in ('LPQ', 'LP'):
            parts.append(f'lowpass=f={fc}:poles=2')
        elif t in ('HPQ', 'HP'):
            parts.append(f'highpass=f={fc}:poles=2')
        elif t in ('NO', 'NOTCH'):
            parts.append(f'bandreject=f={fc}:width_type=q:width={q}')
        # AP (allpass) — no magnitude effect, skip
    if not parts:
        return ''
    return 'lavfi=[' + ','.join(parts) + ']'


@app.route('/api/player/capabilities')
def player_capabilities():
    """Report whether the mpv backend is available and current exclusive-mode setting."""
    _refresh_mpv_backend()
    settings = load_settings()
    version = None
    effective_audio_device = settings.get('audio_device', 'auto')
    if MPV_AVAILABLE:
        try:
            p = _get_mpv()
            version = p.mpv_version if p else None
            if p is not None:
                effective_audio_device = p.audio_device or effective_audio_device
        except Exception:
            pass
    status = _mpv_runtime_status()
    return jsonify({
        'mpv_available':  MPV_AVAILABLE,
        'mpv_version':    version,
        'mpv_error':      _mpv_import_error,
        'exclusive_mode': settings.get('exclusive_mode', False),
        'audio_device':   effective_audio_device,
        'mpv_runtime':    status,
    })


@app.route('/api/player/install_mpv', methods=['POST'])
def player_install_mpv():
    """Install mpv via Homebrew and refresh runtime detection."""
    py_ok, py_err = _ensure_python_mpv_installed()
    if not py_ok:
        status = _mpv_runtime_status()
        return jsonify({
            'ok': False,
            'error': f'python-mpv unavailable: {py_err}',
            'status': status,
        }), 500
    brew = _find_executable('brew')
    if not brew:
        # If libmpv is already present, skip brew and just refresh detection.
        if _find_libmpv_path():
            _refresh_mpv_backend(force=True)
            version = None
            if MPV_AVAILABLE:
                try:
                    p = _get_mpv()
                    version = p.mpv_version if p else None
                except Exception:
                    pass
            status = _mpv_runtime_status()
            return jsonify({
                'ok': MPV_AVAILABLE,
                'mpv_available': MPV_AVAILABLE,
                'mpv_version': version,
                'error': None if MPV_AVAILABLE else (_mpv_import_error or 'libmpv found but backend still unavailable'),
                'status': status,
            }), (200 if MPV_AVAILABLE else 500)
        status = _mpv_runtime_status()
        return jsonify({
            'ok': False,
            'error': 'Homebrew not found in app PATH. Ensure Homebrew is installed at /opt/homebrew or /usr/local, then retry.',
            'status': status,
        }), 400
    try:
        # Installing mpv via Homebrew pulls all formula dependencies needed for libmpv.
        proc = subprocess.run(
            [brew, 'install', 'mpv', '--quiet'],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=1800,
            env=_runtime_env(),
        )
    except subprocess.TimeoutExpired:
        return jsonify({'ok': False, 'error': 'mpv install timed out'}), 500
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or 'brew install mpv failed').strip()
        return jsonify({'ok': False, 'error': msg[-1200:]}), 500
    # Force re-detection; if the app started before mpv was installed,
    # this allows Settings to reflect availability immediately.
    _refresh_mpv_backend(force=True)
    version = None
    if MPV_AVAILABLE:
        try:
            p = _get_mpv()
            version = p.mpv_version if p else None
        except Exception:
            pass
    status = _mpv_runtime_status()
    return jsonify({
        'ok': MPV_AVAILABLE,
        'mpv_available': MPV_AVAILABLE,
        'mpv_version': version,
        'error': None if MPV_AVAILABLE else (_mpv_import_error or 'mpv install completed but backend still unavailable'),
        'status': status,
    }), (200 if MPV_AVAILABLE else 500)


@app.route('/api/player/audio_devices')
def player_audio_devices():
    """Return the list of audio output devices mpv can see."""
    _refresh_mpv_backend()
    if not MPV_AVAILABLE:
        return jsonify({'devices': [{'name': 'auto', 'description': 'Autoselect device'}]})
    try:
        p = _get_mpv()
        devices = list(p.audio_device_list or [])
        # Keep only coreaudio/* and auto; skip avfoundation duplicates
        filtered = [d for d in devices
                    if d.get('name') == 'auto' or
                       str(d.get('name', '')).startswith('coreaudio/')]
        return jsonify({'devices': filtered if filtered else devices})
    except Exception as e:
        return jsonify({'devices': [{'name': 'auto', 'description': 'Autoselect device'}],
                        'error': str(e)})


@app.route('/api/player/audio_device', methods=['POST'])
def player_set_audio_device():
    """Set the audio output device. Reinitialises the mpv instance to apply."""
    _refresh_mpv_backend()
    data   = request.get_json(force=True) or {}
    requested_device = data.get('device', 'auto') or 'auto'
    device = requested_device
    if MPV_AVAILABLE:
        # Validate against current visible device names; if stale/missing fallback to auto.
        try:
            p = _get_mpv()
            names = {str(d.get('name', '')) for d in (p.audio_device_list or [])}
            names.add('auto')
            if device not in names:
                device = 'auto'
        except Exception:
            pass
    settings = load_settings()
    settings['audio_device'] = device
    save_settings(settings)
    # Capture position so frontend can resume
    resume_track_id = _mpv_current_track_id
    resume_position = 0.0
    was_playing     = False
    if MPV_AVAILABLE:
        try:
            p = _get_mpv()
            pos = p.time_pos
            if pos is not None:
                resume_position = float(pos)
            was_playing = (not bool(p.pause)) and (not bool(p.idle_active)) and (pos is not None)
        except Exception:
            pass
        _mpv_safe_reinit()
    effective_device = device
    if MPV_AVAILABLE:
        try:
            p2 = _get_mpv()
            effective_device = p2.audio_device or device
        except Exception:
            pass
    return jsonify({
        'ok':              True,
        'requested_device': requested_device,
        'audio_device':    effective_device,
        'resume_track_id': resume_track_id,
        'resume_position': resume_position,
        'was_playing':     was_playing,
    })


@app.route('/api/player/play', methods=['POST'])
def player_play():
    """Start playback of a track by ID. Optional: position (seconds) to start from."""
    global _mpv_current_track_id, _mpv_track_ended, _mpv_load_time
    _refresh_mpv_backend()
    if not MPV_AVAILABLE:
        return jsonify({'error': 'mpv not available — run: brew install mpv'}), 503
    data     = request.get_json(force=True) or {}
    track_id = data.get('track_id')
    if not track_id:
        return jsonify({'error': 'track_id required'}), 400
    path = _resolve_track_path_mpv(track_id)
    if not path:
        return jsonify({'error': 'track not found'}), 404
    position = float(data.get('position') or 0)

    _mpv_track_ended = False        # clear before loading new file
    _mpv_load_time   = time.time()  # start grace period (suppresses false end-file)

    # CoreAudio exclusive mode holds a hardware lock at the current sample rate.
    # Neither loadfile-replace nor stop-then-loadfile fully releases that lock
    # before reopening — the device hasn't settled and the reinit silently fails.
    # Only a full destroy+recreate of the mpv instance guarantees the lock is
    # released before we open at the new rate.  _mpv_safe_reinit() does this
    # without the crash risk: it nulls _mpv_instance under the lock (so new
    # callers get the fresh instance), creates the new one, then terminates the
    # old one after releasing the lock.  player_mpv_state() has try/except so
    # any thread still holding the old reference gets a safe idle response.
    # NOTE: read old track id BEFORE overwriting _mpv_current_track_id.
    settings = load_settings()
    if settings.get('exclusive_mode') and _mpv_current_track_id:
        new_sr = _get_track_sample_rate(track_id)
        old_sr = _get_track_sample_rate(_mpv_current_track_id)  # still the OLD id here
        if new_sr and old_sr and new_sr != old_sr:
            _mpv_safe_reinit()

    _mpv_current_track_id = track_id  # update AFTER sample-rate check

    # Fetch p AFTER potential reinit so we always talk to the live instance
    p = _get_mpv()
    if position > 0:
        p.command('loadfile', path, 'replace', f'start={position}')
    else:
        p.command('loadfile', path, 'replace')
    p.pause = False
    return jsonify({'ok': True})


@app.route('/api/player/pause', methods=['POST'])
def player_pause():
    """Toggle pause, or set pause state explicitly via {paused: true/false}."""
    _refresh_mpv_backend()
    if not MPV_AVAILABLE:
        return jsonify({'error': 'mpv not available'}), 503
    data = request.get_json(force=True) or {}
    p = _get_mpv()
    if 'paused' in data:
        p.pause = bool(data['paused'])
    else:
        p.pause = not p.pause
    return jsonify({'ok': True, 'paused': p.pause})


@app.route('/api/player/seek', methods=['POST'])
def player_seek():
    """Seek to an absolute position in seconds."""
    _refresh_mpv_backend()
    if not MPV_AVAILABLE:
        return jsonify({'error': 'mpv not available'}), 503
    data     = request.get_json(force=True) or {}
    position = float(data.get('position', 0))
    p = _get_mpv()
    try:
        p.seek(position, 'absolute')
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    return jsonify({'ok': True})


@app.route('/api/player/volume', methods=['POST'])
def player_volume():
    """Set playback volume. {volume: 0.0–1.0}"""
    global _mpv_last_volume
    _refresh_mpv_backend()
    if not MPV_AVAILABLE:
        return jsonify({'error': 'mpv not available'}), 503
    data   = request.get_json(force=True) or {}
    volume = max(0.0, min(1.0, float(data.get('volume', 1.0))))
    _mpv_last_volume = volume
    p = _get_mpv()
    p.volume = volume * 100   # mpv uses 0–100 scale
    return jsonify({'ok': True})


@app.route('/api/player/stop', methods=['POST'])
def player_stop():
    """Stop playback."""
    global _mpv_current_track_id
    _refresh_mpv_backend()
    if not MPV_AVAILABLE:
        return jsonify({'error': 'mpv not available'}), 503
    _mpv_current_track_id = None
    _get_mpv().stop()
    return jsonify({'ok': True})


@app.route('/api/player/peq', methods=['POST'])
def player_peq():
    """Apply a PEQ profile to mpv. {preamp_db: float, filters: [...]}"""
    global _mpv_last_af
    _refresh_mpv_backend()
    if not MPV_AVAILABLE:
        return jsonify({'error': 'mpv not available'}), 503
    data      = request.get_json(force=True) or {}
    preamp_db = data.get('preamp_db', 0)
    filters   = data.get('filters', [])
    p  = _get_mpv()
    af = _build_lavfi_peq(preamp_db, filters)
    _mpv_last_af = af if af else ''
    try:
        p.af = af if af else ''
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    return jsonify({'ok': True, 'af': af})


@app.route('/api/player/mpv_state')
def player_mpv_state():
    """Live playback state: position, duration, playing, track_ended flag."""
    global _mpv_track_ended
    _refresh_mpv_backend()
    if not MPV_AVAILABLE:
        return jsonify({'available': False})
    p = _get_mpv()
    try:
        position = p.playback_time   # None when idle
        duration = p.duration        # None when idle
        paused   = p.pause
        idle     = p.idle_active
    except Exception:
        # mpv handle may be briefly invalid during instance recreation
        return jsonify({'available': True, 'position': 0.0, 'duration': 0.0,
                        'playing': False, 'paused': True, 'idle': True,
                        'track_ended': False, 'track_id': _mpv_current_track_id})
    ended    = _mpv_track_ended
    if ended:
        # Grace period: discard any end-file event that fires within 750 ms of
        # player_play() — these are false positives from loadfile-replace stopping
        # the previous track, not genuine natural track endings.
        if (time.time() - _mpv_load_time) < 0.75:
            ended = False
            _mpv_track_ended = False  # discard
        else:
            _mpv_track_ended = False  # consume the one-shot flag
    return jsonify({
        'available':   True,
        'position':    position if position is not None else 0.0,
        'duration':    duration if duration is not None else 0.0,
        'playing':     (not paused) and (not idle) and (position is not None),
        'paused':      paused,
        'idle':        idle,
        'track_ended': ended,
        'track_id':    _mpv_current_track_id,
    })


@app.route('/api/player/exclusive', methods=['POST'])
def player_exclusive():
    """Toggle CoreAudio exclusive mode. Restarts mpv instance to apply."""
    global _mpv_instance
    _refresh_mpv_backend()
    data    = request.get_json(force=True) or {}
    enabled = bool(data.get('enabled', False))
    settings = load_settings()
    settings['exclusive_mode'] = enabled
    save_settings(settings)
    # Capture playback state before tearing down so the frontend can resume.
    # terminate() does not set eof-reached, so no track-end signal is emitted.
    resume_track_id = _mpv_current_track_id
    resume_position = 0.0
    was_playing     = False
    with _mpv_lock:
        if _mpv_instance is not None:
            try:
                pos = _mpv_instance.time_pos
                if pos is not None:
                    resume_position = float(pos)
                was_playing = (not bool(_mpv_instance.pause)) and (not bool(_mpv_instance.idle_active)) and (pos is not None)
                _mpv_instance.terminate()
            except Exception:
                pass
            _mpv_instance = None
    return jsonify({
        'ok':              True,
        'exclusive_mode':  enabled,
        'resume_track_id': resume_track_id,
        'resume_position': resume_position,
        'was_playing':     was_playing,
    })


# ── Player state persistence ───────────────────────────────────────────────
# Survives WKWebView restarts where localStorage is ephemeral.

@app.route('/api/player/state', methods=['GET'])
def get_player_state():
    return jsonify(_db.db_get_player_state())

@app.route('/api/player/state', methods=['POST'])
def save_player_state():
    data = request.get_json(force=True) or {}
    try:
        _db.db_save_player_state(data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    return jsonify({'ok': True})


@app.route('/api/player/events', methods=['POST'])
def player_events():
    settings = load_settings()
    if not _to_bool(settings.get('listening_tracking_enabled', True)):
        return jsonify({'ok': True, 'stored': 0, 'tracking_enabled': False})

    data = request.get_json(force=True) or {}
    raw_events = data.get('events') if isinstance(data.get('events'), list) else [data]
    if not raw_events:
        return jsonify({'ok': True, 'stored': 0, 'tracking_enabled': True})

    now = int(time.time())
    with library_lock:
        lib_by_id = {str(t.get('id')): t for t in library if t.get('id')}

    rows = []
    for raw in raw_events:
        if not isinstance(raw, dict):
            continue
        track_id = str(raw.get('track_id') or '').strip()
        if not track_id:
            continue
        src = lib_by_id.get(track_id, {})
        played_at = int(raw.get('played_at') or now)
        play_seconds = max(0.0, float(raw.get('play_seconds') or 0.0))
        duration = max(0.0, float(raw.get('track_duration_seconds') or src.get('duration') or 0.0))
        completed = _to_bool(raw.get('completed', False))
        valid = (play_seconds >= VALID_LISTEN_SECONDS) or (duration > 0 and (play_seconds / duration) >= VALID_LISTEN_RATIO)
        skipped = _to_bool(raw.get('skipped', False)) or (play_seconds > 0 and not completed and not valid)

        rows.append({
            'track_id': track_id,
            'played_at': played_at,
            'play_seconds': play_seconds,
            'track_duration_seconds': duration,
            'completed': completed,
            'skipped': skipped,
            'valid_listen': valid,
            'source_type': _normalize_source_type(raw.get('source_type')),
            'source_id': str(raw.get('source_id') or ''),
            'source_label': str(raw.get('source_label') or ''),
            'artist': str(raw.get('artist') or src.get('artist') or src.get('album_artist') or ''),
            'album': str(raw.get('album') or src.get('album') or ''),
            'title': str(raw.get('title') or src.get('title') or ''),
            'format': str(raw.get('format') or src.get('format') or ''),
        })
    if not rows:
        return jsonify({'ok': True, 'stored': 0, 'tracking_enabled': True})

    _db.db_insert_play_events(rows)
    _db.db_prune_play_events(_current_listen_cutoff())
    return jsonify({'ok': True, 'stored': len(rows), 'tracking_enabled': True})


@app.route('/api/player/events/clear', methods=['POST'])
def clear_player_events():
    _db.db_clear_play_events()
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
    try:
        db_path = _db.DB_PATH
        if db_path and db_path.exists():
            cache_age = round((_time.time() - db_path.stat().st_mtime) / 3600, 1)
    except Exception:
        cache_age = None
    result['library'] = {
        'ok': lib_ok,
        'path': str(music_path),
        'tracks': track_count,
        'cache_age_hours': cache_age,
    }

    # 2. squig.link connectivity (host reachability, not endpoint auth/policy)
    import urllib.request as _req
    import urllib.error as _req_err
    try:
        req = _req.Request('https://squig.link', method='HEAD')
        r = _req.urlopen(req, timeout=4)
        result['squig'] = {'ok': True, 'status': getattr(r, 'status', 200)}
    except _req_err.HTTPError as e:
        # HTTP status (including 403/404) still proves host is up/reachable.
        result['squig'] = {'ok': True, 'status': int(getattr(e, 'code', 0) or 0)}
    except Exception as e:
        result['squig'] = {'ok': False, 'error': str(e)}

    # 3. DAPs
    daps = load_daps()
    mounts = _discover_mount_points()
    for d in daps:
        resolved_mount, _, match_method = _resolve_dap_mount_with_method(d, mounts)
        d['mounted'] = bool(resolved_mount and resolved_mount.exists())
        d['mount_match_method'] = match_method or ''
    result['daps'] = [{
        'id': d['id'],
        'name': d['name'],
        'mounted': d['mounted'],
        'mount_match_method': d.get('mount_match_method', ''),
    } for d in daps]

    # 4. Playback runtime
    _refresh_mpv_backend()
    settings = load_settings()
    runtime = _mpv_runtime_status()
    selected_audio_device = settings.get('audio_device', 'auto') or 'auto'
    effective_audio_device = selected_audio_device
    available_audio_devices = ['auto']
    selected_audio_device_available = None
    mpv_version = None
    if MPV_AVAILABLE:
        try:
            p = _get_mpv()
            mpv_version = p.mpv_version if p else None
            if p is not None:
                effective_audio_device = p.audio_device or effective_audio_device
                available_audio_devices = [str(d.get('name', '')) for d in (p.audio_device_list or []) if d.get('name')]
                if 'auto' not in available_audio_devices:
                    available_audio_devices.append('auto')
                selected_audio_device_available = effective_audio_device in set(available_audio_devices)
        except Exception:
            pass
    missing_dependency = bool((not runtime.get('python_mpv_ok')) or (not runtime.get('libmpv_path')))
    result['playback'] = {
        'mpv_available': MPV_AVAILABLE,
        'mpv_version': mpv_version,
        'exclusive_mode': bool(settings.get('exclusive_mode', False)),
        'selected_audio_device': selected_audio_device,
        'effective_audio_device': effective_audio_device,
        'selected_audio_device_available': selected_audio_device_available,
        'available_audio_devices': available_audio_devices,
        'runtime': runtime,
        'missing_dependency': missing_dependency,
        'fix_actions': ['install_mpv'] if missing_dependency else [],
    }

    # 5. Database status
    db_path = _db.DB_PATH
    db_ok = db_path and db_path.exists()
    db_size = None
    db_tables = 0
    if db_ok:
        db_size = round(db_path.stat().st_size / 1024 / 1024, 2)
        try:
            conn = _db.get_conn()
            row = conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()
            db_tables = row[0] if row else 0
        except Exception:
            pass
    result['database'] = {
        'ok': db_ok,
        'engine': 'SQLite (WAL)',
        'path': str(db_path) if db_path else '',
        'size_mb': db_size,
        'tables': db_tables,
        'schema_version': _db.get_schema_version() if db_ok else 0,
    }

    return jsonify(result)


@app.route('/api/restart', methods=['POST'])
def restart_server():
    def do_restart():
        # In-place re-exec keeps restart single-instance (no duplicate windows).
        # The process is replaced with a fresh interpreter running the same args.
        time.sleep(0.6)  # let response flush
        try:
            os.execv(sys.executable, [sys.executable] + sys.argv)
        except Exception:
            os._exit(1)
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

SYNC_EXTENSIONS = {'.flac', '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.wv', '.aiff', '.aif', '.ape', '.wma', '.alac'}
SYNC_SKIP_DIR_NAMES = {
    '.fseventsd',
    '.spotlight-v100',
    '.temporaryitems',
    '.trashes',
    '.trash',
    '$recycle.bin',
    'system volume information',
    '@eadir',
}

def _normalize_rel(path):
    return str(path or '').replace('\\', '/').strip('/')


def _is_music_file_path(path):
    ext = Path(str(path or '')).suffix.lower()
    return ext in SYNC_EXTENSIONS


def _should_skip_scan_dir(dirname):
    name = str(dirname or '').strip()
    if not name:
        return True
    low = name.casefold()
    return low in SYNC_SKIP_DIR_NAMES


def _safe_segment(value):
    seg = str(value or '').strip()
    seg = _INVALID_FS_CHARS_RE.sub('_', seg)
    seg = re.sub(r'\s+', ' ', seg).strip().rstrip('. ')
    if not seg:
        return ''
    if len(seg) > _MAX_SEGMENT_LEN:
        seg = seg[:_MAX_SEGMENT_LEN].rstrip('. ')
    return seg


def _track_tokens(track):
    raw_track = str(track.get('track_number') or '').strip()
    raw_disc = str(track.get('disc_number') or '').strip()
    try:
        track_num = str(int(raw_track.split('/')[0])) if raw_track else ''
    except Exception:
        track_num = ''
    try:
        disc_num = str(int(raw_disc.split('/')[0])) if raw_disc else ''
    except Exception:
        disc_num = ''
    title = str(track.get('title') or Path(track.get('path') or '').stem or '').strip()
    album_artist = str(track.get('album_artist') or '').strip()
    artist = str(track.get('artist') or '').strip()
    return {
        'artist': artist or 'Unknown Artist',
        'albumartist': album_artist or artist or 'Unknown Artist',
        'album': str(track.get('album') or '').strip() or 'Unknown Album',
        'title': title or 'Unknown Title',
        'track': track_num.zfill(2) if track_num else '',
        'discnumber': disc_num.zfill(2) if disc_num else '',
        'year': str(track.get('year') or '').strip(),
        'genre': str(track.get('genre') or '').strip() or 'Unknown Genre',
    }


def _render_device_relpath(track, template):
    warnings = []
    tpl = _normalize_path_template(template)
    tokens = _track_tokens(track)
    rendered = tpl
    invalid_char_hit = False
    missing = []
    for k, v in tokens.items():
        marker = f'%{k}%'
        if marker in rendered:
            raw_v = str(v or '').strip()
            if _INVALID_FS_CHARS_RE.search(raw_v):
                invalid_char_hit = True
            safe = _safe_segment(v)
            if not safe:
                missing.append(k)
                safe = _safe_segment(f'Unknown {k}')
            rendered = rendered.replace(marker, safe)
    if missing:
        warn_tokens = [m for m in sorted(set(missing)) if m not in {'track', 'discnumber', 'year', 'genre', 'albumartist'}]
        if warn_tokens:
            warnings.append(f"{track.get('path', '')}: missing metadata for {', '.join(warn_tokens)}")
    rendered = _normalize_rel(rendered)
    parts = [p for p in rendered.split('/') if p]
    if not parts:
        parts = [_safe_segment(Path(track.get('path') or '').name) or 'Unknown.flac']
    filename = parts[-1]
    ext = Path(track.get('path') or '').suffix.lower()
    if _INVALID_FS_CHARS_RE.search(filename):
        invalid_char_hit = True
    filename = _safe_segment(filename)
    # Preserve the source audio extension even when title text contains dots
    # (e.g. "K.U.S.H"), which can look like a suffix to Path(...).suffix.
    if ext:
        low = filename.lower()
        if not low.endswith(ext):
            current_suffix = Path(filename).suffix.lower()
            if current_suffix not in SYNC_EXTENSIONS:
                filename = f'{filename}{ext}'
    parts[-1] = filename or ('track' + (ext or '.flac'))
    rel = '/'.join([p for p in parts if p])
    if invalid_char_hit:
        warnings.append(f"{track.get('path', '')}: invalid characters sanitized for device filesystem")
    return rel, warnings


def get_dap_music_path(dap_id):
    """Return configured music root folder on the DAP identified by dap_id."""
    dap = next((d for d in load_daps() if d['id'] == dap_id), None)
    if not dap:
        return None
    mount, _ = _resolve_dap_mount(dap)
    if not mount:
        return None
    root = _normalize_music_root(dap.get('music_root') or DEFAULT_DAP_MUSIC_ROOT)
    return mount / root

def walk_music_files(root):
    """Return sorted list of relative path strings for all music files under root."""
    root = Path(root)
    files = []
    if not root.exists():
        return files
    for dirpath, dirnames, filenames in os.walk(root):
        # Skip only known system/index folders; allow valid dot-prefixed album names.
        dirnames[:] = [d for d in dirnames if not _should_skip_scan_dir(d)]
        for fn in filenames:
            if fn.startswith('.') or fn.startswith('._'):
                continue
            ext = Path(fn).suffix.lower()
            if ext in SYNC_EXTENSIONS:
                rel = os.path.relpath(os.path.join(dirpath, fn), root)
                files.append(rel)
    return sorted(files)


def _build_sync_track_entries(template):
    """
    Build sync candidates from LIVE local filesystem paths.
    If metadata for a path exists in cached library, use it to render template path;
    otherwise fall back to local relative path so newly-added files are still detected.
    """
    with library_lock:
        tracks = list(library)

    lib_by_rel = {}
    for t in tracks:
        rel = _normalize_rel(t.get('path'))
        if rel and _is_music_file_path(rel):
            lib_by_rel[rel.casefold()] = t

    local_files = walk_music_files(get_music_base())
    entries = []
    for rel in local_files:
        local_rel = _normalize_rel(rel)
        if not local_rel:
            continue
        t = lib_by_rel.get(local_rel.casefold())
        rendered_rel = ''
        warns = []
        if t:
            rendered_rel, warns = _render_device_relpath(t, template)
            rendered_rel = _normalize_rel(rendered_rel)
        target_rel = rendered_rel or local_rel
        entries.append({
            'local_rel': local_rel,
            'rendered_rel': rendered_rel,
            'target_rel': target_rel,
            'warnings': warns,
        })
    return entries


def _stat_signature(path: Path):
    """Best-effort file signature tuple: (mtime_ns, size_bytes)."""
    try:
        st = path.stat()
        return int(st.st_mtime_ns), int(st.st_size)
    except Exception:
        return None, None


def _compute_sync_diff_for_dap(dap):
    """Compute music sync diff for a DAP profile and return summary payload."""
    if not dap:
        raise RuntimeError('DAP not found')
    dap_id = dap.get('id')
    if not dap_id:
        raise RuntimeError('DAP id missing')
    device_path = get_dap_music_path(dap_id)
    if not device_path or not device_path.exists():
        raise RuntimeError('Device not mounted or configured music folder not found')

    template = dap.get('path_template') or DEFAULT_DAP_PATH_TEMPLATE
    track_entries = _build_sync_track_entries(template)

    device_files = sorted(walk_music_files(device_path))
    device_map = {_normalize_rel(p).casefold(): _normalize_rel(p) for p in device_files}

    device_keys = set(device_map.keys())
    manifest_records = _get_dap_sync_manifest(dap_id)
    manifest_updates = {}
    manifest_seen_keys = set()
    expected_keys = set()
    local_only = []
    local_copy_map = {}
    local_only_existing_sizes = {}
    local_only_reasons = {}
    warnings = []
    target_collisions = set()
    device_only = []
    device_only_reasons = {}

    for e in track_entries:
        local_key = e['local_rel'].casefold()
        rendered_key = e['rendered_rel'].casefold() if e['rendered_rel'] else ''
        variants = {local_key}
        if rendered_key:
            variants.add(rendered_key)
        expected_keys.update(variants)

        matched_key = None
        if rendered_key and rendered_key in device_keys:
            matched_key = rendered_key
        elif local_key in device_keys:
            matched_key = local_key
        elif not variants.isdisjoint(device_keys):
            matched_key = next(iter(variants & device_keys))

        if matched_key is None:
            target_rel = e['target_rel']
            if target_rel in local_copy_map and local_copy_map[target_rel] != e['local_rel']:
                target_collisions.add(target_rel)
                continue
            local_copy_map[target_rel] = e['local_rel']
            local_only.append(target_rel)
            local_only_reasons[target_rel] = 'Missing on device at destination path'
            warnings.extend(e.get('warnings') or [])
            continue

        # File exists on both sides at some equivalent path. If metadata changed,
        # the underlying file mtime/size will differ after a tag write.
        matched_rel = device_map.get(matched_key)
        if not matched_rel:
            continue
        src = get_music_base() / e['local_rel']
        dst = device_path / matched_rel
        src_mtime, src_size = _stat_signature(src)
        dst_mtime, dst_size = _stat_signature(dst)
        if src_mtime is None or dst_mtime is None:
            continue

        now_ts = int(time.time())

        if src_size != dst_size:
            # iTunes-like behavior: local library is authoritative for matched paths.
            local_copy_map[matched_rel] = e['local_rel']
            local_only_existing_sizes[matched_rel] = int(dst_size or 0)
            local_only.append(matched_rel)
            local_only_reasons[matched_rel] = (
                f'Size mismatch: local {int(src_size or 0)} bytes, '
                f'device {int(dst_size or 0)} bytes'
            )
            manifest_seen_keys.add(matched_key)
            manifest_updates[matched_key] = {
                'target_rel': matched_rel,
                'local_rel': e['local_rel'],
                'local_size': int(src_size or 0),
                'local_mtime_ns': int(src_mtime or 0),
                'local_hash': '',
                'device_size': int(dst_size or 0),
                'device_mtime_ns': int(dst_mtime or 0),
                'device_hash': '',
                'updated_at': now_ts,
            }
            continue

        manifest_seen_keys.add(matched_key)
        manifest_entry = manifest_records.get(matched_key) or {}
        local_changed_since_manifest = not (
            manifest_entry
            and manifest_entry.get('local_rel', '').casefold() == e['local_rel'].casefold()
            and int(manifest_entry.get('local_size') or 0) == int(src_size)
            and int(manifest_entry.get('local_mtime_ns') or 0) == int(src_mtime)
        )
        if local_changed_since_manifest and manifest_entry:
            local_copy_map[matched_rel] = e['local_rel']
            local_only_existing_sizes[matched_rel] = int(dst_size or 0)
            local_only.append(matched_rel)
            local_only_reasons[matched_rel] = 'Local file changed since last verified sync'

        manifest_updates[matched_key] = {
            'target_rel': matched_rel,
            'local_rel': e['local_rel'],
            'local_size': int(src_size or 0),
            'local_mtime_ns': int(src_mtime or 0),
            'local_hash': str(manifest_entry.get('local_hash') or ''),
            'device_size': int(dst_size or 0),
            'device_mtime_ns': int(dst_mtime or 0),
            'device_hash': str(manifest_entry.get('device_hash') or ''),
            'updated_at': now_ts,
        }

    local_only = sorted(set(local_only))
    device_only.extend([device_map[k] for k in (device_keys - expected_keys)])
    device_only = sorted(set(device_only))
    for rel in device_only:
        device_only_reasons[rel] = 'Present on device only (not found in local library scan)'

    # Keep only current device-file keys for this DAP and refresh verified entries.
    _update_dap_sync_manifest(
        dap_id,
        manifest_updates,
        prune_to_keys=device_keys.union(manifest_seen_keys),
    )

    # Net required bytes for local->device copy:
    #   max(0, source_size - existing_destination_size)
    # This accounts for overwrite reuse of space on the device.
    local_only_sizes = {}
    local_only_copy_sizes = {}
    required_bytes = 0
    music_base = get_music_base()
    for device_rel in local_only:
        local_rel = local_copy_map.get(device_rel)
        if not local_rel:
            continue
        src = music_base / local_rel
        size = 0
        try:
            if src.exists():
                size = int(src.stat().st_size)
        except Exception:
            size = 0
        existing = int(local_only_existing_sizes.get(device_rel) or 0)
        net = max(0, size - existing)
        local_only_copy_sizes[device_rel] = size
        local_only_sizes[device_rel] = net
        required_bytes += net

    mount_root, _ = _resolve_dap_mount(dap)
    usage_path = mount_root if (mount_root and mount_root.exists()) else device_path
    available_bytes = None
    total_bytes = None
    try:
        if usage_path.exists():
            usage = shutil.disk_usage(usage_path)
            available_bytes = int(usage.free)
            total_bytes = int(usage.total)
    except Exception:
        available_bytes = None
        total_bytes = None

    space_ok = (available_bytes is None) or (required_bytes <= available_bytes)
    shortfall_bytes = 0
    if available_bytes is not None and required_bytes > available_bytes:
        shortfall_bytes = required_bytes - available_bytes
        warnings.append(
            f'Insufficient device space: need {required_bytes} bytes, available {available_bytes} bytes.'
        )

    for c in sorted(target_collisions):
        warnings.append(f'Path collision for "{c}" — multiple local tracks map to the same destination.')
    warnings = sorted(set(warnings))
    if len(warnings) > 250:
        extra = len(warnings) - 250
        warnings = warnings[:250] + [f'...and {extra} more issue(s).']

    return {
        'local_only': local_only,
        'device_only': device_only,
        'warnings': warnings,
        'local_copy_map': local_copy_map,
        'local_only_sizes': local_only_sizes,
        'local_only_copy_sizes': local_only_copy_sizes,
        'local_only_existing_sizes': local_only_existing_sizes,
        'local_only_reasons': local_only_reasons,
        'device_only_reasons': device_only_reasons,
        'total': len(local_only) + len(device_only),
        'music_out_of_sync_count': len(local_only) + len(device_only),
        'music_to_add_count': len(local_only),
        'music_to_remove_count': len(device_only),
        'space_available_bytes': available_bytes,
        'space_total_bytes': total_bytes,
        'space_required_bytes': required_bytes,
        'space_shortfall_bytes': shortfall_bytes,
        'space_ok': space_ok,
        'message': (
            f'{len(local_only)} file(s) to copy to device, '
            f'{len(device_only)} file(s) to copy to local'
        ),
    }


def _playlist_sync_counts_for_dap(dap):
    playlists = load_playlists()
    exports = (dap or {}).get('playlist_exports', {}) or {}
    stale_count = sum(
        1 for pl in playlists.values()
        if pl.get('id') in exports and pl.get('updated_at', 0) > exports[pl.get('id')]
    )
    never_exported = sum(1 for pl in playlists.values() if pl.get('id') not in exports)
    return stale_count, never_exported


def _start_dap_sync_status_check(dap_id):
    if not dap_id:
        return False, 'missing_dap_id'
    with sync_check_lock:
        if dap_id in sync_check_inflight:
            return False, 'already_checking'
        sync_check_inflight.add(dap_id)

    _update_dap_sync_summary(dap_id, {
        'sync_status_state': 'checking',
        'sync_status_message': 'Checking live sync status…',
    })

    def _job():
        try:
            daps = load_daps()
            dap = next((d for d in daps if d.get('id') == dap_id), None)
            if not dap:
                raise RuntimeError('DAP not found')
            resolved_mount, _ = _resolve_dap_mount(dap)
            if not resolved_mount or not resolved_mount.exists():
                raise RuntimeError('Device not mounted')

            diff = _compute_sync_diff_for_dap(dap)
            stale_count, never_exported = _playlist_sync_counts_for_dap(dap)
            now_ts = int(time.time())
            _update_dap_sync_summary(dap_id, {
                'playlist_out_of_sync_count': int(stale_count) + int(never_exported),
                'music_out_of_sync_count': diff['music_out_of_sync_count'],
                'music_to_add_count': diff['music_to_add_count'],
                'music_to_remove_count': diff['music_to_remove_count'],
                'space_available_bytes': diff['space_available_bytes'],
                'space_total_bytes': diff['space_total_bytes'],
                'space_required_bytes': diff['space_required_bytes'],
                'space_shortfall_bytes': diff['space_shortfall_bytes'],
                'space_ok': diff['space_ok'],
                'last_scan_at': now_ts,
                'last_verified_at': now_ts,
                'sync_status_state': 'verified',
                'sync_status_message': 'Live check complete',
            })
        except Exception as e:
            _update_dap_sync_summary(dap_id, {
                'sync_status_state': 'error',
                'sync_status_message': str(e),
            })
        finally:
            with sync_check_lock:
                sync_check_inflight.discard(dap_id)

    threading.Thread(target=_job, daemon=True).start()
    return True, 'started'

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
        return jsonify({'error': 'Device not mounted or configured music folder not found'}), 400

    sync_state = {
        'status': 'scanning',
        'dap_id': dap_id,
        'message': 'Scanning files…',
        'progress': 0,
        'total': 0,
        'local_only': [],
        'device_only': [],
        'warnings': [],
        'errors': [],
        'current': '',
        'local_copy_map': {},
        'local_only_sizes': {},
        'local_only_copy_sizes': {},
        'local_only_existing_sizes': {},
        'local_only_reasons': {},
        'device_only_reasons': {},
        'music_out_of_sync_count': 0,
        'music_to_add_count': 0,
        'music_to_remove_count': 0,
        'space_available_bytes': None,
        'space_total_bytes': None,
        'space_required_bytes': 0,
        'space_shortfall_bytes': 0,
        'space_ok': True,
    }

    def do_scan():
        global sync_state
        try:
            sync_state['current'] = 'Mapping local library structure…'
            daps = load_daps()
            dap = next((d for d in daps if d.get('id') == dap_id), None)
            if not dap:
                raise RuntimeError('DAP not found')
            sync_state['current'] = 'Scanning device…'
            diff = _compute_sync_diff_for_dap(dap)

            sync_state.update({
                'status': 'ready',
                'local_only': diff['local_only'],
                'device_only': diff['device_only'],
                'warnings': diff['warnings'],
                'local_copy_map': diff['local_copy_map'],
                'local_only_sizes': diff['local_only_sizes'],
                'local_only_copy_sizes': diff.get('local_only_copy_sizes', {}),
                'local_only_existing_sizes': diff.get('local_only_existing_sizes', {}),
                'local_only_reasons': diff.get('local_only_reasons', {}),
                'device_only_reasons': diff.get('device_only_reasons', {}),
                'total': diff['total'],
                'current': '',
                'music_out_of_sync_count': diff['music_out_of_sync_count'],
                'music_to_add_count': diff['music_to_add_count'],
                'music_to_remove_count': diff['music_to_remove_count'],
                'space_available_bytes': diff['space_available_bytes'],
                'space_total_bytes': diff['space_total_bytes'],
                'space_required_bytes': diff['space_required_bytes'],
                'space_shortfall_bytes': diff['space_shortfall_bytes'],
                'space_ok': diff['space_ok'],
                'message': diff['message'],
            })
            _update_dap_sync_summary(dap_id, {
                'music_out_of_sync_count': diff['music_out_of_sync_count'],
                'music_to_add_count': diff['music_to_add_count'],
                'music_to_remove_count': diff['music_to_remove_count'],
                'space_available_bytes': diff['space_available_bytes'],
                'space_total_bytes': diff['space_total_bytes'],
                'space_required_bytes': diff['space_required_bytes'],
                'space_shortfall_bytes': diff['space_shortfall_bytes'],
                'space_ok': diff['space_ok'],
                'last_scan_at': int(time.time()),
                'last_verified_at': int(time.time()),
                'sync_status_state': 'verified',
                'sync_status_message': 'Live check complete',
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
    local_paths = data.get('local_paths', [])   # copy local → device (device-relative path keys)
    device_paths = data.get('device_paths', []) # copy device → local
    dap_id = sync_state['dap_id']
    device_path = get_dap_music_path(dap_id)

    if not device_path or not device_path.exists():
        return jsonify({'error': 'Device not mounted'}), 400

    total = len(local_paths) + len(device_paths)
    if total == 0:
        return jsonify({'error': 'No files selected'}), 400

    # Re-check device free space right before copy starts.
    required_selected = 0
    local_only_sizes = sync_state.get('local_only_sizes') or {}
    for rel in local_paths:
        try:
            required_selected += int(local_only_sizes.get(rel) or 0)
        except Exception:
            continue
    available_now = None
    try:
        dap = next((d for d in load_daps() if d.get('id') == dap_id), None)
        mount_root, _ = _resolve_dap_mount(dap)
        usage_path = mount_root if (mount_root and mount_root.exists()) else device_path
        if usage_path and usage_path.exists():
            available_now = int(shutil.disk_usage(usage_path).free)
    except Exception:
        available_now = None
    if available_now is not None and required_selected > available_now:
        shortfall = required_selected - available_now
        return jsonify({
            'error': 'Not enough space on device for selected files',
            'space_available_bytes': available_now,
            'space_required_bytes': required_selected,
            'space_shortfall_bytes': shortfall,
        }), 400

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
        local_copy_map = sync_state.get('local_copy_map') or {}

        for device_rel in local_paths:
            local_rel = local_copy_map.get(device_rel)
            if not local_rel:
                errors.append(f'{device_rel}: no local source mapping found')
                progress += 1
                sync_state['progress'] = progress
                sync_state['message'] = f'Copying {progress} / {total} files…'
                continue
            src = get_music_base() / local_rel
            dst = device_path / device_rel
            sync_state['current'] = f'→ Device: {device_rel}'
            try:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
            except Exception as e:
                errors.append(f'{device_rel}: {e}')
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
        'warnings': [], 'errors': [], 'current': '', 'local_copy_map': {},
        'local_only_sizes': {},
        'local_only_copy_sizes': {},
        'local_only_existing_sizes': {},
        'local_only_reasons': {},
        'device_only_reasons': {},
        'music_out_of_sync_count': 0,
        'music_to_add_count': 0,
        'music_to_remove_count': 0,
        'space_available_bytes': None,
        'space_total_bytes': None,
        'space_required_bytes': 0,
        'space_shortfall_bytes': 0,
        'space_ok': True,
    }
    return jsonify({'ok': True})


# ── DAP Management ────────────────────────────────────────────────────────────

def _slugify_model_id(name):
    s = re.sub(r'[^a-z0-9]+', '_', (name or '').lower()).strip('_')
    return s or 'other'


def _default_sync_summary():
    return {
        'playlist_out_of_sync_count': 0,
        'music_out_of_sync_count': 0,
        'music_to_add_count': 0,
        'music_to_remove_count': 0,
        'space_available_bytes': None,
        'space_total_bytes': None,
        'space_required_bytes': 0,
        'space_shortfall_bytes': 0,
        'space_ok': True,
        'last_scan_at': 0,
        'last_verified_at': 0,
        'sync_status_state': 'estimated',  # estimated | checking | verified | error
        'sync_status_message': '',
    }


def _normalize_sync_summary(summary):
    base = _default_sync_summary()
    if isinstance(summary, dict):
        base.update(summary)
    # Coerce numeric fields safely
    for k in (
        'playlist_out_of_sync_count',
        'music_out_of_sync_count',
        'music_to_add_count',
        'music_to_remove_count',
        'space_required_bytes',
        'space_shortfall_bytes',
        'last_scan_at',
        'last_verified_at',
    ):
        try:
            base[k] = int(base.get(k) or 0)
        except Exception:
            base[k] = 0
    for k in ('space_available_bytes', 'space_total_bytes'):
        v = base.get(k)
        if v is None:
            continue
        try:
            base[k] = int(v)
        except Exception:
            base[k] = None
    base['space_ok'] = bool(base.get('space_ok', True))
    state = str(base.get('sync_status_state') or 'estimated').strip().lower()
    if state not in ('estimated', 'checking', 'verified', 'error'):
        state = 'estimated'
    base['sync_status_state'] = state
    base['sync_status_message'] = str(base.get('sync_status_message') or '')
    return base


def _update_dap_sync_summary(dap_id, summary_patch):
    if not dap_id:
        return
    daps = load_daps()
    changed = False
    for d in daps:
        if d.get('id') != dap_id:
            continue
        merged = _normalize_sync_summary(d.get('sync_summary'))
        if isinstance(summary_patch, dict):
            merged.update(summary_patch)
        merged = _normalize_sync_summary(merged)
        if d.get('sync_summary') != merged:
            d['sync_summary'] = merged
            changed = True
        break
    if changed:
        save_daps(daps)


DEFAULT_DAP_MUSIC_ROOT = 'Music'
DEFAULT_DAP_PATH_TEMPLATE = '%artist%/%album%/%track% - %title%'
_INVALID_FS_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_MAX_SEGMENT_LEN = 120


def _normalize_music_root(path):
    root = str(path or DEFAULT_DAP_MUSIC_ROOT).strip().replace('\\', '/')
    root = root.strip('/')
    return root or DEFAULT_DAP_MUSIC_ROOT


def _normalize_path_template(tpl):
    s = str(tpl or DEFAULT_DAP_PATH_TEMPLATE).strip()
    return s or DEFAULT_DAP_PATH_TEMPLATE


def _normalize_sync_manifest_entry(entry):
    if not isinstance(entry, dict):
        return {}
    out = {
        'target_rel': _normalize_rel(entry.get('target_rel')),
        'local_rel': _normalize_rel(entry.get('local_rel')),
        'local_hash': str(entry.get('local_hash') or ''),
        'device_hash': str(entry.get('device_hash') or ''),
        'updated_at': 0,
    }
    for k in ('local_size', 'local_mtime_ns', 'device_size', 'device_mtime_ns', 'updated_at'):
        try:
            out[k] = int(entry.get(k) or 0)
        except Exception:
            out[k] = 0
    return out


def _get_dap_sync_manifest(dap_id):
    raw = _db.db_load_sync_manifest(dap_id)
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, v in raw.items():
        key = _normalize_rel(k).casefold()
        if not key:
            continue
        ent = _normalize_sync_manifest_entry(v)
        if ent:
            out[key] = ent
    return out


def _update_dap_sync_manifest(dap_id, records, prune_to_keys=None):
    if not dap_id:
        return
    clean_records = {}
    if isinstance(records, dict):
        for k, v in records.items():
            key = _normalize_rel(k).casefold()
            if not key:
                continue
            ent = _normalize_sync_manifest_entry(v)
            if ent:
                clean_records[key] = ent

    allowed = None
    if prune_to_keys is not None:
        allowed = {_normalize_rel(k).casefold() for k in prune_to_keys if _normalize_rel(k)}

    _db.db_upsert_sync_manifest(dap_id, clean_records, prune_to_keys=allowed)


def _normalize_export_folder(path):
    if not path:
        return 'Playlists'
    return str(path).strip().strip('/').strip('\\') or 'Playlists'


def _normalize_gear_profiles(raw):
    out = {'dap_profiles': [], 'iem_types': []}

    iem_types = raw.get('iem_types') if isinstance(raw, dict) else []
    if isinstance(iem_types, list):
        out['iem_types'] = [str(t).strip() for t in iem_types if str(t).strip()]

    dap_profiles = raw.get('dap_profiles') if isinstance(raw, dict) else raw
    if not isinstance(dap_profiles, list):
        dap_profiles = []

    seen = set()
    for p in dap_profiles:
        if not isinstance(p, dict):
            continue
        name = str(p.get('name') or p.get('dapModelOrApp') or '').strip()
        model = str(p.get('model') or '').strip() or _slugify_model_id(name)
        if model in seen:
            continue
        seen.add(model)
        out['dap_profiles'].append({
            'model': model,
            'name': name or model,
            'playlist_format': str(p.get('playlist_format') or p.get('playlistFormat') or '.m3u8'),
            'export_folder': _normalize_export_folder(p.get('export_folder') or p.get('playlistExportFolder') or 'Playlists'),
            'path_prefix': str(p.get('path_prefix') or ''),
            'mount_name': str(p.get('mount_name') or p.get('mountName') or 'MyDAP'),
            'hint': str(p.get('hint') or ''),
        })

    if not out['dap_profiles']:
        out['dap_profiles'] = _DEFAULT_GEAR_PROFILES['dap_profiles']
    if not out['iem_types']:
        out['iem_types'] = _DEFAULT_GEAR_PROFILES['iem_types']
    return out


def load_gear_profiles():
    return _normalize_gear_profiles(_DEFAULT_GEAR_PROFILES)


def load_genre_families():
    raw = _db.db_load_genre_families()
    return raw if raw else dict(_DEFAULT_GENRE_FAMILIES)


def load_playlist_gen_config():
    stored = _db.db_load_playlist_gen_config()
    if stored:
        cfg = dict(_DEFAULT_PLAYLIST_GEN_CONFIG)
        # Reconstruct nested dicts from flattened keys
        for k, v in stored.items():
            parts = k.split('.')
            if len(parts) == 1:
                cfg[k] = v
            elif len(parts) == 2 and parts[0] in cfg and isinstance(cfg[parts[0]], dict):
                cfg[parts[0]][parts[1]] = v
        return cfg
    return dict(_DEFAULT_PLAYLIST_GEN_CONFIG)


@app.route('/api/gear/profiles', methods=['GET'])
def get_gear_profiles():
    return jsonify(load_gear_profiles())

def _normalize_mount_id(value):
    return str(value or '').strip()


def _mount_identity_fields():
    return ('mount_volume_uuid', 'mount_disk_uuid', 'mount_device_identifier')


def _dap_mount_identity(dap):
    return {
        'mount_volume_uuid': _normalize_mount_id((dap or {}).get('mount_volume_uuid')),
        'mount_disk_uuid': _normalize_mount_id((dap or {}).get('mount_disk_uuid')),
        'mount_device_identifier': _normalize_mount_id((dap or {}).get('mount_device_identifier')),
    }


def _mount_matches_dap(mount, dap):
    if not isinstance(mount, dict):
        return False
    ids = _dap_mount_identity(dap)
    # Strong identifiers: UUIDs remain stable across reconnects and renames.
    if ids['mount_volume_uuid'] and _normalize_mount_id(mount.get('volume_uuid')).lower() == ids['mount_volume_uuid'].lower():
        return True
    if ids['mount_disk_uuid'] and _normalize_mount_id(mount.get('disk_uuid')).lower() == ids['mount_disk_uuid'].lower():
        return True
    # Do not trust device_identifier by itself for connected status.
    # On macOS this can be reused and cause false positives for different media.
    return False


def _resolve_dap_mount(dap, mounts=None):
    resolved_mount, matched_mount, _ = _resolve_dap_mount_with_method(dap, mounts)
    return resolved_mount, matched_mount


def _resolve_dap_mount_with_method(dap, mounts=None):
    mounts = mounts if mounts is not None else _discover_mount_points()
    if not isinstance(mounts, list):
        mounts = []

    # UUID/device-id based matching survives user volume renames.
    for m in mounts:
        if _mount_matches_dap(m, dap):
            p = str(m.get('path') or '').strip()
            if p:
                return Path(p), m, 'identity'

    # Fallback to configured path for legacy profiles/manual paths.
    mount_path = str((dap or {}).get('mount_path') or '').strip()
    if mount_path:
        for m in mounts:
            if str(m.get('path') or '').strip() == mount_path:
                return Path(mount_path), m, 'path'
        p = Path(mount_path)
        # Treat as mounted only if it's an actual mount point (not just an existing folder).
        if p.exists() and os.path.ismount(str(p)):
            return p, None, 'path'
    return None, None, None


def load_daps():
    daps = _db.db_load_daps()
    changed = False
    for d in daps:
        if not d.get('storage_type'):
            d['storage_type'] = 'sd'
            changed = True
        if not d.get('music_root'):
            d['music_root'] = DEFAULT_DAP_MUSIC_ROOT
            changed = True
        else:
            norm_root = _normalize_music_root(d.get('music_root'))
            if norm_root != d.get('music_root'):
                d['music_root'] = norm_root
                changed = True
        if not d.get('path_template'):
            d['path_template'] = DEFAULT_DAP_PATH_TEMPLATE
            changed = True
        else:
            norm_tpl = _normalize_path_template(d.get('path_template'))
            if norm_tpl != d.get('path_template'):
                d['path_template'] = norm_tpl
                changed = True
        norm_summary = _normalize_sync_summary(d.get('sync_summary'))
        if d.get('sync_summary') != norm_summary:
            d['sync_summary'] = norm_summary
            changed = True
        for field in _mount_identity_fields():
            norm_id = _normalize_mount_id(d.get(field))
            if d.get(field) != norm_id:
                d[field] = norm_id
                changed = True
    if changed:
        save_daps(daps)
    return daps


def save_daps(daps):
    _db.db_save_daps(daps)


@app.route('/api/daps', methods=['GET'])
def get_daps():
    daps = load_daps()
    playlists = load_playlists()
    # Fast path for Gear home: avoid expensive per-volume diskutil identity calls.
    # Deep identity checks run only during explicit sync-status verification flows.
    mounts = _discover_mount_points(include_identity=False)
    for d in daps:
        resolved_mount, matched_mount, match_method = _resolve_dap_mount_with_method(d, mounts)
        d['mounted'] = bool(resolved_mount and resolved_mount.exists())
        d['active_mount_path'] = str(resolved_mount) if resolved_mount else ''
        d['mount_match_method'] = match_method or ''
        if matched_mount:
            d['active_mount_label'] = matched_mount.get('label') or str(resolved_mount)
        # Count out-of-date playlists
        exports = d.get('playlist_exports', {})
        d['stale_count'] = sum(
            1 for pl in playlists.values()
            if pl['id'] in exports and pl.get('updated_at', 0) > exports[pl['id']]
        )
        d['never_exported'] = sum(
            1 for pl in playlists.values() if pl['id'] not in exports
        )
        summary = _normalize_sync_summary(d.get('sync_summary'))
        summary['playlist_out_of_sync_count'] = int(d['stale_count']) + int(d['never_exported'])
        d['sync_summary'] = summary
    return jsonify(daps)


@app.route('/api/daps/sync-status/check', methods=['POST'])
def check_daps_sync_status():
    daps = load_daps()
    mounts = _discover_mount_points()
    started = []
    skipped = []
    for d in daps:
        resolved_mount, _ = _resolve_dap_mount(d, mounts)
        if not resolved_mount or not resolved_mount.exists():
            skipped.append({'id': d.get('id'), 'reason': 'not_mounted'})
            _update_dap_sync_summary(d.get('id'), {
                'sync_status_state': 'error',
                'sync_status_message': 'Device not mounted',
            })
            continue
        ok, reason = _start_dap_sync_status_check(d.get('id'))
        if ok:
            started.append(d.get('id'))
        else:
            skipped.append({'id': d.get('id'), 'reason': reason})
    return jsonify({'ok': True, 'started': started, 'skipped': skipped})


@app.route('/api/daps/<did>/sync-status/check', methods=['POST'])
def check_single_dap_sync_status(did):
    daps = load_daps()
    dap = next((d for d in daps if d.get('id') == did), None)
    if not dap:
        return jsonify({'error': 'Not found'}), 404
    resolved_mount, _ = _resolve_dap_mount(dap)
    if not resolved_mount or not resolved_mount.exists():
        _update_dap_sync_summary(did, {
            'sync_status_state': 'error',
            'sync_status_message': 'Device not mounted',
        })
        return jsonify({'error': 'Device not mounted'}), 400
    ok, reason = _start_dap_sync_status_check(did)
    if not ok and reason != 'already_checking':
        return jsonify({'error': f'Could not start sync check ({reason})'}), 400
    return jsonify({'ok': True, 'status': reason})


@app.route('/api/daps', methods=['POST'])
def create_dap():
    data = request.json or {}
    model = data.get('model', 'generic')
    profile_map = {p['model']: p for p in load_gear_profiles().get('dap_profiles', [])}
    defaults = profile_map.get(model, {'export_folder': 'Playlists', 'path_prefix': ''})
    storage_type = str(data.get('storage_type') or 'sd').strip().lower()
    if storage_type not in ('sd', 'internal'):
        storage_type = 'sd'
    dap = {
        'id': str(uuid.uuid4()),
        'name': data.get('name', 'New DAP'),
        'model': model,
        'icon': data.get('icon', '📱'),
        'mount_path': data.get('mount_path', ''),
        'mount_volume_uuid': _normalize_mount_id(data.get('mount_volume_uuid')),
        'mount_disk_uuid': _normalize_mount_id(data.get('mount_disk_uuid')),
        'mount_device_identifier': _normalize_mount_id(data.get('mount_device_identifier')),
        'export_folder': _normalize_export_folder(data.get('export_folder') or defaults.get('export_folder')),
        'path_prefix': data.get('path_prefix', defaults.get('path_prefix', '')),
        'storage_type': storage_type,
        'music_root': _normalize_music_root(data.get('music_root')),
        'path_template': _normalize_path_template(data.get('path_template')),
        'peq_folder': data.get('peq_folder', 'PEQ'),
        'playlist_exports': {},
        'sync_summary': _default_sync_summary(),
    }
    daps = load_daps()
    daps.append(dap)
    save_daps(daps)
    resolved_mount, _ = _resolve_dap_mount(dap)
    dap['mounted'] = bool(resolved_mount and resolved_mount.exists())
    dap['active_mount_path'] = str(resolved_mount) if resolved_mount else ''
    return jsonify(dap), 201


@app.route('/api/daps/<did>', methods=['GET'])
def get_dap(did):
    dap = next((d for d in load_daps() if d['id'] == did), None)
    if not dap:
        return jsonify({'error': 'Not found'}), 404
    mounts = _discover_mount_points(include_identity=False)
    resolved_mount, matched_mount = _resolve_dap_mount(dap, mounts)
    dap['mounted'] = bool(resolved_mount and resolved_mount.exists())
    dap['active_mount_path'] = str(resolved_mount) if resolved_mount else ''
    if matched_mount:
        dap['active_mount_label'] = matched_mount.get('label') or str(resolved_mount)
    playlists = load_playlists()
    exports = dap.get('playlist_exports', {})
    stale_count = sum(
        1 for pl in playlists.values()
        if pl['id'] in exports and pl.get('updated_at', 0) > exports[pl['id']]
    )
    never_exported = sum(
        1 for pl in playlists.values() if pl['id'] not in exports
    )
    dap['stale_count'] = stale_count
    dap['never_exported'] = never_exported
    summary = _normalize_sync_summary(dap.get('sync_summary'))
    summary['playlist_out_of_sync_count'] = int(stale_count) + int(never_exported)
    dap['sync_summary'] = summary
    return jsonify(dap)


@app.route('/api/daps/<did>', methods=['PUT'])
def update_dap(did):
    data = request.json or {}
    daps = load_daps()
    dap = next((d for d in daps if d['id'] == did), None)
    if not dap:
        return jsonify({'error': 'Not found'}), 404
    for k in ('name', 'model', 'icon', 'mount_path', 'mount_volume_uuid', 'mount_disk_uuid', 'mount_device_identifier', 'export_folder', 'path_prefix', 'storage_type', 'music_root', 'path_template', 'peq_folder'):
        if k in data:
            if k == 'export_folder':
                dap[k] = _normalize_export_folder(data[k])
            elif k == 'music_root':
                dap[k] = _normalize_music_root(data[k])
            elif k == 'path_template':
                dap[k] = _normalize_path_template(data[k])
            elif k == 'storage_type':
                v = str(data[k] or '').strip().lower()
                dap[k] = v if v in ('sd', 'internal') else 'sd'
            elif k in _mount_identity_fields():
                dap[k] = _normalize_mount_id(data[k])
            else:
                dap[k] = data[k]
    save_daps(daps)
    resolved_mount, _ = _resolve_dap_mount(dap)
    dap['mounted'] = bool(resolved_mount and resolved_mount.exists())
    dap['active_mount_path'] = str(resolved_mount) if resolved_mount else ''
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

    content = generate_m3u(tracks, playlist['name'], path_prefix=prefix)
    safe_name = playlist['name'].replace('/', '-')
    return Response(
        content,
        mimetype='audio/x-mpegurl',
        headers={'Content-Disposition': f'attachment; filename="{safe_name}.m3u"'}
    )


@app.route('/api/daps/<did>/export/favourites', methods=['POST'])
def dap_export_favourites(did):
    daps = load_daps()
    dap = next((d for d in daps if d['id'] == did), None)
    if not dap:
        return jsonify({'error': 'DAP not found'}), 404

    device_root, _ = _resolve_dap_mount(dap)
    if not device_root or not device_root.exists():
        return jsonify({'error': f"Device not mounted. Last configured path: {dap.get('mount_path', 'not set')}"}), 404

    favourites = load_favourites()
    tracks, _ = _resolve_favourite_tracks(favourites.get('songs') or [])
    prefix = dap.get('path_prefix', '')
    out_dir = device_root / dap.get('export_folder', 'Playlists')
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        content = generate_m3u(tracks, 'Favourite Songs', path_prefix=prefix)
        with open(out_dir / "Favourite Songs.m3u", 'w', encoding='utf-8') as f:
            f.write(content)
    except OSError as e:
        import errno as _errno
        if e.errno == _errno.EROFS:
            return jsonify({'error': f"Device is mounted read-only. Eject and reconnect {dap['name']}, then try again."}), 409
        return jsonify({'error': f"Could not write to device: {e.strerror}"}), 409

    favourites['dap_exports'][did] = int(time.time())
    save_favourites(favourites)
    return jsonify({'exported_at': favourites['dap_exports'][did]})


@app.route('/api/daps/<did>/export/<pid>', methods=['POST'])
def dap_export_playlist(did, pid):
    daps = load_daps()
    dap = next((d for d in daps if d['id'] == did), None)
    if not dap:
        return jsonify({'error': 'DAP not found'}), 404

    device_root, _ = _resolve_dap_mount(dap)
    if not device_root or not device_root.exists():
        return jsonify({'error': f"Device not mounted. Last configured path: {dap.get('mount_path', 'not set')}"}), 404

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

def _normalize_iem_source(source, idx=0):
    """Normalize a single IEM squig source record."""
    src = source if isinstance(source, dict) else {}
    sid = str(src.get('id') or f'src-{idx + 1}')
    label = str(src.get('label') or '').strip() or f'Source {idx + 1}'
    url = str(src.get('url') or '').strip()
    return {
        'id': sid,
        'label': label,
        'url': url,
        'squig_subdomain': str(src.get('squig_subdomain') or ''),
        'squig_file_key': str(src.get('squig_file_key') or ''),
        'measurement_L': src.get('measurement_L'),
        'measurement_R': src.get('measurement_R'),
    }


def _sync_iem_primary_measurements(iem):
    """
    Keep legacy top-level measurement fields in sync with primary source.
    This preserves compatibility with existing scoring/analysis code paths.
    """
    sources = iem.get('squig_sources') or []
    primary = None
    pref = iem.get('primary_source_id')
    if pref:
        primary = next((s for s in sources if s.get('id') == pref), None)
    if not primary and sources:
        primary = sources[0]
    if primary:
        iem['primary_source_id'] = primary.get('id')
        iem['squig_url'] = primary.get('url', '')
        iem['squig_subdomain'] = primary.get('squig_subdomain', '')
        iem['squig_file_key'] = primary.get('squig_file_key', '')
        iem['measurement_L'] = primary.get('measurement_L')
        iem['measurement_R'] = primary.get('measurement_R')
    else:
        iem['primary_source_id'] = None
        iem['squig_url'] = ''
        iem['squig_subdomain'] = ''
        iem['squig_file_key'] = ''
        iem['measurement_L'] = None
        iem['measurement_R'] = None


def _normalize_iem_record(iem):
    """Migrate/normalize an IEM record in place. Returns True when changed."""
    changed = False
    if not isinstance(iem.get('squig_sources'), list):
        iem['squig_sources'] = []
        changed = True

    # Migrate legacy single-source fields into squig_sources if needed.
    if not iem['squig_sources'] and (
        iem.get('squig_url') or iem.get('measurement_L') or iem.get('measurement_R')
    ):
        iem['squig_sources'] = [{
            'id': 'src-1',
            'label': 'Primary',
            'url': iem.get('squig_url', ''),
            'squig_subdomain': iem.get('squig_subdomain', ''),
            'squig_file_key': iem.get('squig_file_key', ''),
            'measurement_L': iem.get('measurement_L'),
            'measurement_R': iem.get('measurement_R'),
        }]
        changed = True

    # Keep only non-empty sources and normalize fields.
    norm_sources = []
    for idx, src in enumerate(iem.get('squig_sources') or []):
        nsrc = _normalize_iem_source(src, idx)
        if nsrc.get('url') or nsrc.get('measurement_L') or nsrc.get('measurement_R'):
            norm_sources.append(nsrc)
    if len(norm_sources) > 3:
        norm_sources = norm_sources[:3]
        changed = True
    if norm_sources != (iem.get('squig_sources') or []):
        iem['squig_sources'] = norm_sources
        changed = True

    pref = iem.get('primary_source_id')
    if pref and not any(s.get('id') == pref for s in norm_sources):
        iem['primary_source_id'] = None
        changed = True
    if not iem.get('primary_source_id') and norm_sources:
        iem['primary_source_id'] = norm_sources[0].get('id')
        changed = True

    before = (iem.get('measurement_L'), iem.get('measurement_R'),
              iem.get('squig_url'), iem.get('squig_subdomain'), iem.get('squig_file_key'))
    _sync_iem_primary_measurements(iem)
    after = (iem.get('measurement_L'), iem.get('measurement_R'),
             iem.get('squig_url'), iem.get('squig_subdomain'), iem.get('squig_file_key'))
    if before != after:
        changed = True
    return changed


def _public_iem(iem):
    """Return IEM payload safe for API responses (without heavy measurement arrays)."""
    out = {}
    for k, v in iem.items():
        if k in ('measurement_L', 'measurement_R'):
            continue
        if k == 'squig_sources':
            cleaned = []
            for src in (v or []):
                cleaned.append({
                    'id': src.get('id'),
                    'label': src.get('label'),
                    'url': src.get('url', ''),
                    'squig_subdomain': src.get('squig_subdomain', ''),
                    'squig_file_key': src.get('squig_file_key', ''),
                })
            out[k] = cleaned
        else:
            out[k] = v
    out['has_measurement'] = bool(
        iem.get('measurement_L') or iem.get('measurement_R') or
        any((s.get('measurement_L') or s.get('measurement_R')) for s in (iem.get('squig_sources') or []))
    )
    return out

def load_iems():
    iems = _db.db_load_iems()
    dirty = False
    for iem in iems:
        dirty = _normalize_iem_record(iem) or dirty
    if dirty:
        save_iems(iems)
    return iems


def save_iems(iems):
    _db.db_save_iems(iems)


def load_baselines():
    return _db.db_load_baselines()


def save_baselines(baselines):
    _db.db_save_baselines(baselines)


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
    # Omit measurement arrays from list view; sort alphabetically by name
    result = sorted(
        [_public_iem(iem) for iem in load_iems()],
        key=lambda i: i.get('name', '').lower()
    )
    return jsonify(result)


@app.route('/api/iems', methods=['POST'])
def create_iem():
    data = request.json or {}
    raw_sources = data.get('squig_sources')
    if raw_sources is None:
        legacy_url = str(data.get('squig_url', '')).strip()
        raw_sources = ([{'label': 'Primary', 'url': legacy_url}] if legacy_url else [])
    if not isinstance(raw_sources, list):
        return jsonify({'error': 'squig_sources must be an array'}), 400
    if len(raw_sources) > 3:
        return jsonify({'error': 'You can add up to 3 squig.link URLs per IEM.'}), 400

    sources = []
    first_file_key = None
    for idx, src in enumerate(raw_sources):
        if not isinstance(src, dict):
            continue
        url = str(src.get('url', '')).strip()
        if not url:
            continue
        label = str(src.get('label') or '').strip() or f'Source {idx + 1}'
        try:
            result = fetch_squig_measurement(url)
            if not result['L'] and not result['R']:
                return jsonify({'error': f'Could not fetch measurement data for source "{label}". Check the URL and try again.'}), 400
            file_key = result.get('file_key') or ''
            if not first_file_key and file_key:
                first_file_key = file_key
            sources.append({
                'id': str(src.get('id') or f'src-{idx + 1}'),
                'label': label,
                'url': url,
                'squig_subdomain': result.get('subdomain', ''),
                'squig_file_key': file_key,
                'measurement_L': result['L'],
                'measurement_R': result['R'],
            })
        except Exception as e:
            return jsonify({'error': f'Failed to fetch source "{label}": {e}'}), 400

    iem = {
        'id': str(uuid.uuid4()),
        'name': data.get('name', '').strip() or 'New IEM',
        'type': data.get('type', 'IEM'),
        'squig_url': '',
        'squig_subdomain': '',
        'squig_file_key': '',
        'measurement_L': None,
        'measurement_R': None,
        'primary_source_id': sources[0]['id'] if sources else None,
        'squig_sources': sources,
        'peq_profiles': [],
    }
    _normalize_iem_record(iem)
    if not data.get('name') and first_file_key:
        iem['name'] = first_file_key

    iems = load_iems()
    iems.append(iem)
    save_iems(iems)
    return jsonify(_public_iem(iem)), 201


@app.route('/api/iems/<iid>', methods=['GET'])
def get_iem(iid):
    iem = next((i for i in load_iems() if i['id'] == iid), None)
    if not iem:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(_public_iem(iem))


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

    if 'squig_sources' in data or 'squig_url' in data:
        raw_sources = data.get('squig_sources')
        if raw_sources is None:
            legacy_url = str(data.get('squig_url', '')).strip()
            raw_sources = ([{'label': 'Primary', 'url': legacy_url}] if legacy_url else [])
        if not isinstance(raw_sources, list):
            return jsonify({'error': 'squig_sources must be an array'}), 400
        if len(raw_sources) > 3:
            return jsonify({'error': 'You can add up to 3 squig.link URLs per IEM.'}), 400

        force_refetch = bool(data.get('force_refetch'))
        existing_sources = iem.get('squig_sources') or []
        existing_by_id = {s.get('id'): s for s in existing_sources if s.get('id')}
        existing_by_url = {s.get('url'): s for s in existing_sources if s.get('url')}
        new_sources = []

        for idx, src in enumerate(raw_sources):
            if not isinstance(src, dict):
                continue
            url = str(src.get('url', '')).strip()
            if not url:
                continue
            sid = str(src.get('id') or '')
            label = str(src.get('label') or '').strip() or f'Source {idx + 1}'
            existing = (existing_by_id.get(sid) if sid else None) or existing_by_url.get(url)
            can_reuse = (
                existing and existing.get('url') == url and not force_refetch and
                (existing.get('measurement_L') or existing.get('measurement_R'))
            )
            if can_reuse:
                new_sources.append({
                    'id': existing.get('id') or sid or f'src-{idx + 1}',
                    'label': label,
                    'url': url,
                    'squig_subdomain': existing.get('squig_subdomain', ''),
                    'squig_file_key': existing.get('squig_file_key', ''),
                    'measurement_L': existing.get('measurement_L'),
                    'measurement_R': existing.get('measurement_R'),
                })
            else:
                try:
                    result = fetch_squig_measurement(url)
                    if not result['L'] and not result['R']:
                        return jsonify({'error': f'Could not fetch measurement data for source "{label}". Check the URL and try again.'}), 400
                    new_sources.append({
                        'id': sid or (existing.get('id') if existing else f'src-{idx + 1}'),
                        'label': label,
                        'url': url,
                        'squig_subdomain': result.get('subdomain', ''),
                        'squig_file_key': result.get('file_key', ''),
                        'measurement_L': result['L'],
                        'measurement_R': result['R'],
                    })
                except Exception as e:
                    return jsonify({'error': f'Failed to fetch source "{label}": {e}'}), 400

        iem['squig_sources'] = new_sources
        iem['primary_source_id'] = new_sources[0]['id'] if new_sources else None
        _normalize_iem_record(iem)

    save_iems(iems)
    return jsonify(_public_iem(iem))


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


def _resolve_iem_source(iem, source_id=None):
    """Return selected (or primary) source dict for an IEM."""
    sources = iem.get('squig_sources') or []
    if source_id:
        src = next((s for s in sources if s.get('id') == source_id), None)
        if src:
            return src
    pref = iem.get('primary_source_id')
    if pref:
        src = next((s for s in sources if s.get('id') == pref), None)
        if src:
            return src
    return sources[0] if sources else None


@app.route('/api/iems/<iid>/graph')
def iem_graph(iid):
    iems = load_iems()
    iem = next((i for i in iems if i['id'] == iid), None)
    if not iem:
        return jsonify({'error': 'Not found'}), 404

    peq_id = request.args.get('peq', '')
    source_id = request.args.get('source', '')
    compare_ids = request.args.getlist('compare')
    compare_source_map = {}
    for token in request.args.getlist('compare_source'):
        if ':' in token:
            did, sid = token.split(':', 1)
            compare_source_map[did] = sid
    palette = ['#5b8dee', '#e05c5c', '#4caf8f', '#e8a838', '#9c6dd8', '#e05ca0']

    curves = []
    targets = [iem] + [i for i in iems if i['id'] in compare_ids]

    for idx, cur in enumerate(targets):
        color = palette[idx % len(palette)]
        requested_source_id = source_id if idx == 0 else compare_source_map.get(cur['id'])
        source = _resolve_iem_source(cur, requested_source_id)
        source_label = source.get('label') if source else None
        name = cur['name']
        if source_label and len(cur.get('squig_sources') or []) > 1:
            name = f"{name} [{source_label}]"
        mL = (source or {}).get('measurement_L') or cur.get('measurement_L')
        mR = (source or {}).get('measurement_R') or cur.get('measurement_R')

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
                # _apply_peq re-normalises to 75 dB at 1 kHz internally, so do NOT
                # apply the factory offset on top — that would double-shift the curve.
                if mL:
                    curves.append({'id': f"{cur['id']}-peq-L",
                                   'label': f"{name} + {peq['name']} (L)",
                                   'color': peq_color, 'dash': False,
                                   'data': _apply_peq(mL, peq)})
                if mR:
                    curves.append({'id': f"{cur['id']}-peq-R",
                                   'label': f"{name} + {peq['name']} (R)",
                                   'color': peq_color, 'dash': False,
                                   'data': _apply_peq(mR, peq)})

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

    available_sources = [
        {
            'id': s.get('id'),
            'label': s.get('label'),
            'url': s.get('url', ''),
        }
        for s in (iem.get('squig_sources') or [])
    ]
    active_source = _resolve_iem_source(iem, source_id)
    return jsonify({
        'curves': curves,
        'iem_name': iem['name'],
        'available_sources': available_sources,
        'selected_source_id': (active_source or {}).get('id'),
    })


@app.route('/api/iems/<iid>/graph/custom', methods=['POST'])
def iem_graph_custom(iid):
    iems = load_iems()
    iem = next((i for i in iems if i['id'] == iid), None)
    if not iem:
        return jsonify({'error': 'Not found'}), 404

    body = request.get_json(silent=True) or {}
    source_id = body.get('source_id', '')
    baseline_ids = set(body.get('baseline_ids') or [])
    custom = body.get('custom_peq') or {}

    source = _resolve_iem_source(iem, source_id)
    source_label = source.get('label') if source else None
    name = iem['name']
    if source_label and len(iem.get('squig_sources') or []) > 1:
        name = f"{name} [{source_label}]"
    mL = (source or {}).get('measurement_L') or iem.get('measurement_L')
    mR = (source or {}).get('measurement_R') or iem.get('measurement_R')

    curves = []
    ref_spl = _spl_at_1khz(mL or mR)
    offset = (NORM_REF_DB - ref_spl) if ref_spl is not None else 0.0

    if mL:
        curves.append({'id': f"{iem['id']}-L", 'label': f"{name} (L)",
                       'color': '#5b8dee', 'dash': False, 'data': _shift(mL, offset)})
    if mR:
        curves.append({'id': f"{iem['id']}-R", 'label': f"{name} (R)",
                       'color': '#e05c5c', 'dash': False, 'data': _shift(mR, offset)})

    try:
        preamp_db = float(custom.get('preamp_db', 0.0))
    except Exception:
        preamp_db = 0.0
    bands = custom.get('bands') if isinstance(custom.get('bands'), list) else []
    filters = []
    for b in bands:
        if not isinstance(b, dict):
            continue
        if not b.get('enabled', False):
            continue
        ftype = str(b.get('type', 'PK')).upper()
        try:
            fc = float(b.get('fc', 1000))
        except Exception:
            fc = 1000.0
        try:
            gain = float(b.get('gain', 0.0))
        except Exception:
            gain = 0.0
        try:
            q = float(b.get('q', 1.0))
        except Exception:
            q = 1.0
        filters.append({
            'enabled': True,
            'type': ftype,
            'fc': max(20.0, min(20000.0, fc)),
            'gain': max(-30.0, min(30.0, gain)),
            'q': max(0.1, min(10.0, q)),
        })
    custom_profile = {'name': 'Custom EQ', 'preamp_db': preamp_db, 'filters': filters}
    if filters:
        if mL:
            curves.append({'id': f"{iem['id']}-custom-L",
                           'label': f"{name} + Custom EQ (L)",
                           'color': '#53e16f', 'dash': False,
                           'data': _apply_peq(mL, custom_profile)})
        if mR:
            curves.append({'id': f"{iem['id']}-custom-R",
                           'label': f"{name} + Custom EQ (R)",
                           'color': '#53e16f', 'dash': False,
                           'data': _apply_peq(mR, custom_profile)})

    if baseline_ids:
        for bl in load_baselines():
            if bl.get('id') not in baseline_ids:
                continue
            m = bl.get('measurement')
            if not m:
                continue
            ref_spl = _spl_at_1khz(m)
            offset = (NORM_REF_DB - ref_spl) if ref_spl is not None else 0.0
            curves.append({
                'id': f"baseline-{bl['id']}",
                'label': bl['name'],
                'color': bl.get('color', '#f0b429'),
                'dash': True,
                'data': _shift(m, offset),
            })

    available_sources = [
        {'id': s.get('id'), 'label': s.get('label'), 'url': s.get('url', '')}
        for s in (iem.get('squig_sources') or [])
    ]
    active_source = _resolve_iem_source(iem, source_id)
    return jsonify({
        'curves': curves,
        'iem_name': iem['name'],
        'available_sources': available_sources,
        'selected_source_id': (active_source or {}).get('id'),
    })


@app.route('/api/peq/graph/custom', methods=['POST'])
def peq_graph_custom_without_iem():
    body = request.get_json(silent=True) or {}
    baseline_ids = set(body.get('baseline_ids') or [])
    custom = body.get('custom_peq') or {}

    try:
        preamp_db = float(custom.get('preamp_db', 0.0))
    except Exception:
        preamp_db = 0.0
    bands = custom.get('bands') if isinstance(custom.get('bands'), list) else []
    filters = []
    for b in bands:
        if not isinstance(b, dict):
            continue
        if not b.get('enabled', False):
            continue
        ftype = str(b.get('type', 'PK')).upper()
        try:
            fc = float(b.get('fc', 1000))
        except Exception:
            fc = 1000.0
        try:
            gain = float(b.get('gain', 0.0))
        except Exception:
            gain = 0.0
        try:
            q = float(b.get('q', 1.0))
        except Exception:
            q = 1.0
        filters.append({
            'enabled': True,
            'type': ftype,
            'fc': max(20.0, min(20000.0, fc)),
            'gain': max(-30.0, min(30.0, gain)),
            'q': max(0.1, min(10.0, q)),
        })

    points = []
    n = 300
    for i in range(n):
        f = 20.0 * ((20000.0 / 20.0) ** (i / (n - 1)))
        points.append([round(f, 2), NORM_REF_DB])
    custom_profile = {'name': 'Custom PEQ', 'preamp_db': preamp_db, 'filters': filters}
    custom_curve = _apply_peq(points, custom_profile) if filters else points

    curves = [{
        'id': 'custom-peq-neutral',
        'label': 'Custom PEQ (No IEM selected)',
        'color': '#53e16f',
        'dash': False,
        'data': custom_curve,
    }]
    if baseline_ids:
        for bl in load_baselines():
            if bl.get('id') not in baseline_ids:
                continue
            m = bl.get('measurement')
            if not m:
                continue
            ref_spl = _spl_at_1khz(m)
            offset = (NORM_REF_DB - ref_spl) if ref_spl is not None else 0.0
            curves.append({
                'id': f"baseline-{bl['id']}",
                'label': bl['name'],
                'color': bl.get('color', '#f0b429'),
                'dash': True,
                'data': _shift(m, offset),
            })
    return jsonify({'curves': curves})


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


@app.route('/api/iems/<iid>/peq/<peq_id>', methods=['PUT'])
def update_peq_profile(iid, peq_id):
    iems = load_iems()
    iem = next((i for i in iems if i['id'] == iid), None)
    if not iem:
        return jsonify({'error': 'Not found'}), 404

    existing = next((p for p in iem.get('peq_profiles', []) if p.get('id') == peq_id), None)
    if not existing:
        return jsonify({'error': 'PEQ profile not found'}), 404

    if 'file' in request.files:
        f = request.files['file']
        text = f.read().decode('utf-8', errors='replace')
        name = request.form.get('name') or Path(f.filename).stem
    else:
        body = request.json or {}
        text = body.get('content', '')
        name = body.get('name', existing.get('name', 'PEQ Profile'))

    if not text.strip():
        return jsonify({'error': 'No content'}), 400

    parsed = parse_peq_txt(text)
    existing['name'] = name
    existing['preamp_db'] = parsed['preamp_db']
    existing['filters'] = parsed['filters']
    existing['raw_txt'] = text
    save_iems(iems)
    return jsonify({k: v for k, v in existing.items() if k != 'raw_txt'})


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

    device_root, _ = _resolve_dap_mount(dap)
    if not device_root or not device_root.exists():
        return jsonify({'error': f"Device not mounted. Last configured path: {dap.get('mount_path', 'not set')}"}), 404

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


_stream_track_cache = {}   # track_id → track dict; cleared on rescan

def _get_track_by_id(tid):
    """Look up a track by its ID. Uses in-memory cache to avoid DB hit on every Range request."""
    if tid in _stream_track_cache:
        return _stream_track_cache[tid]
    track = _db.db_get_track(tid)
    if track:
        _stream_track_cache[tid] = track
    return track


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
        resp.headers['Access-Control-Allow-Origin'] = '*'
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
    rv.headers['Content-Range']              = f'bytes {byte1}-{byte2}/{file_size}'
    rv.headers['Accept-Ranges']              = 'bytes'
    rv.headers['Content-Length']             = str(length)
    rv.headers['Cache-Control']              = 'no-cache'
    rv.headers['Access-Control-Allow-Origin'] = '*'
    return rv


@app.route('/api/backup/export', methods=['GET'])
def export_backup():
    buf = io.BytesIO()
    timestamp = time.strftime('%Y%m%d_%H%M%S')
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        # Export a consistent SQLite snapshot.
        with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
            tmp_db_path = Path(tmp.name)
        try:
            src = _db.get_conn()
            dst = sqlite3.connect(str(tmp_db_path))
            try:
                src.backup(dst)
            finally:
                dst.close()
            zf.write(tmp_db_path, 'tunebridge.db')
        finally:
            try:
                tmp_db_path.unlink(missing_ok=True)
            except Exception:
                pass
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
            if 'tunebridge.db' not in names:
                return jsonify({'error': 'Invalid backup: tunebridge.db not found'}), 400

            with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
                tmp_db_path = Path(tmp.name)
            try:
                tmp_db_path.write_bytes(zf.read('tunebridge.db'))
                _validate_backup_db(tmp_db_path)

                live_db = DATA_DIR / 'tunebridge.db'
                _db.close_conn()
                try:
                    (DATA_DIR / 'tunebridge.db-wal').unlink(missing_ok=True)
                    (DATA_DIR / 'tunebridge.db-shm').unlink(missing_ok=True)
                except Exception:
                    pass
                os.replace(str(tmp_db_path), str(live_db))
            finally:
                try:
                    tmp_db_path.unlink(missing_ok=True)
                except Exception:
                    pass

            art_dir = DATA_DIR / 'playlist_artwork'
            art_dir.mkdir(exist_ok=True)
            for name in names:
                if name.startswith('playlist_artwork/') and not name.endswith('/'):
                    dest = art_dir / Path(name).name
                    dest.write_bytes(zf.read(name))
        return jsonify({'ok': True})
    except zipfile.BadZipFile:
        return jsonify({'error': 'Invalid ZIP file — is this a TuneBridge backup?'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _validate_backup_db(path: Path):
    """Validate imported backup has the expected TuneBridge SQLite schema."""
    conn = sqlite3.connect(str(path))
    try:
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        tables = {r[0] for r in rows}
        required = {'schema_version', 'tracks', 'playlists', 'settings'}
        missing = required - tables
        if missing:
            raise ValueError(f'Invalid backup database: missing tables: {", ".join(sorted(missing))}')
    finally:
        conn.close()


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


def _discover_mount_points(include_identity=True):
    mounts = []
    seen = set()
    roots = []

    def _mac_mount_identity(path_str):
        info = {
            'volume_uuid': '',
            'disk_uuid': '',
            'device_identifier': '',
        }
        try:
            proc = subprocess.run(
                ['diskutil', 'info', '-plist', path_str],
                capture_output=True,
                check=False,
            )
            if proc.returncode != 0 or not proc.stdout:
                return info
            data = plistlib.loads(proc.stdout)
            info['volume_uuid'] = _normalize_mount_id(data.get('VolumeUUID'))
            info['disk_uuid'] = _normalize_mount_id(data.get('DiskUUID'))
            info['device_identifier'] = _normalize_mount_id(data.get('DeviceIdentifier'))
        except Exception:
            pass
        return info

    def _mount_entry(path_str, label):
        rec = {'path': path_str, 'label': label}
        if sys.platform == 'darwin' and include_identity:
            rec.update(_mac_mount_identity(path_str))
        else:
            rec.update({'volume_uuid': '', 'disk_uuid': '', 'device_identifier': ''})
        return rec

    if sys.platform == 'darwin':
        roots = [Path('/Volumes')]
    elif os.name == 'nt':
        roots = [Path(f'{chr(code)}:\\') for code in range(ord('A'), ord('Z') + 1)]
    else:
        roots = [Path('/media'), Path('/mnt'), Path('/run/media')]

    for root in roots:
        try:
            if os.name == 'nt':
                if root.exists():
                    p = str(root)
                    if p not in seen:
                        mounts.append(_mount_entry(p, f'{p} (External Drive)'))
                        seen.add(p)
                continue
            if not root.exists() or not root.is_dir():
                continue
            for child in sorted(root.iterdir(), key=lambda p: p.name.lower()):
                if not child.is_dir():
                    continue
                if not os.path.ismount(str(child)):
                    continue
                p = str(child)
                if p in seen:
                    continue
                mounts.append(_mount_entry(p, f'{child.name} (External Drive)'))
                seen.add(p)
        except Exception:
            continue
    return mounts


@app.route('/api/system/mounts', methods=['GET'])
def get_system_mounts():
    return jsonify({'mounts': _discover_mount_points()})



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

    # Genre distribution — top 20 by track count
    genres_raw = {}
    for t in tracks:
        g = (t.get('genre') or '').strip()
        if g:
            genres_raw[g] = genres_raw.get(g, 0) + 1
    genres_sorted = dict(sorted(genres_raw.items(), key=lambda x: -x[1]))
    genres = dict(list(genres_sorted.items())[:20])

    return jsonify({
        'total_tracks':  len(tracks),
        'total_albums':  len(album_set),
        'total_artists': len(artist_set),
        'formats':       formats,
        'sample_rates':  sample_rates,
        'bit_depths':    bit_depths,
        'genres':        genres,
        'genres_all':    genres_sorted,
        'genres_total':  len(genres_sorted),
        'genres_tagged': sum(1 for t in tracks if (t.get('genre') or '').strip()),
    })


@app.route('/api/insights/tag-health')
def insights_tag_health():
    from collections import defaultdict
    tracks = library
    if not tracks:
        return jsonify({'error': 'Library is empty'}), 404

    total = len(tracks)

    # Single-pass accumulation of all completeness counters, artist groups, and problem tracks
    missing_counts = {'title': 0, 'artist': 0, 'album': 0, 'year': 0, 'genre': 0}
    artist_groups = defaultdict(list)
    problem_tracks = []

    for t in tracks:
        issues = []
        if not t.get('title'):
            missing_counts['title'] += 1; issues.append('title')
        v_artist = t.get('artist') or ''
        if not v_artist or v_artist == 'Unknown Artist':
            missing_counts['artist'] += 1; issues.append('artist')
        v_album = t.get('album') or ''
        if not v_album or v_album == 'Unknown Album':
            missing_counts['album'] += 1; issues.append('album')
        if not t.get('year'):
            missing_counts['year'] += 1; issues.append('year')
        if not t.get('genre'):
            missing_counts['genre'] += 1; issues.append('genre')

        raw = (t.get('album_artist') or t.get('artist') or '').strip()
        if raw and raw.lower() != 'unknown artist':
            artist_groups[re.sub(r'\s+', ' ', raw.lower())].append(raw)

        if issues:
            problem_tracks.append({
                'id':     t['id'],
                'title':  t.get('title') or t.get('filename', '?'),
                'artist': t.get('artist', ''),
                'album':  t.get('album', ''),
                'path':   t.get('path', ''),
                'issues': issues,
            })

    completeness = {}
    for field in ('title', 'artist', 'album', 'year', 'genre'):
        n_missing = missing_counts[field]
        present = total - n_missing
        completeness[field] = {
            'present': present,
            'missing': n_missing,
            'pct':     round(present / total * 100, 1),
        }

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

def _load_feature_entries():
    return _db.db_load_feature_entries()


def _has_valid_v3_payload(entry):
    if not entry or entry.get('analysis_version') != 3:
        return False
    if entry.get('failed'):
        return True
    band_energy = entry.get('band_energy') or []
    return (entry.get('brightness') is not None and len(band_energy) == 12)


def _backfill_feature_source_signatures(tracks):
    """
    Backfill source signature fields for legacy v3 cache rows.

    Older analysis rows may predate source signature tracking
    (source_path/source_mtime). Without this backfill, those rows look stale
    and force a one-time full re-analysis. This function upgrades such rows
    in place using current library metadata so future runs stay delta-only.
    """
    entries = _load_feature_entries()
    if not entries or not tracks:
        return entries

    track_by_id = {t.get('id'): t for t in tracks}
    updated = False
    for entry in entries:
        tid = entry.get('track_id')
        track = track_by_id.get(tid)
        if not track:
            continue
        if not _has_valid_v3_payload(entry):
            continue
        if not entry.get('source_path'):
            entry['source_path'] = track.get('path')
            updated = True
        if int(entry.get('source_mtime') or 0) == 0:
            entry['source_mtime'] = _track_source_mtime(track)
            updated = True

    if updated:
        try:
            _db.db_save_feature_entries(entries)
        except Exception:
            pass
    return entries


def _track_source_mtime(track):
    try:
        return int(track.get('date_added') or 0)
    except Exception:
        return 0


def _is_cached_feature_current(cached, track):
    """Return True when a cached entry is valid for the current track revision."""
    if not cached:
        return False
    if cached.get('analysis_version') != 3:
        return False
    if cached.get('source_path') != track.get('path'):
        return False
    if int(cached.get('source_mtime') or 0) != _track_source_mtime(track):
        return False
    if cached.get('failed'):
        return True
    band_energy = cached.get('band_energy') or []
    return (cached.get('brightness') is not None and len(band_energy) == 12)


def _run_analysis():
    global analysis_state
    try:
        import soundfile as sf
        import numpy as np
    except ImportError:
        analysis_state.update({'status': 'error', 'error': 'soundfile / numpy not installed. Run: pip install soundfile numpy'})
        return

    tracks = list(library)
    track_ids = {t.get('id') for t in tracks}
    existing_entries = _backfill_feature_source_signatures(tracks)
    existing_map = {}
    for entry in existing_entries:
        tid = entry.get('track_id')
        if tid in track_ids:
            existing_map[tid] = entry

    pending_tracks = [t for t in tracks if not _is_cached_feature_current(existing_map.get(t['id']), t)]

    analysis_state.update({
        'status':     'running',
        'done':       0,
        'total':      len(pending_tracks),
        'started_at': int(time.time()),
        'error':      None,
    })

    music_base = get_music_base()
    # Start with existing entries for current library tracks so cancellation keeps prior work.
    results_map = {t['id']: existing_map[t['id']] for t in tracks if t['id'] in existing_map}

    for i, track in enumerate(pending_tracks):
        if analysis_state['status'] != 'running':
            break  # allow external cancellation in future

        analysis_state['done'] = i
        tid = track['id']
        source_path = track.get('path')
        source_mtime = _track_source_mtime(track)

        try:
            path = Path(music_base) / source_path
            data, sr = sf.read(str(path), dtype='float32', always_2d=True)
            mono = data[:, 0]
            total_samples = len(mono)

            # Multi-window analysis: 7 windows spread across the musical portion
            # Skip first 10% (intro) and last 10% of the track
            WIN_N     = 65536
            N_WINDOWS = 7
            RMS_FLOOR = 0.01
            start_s   = max(int(total_samples * 0.10), WIN_N)
            end_s     = max(int(total_samples * 0.90), start_s + WIN_N)
            offsets   = [int(start_s + (end_s - start_s - WIN_N) * i / max(N_WINDOWS - 1, 1))
                         for i in range(N_WINDOWS)]
            offsets   = [o for o in offsets if o + WIN_N <= total_samples]
            if not offsets:   # very short file — fall back to start
                offsets = [0]

            window_func = np.hanning(WIN_N)
            bright_list, energy_list, band_list = [], [], []

            for off in offsets:
                frame = mono[off:off + WIN_N]
                if len(frame) < WIN_N:
                    frame = np.pad(frame, (0, WIN_N - len(frame)))
                rms_w = float(np.sqrt(np.mean(frame ** 2)))
                if rms_w < RMS_FLOOR:
                    continue  # skip near-silent window
                fft_mag = np.abs(np.fft.rfft(frame * window_func))
                freqs   = np.fft.rfftfreq(WIN_N, d=1.0 / sr)
                centroid = float(np.sum(freqs * fft_mag) / (np.sum(fft_mag) + 1e-8))
                power        = fft_mag ** 2
                total_power  = power.sum() + 1e-12
                be = [float(power[(freqs >= f_lo) & (freqs < f_hi)].sum() / total_power)
                      for _, f_lo, f_hi, _ in _PERC_BANDS]
                bright_list.append(centroid)
                energy_list.append(rms_w)
                band_list.append(be)

            if not bright_list:   # all windows silent — treat as failed
                raise ValueError('no valid windows')

            band_energy = [round(float(np.mean([w[b] for w in band_list])), 6)
                           for b in range(len(_PERC_BANDS))]

            results_map[tid] = {
                'track_id':        tid,
                'brightness':      round(float(np.mean(bright_list)), 2),
                'energy':          round(float(np.mean(energy_list)), 6),
                'band_energy':     band_energy,
                'analysis_version': 3,
                'cluster':         None,
                'source_path':     source_path,
                'source_mtime':    source_mtime,
                'analysed_at':     int(time.time()),
            }
        except Exception as exc:
            reason = 'unsupported_format' if 'sndfile' in str(exc).lower() else 'read_error'
            results_map[tid] = {
                'track_id': tid,
                'failed': True,
                'reason': reason,
                'brightness': None,
                'band_energy': None,
                'cluster': None,
                'analysis_version': 3,
                'source_path': source_path,
                'source_mtime': source_mtime,
                'analysed_at': int(time.time()),
            }

        # Flush to disk every 200 tracks so progress survives a crash
        if i > 0 and i % 200 == 0:
            try:
                flush_rows = [results_map[t['id']] for t in tracks if t['id'] in results_map]
                _db.db_save_feature_entries(flush_rows)
            except Exception:
                pass

    if analysis_state['status'] == 'running':
        # Normal completion
        final_rows = [results_map[t['id']] for t in tracks if t['id'] in results_map]
        _db.db_save_feature_entries(final_rows)
        analysis_state.update({
            'status':       'done',
            'done':         len(pending_tracks),
            'completed_at': int(time.time()),
        })
    else:
        # Cancelled — save partial results so incremental re-run can resume.
        final_rows = [results_map[t['id']] for t in tracks if t['id'] in results_map]
        if final_rows:
            _db.db_save_feature_entries(final_rows)
        analysis_state.update({'status': 'idle', 'done': 0, 'total': 0, 'error': None})


@app.route('/api/insights/analyse', methods=['POST'])
def insights_start_analysis():
    if analysis_state['status'] == 'running':
        return jsonify({'error': 'Analysis already running'}), 409
    existing_map = {f.get('track_id'): f for f in _backfill_feature_source_signatures(library)}
    pending = [t for t in library if not _is_cached_feature_current(existing_map.get(t['id']), t)]
    if not pending:
        return jsonify({'ok': True, 'already_up_to_date': True, 'total': 0, 'pending': 0})
    t = threading.Thread(target=_run_analysis, daemon=True)
    t.start()
    return jsonify({'ok': True, 'total': len(pending), 'pending': len(pending)})


@app.route('/api/insights/analyse/cancel', methods=['POST'])
def insights_cancel_analysis():
    if analysis_state['status'] == 'running':
        analysis_state['status'] = 'cancelled'
        return jsonify({'ok': True})
    return jsonify({'error': 'No analysis is currently running'}), 409


@app.route('/api/insights/analyse/status')
def insights_analysis_status():
    return jsonify(analysis_state)


@app.route('/api/insights/analyse/info')
def insights_analyse_info():
    """Return per-track analysis coverage: how many library tracks have been processed."""
    total      = len(library)
    processed  = 0   # attempted and current for this exact file revision
    valid      = 0   # has full v3 feature set and current
    needs_upgrade = False
    existing_map = {f.get('track_id'): f for f in _backfill_feature_source_signatures(library)}
    for track in library:
        cached = existing_map.get(track['id'])
        if not cached:
            continue
        if cached.get('analysis_version') != 3:
            needs_upgrade = True
        if _is_cached_feature_current(cached, track):
            processed += 1
            if not cached.get('failed'):
                valid += 1
    pending = max(0, total - processed)
    if processed == 0:
        status = 'not_run'
    elif needs_upgrade:
        status = 'needs_upgrade'
    elif pending == 0:
        status = 'up_to_date'
    else:
        status = 'pending'
    return jsonify({
        'total': total, 'analysed': valid, 'processed': processed,
        'pending': pending, 'status': status, 'needs_upgrade': needs_upgrade,
    })


# ═══════════════════════════════════════════════════════════════════════════════
# Insights — Phase 2 & 3: Sonic Profile + IEM-Genre Matching
# ═══════════════════════════════════════════════════════════════════════════════

# 12 overlapping perceptual frequency-band dimensions.
# Overlap is intentional — each dimension captures a distinct perceptual quality.
# Format: (key, f_lo Hz, f_hi Hz, label)
_PERC_BANDS = [
    ('sub_bass',      20,    60,   'Sub-bass'),
    ('bass',          60,   120,   'Bass'),
    ('bass_feel',     80,   200,   'Bass feel'),
    ('slam',          80,   150,   'Slam'),
    ('lower_mids',   200,   500,   'Lower mids'),
    ('upper_mids',   500,  1500,   'Upper mids'),
    ('note_weight',  200,  1000,   'Note weight'),
    ('lower_treble', 3000, 6000,   'Lower treble'),
    ('upper_treble', 6000, 20000,  'Upper treble'),
    ('detail',       4000, 10000,  'Detail'),
    ('sibilance',    5000, 10000,  'Sibilance'),
    ('texture',      6000, 15000,  'Texture'),
]

# 5 derived perceptual dimensions (computed from IEM FR shape, not FFT energy)
_DERIVED_DIMS = ['sound_stage', 'timbre_color', 'masking', 'layering', 'tonality']

_ALL_DIM_LABELS = {b[0]: b[3] for b in _PERC_BANDS}
_ALL_DIM_LABELS.update({
    'sound_stage':  'Sound stage',
    'timbre_color': 'Timbre / color',
    'masking':      'Masking',
    'layering':     'Layering',
    'tonality':     'Tonality',
})
_ALL_DIM_KEYS = [b[0] for b in _PERC_BANDS] + _DERIVED_DIMS


def _load_features():
    return _db.db_load_feature_entries()


def _library_salience(features):
    """
    Per-band salience S_b = 0.7·norm(mean) + 0.3·norm(std), sums to 1.
    Uses the 12-band v3 scheme. Returns None if no v3 data exists.
    """
    import numpy as np
    valid = [f for f in features
             if f.get('band_energy') and len(f['band_energy']) == 12]
    if not valid:
        return None
    matrix = np.array([f['band_energy'] for f in valid], dtype=float)
    L_b, V_b = matrix.mean(axis=0), matrix.std(axis=0)
    def _n(a):
        r = a.max() - a.min()
        return (a - a.min()) / (r + 1e-12)
    S_b = 0.7 * _n(L_b) + 0.3 * _n(V_b)
    S_b /= S_b.sum() + 1e-12
    return {b[0]: round(float(v), 6) for b, v in zip(_PERC_BANDS, S_b)}


def _library_shape(features, alpha=6.0):
    """
    12-band tonal-shape profile of the library in dB-like space.
    E_b → log → centre → normalise to [-1,1] → ×alpha.
    """
    import numpy as np
    valid = [f for f in features
             if f.get('band_energy') and len(f['band_energy']) == 12]
    if not valid:
        return None
    E_b   = np.array([f['band_energy'] for f in valid], dtype=float).mean(axis=0)
    logE  = np.log(np.maximum(E_b, 1e-12))
    shape = logE - logE.mean()
    ma    = np.abs(shape).max()
    if ma > 1e-8:
        shape /= ma
    return {b[0]: round(float(v), 4) for b, v in zip(_PERC_BANDS, alpha * shape)}


def _score_iem_17d(measurement, target_measurement=None):
    """
    Score an IEM across all 17 perceptual dimensions on a 1–10 scale each.

    12 frequency-band scores: 10·exp(-0.08·|deviation_dB|)
      — k=0.08: 0 dB→10, 3 dB→7.9, 6 dB→6.2, 10 dB→4.5, 15 dB→3.0

    5 derived dimension scores computed from FR shape:
      sound_stage  — mids recession vs surrounding bands → clip(5+recession×0.5, 1,10)
      timbre_color — RMS deviation 200–6 kHz vs target  → 10·exp(-0.05·dev)
      masking      — 500–1500 Hz elevation vs neighbours  → clip(7-elev×0.6, 1,10)
      layering     — std of 1/3-octave bands 300–5000 Hz → clip(1+std×0.7, 1,10)
      tonality     — mean abs deviation full range        → 10·exp(-0.05·dev)

    Returns {'scores': {dim: float 1–10}, 'deviation': {band: dB}} or None.
    """
    import numpy as np
    if not measurement or len(measurement) < 50:
        return None

    ref = _spl_at_1khz(measurement)
    if ref is not None:
        measurement = _shift(measurement, NORM_REF_DB - ref)

    freqs = np.array([p[0] for p in measurement], dtype=float)
    spls  = np.array([p[1] for p in measurement], dtype=float)

    # Target: pre-compute band means and interpolated curve
    t_freqs = t_spls_arr = None
    target_band_mean = {}
    if target_measurement and len(target_measurement) >= 50:
        t_ref       = _spl_at_1khz(target_measurement)
        t_meas      = _shift(target_measurement, NORM_REF_DB - t_ref) if t_ref is not None else target_measurement
        t_freqs     = np.array([p[0] for p in t_meas], dtype=float)
        t_spls_arr  = np.array([p[1] for p in t_meas], dtype=float)
        for key, f_lo, f_hi, _ in _PERC_BANDS:
            m = (t_freqs >= f_lo) & (t_freqs < f_hi)
            target_band_mean[key] = float(t_spls_arr[m].mean()) if m.any() else NORM_REF_DB
    else:
        for key, *_ in _PERC_BANDS:
            target_band_mean[key] = NORM_REF_DB

    # ── 12 frequency-band scores ──────────────────────────────────────────────
    k = 0.08
    scores, deviation = {}, {}
    for key, f_lo, f_hi, _ in _PERC_BANDS:
        m   = (freqs >= f_lo) & (freqs < f_hi)
        dev = float(spls[m].mean()) - target_band_mean[key] if m.any() else 0.0
        deviation[key] = round(dev, 2)
        scores[key]    = round(float(10.0 * np.exp(-k * abs(dev))), 2)

    def _bm(lo, hi):
        m = (freqs >= lo) & (freqs < hi)
        return float(spls[m].mean()) if m.any() else NORM_REF_DB

    # ── Derived: Sound stage ──────────────────────────────────────────────────
    recession = (_bm(60, 300) + _bm(3000, 10000)) / 2 - _bm(300, 3000)
    scores['sound_stage'] = round(float(np.clip(5.0 + recession * 0.5, 1.0, 10.0)), 2)

    # ── Derived: Timbre / color ───────────────────────────────────────────────
    m_tc = (freqs >= 200) & (freqs < 6000)
    if m_tc.any():
        ref_tc = (np.interp(freqs[m_tc], t_freqs, t_spls_arr)
                  if t_freqs is not None else np.full(m_tc.sum(), NORM_REF_DB))
        scores['timbre_color'] = round(
            float(10.0 * np.exp(-0.05 * float(np.mean(np.abs(spls[m_tc] - ref_tc))))), 2)
    else:
        scores['timbre_color'] = 5.0

    # ── Derived: Masking ──────────────────────────────────────────────────────
    masking_elev = _bm(500, 1500) - (_bm(200, 500) + _bm(1500, 4000)) / 2
    scores['masking'] = round(float(np.clip(7.0 - masking_elev * 0.6, 1.0, 10.0)), 2)

    # ── Derived: Layering ─────────────────────────────────────────────────────
    ctrs = [315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000]
    lv   = [float(spls[(freqs >= c * 0.89) & (freqs < c * 1.12)].mean())
            for c in ctrs if ((freqs >= c * 0.89) & (freqs < c * 1.12)).any()]
    scores['layering'] = (
        round(float(np.clip(1.0 + float(np.std(lv)) * 0.7, 1.0, 10.0)), 2)
        if len(lv) >= 3 else 5.0)

    # ── Derived: Tonality ─────────────────────────────────────────────────────
    ref_full = (np.interp(freqs, t_freqs, t_spls_arr)
                if t_freqs is not None else np.full(len(freqs), NORM_REF_DB))
    scores['tonality'] = round(
        float(10.0 * np.exp(-0.05 * float(np.mean(np.abs(spls - ref_full))))), 2)

    return {'scores': scores, 'deviation': deviation}


def _iem_character_label(deviation):
    """Human-readable tonal character from 12-band deviation dict."""
    low_end  = (deviation.get('sub_bass', 0) + deviation.get('bass', 0)
                + deviation.get('bass_feel', 0)) / 3
    body     = (deviation.get('lower_mids', 0) + deviation.get('note_weight', 0)) / 2
    presence = deviation.get('upper_mids', 0)
    detail   = (deviation.get('detail', 0) + deviation.get('lower_treble', 0)) / 2
    air      = (deviation.get('upper_treble', 0) + deviation.get('texture', 0)) / 2
    tags = []
    if   low_end >  4:  tags.append('bass-heavy')
    elif low_end >  2:  tags.append('warm')
    elif low_end < -3:  tags.append('bass-light')
    if   body    >  3:  tags.append('full-bodied')
    elif body    < -3:  tags.append('lean mids')
    if   presence > 4:  tags.append('forward presence')
    elif presence < -3: tags.append('smooth mids')
    if   detail  >  4:  tags.append('bright')
    elif detail  >  2:  tags.append('airy')
    elif detail  < -4:  tags.append('dark')
    if not tags:        tags.append('neutral')
    return ', '.join(tags)


def _library_character_label(salience):
    """Top-band description of the library's spectral salience profile."""
    top = max(salience, key=salience.get)
    return {
        'sub_bass':     'sub-bass heavy',   'bass':         'bass-driven',
        'bass_feel':    'warm and full',     'slam':         'punchy and dynamic',
        'lower_mids':   'full lower midrange', 'upper_mids': 'presence-forward',
        'note_weight':  'full-bodied',       'lower_treble': 'bright and detailed',
        'upper_treble': 'airy and extended', 'detail':       'detail-focused',
        'sibilance':    'treble-forward',    'texture':      'textured treble',
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


# ── Genre fingerprinting ──────────────────────────────────────────────────────

def _compute_genre_fingerprints(features, library_tracks):
    """
    Group tracks by genre tag. Average + per-band-normalise 12-band energy.
    Returns {slug: {genre, slug, track_count, fingerprint: {band: 0-1}}}
    """
    import numpy as np
    band_keys   = [b[0] for b in _PERC_BANDS]
    id_to_genre = {t['id']: (t.get('genre') or '').strip() for t in library_tracks}

    genre_lists = {}
    for f in features:
        if f.get('failed') or not f.get('band_energy') or len(f['band_energy']) != 12:
            continue
        if f.get('analysis_version') != 3:
            continue
        genre = id_to_genre.get(f['track_id'], '') or 'Unknown'
        genre_lists.setdefault(genre, []).append(f['band_energy'])

    if not genre_lists:
        return {}

    raw = {g: {'tc': len(bls), 'avg': np.array(bls).mean(axis=0)}
           for g, bls in genre_lists.items()}

    # Per-band min-max normalisation across genres
    for b_i in range(len(band_keys)):
        vals = [raw[g]['avg'][b_i] for g in raw]
        mn, mx = min(vals), max(vals)
        rng = mx - mn + 1e-12
        for g in raw:
            raw[g]['avg'][b_i] = (raw[g]['avg'][b_i] - mn) / rng

    result = {}
    for genre, data in raw.items():
        slug = re.sub(r'[^a-z0-9_-]', '_', genre.lower().strip())
        result[slug] = {
            'genre': genre, 'slug': slug, 'track_count': data['tc'],
            'fingerprint': {k: round(float(v), 4)
                            for k, v in zip(band_keys, data['avg'])},
        }
    return result


# ── Match matrix ──────────────────────────────────────────────────────────────

def _build_match_matrix(genre_fps, iem_profiles):
    """
    Compute IEM × genre match scores (0–100).
    score(iem, genre) = Σ(energy[b] · iem_score[b]) / Σ(energy[b]) × 10
    where energy[b] ∈ [0,1] and iem_score[b] ∈ [1,10].
    """
    import numpy as np
    band_keys    = [b[0] for b in _PERC_BANDS]
    total_tracks = sum(fp['track_count'] for fp in genre_fps.values())

    matrix = []
    iem_sw = {iem['id']: [] for iem in iem_profiles}   # [(score, weight)]

    for slug, fp in sorted(genre_fps.items(), key=lambda x: -x[1]['track_count']):
        ge = np.array([fp['fingerprint'].get(k, 0.0) for k in band_keys])
        te = ge.sum() + 1e-12
        wt = fp['track_count'] / max(total_tracks, 1)
        matches = []
        for iem in iem_profiles:
            is_ = np.array([iem['scores_12band'].get(k, 5.0) for k in band_keys])
            pct = round(min(float((ge * is_).sum() / te) * 10.0, 100.0), 1)
            top = [band_keys[i] for i in np.argsort(-(ge * is_))[:3] if ge[i] > 0.1]
            matches.append({'iem_id': iem['id'], 'iem_name': iem['name'],
                            'score': pct, 'best_dimensions': top})
            iem_sw[iem['id']].append((pct, wt))
        matches.sort(key=lambda x: -x['score'])
        matrix.append({'genre': fp['genre'], 'slug': slug,
                       'track_count': fp['track_count'], 'matches': matches})

    # IEM library-weighted summary
    iem_summary = []
    for iem in iem_profiles:
        sw = iem_sw.get(iem['id'], [])
        if not sw:
            continue
        tw  = sum(w for _, w in sw) + 1e-12
        lib = round(sum(s * w for s, w in sw) / tw, 1)
        gs  = {r['genre']: next((m['score'] for m in r['matches'] if m['iem_id'] == iem['id']), 0)
               for r in matrix}
        iem_summary.append({
            'iem_id': iem['id'], 'iem_name': iem['name'],
            'library_match_score': lib,
            'best_genre':  max(gs, key=gs.get)  if gs else None,
            'worst_genre': min(gs, key=gs.get)  if gs else None,
            'genres_above_70': sum(1 for s in gs.values() if s >= 70),
            'genres_total': len(gs),
        })
    iem_summary.sort(key=lambda x: -x['library_match_score'])

    # Overall coverage %
    cov_tracks = sum(
        fp['track_count'] for slug, fp in genre_fps.items()
        if any(m['score'] >= 70 for r in matrix if r['slug'] == slug for m in r['matches'])
    )
    cov_threshold = 70
    cov_pct = round(cov_tracks / max(total_tracks, 1) * 100, 1)

    # Summary text
    good = [r['genre'] for r in matrix if max((m['score'] for m in r['matches']), default=0) >= 70]
    bad  = [r['genre'] for r in matrix if max((m['score'] for m in r['matches']), default=0) < 65]
    if not iem_profiles:
        sumtext = 'Add IEMs with FR data in the Gear section to start matching.'
    elif good and bad:
        sumtext = (f"Your collection covers {', '.join(good[:3])} well. "
                   f"{', '.join(bad[:3])} {'are' if len(bad) > 1 else 'is'} underserved.")
    elif good:
        sumtext = f"Your collection covers {', '.join(good[:3])} well. No significant blindspots."
    elif bad:
        sumtext = f"No genres are well-covered yet. Focus areas: {', '.join(bad[:3])}."
    else:
        sumtext = 'Analysis complete. Tag your tracks with genres for richer insights.'

    # Blindspot / well-covered lists
    _dphr = {
        'sub_bass': 'strong sub-bass extension below 60 Hz',
        'bass': 'solid bass punch (60–120 Hz)',       'bass_feel': 'warmth (80–200 Hz)',
        'slam': 'transient attack / slam (80–150 Hz)', 'lower_mids': 'body (200–500 Hz)',
        'upper_mids': 'presence (500 Hz–1.5 kHz)',    'note_weight': 'note weight (200 Hz–1 kHz)',
        'lower_treble': 'lower treble bite (3–6 kHz)', 'upper_treble': 'upper treble air (6–20 kHz)',
        'detail': 'micro-detail (4–10 kHz)',           'sibilance': 'controlled sibilance (5–10 kHz)',
        'texture': 'surface texture (6–15 kHz)',
    }
    blindspots, well_covered = [], []
    for row in matrix:
        bm = max((m['score'] for m in row['matches']), default=0)
        bx = max(row['matches'], key=lambda m: m['score'], default=None)
        if bm < 65:
            fp      = genre_fps[row['slug']]
            missing = [k for k in band_keys
                       if fp['fingerprint'].get(k, 0) > 0.5
                       and min((iem['scores_12band'].get(k, 5.0) for iem in iem_profiles),
                               default=5.0) < 6.0][:3]
            phrases = [_dphr[d] for d in missing if d in _dphr][:2]
            sugg    = ('An IEM with ' + ' and '.join(phrases) + ' would improve coverage.'
                       if phrases else 'A neutral, well-extended IEM would help.')
            blindspots.append({
                'genre': row['genre'], 'slug': row['slug'],
                'track_count': row['track_count'], 'best_score': bm,
                'best_iem_id': bx['iem_id'] if bx else None,
                'best_iem_name': bx['iem_name'] if bx else None,
                'missing_dimensions': missing, 'suggestion': sugg,
            })
        elif bm >= 70:
            well_covered.append({
                'genre': row['genre'], 'track_count': row['track_count'],
                'best_score': bm, 'best_iem_name': bx['iem_name'] if bx else None,
            })

    return {
        'library_overview': {
            'total_tracks': total_tracks, 'total_genres': len(genre_fps),
            'overall_coverage_pct': cov_pct, 'iem_summary': iem_summary,
            'covered_tracks': cov_tracks, 'coverage_threshold_pct': cov_threshold,
            'summary_text': sumtext,
        },
        'matrix': matrix, 'blindspots': blindspots, 'well_covered': well_covered,
        'band_labels': _ALL_DIM_LABELS, 'dim_keys': _ALL_DIM_KEYS,
    }


def _score_iem_peq_variants(iem, target_meas):
    """Score all PEQ variants for an IEM."""
    variants = []
    for peq in (iem.get('peq_profiles') or []):
        pm = _apply_peq(iem.get('measurement_L'), peq)
        r  = _score_iem_17d(pm, target_meas)
        if not r:
            continue
        variants.append({
            'peq_id': peq['id'], 'name': peq.get('name', 'PEQ'),
            'scores_12band': {k: r['scores'][k] for k in [b[0] for b in _PERC_BANDS]},
            'scores_all': r['scores'], 'deviation': r['deviation'],
            'character': _iem_character_label(r['deviation']),
        })
    return variants


def _load_match_data():
    return _db.db_load_match_data()


# ── API routes ────────────────────────────────────────────────────────────────

@app.route('/api/insights/sonic-profile')
def insights_sonic_profile():
    import numpy as np, random as _rnd
    features = _load_features()
    valid    = [f for f in features if f.get('brightness') and f.get('energy') is not None]
    if not valid:
        return jsonify({'error': 'Run audio analysis first'}), 404

    brightness = np.array([f['brightness'] for f in valid], dtype=float)
    energy     = np.array([f['energy']     for f in valid], dtype=float)

    def _hist(arr, n=25):
        counts, edges = np.histogram(arr, bins=n)
        mids = [(edges[i] + edges[i+1]) / 2 for i in range(n)]
        return {'counts': counts.tolist(), 'midpoints': [round(m, 2) for m in mids]}

    def _stats(arr):
        return {k: round(float(v), 2) for k, v in {
            'min': arr.min(), 'max': arr.max(), 'mean': arr.mean(),
            'median': np.median(arr), 'p25': np.percentile(arr, 25),
            'p75': np.percentile(arr, 75),
        }.items()}

    sample  = _rnd.sample(valid, min(600, len(valid)))
    scatter = [{'x': round(f['brightness'], 0), 'y': round(f['energy'], 5)} for f in sample]

    # 12-band energy profile (normalised to 0–1 relative to max band)
    valid12 = [f for f in features
               if f.get('band_energy') and len(f['band_energy']) == 12
               and f.get('analysis_version') == 3 and not f.get('failed')]
    band_profile = None
    if valid12:
        bm  = np.array([f['band_energy'] for f in valid12]).mean(axis=0)
        mx  = bm.max() + 1e-12
        band_profile = {b[0]: round(float(v / mx), 4) for b, v in zip(_PERC_BANDS, bm)}

    return jsonify({
        'track_count':  len(valid),
        'brightness':   {'histogram': _hist(brightness), 'stats': _stats(brightness)},
        'energy':       {'histogram': _hist(energy),     'stats': _stats(energy)},
        'scatter':      scatter,
        'band_profile': band_profile,
        'band_labels':  {b[0]: b[3] for b in _PERC_BANDS},
    })


@app.route('/api/insights/matching/analyse', methods=['POST'])
def insights_matching_analyse():
    """
    Compute genre fingerprints + IEM 17-dim scores + match matrix.
    Fast (no audio I/O) — reads existing analysed track features + IEM FR curves.
    """
    features = _load_features()
    valid12  = [f for f in features
                if f.get('band_energy') and len(f['band_energy']) == 12
                and f.get('analysis_version') == 3 and not f.get('failed')]
    if not valid12:
        return jsonify({'error': 'Run audio analysis first to generate 12-band track features.'}), 404

    body        = request.get_json(silent=True) or {}
    target_id   = body.get('target', 'flat')
    target_meas = None
    baselines   = load_baselines()
    if target_id != 'flat':
        bl = next((b for b in baselines if b['id'] == target_id), None)
        if bl and bl.get('measurement'):
            target_meas = bl['measurement']
        else:
            target_id = 'flat'

    iems = load_iems()

    iem_profiles = []
    for iem in iems:
        r = _score_iem_17d(iem.get('measurement_L'), target_meas)
        if not r:
            continue
        iem_profiles.append({
            'id': iem['id'], 'name': iem['name'],
            'scores_12band': {k: r['scores'][k] for k in [b[0] for b in _PERC_BANDS]},
            'scores_all':    r['scores'],
            'deviation':     r['deviation'],
            'character':     _iem_character_label(r['deviation']),
            'peq_variants':  _score_iem_peq_variants(iem, target_meas),
        })

    genre_fps   = _compute_genre_fingerprints(valid12, library)
    matrix_data = _build_match_matrix(genre_fps, iem_profiles) if genre_fps else None

    out = {
        'generated_at': int(time.time()),
        'target_id':    target_id,
        'genre_fps':    genre_fps,
        'iem_profiles': iem_profiles,
        'matrix_data':  matrix_data,
    }
    try:
        _db.db_save_match_data(out)
    except Exception:
        pass

    return jsonify({
        'status':          'complete',
        'tracks_analysed': len(valid12),
        'genres_found':    len(genre_fps),
        'iems_scored':     len(iem_profiles),
    })


@app.route('/api/insights/matching/overview')
def insights_matching_overview():
    data = _load_match_data()
    if not data or not data.get('matrix_data'):
        return jsonify({'error': 'Run matching analysis first.'}), 404
    md = data['matrix_data']
    lib_overview = dict(md.get('library_overview') or {})

    # Backward-compatible coverage backfill:
    # Older cached matrix payloads may not include covered_tracks/threshold fields.
    # Compute these from matrix rows so overview messaging stays accurate.
    matrix_rows = md.get('matrix') or []
    threshold = int(lib_overview.get('coverage_threshold_pct') or 70)
    total_tracks = sum(int(r.get('track_count') or 0) for r in matrix_rows)
    covered_tracks = sum(
        int(r.get('track_count') or 0)
        for r in matrix_rows
        if max((m.get('score', 0) for m in (r.get('matches') or [])), default=0) >= threshold
    )
    coverage_pct = round(covered_tracks / max(total_tracks, 1) * 100, 1) if total_tracks > 0 else 0.0

    lib_overview['total_tracks'] = total_tracks
    lib_overview['covered_tracks'] = covered_tracks
    lib_overview['coverage_threshold_pct'] = threshold
    lib_overview['overall_coverage_pct'] = coverage_pct

    # Build available targets: Flat/Neutral + any saved baselines
    bl = load_baselines()
    available_targets = [{'id': 'flat', 'name': 'Flat / Neutral'}] + [
        {'id': b['id'], 'name': b['name']} for b in bl
    ]
    return jsonify({**lib_overview,
                    'band_labels':       md.get('band_labels', {}),
                    'generated_at':      data.get('generated_at'),
                    'target_id':         data.get('target_id', 'flat'),
                    'available_targets': available_targets})


@app.route('/api/insights/matching/matrix')
def insights_matching_matrix():
    data = _load_match_data()
    if not data or not data.get('matrix_data'):
        return jsonify({'error': 'Run matching analysis first.'}), 404
    md       = data['matrix_data']
    fps      = data.get('genre_fps', {})
    # Attach fingerprint to each row so the client can recompute scores for PEQ variants
    matrix   = [dict(row, fingerprint=fps.get(row['slug'], {}).get('fingerprint', {}))
                for row in md['matrix']]
    return jsonify({'matrix': matrix, 'band_labels': md['band_labels'],
                    'dim_keys': md['dim_keys']})


@app.route('/api/insights/matching/recommend')
def insights_matching_recommend():
    genre = request.args.get('genre', '')
    data  = _load_match_data()
    if not data or not data.get('matrix_data'):
        return jsonify({'error': 'Run matching analysis first.'}), 404
    row = next((r for r in data['matrix_data']['matrix']
                if r['genre'] == genre or r.get('slug') == genre), None)
    if not row:
        return jsonify({'error': 'Genre not found.'}), 404
    return jsonify({'genre': row['genre'],
                    'recommendations': sorted(row['matches'], key=lambda m: -m['score'])})


@app.route('/api/insights/matching/blindspots')
def insights_matching_blindspots():
    data = _load_match_data()
    if not data or not data.get('matrix_data'):
        return jsonify({'error': 'Run matching analysis first.'}), 404
    md = data['matrix_data']
    return jsonify({'blindspots': md['blindspots'], 'well_covered': md['well_covered'],
                    'band_labels': md['band_labels']})


@app.route('/api/insights/matching/iem/<iem_id>/radar')
def insights_matching_iem_radar(iem_id):
    data = _load_match_data()
    if not data:
        return jsonify({'error': 'Run matching analysis first.'}), 404
    prof = next((p for p in (data.get('iem_profiles') or []) if p['id'] == iem_id), None)
    if not prof:
        return jsonify({'error': 'IEM not found in analysis.'}), 404
    best_genres = []
    if data.get('matrix_data'):
        gs = {r['genre']: next((m['score'] for m in r['matches'] if m['iem_id'] == iem_id), 0)
              for r in data['matrix_data']['matrix']}
        best_genres = sorted(gs, key=lambda g: -gs[g])[:3]
    scores    = prof['scores_all']
    deviation = prof.get('deviation', {})
    dim_keys  = _ALL_DIM_KEYS
    return jsonify({
        'iem_id': iem_id, 'iem_name': prof['name'],
        'scores': scores, 'deviation': deviation,
        'dim_keys': dim_keys, 'dim_labels': _ALL_DIM_LABELS,
        'best_genres': best_genres,
        'weakest_dimensions': sorted(dim_keys, key=lambda k: scores.get(k, 0))[:3],
        'peq_variants': [{'peq_id': v['peq_id'], 'name': v['name'],
                          'scores': v['scores_all'], 'deviation': v.get('deviation', {})}
                         for v in prof.get('peq_variants', [])],
    })


@app.route('/api/insights/matching/genre/<genre>/fingerprint')
def insights_matching_genre_fingerprint(genre):
    data = _load_match_data()
    if not data or not data.get('genre_fps'):
        return jsonify({'error': 'Run matching analysis first.'}), 404
    fp = data['genre_fps'].get(genre) or next(
        (v for v in data['genre_fps'].values() if v['genre'] == genre), None)
    if not fp:
        return jsonify({'error': 'Genre not found.'}), 404
    return jsonify({**fp, 'band_labels': {b[0]: b[3] for b in _PERC_BANDS}})


@app.route('/api/insights/matching/targets')
def insights_matching_targets():
    baselines  = load_baselines()
    targets    = [{'id': 'flat', 'name': 'Flat / Neutral'}] + [
        {'id': b['id'], 'name': b['name']} for b in baselines if b.get('measurement')]
    data       = _load_match_data()
    current_id = data.get('target_id', 'flat') if data else 'flat'
    return jsonify({'targets': targets, 'current_target_id': current_id})


# ── Insights heatmap genre config ──────────────────────────────────────────────

def load_insights_config():
    return _db.db_load_insights_config()

def save_insights_config(cfg):
    _db.db_save_insights_config(cfg)

@app.route('/api/insights/matching/heatmap-genres', methods=['GET'])
def get_heatmap_genres():
    cfg = load_insights_config()
    return jsonify({'extra_genres': cfg.get('heatmap_extra_genres', [])})

@app.route('/api/insights/matching/heatmap-genres', methods=['POST'])
def set_heatmap_genres():
    data = request.get_json() or {}
    genres = data.get('extra_genres', [])
    if not isinstance(genres, list):
        return jsonify({'error': 'extra_genres must be a list'}), 400
    genres = [str(g) for g in genres if g][:5]
    cfg = load_insights_config()
    cfg['heatmap_extra_genres'] = genres
    save_insights_config(cfg)
    return jsonify({'extra_genres': genres})


# ── SQLite initialization ─────────────────────────────────────────────────────
_db.init_db(DATA_DIR)
if not _migrate.ensure_db(DATA_DIR):
    raise RuntimeError('SQLite migration failed; startup aborted (JSON fallback removed).')

load_library()

if __name__ == '__main__':
    port = int(os.environ.get('TUNEBRIDGE_PORT', 5001))
    if HAS_WAITRESS:
        print(f' * TuneBridge running on http://127.0.0.1:{port}')
        waitress_serve(app, host='127.0.0.1', port=port, threads=4)
    else:
        app.run(debug=False, host='127.0.0.1', port=port, use_reloader=False)
