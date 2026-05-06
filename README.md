# TuneBridge

A local music manager for a personal FLAC library. Browse your music collection, build playlists with drag-and-drop, export to portable players, sync music to devices, manage IEM/headphone frequency response data, and analyse your library's sonic character.

Built with **Flask** (Python) + **Vanilla JS**. No cloud, no subscription — runs entirely on your machine.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend language | Python 3.10+ |
| Web framework | Flask |
| WSGI server | Waitress (production), Flask dev server (fallback) |
| Audio metadata | Mutagen |
| Audio analysis | soundfile + NumPy (Insights feature) |
| Machine learning | scikit-learn (normalisation helpers in Insights) |
| Image processing | Pillow |
| Frontend | Vanilla JS (no framework) |
| Charts | Chart.js 4.4.0 (FR graphs + Insights charts) |
| Drag & drop | SortableJS |
| Audio playback | Web Audio API + HTMLAudioElement (+ optional mpv/libmpv bit-perfect mode) |
| Desktop wrapper | pywebview (WKWebView on macOS) |
| App launcher | Frozen Python runtime (PyInstaller, arm64) |
| App entrypoint | `tunebridge_gui.py` |
| Packaging | `build_app.sh` → self-contained `.app` + drag-to-install `.dmg` |
| Data storage | SQLite (`tunebridge.db`) |
| VCS | Git → GitHub (`hashansr/tunebridge`) |

> **Keep this table updated** whenever a new dependency is added or removed.

---

## Features

### Library
- Browse by Artist → Album → Track with album art thumbnails
- A–Z sticky alpha bars on Artists and Albums pages (case-insensitive grouping)
- "Browse All Songs" — flat track list for an entire artist
- Full Songs view: 4300+ tracks, sortable columns, text filter, pagination (100/page)
- Instant search across all tracks

### Playlists
- Build playlists with drag-and-drop reordering
- Multi-select tracks (click `#` cell, shift-click for range)
- Duplicate detection — Cancel / Skip Duplicates / Add Anyway dialog
- In-playlist text filter and sort (Original / A–Z / Album / Date)
- Custom cover art per playlist, or auto-generated 2×2 mosaic from album art
- M3U / M3U8 import with interactive mapping UI for unmatched tracks
- **Smart Playlist** generator:
  - quick mode: `Mix style`, `Vibe`, `Length`, optional references/genre lane
  - advanced controls in collapsible section (arc, constraints, deterministic, etc.)
  - reference-track browser modal + "use current selection" shortcut
  - regenerate for alternate high-quality candidate sets before saving

### Device Export & Sync
- Dynamic per-DAP export pills on every playlist (download or copy directly to device)
- DAP management: add/edit/delete with profile-driven presets (no hardcoded device list)
- Per-playlist sync timestamps — shows stale / up-to-date badge per DAP
- Bidirectional music sync (local ↔ DAP): scan diff, checkbox preview, file-by-file progress

### In-App Player
- Refreshed bottom player bar (glass shell, responsive 86px desktop height), queue drawer, PEQ popover
- Web Audio API signal chain: preamp → biquad PEQ filters → volume
- Crossfade between tracks: dual A/B `HTMLAudioElement` engine, 0–12s configurable
- Shuffle (Fisher-Yates), repeat off/all/one
- Context-aware playback + shuffle:
  - double-click from playlist/artist/album/songs starts from that active context
  - shuffle acts on the current context collection (not a single-track queue)
- Playback quality display: `24-bit · 48 kHz · FLAC` or `320 kbps · MP3`
- Right-click context menu: Play Next / Add to Queue / Add to Playlist on all track rows and cards
- Right-click Smart Playlist entry: create a Smart Playlist from selected/target tracks
- Double-click track to play
- Keyboard shortcuts: Space = play/pause, Alt+←/→ = prev/next, M = mute
- Player state persisted to localStorage and server-side SQLite state
- Motion polish: animated queue/PEQ panel transitions, tactile hover/press feedback, `prefers-reduced-motion` support

### Gear (IEMs & DAPs)
- IEM/headphone library: CRUD with squig.link FR measurement import
- Frequency response graph: Chart.js log-scale, 7 region bands, fixed Y 50–110 dB, 1kHz normalised to 75 dB
- PEQ profiles: upload APO/AutoEQ `.txt`, overlay on graph, accordion view (filter table + download)
- **IEM comparison**: multi-select IEMs → single FR graph overlay in a modal
- Add custom FR references: up to 3 user-provided squig.link URLs with labels, reusable across FR chart selectors
- FR baselines (tuning targets): add squig.link targets (Harman, Rtings, etc.) with a 10-colour swatch picker

### Insights (Audio Analytics)
- **Overview**: stat cards + File Format / Sample Rate / Bit Depth donut charts
- **Tag Health**: completeness bars for title, artist, album, genre, year, album art
- **Rescan tags**: one-click re-scan with inline progress for updated library tags
- **Sonic Profile**: compact tonal profile cards + brightness/energy histograms + tonal demand chart (requires analysis)
- **Gear Fit**: score every IEM against your library's sonic character using two models:
  - *Target Fidelity* — how accurately the IEM reproduces a chosen FR target (Harman, flat, etc.)
  - *Library Fit* — how well the IEM matches your library's own tonal balance
  - Factory + PEQ variant tabs per IEM, blindspot analysis, dual score pills, sort toggle
- Incremental analysis: only re-analyses tracks with missing or stale cache
- M4A/AAC files gracefully recorded as unanalysable (soundfile/libsndfile limitation)

### Settings & Tools
- First-run onboarding modal for new installs (library path + folder/file format preferences)
- Configurable music library path with Browse… folder picker
- Health check panel (library, squig.link, DAPs, playback runtime, database)
- Data backup / restore (ZIP of all user data)
- Restart & Reload server in-app

---

## Requirements

- macOS (tested on macOS 14+, Apple Silicon for packaged build)
- Music library organised as: `Artist/Album/NN. Title.ext`
- Supported formats: FLAC, MP3, AAC, M4A, ALAC, OGG, OPUS, WAV, AIFF, WMA, APE

### Developer Requirements
- Python 3.10+
- Homebrew (optional, required only for mpv bit-perfect output): `brew install mpv`

---

## Quick Start

For end users, use the macOS DMG below. The source workflow is for development.

```bash
# 1. Clone and install
git clone https://github.com/hashansr/tunebridge.git
cd tunebridge
bash install.sh

# 2. Run in a browser for backend/frontend development
bash run.sh
# → Opens at http://localhost:5001

# Or run the native development wrapper
source venv/bin/activate
python tunebridge_gui.py
```

## macOS Distribution (Recommended)

```bash
bash build_app.sh --dmg
# → dist/TuneBridge.dmg
# → distro/TuneBridge-latest.dmg
```

Install flow for end users:
1. Open `TuneBridge.dmg`
2. Drag `TuneBridge.app` to `Applications`
3. Launch TuneBridge from Applications

The packaged app is the supported user experience. It starts the embedded local server itself and opens TuneBridge in a native macOS WKWebView window, so users do not need Terminal, a browser tab, Python, pip, or project source files.

### First Launch on macOS (Unsigned / Not Notarized Build)

If macOS shows a warning like:
- `"TuneBridge" can’t be opened because Apple cannot check it for malicious software`
- `"TuneBridge" is damaged and can’t be opened` (Gatekeeper quarantine wording)

Use this first-time launch flow:
1. Move `TuneBridge.app` to `Applications` (do not run directly from DMG).
2. In `Applications`, right-click `TuneBridge.app` and choose `Open`.
3. Click `Open` again in the confirmation dialog.

If it is still blocked:
1. Open `System Settings` → `Privacy & Security`.
2. Scroll to the security section and find the message about TuneBridge being blocked.
3. Click `Open Anyway`.
4. Re-open TuneBridge from `Applications`.

Notes:
- You usually need to do this once per new app build.
- This warning appears because the app is currently distributed without Apple notarization.

### Distribution Folder
- Latest shareable build:
  - `distro/TuneBridge-latest.dmg`
- Archived per-build DMGs:
  - `distro/TuneBridge-v<version>-<timestamp>.dmg`
- `dist/TuneBridge.dmg` remains the raw build output.

### First Run Behavior
- Automatically creates app data at:
  `~/Library/Application Support/TuneBridge/`
- Packaged app already includes Python dependencies (no first-run `pip install`).
- First-run onboarding appears only for a fresh App Support database. Choosing `Set Up Later` records that preference so the modal does not keep returning on every launch.
- Shows onboarding for fresh installs to capture:
  - default library folder
  - folder structure preference
  - primary file format preference
- Initializes/migrates SQLite schema where applicable.
- Starts the embedded local server and opens native UI.
- Standard playback works without optional system packages. If mpv bit-perfect mode is needed, install it from `Settings → Playback → Install mpv`; Homebrew/libmpv are optional and checked in-app.

---

## Data Storage

| Path | Contents | Committed? |
|------|---------|---|
| `~/Library/Application Support/TuneBridge/tunebridge.db` | Main SQLite store (library metadata, playlists, settings, DAPs, IEMs, baselines, analysis cache, player state) | User machine |
| `~/Library/Application Support/TuneBridge/tunebridge.db-wal` | SQLite WAL journal | User machine |
| `~/Library/Application Support/TuneBridge/tunebridge.db-shm` | SQLite shared memory file | User machine |
| `~/Library/Application Support/TuneBridge/playlist_artwork/` | Custom playlist cover images | User machine |
| `~/Library/Application Support/TuneBridge/artwork/` | Album art cache (auto-generated) | User machine |

---

## Project Structure

```
tunebridge/
├── app.py                  # Flask backend, all API routes
├── tunebridge_gui.py       # pywebview entrypoint (desktop app)
├── static/
│   ├── index.html          # Single-page app HTML, all modals
│   ├── app.js              # All frontend logic
│   ├── player.js           # In-app music player
│   └── style.css           # Dark theme (Luminous Depth design system)
├── data/
│   ├── tunebridge.db            # SQLite data store (dev/source mode)
│   ├── artwork/                 # Cached album art
│   └── playlist_artwork/        # Custom playlist covers
├── create_app.sh           # Legacy dev launcher workflow
├── build_app.sh            # Build self-contained .app and drag-drop .dmg
├── install.sh              # One-time setup script
├── update.sh               # Backup data, pull latest, update deps
└── requirements.txt        # Python dependencies
```

---

## DAP Profiles

DAP export behavior is profile-driven and not hardcoded in UI logic.

- Profile definitions are currently bundled in backend defaults (`app.py`).
- Each profile controls fields such as:
  - model id / display name
  - playlist format (`.m3u` / `.m3u8`)
  - export folder
  - path prefix
  - suggested mount name
- Add/edit DAP modal and export logic consume this profile registry at runtime.

---

## UI Change Checklist (Required)

For any UI/UX change, validate against:
- [`master-design.md`](master-design.md) (single source of truth)
- `static/style.css` token usage and spacing rhythm

Before merging UI work:
1. Confirm typography uses canonical system font stack and approved scale.
2. Confirm color usage follows semantic rules (primary, success, warning, danger).
3. Confirm runtime UI iconography uses SVG/curated assets only (no emoji).
4. Confirm spacing rhythm matches surrounding views (header, controls, content, cards).
5. Confirm interaction states exist and are coherent (hover/focus/active/disabled).
6. Confirm empty/loading/error states are handled.
7. Confirm behavior contracts still hold (for example shuffle-aware Play/Play All).
8. Add a short design-impact note to `codex.md`.
