# TuneBridge

A local web-based music manager for a personal FLAC library. Browse your music collection, build playlists with drag-and-drop, export to portable players, and keep your devices in sync.

Built with **Flask** (Python) + **Vanilla JS**. No cloud, no subscription — runs entirely on your machine.

## Features

- **Browse** your library by Artist → Album → Track with album art thumbnails
- **Search** across all tracks instantly
- **Build playlists** with drag-and-drop reordering, multi-select, and bulk actions
- **Export to devices** — Poweramp on FiiO M21 and AP80 Pro Max (M3U format, correct relative paths)
- **Import playlists** from M3U/M3U8 files, with an interactive UI to map unmatched tracks
- **Sync music** bidirectionally between your local library and SD cards
- **Custom cover art** per playlist, or auto-generated 2×2 mosaic from album art
- Persistent playlists with stable track IDs (safe to rescan library without losing playlists)

## Requirements

- macOS (tested on macOS 14+)
- Python 3.8+
- Music library organised as: `Artist/Album/NN. Title.ext`
- Supported formats: FLAC, MP3, AAC, M4A, ALAC, OGG, OPUS, WAV, AIFF, WMA, APE

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/hashansr/tunebridge.git
cd tunebridge
bash install.sh

# 2. Set your music library path
nano data/settings.json   # set "music_base" to your library path

# 3. Run
bash run.sh
# → Open http://localhost:5001

# 4. (Optional) Create a macOS app launcher
bash create_app.sh
# → Opens TuneBridge.app in /Applications — double-click to launch
```

## Install Script

`install.sh` handles everything on a fresh machine:
- Checks Python 3.8+
- Creates a virtual environment
- Installs dependencies (`flask`, `flask-cors`, `mutagen`)
- Creates `data/` directories
- Generates default `data/settings.json`

## macOS App Launcher

Run `bash create_app.sh` once to create **TuneBridge.app** in `/Applications`.

- Double-click (or add to Dock) to launch
- Starts the server automatically if not running
- Opens `http://localhost:5001` in a new Safari window
- Server logs at `/tmp/tunebridge.log`

Re-run `create_app.sh` if you move the project folder.

## Configuration

`data/settings.json`:

```json
{
  "music_base": "/Volumes/Storage/Music/FLAC",
  "poweramp_mount": "/Volumes/FIIO M21",
  "ap80_mount": "/Volumes/AP80"
}
```

| Key | Description |
|-----|-------------|
| `music_base` | Root of your local music library |
| `poweramp_mount` | Mount point of your FiiO M21 SD card |
| `ap80_mount` | Mount point of your AP80 Pro Max SD card |

After changing `music_base`, click **Rescan Library** (↺) in the sidebar.

## Device Export

### FiiO M21 (Poweramp)
- Playlists saved to `Playlists/` on the SD card
- Paths: `Music/Artist/Album/track.flac`
- Playlist name = filename (rename via long-press → Edit in Poweramp)

### AP80 Pro Max
- Playlists saved to `playlist_data/` on the SD card (firmware requirement)
- Paths: `../Music/Artist/Album/track.flac`
- **Note:** Save one playlist natively on the AP80 first so the device creates `playlist_data/` — manually creating the folder causes a "0 songs" bug.

## Music Sync

The sync feature compares your local library against an SD card and shows a diff:
- Files only on local → option to copy to device
- Files only on device → option to copy to local

Folder structure is always preserved. Files are never deleted — only added.

## Data Files

| File | Contents |
|------|---------|
| `data/playlists.json` | Your playlists and track lists |
| `data/settings.json` | Device paths (machine-specific) |
| `data/library.json` | Track metadata cache (auto-generated, gitignored) |
| `data/artwork/` | Album art cache (auto-generated, gitignored) |
| `data/playlist_artwork/` | Your custom playlist covers |

## Project Structure

```
tunebridge/
├── app.py              # Flask backend, all API routes
├── static/
│   ├── index.html      # Single-page app
│   ├── app.js          # All frontend logic
│   └── style.css       # Dark theme
├── data/
│   ├── playlists.json  # Persisted playlists
│   ├── settings.json   # Device config
│   ├── artwork/        # Album art cache
│   └── playlist_artwork/  # Custom playlist covers
├── create_app.sh       # Build TuneBridge.app for macOS
├── install.sh          # One-time setup script
├── run.sh              # Start the app
└── requirements.txt    # Python dependencies
```
