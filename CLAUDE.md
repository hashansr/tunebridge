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
| `static/player.js` | In-app music player (queue, Web Audio PEQ, shuffle/repeat, localStorage persistence) |
| `data/library.json` | Cached track metadata |
| `data/playlists.json` | Persisted playlists |
| `data/settings.json` | Device mount paths |
| `data/daps.json` | DAP devices (name, model, mount, export config, playlist export timestamps) |
| `data/iems.json` | IEM/headphone library (name, type, squig measurement data, PEQ profiles) |
| `data/baselines.json` | FR tuning targets (name, url, color, 300-point measurement) |
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
- `GET /api/health/status` — detailed system status (library, squig.link, DAPs, data files)
- `POST /api/restart` — restart server via `os.execv` (responds before restarting)
- `GET /api/stream/<track_id>` — stream audio file with HTTP Range support (64KB chunks, required for seeking in FLAC)
- `GET/POST /api/daps` — list / create DAP devices
- `GET/PUT/DELETE /api/daps/<did>` — get / update / delete DAP
- `POST /api/daps/<did>/export/<pid>` — export playlist M3U to DAP, records timestamp in `playlist_exports`
- `GET/POST /api/iems` — list / create IEM (POST fetches squig.link measurement)
- `GET/PUT/DELETE /api/iems/<iid>` — get / update (re-fetches squig if URL changed or missing) / delete
- `GET /api/iems/<iid>/graph` — returns curve data for Chart.js (`?peq=<id>` to overlay PEQ, `?compare=<id>` for multi)
- `POST /api/iems/<iid>/peq` — upload APO/AutoEQ .txt PEQ profile (multipart or JSON)
- `DELETE /api/iems/<iid>/peq/<peq_id>` — delete PEQ profile
- `POST /api/iems/<iid>/peq/<peq_id>/copy` — copy PEQ file to a DAP's PEQ folder
- `GET /api/iems/<iid>/peq/<peq_id>/download` — download raw PEQ .txt file
- `GET/POST /api/baselines` — list / create FR tuning targets (fetches squig.link target data)
- `DELETE /api/baselines/<bid>` — delete a baseline
- `GET /api/daps/<did>/export/<pid>/download` — generate & download M3U using DAP's path config

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
- `_baselines` — cached baseline list (loaded on Settings view open)
- `_selectedBaselineColor` — currently chosen swatch for next baseline add
- `BASELINE_COLORS` — 10-colour design-system palette for baseline swatch picker
- `_DAP_SVG` — inline SVG string used for all DAP card/header icons

Public `App` object exposes all functions called from HTML `onclick` attributes.

## Features Implemented
- [x] DAP management — add/edit/delete DAPs with model presets (Poweramp, Hiby OS, FiiO Player, Other), SVG icon (no emoji), per-playlist sync status tracking (never / stale / up-to-date), one-click export to mounted device
- [x] IEM & Headphone library — add/edit/delete with squig.link measurement import, frequency response graph (Chart.js, log-scale, region bands, 1kHz normalised to 75 dB), PEQ profile upload (APO/AutoEQ .txt), PEQ overlay on graph, PEQ accordion view with filter table + download
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
- [x] Health check panel in Settings (library, squig.link, DAPs, data files)
- [x] Production server: Waitress replaces Flask dev server (debug=False)
- [x] File upload size cap: 10 MB MAX_CONTENT_LENGTH
- [x] SSRF warning for non-squig.link URLs in baseline add form (regex fixed: `[^./]+` subdomain match)
- [x] update.sh: backs up data/, pulls latest git, updates deps, rebuilds Mac app
- [x] FR tuning targets (baselines) — add squig.link targets (Harman, Rtings, etc.), toggle per-curve in legend, user-chosen plot colour via 10-colour swatch picker
- [x] FR graph: baselines hidden by default on load — only factory L/R visible; eye-toggle to show/hide any curve; legend items dim when hidden
- [x] FR graph: fixed Y-axis 50–110 dB, chart height 420px, 1kHz normalisation to 75 dB reference
- [x] FR graph: 7 squig.link-style region bands (Sub bass → Air), log-scale X-axis, blue-tinted grid
- [x] PEQ accordion — view filter table (type/fc/gain/Q) and download PEQ file inline on IEM detail page without navigation
- [x] Dynamic DAP export pills in playlist view — fetches live DAP list, renders download + device-copy button per DAP
- [x] Dynamic Sync modal — DAP list fetched live; uses DAP's mount/music path; no hardcoded device names
- [x] No emoji in UI — DAP cards/headers use SVG portable-player icon; sync modal and export pills use SVG only
- [x] New waveform icons — sidebar logo, favicon (multi-size .ico), Mac app icon (icns via iconutil)
- [x] IEM list sorted alphabetically
- [x] R channel solid line (same as L channel); only baselines use dashed lines
- [x] Native macOS app (`TuneBridge.app`) — C launcher binary (`launcher.c`) compiled via CLT clang, execs into CLT Python → `tunebridge_gui.py` → pywebview WKWebView window. Clean bundle (binary + Info.plist + icon), ad-hoc signed. TCC Documents prompt fires on first launch.
- [x] In-app music player — fixed bottom bar (74px), queue drawer (slide-up), PEQ popover. Web Audio API graph (lazy AudioContext) with BiquadFilterNode chain for real-time PEQ. Shuffle (Fisher-Yates), repeat off/all/one. Keyboard shortcuts: Space = play/pause, Alt+←/→ = prev/next, M = mute. State persisted to localStorage.
- [x] Playback quality display — `#player-quality` in player bar shows `<bit depth> · <sample rate> · <format>` for lossless (e.g. `24-bit · 48 kHz · FLAC`) or `<kbps> · <format>` for lossy. `scan_file()` returns `sample_rate` and `bits_per_sample`; requires library rescan to populate for existing libraries.
- [x] Sync modal Luminous Depth redesign — icon-header, vertical device card list, indeterminate CSS progress animation, gradient progress bar, count pill badges, green done icon
- [x] Delete/confirm modal Luminous Depth redesign — vertical centred layout, large dark circle icon, full-width pink pill delete button, plain text Cancel link
- [x] Play All button — on album/artist hero, playlist header, and album card hover overlay
- [x] Player state persistence — background Python thread in `tunebridge_gui.py` calls `evaluate_js` every 5 s to write `data/player_state.json`; `init()` fetches server state on load. Avoids WKWebView localStorage ephemerality and `os._exit(0)` race.
- [x] Crossfade between tracks — dual `HTMLAudioElement` A/B engine in `player.js`. Configurable duration (0–12 s) via slider in PEQ popover. GainNode fade-out on current + fade-in on next. Persisted to localStorage as `tb_crossfade`.
- [x] Right-click context menu — on track rows, artist cards, album cards. Options: Play Next (inserts after current with shuffle-order patch), Add to Queue, Add to Playlist…. Dismisses on outside click / scroll / Escape.
- [x] `Player.playNext(tracks)` — inserts tracks after current queue position; patches `shuffleOrder` correctly.
- [x] `Player.getTrack(id)` — looks up track from `_registry` or live queue.
- [x] In-app create playlist modal — replaces native `prompt()` (showed Python rocket icon). Music note icon, name input with Enter-key submit, Cancel/Create buttons, dark theme.
- [x] In-app confirm/delete modal — generic `_showConfirm({title, message, okText, danger})` returning `Promise<bool>`. Replaces all `confirm()` calls (deletePlaylist, deleteDap, deleteIem, deletePeq). Trash icon, red Delete button.
- [x] Stale playlist home data fixed — `loadPlaylists()` called after addTracks, uploadArtwork, removeArtwork, removeTrack so track_count and artwork_keys stay fresh in grid.
- [x] Albums view sorted by album title (article-stripped, A–Z) — was sorted by artist name. Backend sort key changed from `artist_sort_key(x['artist'])` to `artist_sort_key(x['name'])`.
- [x] Double-click to play track — `ondblclick="Player.playTrackById(id)"` on all track rows (library, songs, playlist views).
- [x] Marquee scroll for long track/artist names in player bar — `overflow:visible` on `.player-title.marquee`; parent `.player-track-info` clips.
- [x] Player bar artist/album nav links — clicking artist or album name in player bar navigates to that artist/album page.

## Key Files (additional)
| File | Purpose |
|------|---------|
| `tunebridge_gui.py` | pywebview entrypoint: starts Waitress in thread, opens WKWebView window |
| `launcher.c` | Source for the tiny C binary inside TuneBridge.app |
| `create_app.sh` | Builds TuneBridge.app: compiles launcher.c, assembles bundle, signs |

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
- Baselines stored in `data/baselines.json`: `{id, name, url, color, measurement: [[freq,spl],...]}`
- Baseline `id` = MD5(url)[:12]; `color` = user-chosen hex OR deterministic from `_baseline_color(bid)` fallback
- Target files use bare `{file_key}.txt` (no L/R suffix); `fetch_squig_target()` tries bare then falls back to `{file_key} L.txt`
- All FR curves normalised to 75 dB at 1kHz (`NORM_REF_DB = 75.0`); IEM L/R share one offset from L channel; baselines normalised independently
- DAP `icon` field is deprecated — no longer sent or rendered; all DAPs use `_DAP_SVG` inline icon

## Known Issues / Quirks
- Poweramp displays playlist name as filename (e.g. "My Mix.m3u" shows as "My Mix.m3u"). User can long-press → Edit to rename within Poweramp.
- AP80 `playlist_data/` folder must be created by the device first (save a dummy playlist on-device), otherwise manually created folders show 0 songs.
- macOS AirPlay occupies port 5000; app uses port 5001.
- Preview tool sandbox can't access `~/Documents/`; solved with proxy on port 5002.
- squig.link returns 403 without browser headers — `fetch_squig_measurement()` sends `User-Agent` + `Referer` to work around this.
- IEMs created before the header fix will have `measurement_L/R = null`. Editing and saving the IEM (PUT with same squig_url) will auto-refetch since the backend now refetches when measurement is missing.
- `POST /api/restart` (`os.execv`) does NOT work inside TuneBridge.app — the C launcher changes `sys.argv`, so re-exec fails and the server dies without restarting. Any Python code change requires relaunching the .app manually.
- `window.events.closing` in pywebview on macOS runs on the main AppKit thread. Calling `evaluate_js` from within `closing` deadlocks (`performSelectorOnMainThread:waitUntilDone:YES` waits on itself). Fix: use a background daemon thread for periodic `evaluate_js` calls instead.
- Crossfade: `AudioContext` must be created lazily (on first user gesture) to satisfy browser autoplay policy. Crossfade GainNode ramp uses `linearRampToValueAtTime`; both audio elements share the same `AudioContext`.

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

## Future Improvements
- [ ] LAN access with authentication (currently localhost-only for security)
- [ ] Windows installer / run.bat script
- [ ] Automatic library rescan on file system changes (FSEvents/inotify)
- [ ] Multiple library paths support
- [ ] Playlist sharing / export to streaming services

## Out of Scope — Researched & Decided Against

### iPod Classic 5th Gen Sync — OOS (researched 2026-03-26)
Investigated feasibility of syncing music and playlists to an iPod Classic 5th Gen from TuneBridge. **Decision: too large and too complex, will not implement.**

Key findings:
- **Mounting risk**: macOS Sequoia 15.4.1+ broke iPod Classic USB disk mounting at the OS level. No app-level fix possible. Go/no-go depends entirely on whether the device mounts cleanly.
- **No FLAC support**: iPod 5th Gen does not support FLAC. Entire library would need FLAC → ALAC transcoding via `ffmpeg` before each sync. Requires a transcoded file cache (gigabytes), invalidation logic, and re-transcode detection.
- **Binary iTunesDB format**: Custom binary database (`iPod_Control/iTunes/iTunesDB`) with chunk-based tree structure (`mhbd/mhsd/mhlt/mhit/mhod`). Tracks stored with scrambled filenames across 50 subdirs (`F00`–`F49`). Must be read and rewritten on every sync.
- **hash58 auth**: 5th gen uses a device-specific hash derived from FirewireID in `SysInfo` — computable in pure Python, no iTunes pre-authorization needed. Not a blocker.
- **Best available library**: iOpenPod (github.com/TheRealSavi/iOpenPod) — modern Python 3, implements its own iTunesDB parser/writer, handles transcoding. Would be the reference implementation to study.
- **Artwork**: Separate binary ArtworkDB format — very high complexity, would skip in any v1.
- **Rockbox alternative**: Flashing Rockbox firmware adds native FLAC support and simplifies sync to plain file copy, but is a one-time device commitment.
- **Effort estimate**: PoC 2–3 sessions; playlists + delta sync +3–4; transcoding pipeline +2–3; artwork +3–4; Sequoia workarounds unpredictable. Total: 10–15+ sessions for production quality.

## Last Updated
2026-03-28 — Session 20: Playback quality display, Sync modal redesign, Delete modal redesign

- **Playback quality display**: `scan_file()` in `app.py` now returns `sample_rate` (Hz int) and `bits_per_sample` (int) for all formats. `_formatQuality(track)` helper in `player.js` renders `"24-bit · 48 kHz · FLAC"` for lossless, `"320 kbps · MP3"` for lossy. `#player-quality` element in the player bar updated by `_updateTrackUI()`. Audio pipeline confirmed lossless: HTMLAudioElement → GainNodes (1.0) → BiquadFilters → destination; browser AudioContext resamples to device native SR (OS-level constraint, not introduced by the player).
- **Sync modal redesign (Luminous Depth)**: Full redesign of `#sync-modal`. Header now has a rounded icon tile + title/subtitle + SVG close button. Device picker is a vertical flex list of full-width `.sync-device-card` rows (icon tile, name, coloured-dot status) — no borders, tonal background only. Online cards get a subtle accent inset glow. Scanning phase uses a pure-CSS indeterminate sweep animation (`@keyframes sync-indeterminate`) — JS no longer fights the bar width. Progress bar 4px gradient pill (`#adc6ff → #385283`). Preview sections use eyebrow labels + count pill badges + custom scrollbar on file lists. Done phase has a green checkmark icon tile.
- **Delete/confirm modal redesign (Luminous Depth)**: `#confirm-modal` fully redesigned to match design reference. Layout is now vertical and centred: large 76×76px dark circle icon at top → bold title → grey message → full-width pill delete button → plain text Cancel link below. `.btn-danger-pill` uses Luminous Depth secondary pink `rgba(255,179,181,0.85)` with dark text (not harsh red). `.confirm-cancel-link` is bare text, no border. `_showConfirm()` updated to set `btn-danger-pill` class and softer SVG icons using `var(--accent-secondary)`.

2026-03-28 — Session 19: Player persistence, crossfade, context menus, UX polish

- **Player state persistence**: `tunebridge_gui.py` background thread (`_player_state_watcher`) calls `evaluate_js('Player.getStateJSON()')` every 5 s and writes `data/player_state.json` directly (bypasses WKWebView localStorage ephemerality + `os._exit(0)` race). `Player.init()` is async and fetches server state on load; server wins over empty localStorage. `Player.getStateJSON()` exposed on public API.
- **App close hang fixed**: Removed `window.events.closing` handler that called `evaluate_js` — this deadlocked on macOS (closing fires on main AppKit thread; `evaluate_js` dispatches back to same thread via `performSelectorOnMainThread:waitUntilDone:YES`). Background watcher thread is safe because it calls from a non-main thread.
- **Crossfade**: Dual `HTMLAudioElement` (A/B) engine. `_crossfadeActive` flag, `_fadeDuration` (0–12 s, default 3 s). On track end: start next track on idle element, ramp gainA out + gainB in over `_fadeDuration` seconds using `linearRampToValueAtTime`, then swap roles. Slider in PEQ popover. Persisted to `tb_crossfade` in localStorage.
- **Right-click context menu**: `#ctx-menu` overlay, viewport-clamped positioning. `showTrackCtxMenu`, `showArtistCtxMenu` (fetches all artist tracks), `showAlbumCtxMenu` (fetches album tracks). Actions: `ctxPlayNext`, `ctxAddToQueue`, `ctxAddToPlaylist`. `Player.playNext(tracks)` inserts after current queue position and patches `shuffleOrder`. `Player.getTrack(id)` looks up from `_registry`.
- **In-app modals replace all native dialogs**: Create Playlist (was `prompt()`), Delete Playlist/DAP/IEM/PEQ (were `confirm()`). Generic `_showConfirm({title,message,okText,danger})` returns `Promise<bool>`. All dark-themed, no Python rocket icon.
- **Stale playlist home**: `loadPlaylists()` called after every mutation (add tracks, upload/remove artwork, remove track) — keeps `track_count` and `artwork_keys` fresh in grid.
- **Albums sort**: Changed `app.py` sort key from `artist_sort_key(x['artist'])` to `artist_sort_key(x['name'])` — albums now A–Z by title. Requires app relaunch (Python change).
- **Double-click to play**: `ondblclick` on all track rows in library, songs, and playlist views.
- **Player bar nav links**: Clicking artist/album in the player bar navigates to that page.
- **Marquee for long names**: Player bar title/artist uses CSS marquee animation; `overflow:visible` on the animated element, parent clips.

2026-03-27 — Session 18: In-app music player with PEQ integration

- **New `GET /api/stream/<track_id>`**: Streams audio with HTTP Range support. 64KB chunked generator handles partial-content requests (status 206) for correct seeking in large FLAC files. `_AUDIO_MIMES` dict maps extensions → MIME types (flac, mp3, m4a, aac, wav, ogg, opus).
- **`static/player.js`** (~870 lines): Self-contained player module exposed as `window.Player`.
  - `HTMLAudioElement` with `crossOrigin='anonymous'` + lazy `AudioContext` (created on first play gesture to satisfy browser autoplay policy)
  - Web Audio graph: `MediaElementSource → GainNode (preamp) → [BiquadFilterNode...] → GainNode (vol) → destination`
  - PEQ: `_buildPeqChain(profile)` maps APO filter type strings (`PK/LSC/HSC/LPQ/HPQ/NO/AP`) to `BiquadFilterNode.type`; preamp dB → linear gain via `_dBToLinear(db)`
  - Queue: `playTrack()`, `playAll()`, `addToQueue()`, `removeFromQueue()`, `clearQueue()`, `moveQueueItem()`, SortableJS drag/drop in queue drawer
  - Shuffle: Fisher-Yates on `shuffleOrder` index array; current track pinned to position 0 when enabling
  - Repeat: `cycleRepeat()` cycles `'off' → 'all' → 'one'`; repeat-one `::after` badge via CSS class
  - Persistent state via localStorage (`tb_queue`, `tb_queue_idx`, `tb_shuffle`, `tb_repeat`, `tb_volume`, `tb_muted`, `tb_peq_iem`, `tb_peq_profile`)
  - Keyboard: Space = play/pause, Alt+← = prev, Alt+→ = next, M = mute (blocked in inputs)
  - `registerTracks(tracks)` populates `_registry` Map so `playTrackById(id)` can find tracks without them being in the active queue
- **`#player-bar`** (HTML + CSS): Fixed 74px bottom bar using 3-column CSS grid (`260px / 1fr / 260px`) so transport controls are truly centred. Left section: album art (40×40) + title/artist. Centre: prev/play/next + seek bar + timestamps. Right: shuffle, repeat, PEQ toggle, queue toggle, mute, volume slider.
- **Queue drawer** (`#queue-drawer`): Slides up from bottom over player bar. Track list with drag-to-reorder, remove button, active track highlighted.
- **PEQ popover** (`#peq-popover`): IEM dropdown → profile dropdown → applies `_buildPeqChain()`. IEM list fetched live from `/api/iems`. Closes on outside click.
- **Track row play buttons**: Each track row in library/playlist/songs has a `.thumb-play-btn` overlay — clicking it calls `Player.playTrackById(id)`.
- **Play All buttons**: Added to album/artist hero sections, playlist header, and album card hover overlay (`App.playAlbum(artist, album)` fetches tracks then calls `Player.playAll()`).
- **Player init**: `Player.init()` called in `DOMContentLoaded`; `Player.registerTracks(tracks)` called at end of every view-load function.

2026-03-27 — Session 17: UI/UX overhaul, Gear screen redesign, case-insensitive artist grouping

- **System font**: Confirmed `-apple-system, BlinkMacSystemFont` already provides SF Pro on macOS/iOS — no change needed.
- **Case-insensitive artist grouping**: Backend normalises `album_artist` and `artist` fields to lowercase before grouping, eliminating duplicate cards for "Linkin Park" vs "LINKIN PARK".
- **Artists breadcrumb scroll restoration**: Clicking a letter anchor on Artists page → artist drill-down → back to Artists now restores scroll position to the letter. Fixed falsy-zero bug: `if (state._artistsScrollTop)` treated `0` as falsy — changed to `main.scrollTop = state._artistsScrollTop || 0`.
- **Artists sidebar nav always scrolls to top**: Same falsy-zero fix. Sidebar nav item now reliably resets to top of list.
- **DAP Export 500 fix**: Export crashing on read-only filesystem (commit `d123663`).
- **Sync badge rename**: "Stale" → "Outdated" (commit `39929f9`).
- **Major UI/UX overhaul** (commit `60213de`):
  - Sidebar: removed sidebar playlist list; added prominent Sync Music button; active nav state via `NAV_MAP` in `setActiveNav()` for compound views (tracks, dap-detail, iem-detail, playlist); Library status bar pinned to sidebar bottom (`margin-top:auto; flex-shrink:0`).
  - Albums A–Z alpha bar mirrors Artists implementation; shown only on all-albums browse; anchors use `id="albums-alpha-{letter}"`.
  - Spinner loaders (`@keyframes spin`, `.spinner`, `.spinner-wrap`) on Artists, Albums, Songs load.
  - Empty states added to Artists, Albums, Songs, DAPs, IEMs, Playlists views.
  - `view-playlists` grid with mosaic cover art (CSS `display:grid; grid-template-columns: 1fr 1fr`); `/api/playlists` returns `artwork_keys` + `track_count`.
  - Settings button moved to sidebar header icon group.
- **Gear screen redesign** (commits `e3ee64f`, `c32f4fe`, `1a2a2b2`):
  - Removed tab UI entirely; replaced `view-daps` + `view-iems` with single `view-gear` containing two stacked sections.
  - Section headers: "Digital Audio Players" and "IEMs & Headphones", each with `+ Add` button.
  - `loadGearView()` simplified to `Promise.all([loadDapsView(), loadIemsView()])`.
  - `switchGearTab` removed from both function definitions AND `App` exports (missing removal from exports caused `ReferenceError` that silently broke entire app JS).
  - `backToGear()` added for DAP/IEM detail breadcrumb navigation.
- **`showViewEl()` views array**: updated to `['artists', 'albums', 'tracks', 'songs', 'playlist', 'gear', 'dap-detail', 'iem-detail', 'settings', 'playlists']`.
- **Technical debt noted**: Duplicate `loadSettings()` functions in `app.js` (lines ~1229 and ~2561) — second definition wins via JS scoping; should be cleaned up.

2026-03-26 — Session 15: Native macOS app (C launcher)

- **Native macOS app**: `TuneBridge.app` built via `create_app.sh`. Three approaches were tried:
  1. Shell script `.app` → silent failure (macOS TCC blocks `~/Documents` access for shell scripts with EPERM, no prompt shown)
  2. PyInstaller Mach-O → Finder "(null)" error (codesign refuses to sign bundles containing `webview/js/` and `.dist-info` dirs in `Contents/Frameworks/`)
  3. **Tiny C launcher (current)** → works cleanly
- **`launcher.c`**: 27-line C program. Sets `PYTHONPATH` to venv site-packages and `TUNEBRIDGE_PROJECT_DIR` to project root, then `execv()`s into CLT Python with `tunebridge_gui.py`. CLT Python is not in `~/Documents` so no TCC is needed for the `execv()`. When Python opens `tunebridge_gui.py` (in `~/Documents`), TCC fires naturally. User approves once, remembered forever.
- **`create_app.sh` rewritten**: Auto-detects CLT Python version; generates path-correct `launcher.c` on the fly (via Python heredoc to handle spaces); compiles with `clang`; builds minimal `.app` bundle (binary + Info.plist + icon only); ad-hoc signs with `codesign --force --sign -`; clears quarantine. No PyInstaller dependency.
- **`tunebridge_gui.py`**: Starts Waitress/Flask in daemon thread; polls `/api/health` for up to 15s; creates 1280×800 WKWebView window (`pywebview>=6.0`). Window close → `os._exit(0)`. Works both as direct Python script and as frozen/launcher-launched app.

2026-03-26 — Session 14: FR graph defaults, baseline colour picker, IEM sort, bug fixes

- **FR baselines hidden by default on load**: Baseline datasets start with `hidden: true` in Chart.js. Only factory L (blue) / R (red) visible on initial load. Legend items rendered dimmed (swatch line + label at 0.35/0.45 opacity) when hidden. `toggleIemCurve()` now dims/undims the swatch SVG line and label span — not just the eye-toggle button.
- **Baseline colour picker**: 10-swatch design-system colour picker in Settings → Frequency Response Baselines add row. Clicking the circular swatch button opens a floating 5×2 grid. Selected colour POSTed to `/api/baselines` and stored. Backend validates hex colour, falls back to deterministic hash if invalid. After adding, picker auto-advances to next colour. Functions: `_initBaselineColorPicker()`, `selectBaselineColor(color)`, `toggleBaselineColorPicker()`. Palette: amber, blue, pink, green, violet, orange, sky, rose, emerald, teal.
- **IEM list sorted A–Z**: `GET /api/iems` now returns IEMs sorted alphabetically by name (case-insensitive). Applied in `get_iems()` backend route.
- **Fix squig.link root-domain URLs**: URLs without a subdomain (e.g. `https://squig.link/?share=Xenns_Tea_Pro`) now handled correctly. `fetch_squig_measurement()` previously crashed with `KeyError: 'subdomain'` when parsing these URLs. Fixed by defaulting subdomain to empty string and building data URL as `squig.link/data/...` directly.
- **Remove DAP emoji/icon picker**: DAP icon picker dropdown, `DAP_ICONS` array, `_renderIconPicker()`, `_selectIcon()`, `toggleIconDropdown()`, all `.icon-picker`/`.icon-dropdown` CSS, the hidden `dap-icon` input, and click-outside handler removed. All DAPs use `_DAP_SVG` inline SVG icon consistently. `icon` field no longer sent to API.

2026-03-26 — Session 13: FR graph improvements + UI polish

- **FR baselines hidden by default**: Baseline/target datasets start with `hidden: true` in Chart.js. Only factory L (blue) / R (red) channels show on initial load. Legend items render dimmed (swatch line + label at 0.35/0.45 opacity) when hidden. `toggleIemCurve()` now also dims/undims the swatch SVG line and label span — not just the eye-toggle button.
- **Baseline colour picker**: New 10-swatch colour picker in the Settings → Frequency Response Baselines add row. Clicking the circular swatch button opens a floating 5×2 grid using the design-system palette (amber, blue, pink, green, violet, orange, sky, rose, emerald, teal). Selected colour is POSTed to `/api/baselines` and stored. Backend validates hex colour and falls back to deterministic hash if invalid. After adding a baseline the picker auto-advances to the next colour. Functions: `_initBaselineColorPicker()`, `selectBaselineColor(color)`, `toggleBaselineColorPicker()`.
- **Remove DAP emoji entirely**: DAP icon picker dropdown, `DAP_ICONS` array, `_renderIconPicker()`, `_selectIcon()`, `toggleIconDropdown()`, all `.icon-picker` / `.icon-dropdown` CSS, the hidden `dap-icon` input, and the click-outside handler removed (−128 lines). All DAP cards and detail headers now use `_DAP_SVG` — a consistent inline SVG of a portable media player (rectangle + scroll wheel + label bar). The `icon` field is no longer sent to the API.

2026-03-26 — Session 12: Production-readiness + Gear feature expansion
- **Health check panel**: New "System Status" section in Settings view. `GET /api/health/status` returns library path/track count/cache age, squig.link reachability, DAP mount status, and data file R/W access. Frontend `runHealthCheck()` renders a 2×2 grid of status tiles with colour-coded dots (green/yellow/red/grey).
- **Production server**: Replaced `debug=True` Flask dev server with Waitress WSGI server (`waitress>=3.0`). Falls back to `app.run(debug=False)` if waitress not installed. Port configurable via `TUNEBRIDGE_PORT` env var.
- **File upload size cap**: `MAX_CONTENT_LENGTH = 10 MB` added to Flask app config.
- **SSRF warning fix**: Regex corrected from `[^/]+` to `[^./]+` so subdomain check actually works.
- **FR tuning targets (baselines)**: `GET/POST /api/baselines`, `DELETE /api/baselines/<bid>`. `fetch_squig_target()` tries bare `{file_key}.txt` then `{file_key} L.txt`. Stored in `data/baselines.json`. Rendered as reference lines on all IEM graphs. Settings section to manage them.
- **1kHz normalisation**: All FR curves (IEM L/R, PEQ, baselines) shifted so value at 1kHz = 75 dB. Eliminates inter-database dB gaps. `NORM_REF_DB`, `_spl_at_1khz()`, `_shift()` helpers in `app.py`.
- **FR graph fixed Y-axis**: 50–110 dB, chart height 420px.
- **PEQ accordion**: Inline filter table (type/fc/gain/Q) and download button on IEM detail page. `.peq-card`, `.peq-card-header`, `.peq-accordion`, `.peq-chevron`. `togglePeqAccordion(peqId)`, `downloadPeq(peqId, name)`. New route `GET /api/iems/<iid>/peq/<peq_id>/download`.
- **Dynamic DAP export pills**: `renderDapExportPills(pid)` fetches `/api/daps` on each playlist open. New route `GET /api/daps/<did>/export/<pid>/download`. Replaced hardcoded Poweramp/AP80 buttons.
- **Dynamic Sync modal**: `showSync()` fetches live DAP list; `startSyncScan(dapId)` passes `dap_id`; `get_dap_music_path(dap_id)` replaces hardcoded `get_device_music_path()`.
- **No emoji in UI**: Sync modal and export pills use SVG icons only.
- **New waveform icons**: `static/logo.png` (sidebar), `static/favicon.ico` (multi-size ICO via Python struct), `static/favicon_32.png`, `static/favicon_180.png`, `static/TuneBridge.icns` (Mac app via iconutil). Source icons at `/Users/hashan/Documents/Claude/Music Library/icons/`.
- **requirements.txt**: Removed unused `flask-cors`, added `pillow>=10.0` and `waitress>=3.0`.
- **update.sh**: New script — backs up `data/*.json` to timestamped folder, runs `git pull --ff-only`, updates pip deps, optionally rebuilds Mac app wrapper.
- **Settings layout**: Replaced inline `max-width:620px` div with `.settings-content` CSS class (flex column, full width).

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
