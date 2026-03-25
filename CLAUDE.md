# TuneBridge — Project Memory

## What This Is
A local web-based music manager for a personal FLAC music library. Built with Flask (Python) + Vanilla JS. Lets you browse your library, build playlists with drag-and-drop, export them to portable music players, and sync music between local storage and SD cards.

**Project name**: TuneBridge (previously "Music Manager", previously "Playlist Creator")

## How to Run
```bash
cd "/Users/hashan/Documents/Claude/Projects/Playlist Creator"
source venv/bin/activate
python app.py          # runs on port 5001
```
Preview proxy runs on port 5002 via `~/playlist_proxy.py` (workaround for macOS sandbox blocking port 5001 from preview tools).

**Launch config**: `.claude/launch.json` → starts `~/playlist_proxy.py` on port 5002.

Port 5000 is blocked on macOS (AirPlay). Always use 5001.

## Music Library
- **Source**: `/Volumes/Storage/Music/FLAC/` — 398 artists, 1089 albums, 4226 FLAC tracks
- **Structure**: `Music/%artist%/%album%/NN. %title%.flac`
- **Cache**: `data/library.json` (fast startup), album art cached to `data/artwork/*.jpg`

## Device Export

### Poweramp — FiiO M21
- Mount: `/Volumes/FIIO M21`
- Export folder: `Playlists/` on the SD card root
- File format: `.m3u` with relative paths: `Music/Artist/Album/track.flac`
- Poweramp uses the **filename** as playlist name (ignores `#PLAYLIST:` tag)

### AP80 Pro Max
- Mount: `/Volumes/AP80`
- Export folder: `playlist_data/` at SD card root (**firmware requirement** — NOT `Playlists/`)
- File format: `.m3u` with relative paths: `../Music/Artist/Album/track.flac`
  (one level up from `playlist_data/` to reach `Music/`)
- **One-time setup**: On the AP80, save one playlist natively first so the device creates `playlist_data/` itself. Manually creating the folder causes "0 songs" bug.

## Key Files
| File | Purpose |
|------|---------|
| `app.py` | Flask backend, all API routes, library scanner |
| `static/index.html` | Single-page app HTML, all modals |
| `static/style.css` | Dark theme CSS |
| `static/app.js` | All frontend logic |
| `data/library.json` | Cached track metadata |
| `data/playlists.json` | Persisted playlists |
| `data/settings.json` | Device mount paths |
| `data/daps.json` | DAP devices (name, model, mount, export config, playlist export timestamps) |
| `data/iems.json` | IEM/headphone library (name, type, squig measurement data, PEQ profiles) |
| `data/artwork/` | Cached album art JPEGs |
| `data/playlist_artwork/` | Custom playlist cover images |
| `~/playlist_proxy.py` | Reverse proxy 5002 → 5001 |

## Architecture

### Backend (`app.py`)
Key routes:
- `GET /api/library/artists` — artist list with artwork keys
- `GET /api/library/albums` — album list, optional `?artist=` filter
- `GET /api/library/tracks` — track list, optional `?artist=`, `?album=`, `?q=` (search)
- `GET/POST /api/playlists` — list / create
- `GET/PUT/DELETE /api/playlists/<pid>` — get / update tracks / delete
- `POST /api/playlists/<pid>/tracks` — add tracks (with duplicate detection + `force` flag)
- `DELETE /api/playlists/<pid>/tracks/<tid>` — remove track
- `GET /api/playlists/<pid>/export/<fmt>` — download M3U (`poweramp` or `ap80`)
- `POST /api/devices/export` — copy playlist directly to mounted device
- `GET /api/devices/status` — check if devices are mounted
- `POST/DELETE /api/playlists/<pid>/artwork` — upload/remove custom cover art
- `GET /api/playlists/<pid>/artwork` — serve cover art
- `POST /api/playlists/import` — parse and import M3U/M3U8 file
- `GET/PUT /api/settings` — device configuration
- `GET /api/health` — health check (`{status: "ok"}`)
- `POST /api/restart` — restart server via `os.execv` (responds before restarting)
- `GET/POST /api/daps` — list / create DAP devices
- `GET/PUT/DELETE /api/daps/<did>` — get / update / delete DAP
- `POST /api/daps/<did>/export/<pid>` — export playlist M3U to DAP, records timestamp in `playlist_exports`
- `GET/POST /api/iems` — list / create IEM (POST fetches squig.link measurement)
- `GET/PUT/DELETE /api/iems/<iid>` — get / update (re-fetches squig if URL changed or missing) / delete
- `GET /api/iems/<iid>/graph` — returns curve data for Chart.js (`?peq=<id>` to overlay PEQ, `?compare=<id>` for multi)
- `POST /api/iems/<iid>/peq` — upload APO/AutoEQ .txt PEQ profile (multipart or JSON)
- `DELETE /api/iems/<iid>/peq/<peq_id>` — delete PEQ profile
- `POST /api/iems/<iid>/peq/<peq_id>/copy` — copy PEQ file to a DAP's PEQ folder

### Frontend (`app.js`)
State object:
```js
const state = {
  view, artist, album, playlist, playlists, tracks, artists, albums,
  searchResults, devices, scanStatus, activeTrackId, sortable,
  lastUsedPlaylistId,   // most-recently-added-to playlist (drives picker order)
  _pendingTrackIds,     // queued for picker selection
  selectedTrackIds,     // Set of selected track IDs (multi-select)
  lastSelectedIdx,      // last clicked index (for shift-click range select)
  playlistSortMode,     // sidebar sort: 'alpha' | 'created' | 'updated'
  plSortMode,           // in-playlist sort: 'original' | 'az' | 'album' | 'date'
  plFilter,             // in-playlist text filter
}
```

Module-level globals for Gear views:
- `_iemChart` — active Chart.js instance (destroyed/recreated on IEM detail load)
- `_currentIemId` — IEM being viewed (used by PEQ upload/delete)
- `_activePeqId` — currently overlaid PEQ profile ID (null = raw measurement)
- `DAP_MODEL_PRESETS` — map of model → `{mount, folder, prefix, hint}` for modal auto-fill

Public `App` object exposes all functions called from HTML `onclick` attributes.

## Features Implemented
- [x] DAP management — add/edit/delete DAPs with model presets (Poweramp, Hiby OS, FiiO Player, Other), emoji icon picker, per-playlist sync status tracking (never / stale / up-to-date), one-click export to mounted device
- [x] IEM & Headphone library — add/edit/delete with squig.link measurement import, frequency response graph (Chart.js, log-scale, region bands), PEQ profile upload (APO/AutoEQ .txt), PEQ overlay on graph
- [x] Artist → Album → Track drill-down navigation
- [x] "Browse All Songs" button in artist hero → flat track list for entire artist
- [x] Multi-select tracks (click `#` cell) with shift-click range; floating bulk action bar
- [x] A–Z sticky alpha bar on artists page (scrolls to letter anchor)
- [x] Artist & album card grids with album art thumbnails
- [x] Drag-and-drop track reordering in playlists (SortableJS)
- [x] Add single track / whole album / all artist songs to playlist
- [x] Playlist picker dropdown (most-recently-used playlist at top)
- [x] Duplicate detection with Cancel / Skip Duplicates / Add Anyway dialog
- [x] In-playlist text filter (live search)
- [x] In-playlist sort: Original / A–Z / Album / Date (drag disabled when sorted/filtered)
- [x] Sidebar playlist sort: A–Z / Date Created / Last Updated
- [x] Custom playlist cover art upload (replaces auto-mosaic)
- [x] Auto 2×2 mosaic cover from top 4 album artworks
- [x] Export to Poweramp (M3U) — download or copy direct to FiiO M21
- [x] Export to AP80 Pro Max (M3U) — download or copy direct to AP80
- [x] M3U / M3U8 import with 4-tier path matching
- [x] Help modal with device-specific instructions
- [x] Device settings modal (mount paths, Poweramp prefix)
- [x] Library rescan with progress bar
- [x] `updated_at` tracked on all playlist mutations; backfilled on old playlists
- [x] Bidirectional music sync (local ↔ M21 / local ↔ AP80) — scan diff, preview with checkboxes, copy with progress
- [x] Artist sort ignores leading articles (The, A, An) — across artists page, albums page, and Songs sort
- [x] Settings view (Tools section) — Library section (path config) + App section (Restart & Reload)
- [x] IEM graph: distinct L (blue) / R (red) / PEQ (green) colours, custom eye-toggle legend
- [x] Songs view pagination (100 tracks/page)
- [x] DAP detail: clickable playlist names → navigate to playlist
- [x] Sidebar nav order: Library → Gear → Tools → Playlists

## Data Notes
- Playlists store track IDs (strings), resolved to full objects on load
- `updated_at` and `created_at` are Unix timestamps (int)
- Settings default: Poweramp mount `/Volumes/FIIO M21`, AP80 mount `/Volumes/AP80`
- AP80 prefix is hardcoded `..` (not user-configurable) — relative paths from `playlist_data/`
- Artwork keys are MD5 of `artist+album` string
- DAP `playlist_exports`: `{pid: unix_timestamp}` — stale when `playlist.updated_at > exports[pid]`
- IEM measurements stored as `[[freq, spl], ...]` (300 log-spaced points, 20–20kHz) in `measurement_L` / `measurement_R`
- IEM PEQ profiles: `{id, name, preamp_db, filters: [{type, fc, gain, q}], raw_txt}`
- squig.link fetch requires browser User-Agent + Referer headers (server returns 403 otherwise)

## Known Issues / Quirks
- Poweramp displays playlist name as filename (e.g. "My Mix.m3u" shows as "My Mix.m3u"). User can long-press → Edit to rename within Poweramp.
- AP80 `playlist_data/` folder must be created by the device first (save a dummy playlist on-device), otherwise manually created folders show 0 songs.
- macOS AirPlay occupies port 5000; app uses port 5001.
- Preview tool sandbox can't access `~/Documents/`; solved with proxy on port 5002.
- squig.link returns 403 without browser headers — `fetch_squig_measurement()` sends `User-Agent` + `Referer` to work around this.
- IEMs created before the header fix will have `measurement_L/R = null`. Editing and saving the IEM (PUT with same squig_url) will auto-refetch since the backend now refetches when measurement is missing.

## Sync Feature
Routes: `POST /api/sync/scan`, `GET /api/sync/status`, `POST /api/sync/execute`, `POST /api/sync/reset`

Global `sync_state` dict tracks: `status` (idle/scanning/ready/copying/done/error), `local_only[]`, `device_only[]`, `progress`, `total`, `errors[]`.

`walk_music_files(root)` — walks a directory, skips hidden/`._` files, returns sorted list of relative paths for all music file extensions.

Sync button (⟳ arrows icon) in sidebar bottom bar opens `#sync-modal`. Device picker shows mount status (green "Connected" / grey "Not connected"). Scan phase shows animated progress bar. Preview phase shows two sections (copy to device ↑ / copy to local ↓) with scrollable checkbox lists — folder path in muted colour, filename in brighter. "Select all" toggle per section. Copy phase shows file-by-file progress. Done phase shows summary + any errors.

## Git Workflow
- Repo: `https://github.com/hashansr/tunebridge` (pushed, `main` branch)
- **Commit all changes after each session** — always `git add` modified files and commit with a clear message
- `.claude/` is intentionally gitignored (machine-specific Claude Code config)
- `data/library.json` and `data/artwork/` are gitignored (auto-regenerated cache)
- `data/playlists.json`, `data/settings.json`, `data/playlist_artwork/` ARE committed (user data)

## DAP Playlist Path Reference
| Model preset | Export folder | Path prefix | Notes |
|---|---|---|---|
| Poweramp | `Playlists` | _(empty)_ | Scans all storage; filename = playlist name |
| Hiby OS | `HiByMusic/Playlist` | _(empty)_ | HiBy R5/R6 etc; paths relative to storage root |
| FiiO Player | `Playlists` | _(empty)_ | Access via Browse Files (not Playlist menu) |
| Other / AP80 | `playlist_data` | `..` | AP80 firmware requires this folder; device must create it first |

## Gear Feature: squig.link URL Format
- URL: `https://{subdomain}.squig.link/?share={File_Key_With_Underscores}`
- Data files: `https://{subdomain}.squig.link/data/{File Key} L.txt` and `…R.txt`
- File format: REW space-separated (`* header` lines skipped, columns: freq SPL phase)
- Downsampled to 300 log-spaced points between 20–20kHz

## Last Updated
2026-03-25 — Session 11: Artist sort, Settings view, Restart & Reload
- **Artist sort ignores leading articles**: "The", "A", "An" stripped before sorting — "The Offspring" sorts under O, "A Perfect Circle" under P. Applied to `/api/library/artists`, `/api/library/albums`, and `/api/library/songs` (artist/album_artist columns). `artist_sort_key()` helper in `app.py`. Frontend A–Z alpha bar already used the same stripping logic.
- **Settings view**: Renamed "Library Settings" nav item → **"Settings"** (gear icon). View (`view-settings`) now has two card sections:
  - **Library** — music library path input, Save, Rescan Library buttons (same as before)
  - **App** — Restart & Reload button: calls `POST /api/restart`, polls `GET /api/health` every 800ms until server responds, then reloads the page automatically
- **New API routes**: `GET /api/health` (returns `{status: "ok"}`), `POST /api/restart` (uses `os.execv` to replace the process with a fresh instance after 600ms delay)
- **Sidebar nav order**: Library → Gear → Tools → Playlists (Playlists is outside `<nav>` as `#playlists-header` + `#playlists-section`)
- **Playlist scroll bug fixed**: PLAYLISTS header moved outside `#playlists-section` as a static flex sibling — no more content scrolling behind the header
- **IEM graph**: L channel = Blue (`#5b8dee`), R channel = Red (`#e05c5c`), PEQ overlay = Green (`#53e16f`). Custom HTML legend with eye-toggle buttons per curve (replaces Chart.js built-in legend). `_iemCurveColor(id)` derives colour from dataset ID suffix (`-L`, `-R`, `-peq-*`). `toggleIemCurve(idx)` toggles Chart.js dataset visibility.
- **DAP modal**: Icon dropdown aligned correctly (44px → 36px, border-radius fix)
- **Songs view**: Client-side pagination (100 tracks/page). `_songsPage`, `SONGS_PER_PAGE`, `songsPrevPage()`, `songsNextPage()`, `_scrollSongsTop()`. Sort/filter resets to page 0.
- **DAP detail**: Playlist names in sync status table are clickable → navigates directly to that playlist (`openPlaylist(id)`)
- **Search Songs removed**: Superseded by Songs view with inline filter

2026-03-25 — Session 10: Major UI overhaul (Luminous Depth design system) + new features
- **Design System**: Complete CSS rewrite implementing "Luminous Depth" / "Obsidian Lens" design spec
  - New colour palette: primary `#adc6ff` (blue), secondary `#ffb3b5` (pink), tertiary `#53e16f` (green)
  - Inter font loaded from Google Fonts, all typography updated
  - "No-border" rule: replaced all solid 1px borders with tonal layering (background-colour shifts)
  - Glassmorphism on modals, dropdowns, toast (backdrop-filter blur)
  - Pill-shaped buttons with gradient primary CTA
  - Surface hierarchy: `#131313` → `#1c1b1b` → `#2a2a2a` → `#353534`
- **Songs view**: New "Songs" nav item under Library — shows all 4300+ tracks in full table with columns: #, Title, Artist, Album, Duration, Genre, Year, Album Artist, Format, Bitrate, Date Added. Sortable columns (click header), filterable (search bar).
- **Library Settings**: New view under Gear → Library Settings. Configurable music library path (saved to settings.json). Save + Rescan buttons.
- **Configurable library path**: `MUSIC_BASE` is now read from `settings.json` via `get_music_base()` — no longer hardcoded.
- **Track metadata**: `scan_file()` now outputs `bitrate` (kbps), `format` (FLAC/MP3/M4A), `date_added` (file mtime). Available after rescan.
- **New API**: `GET /api/library/songs` — full track list with sort/filter (`?sort=title&order=asc&q=search`)
- **DAP modal**: Icon selection changed to compact dropdown (was full grid). Removed placeholder text from all fields. Mount path auto-filled based on OS (mac/windows/linux). Model preset updates mount value (not placeholder).
- **IEM modal**: Removed all placeholder text. "squig.link" is now a clickable hyperlink to the website.
- **Frequency response graph**: Updated to match squig.link with 7 region bands (Sub bass, Mid bass, Lower midrange, Upper midrange, Presence region, Mid treble, Air). X-axis ticks: 20, 50, 100, 200, 500, 1k, 2k, 5k, 10k, 20k. Major gridlines more prominent. Legend items click-to-toggle curve visibility. Blue-tinted region bands and grid.
- **Error handling**: IEM creation now returns 400 if squig.link measurement fetch fails (instead of silently saving with null data). PEQ upload shows server error messages. Graph load failures show toast.
- **Favicon**: New SVG favicon matching the TuneBridge logo (music note in blue).
- **Sidebar**: Section headers (LIBRARY, TOOLS, GEAR, PLAYLISTS) are now sticky — stay pinned while scrolling. Removed cog/settings button (replaced by Library Settings under Gear).

2026-03-25 — Session 9: DAP management + IEM/Headphone library with frequency response graphs
- Added DAP management: CRUD, model presets (Poweramp/Hiby OS/FiiO Player/Other), emoji icon picker, per-playlist sync status, one-click export to mounted device
- Added IEM & Headphone library: CRUD, squig.link measurement import, Chart.js frequency response graph (log-scale x-axis, region band overlay plugin), PEQ upload (APO/AutoEQ .txt), PEQ overlay on graph
- Fixed squig.link fetch 403: added browser User-Agent + Referer headers to `fetch_squig_measurement()`
- PUT `/api/iems/<iid>` now auto-refetches measurement if `measurement_L` is null (handles IEMs created before the header fix)
- Sidebar: new GEAR section with DAPs and IEMs & Headphones nav items
- New views: `view-daps`, `view-dap-detail`, `view-iems`, `view-iem-detail`
- New modals: DAP add/edit, IEM add/edit, PEQ upload
- Chart.js 4.4.0 added via CDN

2026-03-25 — Session 8: Stability fixes, UI redesign, git setup
- Fixed playlist clearing bug: switched from random `uuid4()` to `MD5(path)` as track ID → playlists survive rescans
- Added atomic playlist save with `.tmp` write + rename to prevent corruption
- Added `playlists.bak.json` backup on every save; auto-recovery if primary file corrupt
- Fixed M4A/non-FLAC files missing from library: `scan_file()` now handles all audio formats via mutagen
- Fixed playlist picker popup appearing off-screen (left edge): repositioning logic now clamps to viewport
- Fixed playlist sort dropdown appearing at bottom of page instead of near sort button
- Redesigned track row num-cell: `[⠿ drag] [□ check]` always visible side-by-side (no more hover-toggle)
  - Playlist rows: grip icon + checkbox; Browse rows: track number + checkbox
  - Both elements always visible at low opacity, brighten on hover; checkbox fills red when selected
  - Grip icon changed to 6-dot grid pattern (more standard drag affordance)
- Library scan status now shows new track count: "Library ready — 4304 tracks · +12 new"
- Added "Force Clean Cache" option (⟳ long-press or dedicated button) — deletes library.json and re-scans from disk
- Set up git repo: `.gitignore`, `README.md`, `install.sh`, `requirements.txt` with version pins
- `install.sh` checks Python 3.8+, creates venv, installs deps, bootstraps data files with defaults

2026-03-24 — Session 7: Modal click-outside protection + import source context
- Removed click-outside-to-close from import, settings, sync, and rename modals — prevents accidental data loss
- Help modal retains click-outside-to-close (read-only, no data at risk)
- Import mapping rows now show Artist › Album breadcrumb below the track title, parsed from M3U path folder structure (e.g. `Music/Artist/Album/track.flac` → `Artist › Album`)
- Track number prefix stripped from display title (e.g. "04. One" → "One")
- Pre-search field now populated with cleaned title + artist for better auto-search results

2026-03-24 — Session 5: Import mapping UI
- Replaced simple "unmatched tracks" list in import modal with an interactive mapping UI
- Each unmatched entry shows a search field pre-filled with the track's title+artist from the M3U file
- Clicking/focusing the search field queries `/api/library/tracks?q=...` and shows a dropdown of up to 6 results
- Selecting a result swaps the search field for a green "mapped" chip showing the matched track
- Chip has a ✕ button to undo a mapping and return to search
- "Import Playlist" button updates to show total track count as user maps entries (e.g. "Import Playlist (12 tracks)")
- Confirm import combines originally matched IDs + user-mapped IDs; uses `force:true` to avoid duplicate check on import
- New functions: `searchForMapping(idx, query)`, `selectMapping(idx, trackId, title, artist)`, `clearMapping(idx)`, `_updateMappingCount()`
- New state: `_importMappings = {}` (idx → {trackId, title, artist}), `_mapSearchTimers = {}` (per-row debounce)
- Clicking outside a mapping results dropdown closes it (document click handler)
- Added CSS for `.map-row`, `.map-row-source`, `.map-row-target`, `.map-input`, `.map-results`, `.map-result-item`, `.map-mapped`, etc.

2026-03-24 — Session 4: Polish + fixes
- Renamed app from "Playlist Creator" to "Music Manager" (HTML title + sidebar header)
- Added "Sync Music" nav item under new "TOOLS" section in left sidebar
- Fixed multi-select "Add to Playlist" bug: missing `e.stopPropagation()` caused the document click listener to immediately close the dropdown after it opened
- Fixed multi-select "Remove" bug: `#bulk-remove-btn` was missing `onclick="App.removeSelectedFromPlaylist()"` — button showed but did nothing

2026-03-24 — Session 3: Music Sync feature
- Added `POST /api/sync/scan`, `GET /api/sync/status`, `POST /api/sync/execute`, `POST /api/sync/reset` routes
- `walk_music_files()` helper skips hidden/macOS junk files, returns relative paths
- Sync modal: device picker → scan → file preview with checkboxes → copy with progress → done summary
- Sync button added to sidebar bottom alongside ⚙ and ↺ buttons

2026-03-24 — Session 2: More UI/UX improvements
- Added "Browse All Songs" button to artist hero → `showArtistTracks(artist)` → tracks view with "Artists › Artist › All Songs" breadcrumb and artist-style hero (label = "ARTIST", shows total song count + duration)
- Added multi-select: click `#` column cell to toggle selection; shift-click for range select; `has-selection` class on tbody shows checkboxes on all rows; `track-selected` class shows red checkmark
- Floating `#bulk-bar` slides up from bottom when ≥1 track selected: shows count, "+ Add to Playlist" (opens picker), "Remove" (playlist view only), "✕ Clear"
- Selection cleared on any view navigation
- New functions: `showArtistTracks`, `toggleTrackSelection`, `updateSelectionUI`, `clearSelection`, `removeSelectedFromPlaylist`, `_getCurrentViewTrackList`

2026-03-24 — Session 1: Initial UI/UX improvements batch
- Fixed sidebar sort / in-playlist filter / sort not working (functions missing from `App` export)
- Added `updated_at` backfill migration in `load_playlists()`
- Fixed `updated_at` missing from import route
- Confirmed: album art fills thumbnails correctly, alpha bar is sticky, playlist mosaic works
- AP80 export fixed: uses `playlist_data/` folder + `../Music/` relative paths
- Removed confusing AP80 "Internal SD card path" setting (no longer needed)
