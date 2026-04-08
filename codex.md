# TuneBridge Codex Memory

Last updated: 2026-04-03 (Australia/Sydney)
Maintainer: Codex agent
Purpose: Persistent project memory for implementation context, decisions, and progress.

## 1) Product Context
TuneBridge is a local-first music management app for a personal FLAC-centric library. It runs entirely on the user's machine and combines:
- library browsing (artists, albums, songs),
- playlist creation/import/export,
- DAP management and sync,
- IEM/headphone measurement + PEQ tooling,
- in-app audio playback with Web Audio PEQ,
- Insights analytics (tag health, sonic profile, IEM matching).

Historical names: Playlist Creator -> Music Manager -> TuneBridge.

## 2) Current Tech Stack (from code)
- Backend: Python 3.10+, Flask
- Production server: Waitress (fallback: Flask app.run)
- Metadata: Mutagen
- Audio analysis: soundfile + NumPy
- ML helpers: scikit-learn
- Image handling: Pillow
- Frontend: Vanilla JS + HTML + CSS
- UI libs: Chart.js 4.4.0, SortableJS 1.15.2 (CDN)
- Desktop app shell: pywebview (WKWebView)
- Native app launcher: C binary (`launcher.c`)
- Packaging: `build_app.sh` (optional DMG)
- Persistence: JSON files under `data/` (or App Support in bundled mode)

## 3) Runtime + Data Model
### Runtime modes
- Source/dev mode: data lives in repo `data/`
- Bundled mode (`TUNEBRIDGE_BUNDLED=1`): data lives in:
  `~/Library/Application Support/TuneBridge/`

### Key backend files (resolved from `DATA_DIR`)
- `playlists.json`, `playlists.bak.json`
- `library.json` (cache)
- `artwork/`, `playlist_artwork/`
- `settings.json`, `daps.json`, `iems.json`, `baselines.json`
- `player_state.json`
- `features/track_features.json` (analysis cache)
- `match-matrix.json` (IEM matching results)
- `insights_config.json` (Insights preferences)

### Important migration behavior
- `_migrate_legacy_data()`: first bundled run copies legacy JSON/artwork from repo `data/` to App Support.
- `_migrate_features()`: bundled run copies `data/features/track_features.json` into App Support if missing.

## 4) App Architecture Snapshot
### Backend (`app.py`)
Single-file Flask backend with routes for:
- library scan/status/tracks/artists/albums/songs,
- playlists CRUD/import/export/artwork,
- settings/health/restart,
- devices + DAP CRUD/export,
- sync scan/execute/status/reset,
- IEM CRUD/graph/PEQ,
- baseline CRUD,
- audio streaming with HTTP Range,
- backup import/export,
- folder picker bridge,
- Insights (overview, tag health, analysis status/run/cancel, sonic profile, IEM matching APIs).

Notable implementation details:
- Adds no-store headers for `.css`/`.js` responses to avoid WKWebView stale cache.
- 10 MB upload cap (`MAX_CONTENT_LENGTH`).
- Artist sorting ignores leading articles (`The`, `A`, `An`).
- Playlist persistence uses atomic writes and backup file.

### Frontend (`static/index.html`, `static/app.js`, `static/player.js`)
- Single-page UI with view switching and app-wide state object.
- Dynamic rendering for library, playlists, gear, sync, settings, insights.
- Player module (`window.Player`) handles queue/playback/PEQ/crossfade/persistence.

### Desktop wrapper (`tunebridge_gui.py`)
- Starts backend in a background thread.
- Opens pywebview native window.
- Persists player state every 5s via background JS polling.
- Uses `window.events.closed += lambda: os._exit(0)`.

### Native package (`build_app.sh` + `launcher.c`)
- Builds self-contained `.app` with vendored Python packages in `Contents/Resources/Packages`.
- Writes `.python-version` and compiles launcher.
- Optional DMG build with Applications symlink.

## 5) Feature Status (implemented)
- Library browsing: Artists, Albums, Tracks, Songs with search/sort/filter/pagination.
- Playlist system: CRUD, drag reorder, multi-select, duplicate handling, import mapping UI, artwork upload/remove, auto mosaic covers.
- Device export/sync: DAP presets, direct export per DAP, sync scan/preview/copy workflow.
- Gear: DAP + IEM management, squig.link import, FR graphing, PEQ upload/overlay/download/copy.
- Insights:
  - Overview and Tag Health
  - Sonic Profile (histograms/scatter/band profile)
  - Analysis pipeline with incremental re-run, cache versioning, AAC/M4A failure handling
  - IEM Match module (17-dimension scoring + matrix/radar/blindspot/recommendation views)
- In-app player: queue, shuffle/repeat, keyboard shortcuts, crossfade, PEQ, play-next context actions, state persistence.
- Settings/tools: health checks, folder picker, backup/restore, restart endpoint.

## 6) Current Branch + Recent Progress
- Current branch: `feature/library-insights`
- Latest commit: `2ab759b` - Fix cold-start cache + Insights data missing in bundled app
  - touched `app.py`, `build_app.sh`

Recent trajectory from git log:
- Heavy ongoing work in Insights + IEM Fit/Match iterations.
- WKWebView cache busting and static no-store improvements.
- Reliability fixes for bundled app startup/data migration.

## 7) Known Decisions (important and intentional)
1. Local-first architecture: no cloud backend.
2. JSON storage over database for simplicity and portability.
3. Port 5001 default (macOS 5000 conflict risk with AirPlay).
4. Bundled app uses App Support for writable user data.
5. Static JS/CSS forced no-cache to avoid WKWebView stale assets.
6. AP80 export remains `playlist_data` + `..` prefix behavior.
7. Insights analysis cache versioning enforced (`analysis_version == 3`, 12 perceptual bands).
8. M4A/AAC decode failures are recorded as processed failures (not endless pending).
9. In-app player uses dual audio elements for crossfade.
10. Background watcher (not close-event hook) persists player state to avoid macOS deadlock.

## 8) Current Data/Environment Snapshot
- Default configured library path: `/Volumes/Storage/Music/FLAC`
- Settings mounts:
  - Poweramp: `/Volumes/FIIO M21`
  - AP80: `/Volumes/AP80`

Observed working tree at time of writing (not touched by this codex update):
- Modified: `.claude/settings.json`, `.claude/settings.local.json`
- Modified: `data/features/track_features.json`, `data/match-matrix.json`, `data/player_state.json`
- Untracked: `.claude/worktrees/`

## 9) Risks / Quirks to remember
- `POST /api/restart` may not reliably restart from inside packaged app contexts.
- WKWebView behavior differs from browser for cache and media constraints.
- squig.link fetches need browser-like headers for reliability.
- AP80 playlist folder behavior is firmware-sensitive.
- Source and bundled modes use different effective data roots.

## 10) How to use this file going forward
- This is the first-stop context file before making changes.
- When implementing new work, update this file with:
  - what changed,
  - why it changed,
  - files/routes affected,
  - decision/tradeoff notes,
  - date stamp.
- Keep entries factual and implementation-level (avoid vague summaries).

## 11) Update Log (Codex)
### 2026-04-02 (Bundled app startup/restart fix)
- Investigated issue: bundled app could show legacy UI on launch and Restart & Reload could open another instance.
- Root causes identified:
  - GUI startup accepted any `/api/health` on port 5001, so a stale older TuneBridge server could be reused.
  - `/api/restart` spawned a second process (`subprocess.Popen`) before killing the original.
- Fixes implemented:
  - `app.py`:
    - `GET /api/health` now returns `{status, instance_token, pid}`.
    - `POST /api/restart` now performs in-place `os.execv(...)` restart (single-instance re-exec) instead of spawning a new process.
  - `tunebridge_gui.py`:
    - Generates per-process `TUNEBRIDGE_INSTANCE_TOKEN`.
    - `_wait_for_server()` now verifies the health response token matches this process.
    - Detects foreign instance on port and shows explicit startup error instead of silently attaching.
- Validation:
  - Syntax check passed with `PYTHONPYCACHEPREFIX=/tmp python3 -m py_compile app.py tunebridge_gui.py`.

### 2026-04-02 (Additional WKWebView cache hardening)
- Addressed persistent stale-UI symptoms on cold launch with two extra safeguards:
  - `app.py` `@after_request` now applies no-store headers to HTML as well (`.html` and `/` path), not just JS/CSS.
  - `tunebridge_gui.py` now opens the window URL as `http://localhost:<port>/?v=<timestamp>` so each app launch fetches a fresh document shell.
- Rationale:
  - Even with JS/CSS no-store, WKWebView can reuse a cached HTML shell in edge cases.
  - Per-launch URL busting ensures the first paint reflects the latest bundled UI.

### 2026-04-02 (Insights deep dive)
- Traced full Insights implementation across backend and frontend:
  - Backend: `app.py` (`/api/insights/*` routes, analysis pipeline, matching model)
  - Frontend: `static/index.html` (Insights view structure), `static/app.js` (rendering + polling + interaction)
  - Data artifacts: `data/features/track_features.json`, `data/match-matrix.json`, `data/insights_config.json`

- Insights architecture is split into 3 phases:
  1. Overview + Tag Health (works without audio analysis)
  2. Sonic Profile (requires analysis features cache)
  3. IEM Match / Headphone Fit (requires analysis cache + IEM FR data)

- Backend endpoints and behavior:
  - `GET /api/insights/overview`:
    - Aggregates total tracks/albums/artists
    - Computes format/sample rate/bit depth distributions
    - Returns top 20 genres and `genres_tagged`
  - `GET /api/insights/tag-health`:
    - Completeness for title/artist/album/year/genre
    - Detects artist naming variants (case/spacing inconsistencies)
    - Returns capped list of problematic tracks
  - `POST /api/insights/analyse`:
    - Starts daemon thread (`_run_analysis`) unless already running
  - `_run_analysis`:
    - Incremental cache reuse from `features/track_features.json`
    - Valid cache requires:
      - `analysis_version == 3`
      - 12-length `band_energy`
      - non-null brightness
    - Per track:
      - Reads audio with `soundfile`
      - Uses 7 FFT windows (65536 samples) over 10%-90% track span
      - Drops near-silent windows (`RMS_FLOOR=0.01`)
      - Computes:
        - spectral centroid (`brightness`)
        - RMS (`energy`)
        - 12 perceptual band energy ratios
      - Flushes to disk every 200 tracks
      - Records failed tracks as `{failed:true, reason:'unsupported_format'|'read_error'}`
    - Supports cancellation by status flip
  - `GET /api/insights/analyse/info`:
    - Distinguishes `processed`, `analysed(valid)`, `pending`
    - Status: `not_run | needs_upgrade | up_to_date | pending`
  - `GET /api/insights/sonic-profile`:
    - Builds brightness/energy histograms and summary stats
    - Returns sampled scatter points (max 600)
    - Returns normalized 12-band library profile (0-1)
  - `POST /api/insights/matching/analyse`:
    - Requires valid v3 12-band features
    - Optional scoring target via baseline id (fallback `flat`)
    - Loads IEMs, scores each on:
      - 12 perceptual bands
      - 5 derived dimensions (`sound_stage`, `timbre_color`, `masking`, `layering`, `tonality`)
    - Scores PEQ variants by applying biquad filter transfer math to FR curve
    - Builds genre fingerprints (per-band min-max normalized across genres)
    - Builds match matrix (0-100) and summary/blindspot sets
    - Persists result to `match-matrix.json`
  - Matching read endpoints:
    - `/overview`, `/matrix`, `/recommend`, `/blindspots`, `/iem/<id>/radar`, `/genre/<genre>/fingerprint`, `/targets`
  - Heatmap user config endpoints:
    - `GET/POST /api/insights/matching/heatmap-genres` persisted in `insights_config.json`

- Core model constants/decisions:
  - 12 overlapping perceptual bands (`_PERC_BANDS`)
  - 1kHz normalization reference for FR processing (`75 dB`)
  - Band score function in `_score_iem_17d`:
    - `10 * exp(-0.08 * abs(deviation_dB))`
  - Match score formula:
    - weighted mean of IEM 12-band scores by genre fingerprint energy
    - scaled to 0-100

- Frontend behavior (`loadInsightsView` flow):
  - Enters `insights` view and resumes analysis polling if running
  - Loads and renders:
    - overview + tag health
    - sonic profile (if available)
    - IEM match overview (or CTA if missing)
  - Includes:
    - analysis banner with progress and cancel
    - rescan tags flow (reuses `/api/library/scan` + `/api/library/status`)
    - section help popovers
    - per-IEM accordion for:
      - genre score bars
      - blindspot bars
      - FR chart + optional genre salience overlay + PEQ switching
  - PEQ dropdown freshness strategy:
    - fetch radar endpoint for scores
    - fetch live IEM endpoint for up-to-date PEQ list
    - merge by `peq_id`

- Persisted data schemas observed:
  - `track_features.json` item:
    - `{track_id, brightness, energy, band_energy[12], analysis_version, cluster}`
    - or failed variant `{track_id, failed, reason, ...}`
  - `match-matrix.json` top-level:
    - `{generated_at, target_id, genre_fps, iem_profiles, matrix_data}`
  - `insights_config.json`:
    - currently `{heatmap_extra_genres:[...]}`

- Noted implementation quirks:
  - Insights section title in HTML says "IEM / Headphone Fit" while code comments still reference old "IEM Match/Gear Fit" naming.
  - Analysis status message still says "Library Fit" in one UI string (legacy wording).

### 2026-04-02
- Created `codex.md` from repository scan of:
  - `README.md`
  - `CLAUDE.md`
  - `app.py`
  - `static/index.html`
  - `static/app.js`
  - `static/player.js`
  - `tunebridge_gui.py`
  - `build_app.sh`
  - `requirements.txt`
  - git history (`git log` / latest commit)

### 2026-04-02 (Insights UX optimization + incremental persistence hardening)
- Scope: implement user-requested Insights UX refinements and ensure analysis data persists safely without full-library recompute on every refresh/reopen.

- UX changes:
  - Removed persistent right-hand Insights rail (duplicated data/actions) from `static/index.html`.
  - Simplified Insights shell to single-column content flow in `static/style.css`.
  - Genre Distribution switched from chart-style panel to ranked compact bars in `static/app.js`:
    - renders Top N genre rows with rank, bar, and count.
    - avoids out-of-place chart visual while preserving exact underlying data.
  - Tag Health compacted to pill cards in `static/app.js` + `static/style.css`:
    - 3-up compact cards for metadata fields (label, percent, micro-progress, counts).
    - moved duplicate-artist warning into compact meta row.
    - keeps “problem tracks” action, but reduces vertical footprint.

- Analysis persistence and delta behavior:
  - `app.py` now stores source signature per analysis row:
    - `source_path`, `source_mtime` (from scanned track `date_added` mtime), `analysed_at`.
  - Added cache validation helper `_is_cached_feature_current(...)`:
    - current only if `analysis_version == 3`, source path/mtime unchanged, and feature payload valid (or failed marker).
  - `_run_analysis()` now analyzes only pending delta tracks:
    - builds `pending_tracks` from cache validity checks.
    - reuses current entries untouched.
    - writes output only for tracks still present in library (stale removed tracks pruned on write).
    - cancellation preserves partial progress and existing results.
  - `POST /api/insights/analyse`:
    - returns `{already_up_to_date: true}` if no pending delta.
    - otherwise returns pending count and starts worker.
  - `GET /api/insights/analyse/info` now reports status against current file signatures (not just track id presence).

- Backup/restore coverage extended:
  - `GET /api/backup/export` now includes:
    - `features/track_features.json`
    - `match-matrix.json`
    - `insights_config.json`
  - `POST /api/backup/import` restores these artifacts (supports both `features/track_features.json` and legacy `track_features.json` in ZIP root).

- Validation:
  - Python syntax check passed:
    - `PYTHONPYCACHEPREFIX=/tmp python3 -m py_compile app.py`

### 2026-04-02 (Manual Verification Pass - Insights UX + persistence)
- Verification objective:
  - Confirm the new Insights UX structure is active (no legacy right rail).
  - Confirm Insights APIs still return valid data after UI refactor.
  - Confirm restart behavior remains single-instance from backend perspective.
  - Confirm backup export includes Insights persistence artifacts.
  - Confirm analysis state behavior for delta strategy migration path.

- Environment used:
  - Local workspace run via `venv/bin/python app.py`
  - Test port: `5051`
  - Verification executed via live HTTP calls against local Flask/Waitress server.

- Checks performed and outcomes:
  1. Insights UI structure checks (code + render contract)
     - Confirmed right-rail markup removed from `static/index.html` Insights view.
     - Confirmed right-rail CSS selectors removed from `static/style.css`.
     - Confirmed no runtime JS writes remain to `insights-rail-*` IDs.
     - Result: PASS.

  2. Live health + Insights payload checks
     - `GET /api/health` returned `{status: "ok"}`.
     - `GET /api/insights/overview` returned non-empty aggregates:
       - `total_tracks: 4304`, `total_artists: 394`, `total_albums: 1096`, `genres: 20`.
     - `GET /api/insights/tag-health` returned expected structure:
       - `total: 4304`, `problem_track_count: 7`, completeness fields present.
     - Result: PASS.

  3. Restart behavior check
     - Called `POST /api/restart`.
     - Server became reachable again on same port.
     - `pid` stayed the same before/after (expected with `os.execv` in-place re-exec).
     - `lsof` showed a single listener process on port `5051`.
     - Result: PASS (single-instance backend behavior confirmed).

  4. Backup export coverage check
     - Called `GET /api/backup/export`, inspected ZIP contents.
     - Confirmed presence of:
       - `features/track_features.json`
       - `match-matrix.json`
       - `insights_config.json`
       - plus core app data JSON files.
     - Result: PASS.

  5. Analysis info/start behavior check
     - `GET /api/insights/analyse/info` returned:
       - `status: "not_run"`, `pending: 4304`, `needs_upgrade: true`.
     - `POST /api/insights/analyse` returned start payload with full pending count.
     - Interpretation:
       - existing feature cache rows in current local data predate new source-signature fields (`source_path`/`source_mtime`), so the new validator intentionally flags them for one-time upgrade.
       - after one full analysis run under the new schema, future runs should be delta-only.
     - Result: PASS (migration behavior as designed).

- Important operational note for other agents:
  - If a user already has older `track_features.json` rows (without source signature fields), they will see one full re-analysis requirement once after upgrading.
  - This is expected, not regression.
  - Post-upgrade steady state: only changed/added/removed tracks should require work.

- Remaining verification gap:
  - Full GUI-level pixel verification (desktop window screenshot interaction) was not automated in this CLI run.
  - API/data-path validation and static UI structure validation were completed.

### 2026-04-02 (Insights UX compactness pass: tag/genre side-by-side + tighter overview)
- User request:
  1. Place Tag Health and Genre Distribution side by side to reduce vertical scrolling.
  2. Show top 10 genres inline and allow drill-down via popup.
  3. Tighten spacing around File Format/Sample Rate/Bit Depth cards to reduce negative/unused space.

- Structural UI changes (`static/index.html`):
  - Wrapped Tag Health + Genre sections in new shared row container:
    - `.insights-split-row`
  - Added new Insights section:
    - `#insights-genre-section` with content mount `#insights-genre-content`
  - Added dedicated genre drill-down modal:
    - `#genre-distribution-modal`
    - body: `#genre-distribution-modal-body`

- Rendering behavior changes (`static/app.js`):
  - `loadInsightsView()` now:
    - parses overview payload once,
    - renders both `_renderInsightsOverview(overviewData)` and `_renderInsightsGenreDistribution(overviewData)`.
  - Added `_renderInsightsGenreDistribution(d)`:
    - computes sorted genre distribution from overview payload,
    - renders top 10 genres inline,
    - shows metadata badge (`% tagged`) where available,
    - adds CTA button to open full drill-down.
  - Added drill-down modal handlers:
    - `openGenreDistributionModal()`
    - `closeGenreDistributionModal()`
  - Added `_allInsightGenres` in-memory cache for modal rendering.
  - Exported the new handlers on `window.App` for HTML button bindings.
  - Rescan path update:
    - after `/api/library/status` completes, overview reload now re-renders both overview and genre section.

- Overview compactness changes (`static/app.js` + `static/style.css`):
  - Removed inline genre card from `_renderInsightsOverview()` to avoid duplicate content and save vertical space.
  - Reworked overview chart row to 3 sibling cards in one row:
    - File Format
    - Sample Rate
    - Bit Depth
  - Removed previous stacked right-column wrapper in markup path (`.ov-bars-col` no longer used).

- Style updates (`static/style.css`):
  - Added `.insights-split-row` responsive grid for Tag Health + Genre.
  - Tightened Overview card internals:
    - smaller donut footprint and legend spacing,
    - denser Sample Rate/Bit Depth bars,
    - reduced title/content spacing in bar cards.
  - Added genre section helper styles:
    - `.ov-genre-header-row`
    - `.ov-genre-list--compact`
    - `.ov-genre-actions`
  - Added genre modal row styles:
    - `.genre-modal-*`
  - Responsive behavior:
    - desktop: split row side-by-side, overview 3-card row,
    - medium: split row collapses to single column; format card spans two columns in overview row,
    - small: overview collapses to single column.

- Design/behavior decisions:
  - Kept all data semantics unchanged (UI-only facelift).
  - Genre source of truth remains `/api/insights/overview` `genres` payload; no backend route changes.
  - Inline cap fixed at top 10 for quick scan performance/readability; full list preserved in modal.

- Validation:
  - JS parse check passed:
    - `node --check static/app.js`
  - Python syntax check still passes:
    - `PYTHONPYCACHEPREFIX=/tmp python3 -m py_compile app.py`

### 2026-04-02 (Insights hero balancing + genre inline compaction)
- User request:
  1. Add Genres count to top Insights hero stats for visual balance.
  2. Reduce inline Genre Distribution height by showing top 5 instead of top 10 (retain drill-down for full list).

- Backend update (`app.py`):
  - Enhanced `GET /api/insights/overview` payload with:
    - `genres_all`: full sorted genre frequency map (no top-20 truncation),
    - `genres_total`: total distinct genre count.
  - Existing `genres` (top 20) remains for backward compatibility.

- Frontend updates (`static/app.js`):
  - Added new hero stat card:
    - label: `Genres`
    - badge: `Tagged categories`
    - value uses `genres_total` (fallback to key count in `genres` for older payloads).
  - Added icon for genre stat card to match existing hero card language.
  - Updated Genre Distribution source:
    - now reads `genres_all` when available (fallback `genres`),
    - inline list now `slice(0, 5)`.
  - Updated help copy:
    - “top 10” -> “top 5”.

- Styling update (`static/style.css`):
  - Hero stat grid balanced to 4 equal columns:
    - `.ov-stat-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }`
  - Existing responsive breakpoints remain in place (`2 cols` at medium widths).

- Outcome:
  - Top hero area now visually balanced across four metrics:
    - Total Tracks, Albums, Artists, Genres.
  - Genre section consumes less vertical space while preserving full discoverability via modal drill-down.

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-04 (Modal scroll support for long forms)
- Fixed long modal usability issue where lower fields/actions were unreachable on smaller windows.
- Implemented shared modal scrolling behavior:
  - `.modal-overlay` now supports vertical scrolling with responsive padding.
  - `.modal` now has a viewport-aware `max-height` and internal `overflow-y: auto`.
  - Added `overscroll-behavior: contain` for smoother in-modal scrolling.
- Result:
  - Longer forms like `Add DAP` can now be scrolled end-to-end without clipping.

- Files updated:
  - `static/style.css`

### 2026-04-04 (Add DAP modal clarity pass)
- Updated `Folder structure` labels to user-friendly path examples:
  - `Artist/Album/song-file.flac (Recommended)`
  - `Artist/song-file.flac`
  - `Artist/Year/song-file.flac`
  - `Genre/song-file.flac`
- Improved token selection visibility by switching active token chips to the app’s success-green treatment.
- Updated template preview format to a single line:
  - `📁 Preview: <path>`
  - Includes selected `Music folder on DAP` prefix.
- Refined preview typography for readability with a monospace path style aligned to existing design language.

- Files updated:
  - `static/index.html`
  - `static/style.css`
  - `static/app.js`

### 2026-04-04 (Add DAP modal help + simplification pass)
- Removed `Storage location` selector from Add/Edit DAP modal to reduce complexity.
  - Frontend no longer sends `storage_type` in DAP save payload.
  - Existing DAP storage values are preserved on edit; new DAPs continue to default server-side.
- Moved visible helper copy into `?` toggles for better density and consistency:
  - `Mount path`
  - `Music folder on DAP`
  - `Playlist export folder`
  - `Path prefix`
  - Existing `Path template` help remains under `?`.
- Fixed help-text alignment by rendering helper notes inside each field’s right-hand input column (no floating offset/margin hacks).
- Added centralized DAP help utilities:
  - `toggleDapHelp(id)`
  - `_closeDapHelpPanels()` (called on open/close modal).
- Improved export-folder help text generation:
  - Includes a stable base explanation plus model-specific preset note when available.

- Files updated:
  - `static/index.html`
  - `static/app.js`
  - `static/style.css`

### 2026-04-04 (Add DAP modal UX overhaul from `dap_form_ux_improvements_change.md`)
- Reworked Add/Edit DAP modal into guided sections:
  - `Device Setup`
  - `Music Library`
  - `Playlists`
- Updated microcopy to reduce technical jargon:
  - `Add DAP` -> `Add Device`
  - `Name` -> `Device name`
  - `Model preset` -> `Device type`
  - `Mount path` -> `Device location`
  - `Music folder on DAP` -> `Music folder (on device)`
  - `Folder structure` -> `Organisation`
  - `Path template` -> `File naming format`
  - `Playlist export folder` -> `Playlist folder (on device)`
  - Save CTA -> `Save Device`
- Implemented device picker flow for location:
  - New backend endpoint `GET /api/system/mounts` discovers mounted external volumes.
  - Frontend dropdown lists detected devices (`<name> (External Drive)`).
  - Added `Refresh` action.
  - Added `Advanced: enter path manually` toggle (reveals manual path + Browse).
- Added inline validation + smarter save behavior:
  - Save disabled until required fields are valid (device name + valid location + template).
  - Inline location error shown for missing/disconnected selections.
- Enhanced preview readability:
  - `📁 Preview file path:`
  - Breadcrumb style (`Music › Artist › Album › file.flac`) instead of raw slash path.
- Moved path prefix under `Advanced settings` in Playlists section (`Path prefix (advanced)`).

- Files updated:
  - `static/index.html`
  - `static/style.css`
  - `static/app.js`
  - `app.py`

### 2026-04-04 (Add DAP visual facelift alignment with `DESIGN.md`)
- Applied a scoped visual polish to Add DAP modal only (`.dap-modal-shell`) to align with Luminous Depth principles without impacting other modals.
- Updated section containers to rely on tonal grouping and negative space instead of line dividers.
- Refined field styling to a no-line input treatment with bottom-only focus glow.
- Strengthened glass treatment for modal shell and softened helper/preview surfaces for better depth consistency.
- Kept changes functionally neutral (UI/UX presentation only; no behavioral regressions introduced by this pass).

- Files updated:
  - `static/index.html`
  - `static/style.css`

### 2026-04-04 (Add DAP accessibility contrast pass)
- Added scoped contrast/readability refinements for Add DAP modal while preserving the same aesthetic:
  - Stronger label color and section-title contrast
  - Higher-contrast input text and placeholders
  - Stronger focus indicator (bottom glow + subtle outer ring)
  - Improved browse-button contrast/hover visibility
  - Improved preview label/path contrast
  - Strengthened help/validation text contrast
  - Higher-visibility `?` help icon styling

- Files updated:
  - `static/style.css`

### 2026-04-04 (DAP sync status: music delta + storage checks)
- Extended sync scan to compute and expose per-DAP music delta summary:
  - `music_to_add_count`
  - `music_to_remove_count`
  - `music_out_of_sync_count`
- Added storage calculations during scan:
  - `space_available_bytes`
  - `space_total_bytes`
  - `space_required_bytes` (for files to add)
  - `space_shortfall_bytes`
  - `space_ok`
- Persisted per-DAP sync summary in `daps.json` under `sync_summary` so counts survive UI refreshes.
- Added migration/normalization for `sync_summary` in DAP load path.
- Added execute-time storage guard:
  - Re-check available space right before copying.
  - Return a blocking error if selected add payload exceeds current free space.
- UI updates:
  - DAP cards now show always-visible counts:
    - `Playlists X out of sync`
    - `Music Y out of sync (A add • R remove)`
  - DAP detail now shows:
    - playlists/music out-of-sync counts
    - device space + required add payload + shortfall badge
  - Sync preview panel now includes dynamic space summary with state colors:
    - OK / Warn / Danger
  - Start Sync button is disabled when selected add payload exceeds available space.

- Files updated:
  - `app.py`
  - `static/app.js`
  - `static/index.html`
  - `static/style.css`
  - `PYTHONPYCACHEPREFIX=/tmp python3 -m py_compile app.py` passed.

### 2026-04-02 (Sonic Profile UX reframing toward end-user compatibility meaning)
- User request:
  - Rework Sonic Profile visualization language so the section is more meaningful to end users (library understanding + IEM/headphone compatibility context), without changing core functionality.

- Scope + constraints:
  - UI/copy interpretation layer only.
  - No backend analysis math changed.
  - Existing sonic charts/data sources preserved (`brightness`, `energy`, `band_profile`).

- Changes in `static/app.js`:
  1. Help content rewrite for `sonic` section (`_INSIGHTS_HELP.sonic`):
     - shifted from DSP-heavy wording to compatibility-oriented interpretation:
       - “library tonal demand”
       - “brightness distribution”
       - “mastering density”
     - clarified that tonal demand is the same signal used by matching logic.

  2. `_renderInsightsSonicProfile(d)` reframed:
     - Added `sonic-insight-grid` summary cards above charts:
       - `Tonal Tilt`
       - `Brightness Read`
       - `Dynamics Read`
     - Derived lightweight interpretation cues from existing payload:
       - aggregate bass/mid/treble demand from `band_profile`
       - brightness read from centroid median
       - dynamics read from RMS IQR spread
     - Added top-demand-bands text (from `band_profile` + `band_labels`).

  3. Chart title updates (same charts, new language):
     - `Spectral Brightness` -> `Brightness Distribution (Tonal Tilt)`
     - `RMS Energy` -> `RMS Energy Distribution (Mastering Density)`
     - Band chart title/subtitle now explicitly call it a compatibility signal.

  4. Caveat block update:
     - replaced generic technical paragraph with dynamic `Compatibility cues` sentence list generated from existing metrics.
     - retained FLAC-only limitation note.

- Changes in `static/style.css`:
  - Added new styles for summary interpretation cards:
    - `.sonic-insight-grid`, `.sonic-insight-card`, `.sonic-insight-kicker`, `.sonic-insight-title`, `.sonic-insight-meta`
  - Added mobile behavior:
    - summary cards collapse to one column under small width.

- Why this improves end-user meaning:
  - keeps analytical depth while adding immediate “what this means for gear” interpretation before raw charts.
  - better continuity between Sonic Profile and Gear Compatibility analysis.
  - reduces cognitive load by translating technical metrics into practical reading cues.

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-02 (Data-driven DAP profiles + gear add flow de-hardcoding)
- User request:
  1. Pre-populate Add DAP modal using attached DAP export matrix.
  2. Ensure DAPs/IEMs are not hardcoded in add-gear flows.

- Source data integrated:
  - Added `data/gear_profiles.json` with:
    - `dap_profiles` derived from provided matrix (`dap_playlist_export_matrix.json`)
    - `iem_types` list for IEM add/edit type selector.

- Backend changes (`app.py`):
  - Added gear profile registry support:
    - `GEAR_PROFILES_FILE` in user data dir (`DATA_DIR/gear_profiles.json`) for override capability.
    - Loader + normalizer functions:
      - `_normalize_gear_profiles(...)`
      - `_normalize_export_folder(...)`
      - `_slugify_model_id(...)`
      - `load_gear_profiles()`
  - Added API endpoint:
    - `GET /api/gear/profiles` -> returns normalized `{dap_profiles, iem_types}`.
  - DAP creation defaults now data-driven:
    - `POST /api/daps` maps `model` to profile defaults for `export_folder` + `path_prefix`.
    - removed hardcoded `model_defaults` mapping.
  - DAP update sanitization:
    - normalizes `export_folder` on `PUT /api/daps/<id>`.
  - Removed AP80-specific hardcoded export branch:
    - export routes now rely on persisted `path_prefix` only (profile-provided), not `model == 'ap80'`.

- Frontend changes (`static/app.js` + `static/index.html`):
  - Removed hardcoded DAP model preset constants and hardcoded modal options.
  - Added profile bootstrap:
    - `loadGearProfiles()` fetches `/api/gear/profiles`.
    - populates DAP model dropdown and IEM type dropdown dynamically.
  - Add/Edit DAP modal now profile-driven:
    - default selected model = first profile from API.
    - mount/export folder/prefix/hint auto-filled from profile.
    - handles unknown legacy model ids by appending a temporary option in edit mode.
  - IEM add/edit modal type selector now profile-driven:
    - options sourced from `iem_types` in gear profile payload.
  - Init flow updated:
    - `DOMContentLoaded` now calls `await loadGearProfiles()` before normal view interaction.
  - HTML select updates:
    - DAP model select starts with loading placeholder (replaced at runtime).
    - IEM type select is runtime-populated.

- Behavior outcomes:
  - Add DAP modal is now pre-populated from attached matrix data (folder/path behavior by profile).
  - Gear add flow is data-driven for DAP model presets and IEM type list.
  - New profiles can be introduced by editing `gear_profiles.json` (bundle or user-data override) without code changes.

- Validation:
  - `node --check static/app.js` passed.
  - `PYTHONPYCACHEPREFIX=/tmp python3 -m py_compile app.py` passed.

### 2026-04-02 (Gear compare modal FR UI cleanup + chart consistency)
- User request:
  - Clean up `Gear > IEM/Headphones` comparison popup and make chart styling consistent with other FR charts.

- Changes in `static/index.html`:
  - Updated modal header copy:
    - title: `Frequency Response Comparison`
    - added subtitle explaining same reference scale consistency.

- Changes in `static/app.js` (`_buildIemCompareChart`):
  - Improved curve readability:
    - primary curves slightly thicker (`2.1`) and baselines at `1.5`.
  - Aligned chart typography/visuals with compact FR chart style:
    - Inter font for axis labels/ticks
    - tooltip colors aligned to Gear FR chart conventions (`rgba(30,30,42,0.95)` + accent title).
  - Legend behavior improvements:
    - legend chips now initialize in off-state when datasets are hidden by default.
    - toggle action now uses class-based state (`compare-legend-item--off`) instead of inline opacity.
    - long legend names truncated via dedicated label class.

- Changes in `static/style.css`:
  - Modal container redesigned for better readability:
    - wider dialog (`min(1040px, 96vw)`)
    - refined dark gradient panel and border for visual consistency.
  - Added subtitle styling (`.iem-compare-subtitle`).
  - Legend chips restyled:
    - pill chips with borders/background
    - explicit disabled/off visual state
    - scrollable legend area for many curves.
  - Chart area enlarged:
    - desktop height `540px`
    - responsive fallback `420px` on smaller screens.

- Outcome:
  - Comparison chart is easier to read with more vertical space and clearer legends.
  - Visual language now matches other FR chart modules in Gear and Insights.
  - No change to comparison data or matching functionality (UI-only cleanup).

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-02 (FR compare modal proportion tweak)
- User feedback:
  - Compare popup FR chart still looked horizontally stretched.

- Change:
  - Increased compare chart area height in `static/style.css`:
    - desktop: `540px` -> `640px`
    - <=900px breakpoint: `420px` -> `500px`

- Outcome:
  - Better aspect ratio for FR overlays in the compare modal and easier visual separation between curve shapes.

### 2026-04-02 (FR compare modal proportion tweak v2 from screenshot feedback)
- User feedback:
  - Chart area still appeared horizontally stretched after first height increase.

- Additional UI adjustment:
  - `static/style.css`
    - `.iem-compare-dialog` max-height increased: `90vh` -> `94vh`
    - `.iem-compare-chart-wrap` height increased: `640px` -> `760px`
    - mobile breakpoint (`<=900px`) chart height: `500px` -> `580px`

- Expected effect:
  - More vertical plotting area for FR curves in the comparison modal.
  - Reduced perceived horizontal stretch and improved shape readability.

### 2026-04-02 (Help section copy + header help icon polish)
- User request:
  - Update Help section text and improve the header Help icon visual.

- Changes in `static/index.html`:
  - Header help button:
    - tooltip text updated from `Help` -> `Help Center`.
    - added `aria-label="Open Help Center"` for clearer accessibility semantics.
    - replaced previous question-mark glyph with a cleaner lifebuoy-style support icon (`.help-btn-icon`) to better match surrounding icon language.
  - Help modal header:
    - title updated from `Help & Guide` -> `Help Center`.
    - added intro copy: “Need quick steps for playlist export, import, and DAP sync? Start here.”
  - Minor cleanup:
    - removed duplicate `style` attribute on help modal close button.

- Changes in `static/style.css`:
  - Refined `#help-btn` appearance:
    - size increased to `26x26` for better balance with adjacent settings icon.
    - subtle border + low-opacity background added for stronger affordance.
    - hover state now updates border tint for clearer interaction feedback.
  - Added `.help-intro` style for modal subheading.
  - Added `.help-btn-icon` display rule for consistent SVG rendering.

- Scope note:
  - UI-only polish (no behavior or functionality changes).

### 2026-04-02 (Help icon rollback + dynamic Help Center content)
- User request:
  - Keep Help icon as `?` (previous support icon felt unclear).
  - Replace AP80/M21-specific Help copy with dynamic, device-agnostic guidance.

- Changes in `static/index.html`:
  - Header help button icon changed back to explicit `?` glyph (`.help-btn-glyph`).
  - Help Center content rewritten to generic sections:
    - `Quick Start`
    - `Configured Devices`
    - `Path Rules`
    - `Importing existing playlists`
    - `Storage & Library`
  - Added dynamic mount points in Help modal:
    - `#help-device-list`
    - `#help-library-root`
    - `#help-data-dir`

- Changes in `static/app.js`:
  - Added `renderHelpCenter()`:
    - fetches `/api/settings` and `/api/daps`.
    - injects current `library_path` and `_data_dir` into Help modal.
    - renders a per-device guidance card with:
      - device name
      - connected state
      - mount path
      - export folder
      - path prefix
    - renders fallback message when no DAPs are configured.
  - `showHelp()` now opens modal and triggers dynamic render.

- Changes in `static/style.css`:
  - Added styling for `?` glyph icon treatment on header help button.
  - Added Help device card/grid styles for dynamic device guidance.

- Outcome:
  - Help content is no longer hardcoded around AP80/M21.
  - Help guidance now reflects the user’s actual configured device profiles and storage setup.

### 2026-04-03 (Insights IEM accordion layout: Genre + Blindspot side-by-side)
- User request:
  - In Insights > IEM accordion, render `Genre Scores` and `Blind Spot Detector` side by side.

- Changes in `static/app.js`:
  - Updated `_renderIemDetail(iemId, container)` markup:
    - wrapped the first two detail sections (`Genre Scores`, `Blindspot Detector`) in new layout container:
      - `.iemfit-detail-top-grid`
    - kept Frequency Response section below unchanged.

- Changes in `static/style.css`:
  - Added `.iemfit-detail-top-grid` as a 2-column grid for desktop/tablet.
  - Added responsive rule at `max-width: 980px` to collapse `.iemfit-detail-top-grid` to one column.

- Outcome:
  - Genre and blindspot analysis are now presented side by side in each IEM detail panel, reducing vertical scroll while preserving existing functionality/data.

### 2026-04-03 (Insights analysis persistence: legacy cache signature backfill)
- User requirement reaffirmed:
  - No full re-analysis after app updates when prior analysis exists.
  - Keep analysis history and run only delta (added/changed/removed tracks).

- Problem addressed:
  - Older v3 cache rows without `source_path`/`source_mtime` were treated as stale,
    causing an unnecessary one-time full re-analysis.

- Changes in `app.py`:
  - Added `_has_valid_v3_payload(entry)` helper to validate reusable v3 rows.
  - Added `_backfill_feature_source_signatures(tracks)`:
    - upgrades legacy v3 rows by filling missing `source_path` and `source_mtime`
      from current library metadata.
    - writes upgraded rows back to `features/track_features.json`.
  - Wired backfill into analysis flows:
    - `_run_analysis()`
    - `POST /api/insights/analyse`
    - `GET /api/insights/analyse/info`

- Behavior outcome:
  - Existing analysis history is preserved across app version updates.
  - Start/info checks now auto-upgrade legacy cache rows and only analyze true delta tracks.
  - Full re-analysis is only needed for genuinely incompatible schema rows or invalid payloads.

- Validation:
  - `PYTHONPYCACHEPREFIX=/tmp python3 -m py_compile app.py` passed.

### 2026-04-03 (Insights IEM accordion CTA baseline alignment)
- User request:
  - Keep `view all` CTAs in `Genre Scores` and `Blindspot Detector` aligned to the same baseline.

- Changes in `static/app.js`:
  - Added shared CTA class to both panel buttons:
    - `iemfit-bs-more-btn iemfit-panel-cta`
  - Applied to:
    - Genre panel `showAllIemGenres(...)` CTA
    - Blindspot panel `showAllIemBlindspots(...)` CTA

- Changes in `static/style.css`:
  - Made both top-row detail sections equal-height flex columns:
    - `.iemfit-detail-top-grid .iemfit-detail-section`
  - Made panel bodies flex containers:
    - `.iemfit-heatmap-body`, `.iemfit-bs-body`
  - Added bottom spacing under lists and anchored CTA:
    - `.iemfit-heatmap-grid`, `.iemfit-bs-list` now include `margin-bottom: 12px`
    - `.iemfit-panel-cta { margin-top: auto; }`

- Outcome:
  - Genre and Blindspot `view all` buttons stay vertically aligned in the IEM accordion (desktop/tablet), regardless of row-height/content differences.

### 2026-04-03 (Insights compatibility summary card: density + score meaning clarity)
- User request:
  1. Reduce negative space in `Insights > Compatibility analysis` overall score card.
  2. Clarify what the overall percentage means.

- Backend changes (`app.py`):
  - Extended match overview payload (`library_overview`) with:
    - `covered_tracks`
    - `coverage_threshold_pct` (currently `70`)
  - No scoring math changes; only exposes components already used to compute `overall_coverage_pct`.

- Frontend changes (`static/app.js`):
  - Updated summary rendering in `_renderInsightsMatchOverview(...)`:
    - added explicit one-line meaning text:
      - “X of Y tracks are in genres where at least one IEM scores >= threshold.”
    - added compact metadata pills:
      - coverage threshold
      - qualitative coverage reading
  - Existing headline summary text remains.

- Style changes (`static/style.css`):
  - Reworked `.iemfit-summary-card` into denser grid layout:
    - tighter padding/gap
    - centered score block
    - larger percentage figure with improved typography
  - Added styles for:
    - `.iemfit-summary-meaning`
    - `.iemfit-summary-meta`
    - `.iemfit-summary-pill`
  - Added mobile behavior to stack summary sections cleanly.

- Clarification on correctness of percentage:
  - `overall_coverage_pct` is genre-weighted by track count and reflects the share of library tracks that fall into genres where at least one IEM reaches the coverage threshold (>=70%).
  - This is a genre-level coverage metric (not per-track FR scoring).

- Validation:
  - `node --check static/app.js` passed.
  - `PYTHONPYCACHEPREFIX=/tmp python3 -m py_compile app.py` passed.

### 2026-04-03 (Compatibility summary rewrite + CTA styling + coverage consistency backfill)
- User feedback:
  - Summary explanation was confusing.
  - Replace pill-style meta labels with CTA-like visual treatment.

- Backend fix (`app.py`):
  - `GET /api/insights/matching/overview` now recomputes/overrides coverage fields from matrix rows for backward compatibility with older cached match data:
    - `total_tracks`
    - `covered_tracks`
    - `coverage_threshold_pct`
    - `overall_coverage_pct`
  - Purpose: prevent stale/partial payloads from showing contradictory values (e.g. summary says strong coverage while covered count appears as 0).

- Frontend text rewrite (`static/app.js`):
  - Replaced previous one-liner with plainer language:
    - “X% means at least one of your IEMs is a strong match for Y of Z tracks (based on track genre).”
  - Kept qualitative tone line (excellent/good/mixed/low) for quick interpretation.

- CTA visual update (`static/style.css` + `static/app.js`):
  - Replaced `.iemfit-summary-pill` usage with `.iemfit-summary-cta`.
  - New CTA-like style:
    - stronger border/gradient
    - accent-forward text
    - heavier weight/letter spacing

- Validation:
  - `PYTHONPYCACHEPREFIX=/tmp python3 -m py_compile app.py` passed.
  - `node --check static/app.js` passed.

### 2026-04-03 (Compatibility metric reframing: from "any-IEM coverage" to single-IEM fit)
- User concern:
  - The previous wording/metric was misleading: “100% means at least 1 IEM is a strong match”.
  - This overstates decision value because users listen to one IEM at a time.

- Product decision update:
  - Reframed the top `overall` card to a **single-IEM metric**.
  - New headline score uses the top item from `iem_summary`:
    - `best single-IEM library fit` = highest `library_match_score` among configured IEMs.

- Frontend changes (`static/app.js`):
  - `_renderInsightsMatchOverview(...)` now:
    - computes `topIem = iem_summary[0]` (already sorted desc by backend).
    - displays `topIem.library_match_score` as primary large percentage.
    - replaces old “of your library matched” semantics.
    - updates explanation copy to:
      - weighted average match score for that one IEM across library genres.
    - adds CTA-style context labels:
      - Best all-round IEM
      - Biggest risk area (worst genre)
      - strongest all-round note

- UX outcome:
  - Top card now reflects how users actually make listening choices (pick one IEM),
    rather than an optimistic “some IEM somewhere matches” coverage interpretation.

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-03 (Compatibility analysis cleanup: removed duplicated top summary panel)
- User request:
  - Remove the top compatibility information panel because it duplicates score information already visible in the per-IEM list.

- Change in `static/app.js`:
  - In `_renderInsightsMatchOverview(...)`:
    - removed rendering of `.iemfit-summary-card` block.
    - Insights compatibility section now renders directly into `.iemfit-iem-list` only.

- Outcome:
  - Reduced visual duplication and vertical clutter.
  - Users now focus directly on actionable per-IEM cards/accordion scores.

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-03 (Multi-source IEM measurements: up to 3 squig URLs with labels)
- User request:
  - In Add IEM/Headphone modal, allow up to 3 squig.link URLs with labels.
  - Ensure these appear as options in FR graph dropdowns across the app.

- Data model / backend (`app.py`):
  - Added multi-source measurement support on each IEM record:
    - `squig_sources: [{id,label,url,squig_subdomain,squig_file_key,measurement_L,measurement_R}]`
    - `primary_source_id`
  - Added normalization + migration helpers:
    - `_normalize_iem_source(...)`
    - `_sync_iem_primary_measurements(...)`
    - `_normalize_iem_record(...)`
    - `_public_iem(...)`
  - `load_iems()` now normalizes/migrates legacy single-source records and persists upgraded shape.
  - Backward compatibility preserved:
    - legacy top-level fields (`squig_url`, `measurement_L/R`, etc.) are synced from primary source for existing analysis/scoring code paths.

- IEM CRUD API updates:
  - `POST /api/iems` now accepts `squig_sources` (max 3), fetches each URL, stores labeled source measurements.
  - `PUT /api/iems/<id>` now supports updating labeled sources (max 3), reuses existing measurements when URL unchanged, refetches when needed.
  - `GET /api/iems` and `GET /api/iems/<id>` now return public IEM payloads without large measurement arrays; include:
    - `squig_sources` metadata (id/label/url/...)
    - `has_measurement`

- Graph API updates:
  - `GET /api/iems/<id>/graph` now supports:
    - `source=<source_id>` for primary IEM curve source selection.
    - optional `compare_source=<iem_id>:<source_id>` mapping support.
  - Response now includes:
    - `available_sources`
    - `selected_source_id`
  - Curve labels include source label when IEM has multiple sources.

- Frontend modal updates (`static/index.html`, `static/style.css`, `static/app.js`):
  - Replaced single squig URL input with 3 labeled source rows.
  - Added modal helpers:
    - `_collectIemModalSources()`
    - `_setIemModalSources(...)`
  - Add/Edit flows now save/load `squig_sources`.

- FR dropdown integration across app (`static/app.js`):
  1. Gear > IEM detail FR chart:
     - Added `Source` dropdown in graph toolbar.
     - Added `applyIemSourceToGraph(...)`.
     - Graph fetch now passes `source` query param.

  2. Insights > Compatibility > IEM accordion FR chart:
     - Added per-IEM `Source` dropdown in FR controls.
     - Added `_iemFitSourceState` and `iemFitChangeSource(...)`.
     - FR fetch now includes selected `source` query param.

- Notes:
  - Matching/analysis math remains tied to the IEM primary source via legacy-compatible top-level measurements; this change targets FR visualisation selection UX.

- Validation:
  - `PYTHONPYCACHEPREFIX=/tmp python3 -m py_compile app.py` passed.
  - `node --check static/app.js` passed.

### 2026-04-03 (Design lift pass: header icons + Gear + IEM detail visual facelift)
- Request scope:
  1. Update main Settings + Help icons.
  2. Update Gear page UI.
  3. Update Gear > IEM page UI.
  - Reference used: `analysis-design-update.md` (`Luminous Depth / Obsidian Gallery`).

- Design direction applied:
  - No-line hierarchy emphasis via tonal layering + glow (instead of hard dividers).
  - Larger radii (`lg/full`), atmospheric gradients, subtle glass blur on interactive/floating surfaces.
  - Editorial overlines for section structure.

- Changes in `static/index.html`:
  - Header icons:
    - applied shared `header-orb-btn` class to Help + Settings buttons.
    - upgraded Settings icon stroke treatment and class hook (`settings-btn-icon`).
  - Gear section headers:
    - added overline labels (`Transport`, `Monitoring`) via `.gear-section-overline`.

- Changes in `static/style.css`:
  - Header icon refresh:
    - added `.header-orb-btn` with luminous glass treatment and hover lift.
    - refined Help glyph sizing/alignment and settings icon alignment.
  - Gear page facelift:
    - card grid spacing increased.
    - `.gear-card` updated to layered gradient surfaces + ghost border + depth shadow + hover lift.
    - `.gear-card-icon` shifted to circular luminous badge style.
    - selected-card state updated to tonal glow instead of hard outline.
    - section headers upgraded (`Title-Lg`) + new uppercase overline style.
    - page-level atmospheric background + spacing for `#view-gear`.
  - IEM detail facelift:
    - `.iem-detail-header` converted to elevated glass panel.
    - icon chip updated to luminous circular badge.
    - `.freq-graph-wrap` converted to layered elevated panel with softer border/glow.
    - graph toolbar selects restyled to rounded glass pills.
    - page-level atmospheric background + spacing for `#view-iem-detail`.

- Functional impact:
  - UI-only facelift. No changes to data behavior or feature logic.

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-03 (Design lift expansion: nav + Artists/Albums/Playlists + detail pages)
- User request:
  - Apply the same UI facelift language to:
    1) Left nav
    2) Artists
    3) Artist detail page
    4) Albums
    5) Album detail page
    6) Playlists
    7) Playlist detail page

- Approach:
  - CSS-only visual lift (no behavior/data changes).
  - Reused Luminous Depth patterns already applied to Insights/Gear:
    - tonal layering over hard lines
    - ghost borders
    - atmospheric gradients
    - larger rounded geometry
    - subtle glass blur + hover lift

- Changes in `static/style.css`:
  - Left nav:
    - upgraded `#sidebar`, `#sidebar-header`, `.nav-section-label`, `.nav-item`, `#sync-nav-btn`, `#scan-status`.
    - active nav state now uses luminous tonal treatment.
  - Artists + Albums grids/cards:
    - upgraded `.artist-grid/.artist-card/.artist-thumb` and `.album-grid/.album-card/.album-thumb`.
  - Artist/Album detail hero:
    - upgraded `.browse-hero` and related hero text emphasis.
  - Playlists view:
    - upgraded `.playlists-view-grid`, `.pl-view-card`, `.pl-view-cover`.
  - Playlist detail page:
    - upgraded `.playlist-header`, `#view-playlist .pl-controls`, `#view-playlist #pl-table`.
  - Shared list/table tone:
    - refined table header/body tonal contrast for tracks + playlist tables.
  - Added ambient backgrounds for:
    - `#view-artists`, `#view-albums`, `#view-tracks`, `#view-playlists`, `#view-playlist`.

- Files touched:
  - `static/style.css`

- Validation:
  - `node --check static/app.js` passed (no JS regressions from style-only pass).

### 2026-04-03 (Artist/Album hero action button alignment fix)
- User issue:
  - Action buttons in Artist/Album detail hero row were vertically misaligned.

- Root cause:
  - `.btn-play-all` had `margin-bottom: 12px`, causing it to sit lower than adjacent `.btn-secondary` actions.

- Fix (`static/style.css`):
  - Updated `.hero-actions`:
    - set `align-items: center` for consistent vertical alignment.
  - Added shared hero-action button normalization:
    - `.hero-actions .btn-play-all, .hero-actions .btn-secondary` now use `min-height: 44px`, `display: inline-flex`, `align-items: center`.
  - Removed vertical offset from `.btn-play-all`:
    - removed `margin-bottom: 12px`
    - set `line-height: 1` for stable internal alignment.

- Outcome:
  - Play/Add/Browse buttons now align consistently on Artist and Album detail pages.

### 2026-04-03 (Playlist detail overlap fix: controls vs table header)
- User issue:
  - On Playlist detail page, table header visually overlapped the search/filter + sort controls bar.

- Root cause:
  - During the recent playlist facelift, spacing between `#view-playlist .pl-controls` and `#view-playlist #pl-table` was reduced to zero, causing the header row to appear merged/overlapping with the controls area.

- Fix (`static/style.css`):
  - Updated playlist-only table wrapper spacing:
    - `#view-playlist #pl-table` now has `margin-top: 10px;`
  - Kept the change strictly scoped to Playlist detail view so Songs/Artists/Albums table layouts are unaffected.

- Functional impact:
  - UI-only spacing correction. No behavior/data/API changes.

### 2026-04-03 (Facelift: Gear DAP detail + shared modal system)
- User request:
  - Apply UI facelift to `Gear > DAP Detail` and all popup modals.
  - Keep functionality unchanged.

- DAP detail updates:
  - Files:
    - `static/app.js`
    - `static/style.css`
  - UI structure refinements in `showDapDetail(...)`:
    - replaced inline styles with reusable classes:
      - `dap-section-title`
      - `dap-table-shell`
      - `dap-pl-empty-row`
      - `dap-pl-export-cell`
  - Visual facelift styles:
    - Added atmospheric background for `#view-dap-detail`.
    - Upgraded `.dap-detail-header` to elevated glass card.
    - Updated `.dap-detail-icon` to luminous badge treatment.
    - Refined `.dap-config-block` into layered panel.
    - Wrapped playlist sync table in `.dap-table-shell` with border + depth.

- Popup modal system updates:
  - Files:
    - `static/index.html`
    - `static/style.css`
  - Introduced shared modal header/close patterns:
    - `modal-head`, `modal-head-tight`, `modal-head-spaced`
    - `modal-title-sm`
    - `modal-x-btn` (reused across compare/help/settings/DAP/IEM/PEQ + insights modals)
  - Applied header/close cleanup to modals:
    - Problem tracks
    - Genre distribution
    - IEM blindspot
    - Help
    - Settings
    - Add/Edit DAP
    - Add/Edit IEM
    - PEQ upload
  - Unified modal visual language across popups:
    - upgraded `.modal-overlay` (atmospheric dim + blur)
    - upgraded `.modal` surface (gradient, ghost border, soft depth)
    - tightened `.modal-actions` (top divider + spacing)
    - unified modal form controls (`input/select/textarea/file`) with consistent borders/focus states
  - Inline style cleanup in modal forms:
    - removed old inline styling from:
      - `#import-name-input`
      - `#dap-model`
      - `#iem-type`
    - these now inherit shared modal control styling.

- Functional impact:
  - UI-only facelift; no workflow or API behavior changes.

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-03 (Modal density pass v2: spacing + typography rhythm)
- User request:
  - Do a second pass on popup/modal UX after the initial facelift.

- Scope:
  - CSS-only refinements to improve readability and reduce perceived visual noise.
  - No behavior/API/logic changes.

- File updated:
  - `static/style.css`

- Improvements made:
  1. Modal size tiers and baseline typography
    - refined default modal width/padding for non-wide modals.
    - widened `modal-wide`/`modal-help` for better content fit.
    - set consistent modal typography rhythm (`font-size`, `line-height`).

  2. Header/action spacing consistency
    - tightened `modal-head` spacing.
    - normalized action area button heights in `modal-actions`.
    - improved settings-row spacing/label cadence inside modals.

  3. Help modal readability
    - tightened section spacing and section-title hierarchy.
    - added subtle section separators for scanability.
    - reduced visual bulk on helper cards/code blocks.

  4. Compare modal balance
    - reduced header/legend padding slightly.
    - adjusted title/subtitle and legend chip density.
    - tightened chart wrapper padding to better use available plotting area.

  5. Insights popup list density
    - compacted problem-tracks and genre-list row spacing.
    - slightly reduced modal body max-heights for balanced viewport fit.

  6. Responsive behavior
    - on narrower screens, modal form rows switch to stacked label+field layout for cleaner wrapping.

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-03 (Sync modal micro-pass: phase consistency)
- User request:
  - Improve visual consistency across Sync modal phases (`pick`, `scanning`, `preview`, `copying`, `done`).

- Scope:
  - UI/UX-only updates for Sync modal flow.
  - No sync backend/API logic changes.

- Files updated:
  - `static/index.html`
  - `static/style.css`
  - `static/app.js`

- What was implemented:
  1. Phase rail/navigation context
    - Added a compact step rail under Sync header:
      - `Device`, `Scan`, `Review`, `Copy`, `Done`
    - Added active-step state tied to real phase transitions.

  2. Unified phase containers
    - Added shared phase panel wrappers for all Sync stages via classes:
      - `sync-phase-panel`
      - `sync-phase-panel--progress`
    - This gives all stages the same elevated surface language and spacing rhythm.

  3. State wiring in JS
    - `_syncPhase(name)` now:
      - sets `data-phase` on `#sync-modal`
      - toggles `.active` on `.sync-phase-step` markers
      - preserves existing show/hide behavior per phase.
    - `showSync()` now resets done/error remnants on open (`sync-done-msg`, `sync-errors-wrap`) for cleaner phase re-entry.

  4. Sync-specific styling refinement
    - Added Sync modal-specific width tuning (`#sync-modal .modal`).
    - Refined device card spacing and progress visuals.
    - Standardized preview sections as panel-like blocks.
    - Improved list container contrast and row density.
    - Tightened done-state spacing and mobile behavior.

- Functional impact:
  - Visual/interaction clarity only. Sync behavior remains unchanged.

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-03 (Sync copywriting polish: phase text tone)
- User request:
  - Final pass on Sync modal progress messaging wording.

- Scope:
  - Frontend copy refinement only.
  - No sync logic/API behavior changes.

- Files updated:
  - `static/app.js`
  - `static/index.html`

- Wording/system updates:
  1. Added message normalizer helper in Sync flow:
    - `_formatSyncPhaseMessage(raw, phase)`
    - standardizes scan/copy phrasing, including `x/y` progress patterns.

  2. Scan phase copy:
    - default: `Scanning your library files…`
    - error toast: `Could not complete scan: ...`

  3. Review/empty-state copy:
    - `Nothing to copy` -> `No files to sync in this direction.`

  4. Copy phase copy:
    - startup: `Preparing to copy 0 / N files…`
    - in-progress strings normalized through helper.
    - error toast: `Sync failed: ...`

  5. Done phase copy:
    - success message now appends issue count when present:
      - `Completed with X issue(s).`

  6. CTA label updates in Sync modal:
    - `Sync Selected Files` -> `Start Sync`
    - `Scan Again` -> `Run Another Scan`
    - `Done` -> `Close`

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-03 (Playlist detail hero refinement: overlap + compact layout)
- User request:
  - Fix overlap between `Play` and DAP download buttons.
  - Tighten playlist hero vertical footprint.
  - Scale playlist cover to better match page aesthetic.

- File updated:
  - `static/style.css`

- Changes (playlist-detail scoped):
  - `#view-playlist .playlist-header`
    - compacted padding/margins/radius and aligned content center.
  - `#view-playlist .playlist-cover-wrap`
    - reduced cover size to `152x152` (with responsive reductions).
    - aligned cover corner radius with updated hero geometry.
  - `#view-playlist .playlist-meta`
    - set explicit flex-column flow so title/stats/play/export/delete stack predictably.
  - `#view-playlist #pl-name`
    - reduced title size for a tighter hero.
  - `#view-playlist #pl-play-all`
    - forced explicit bottom spacing to prevent visual collision with export pills.
  - `#view-playlist .playlist-actions` and `.export-group`
    - tightened row/column spacing and ensured stable wrapping/alignment.
  - `#view-playlist .btn-export`
    - reduced button height/padding/font for denser action row.

- Responsive behavior:
  - <=1200px: slightly smaller cover/title.
  - <=860px: hero stacks vertically; cover and title scale down further.

- Functional impact:
  - UI-only adjustments; no playlist/export/play logic changes.

### 2026-04-03 (Playlist hero follow-up: Play button width + spacing fix)
- User feedback:
  - Play button still rendered full-width.
  - Hover state of first DAP export button visually collided with Play button area.

- Root cause:
  - Playlist-specific style targeted `#pl-play-all` but actual runtime id is `#pl-play-all-btn`.
  - In a column flex container, items stretch by default unless constrained (`align-self`).

- Fix (`static/style.css`):
  - Replaced selector with correct runtime id:
    - `#view-playlist #pl-play-all-btn`
  - Enforced compact button sizing in hero:
    - `align-self: flex-start; width: auto;`
  - Added additional vertical separation:
    - increased bottom margin under Play button to `14px`.
  - Prevented hover growth from causing collision in playlist hero context:
    - `#view-playlist #pl-play-all-btn:hover { transform: none; }`
  - Added tiny top spacing before export action row:
    - `#view-playlist .playlist-actions { margin-top: 2px; }`

- Functional impact:
  - UI-only tweak; no playback/export logic changes.

### 2026-04-03 (Packaging migration: self-contained Apple Silicon .app + DMG install)
- User requirements addressed:
  1. Simple distribution: install by drag-copying app to Applications.
  2. First run should complete setup automatically (no manual dependency install).
  3. Persist all data under `~/Library/Application Support/TuneBridge/`.

- Design decision:
  - Replaced "external system Python + launcher resolution" distribution approach with a self-contained frozen app build.
  - Runtime dependency installation is no longer required on user machines.
  - "First run setup" is now bootstrap/migration only (create App Support folders + migrate seeded data/features when needed).

- Implemented changes:

  1. `build_app.sh` rewritten for Apple Silicon distribution
    - Target: `arm64` macOS builds only.
    - Builds a self-contained `.app` via PyInstaller (windowed app bundle).
    - Installs build-time deps in isolated `.build-venv` (includes `pyinstaller`).
    - Bundles app assets:
      - `static/`
      - optional `data/features/` (for first-run feature migration)
    - Injects/patches `Info.plist` values (bundle metadata + folder usage descriptions).
    - Ad-hoc signs the app and clears quarantine attributes.
    - Optional `--dmg` creates drag-and-drop installer image with `/Applications` symlink.

  2. `tunebridge_gui.py` runtime path/bootstrap hardening
    - Added `_resolve_project_dir()` with fallback order:
      - `TUNEBRIDGE_PROJECT_DIR` env override
      - frozen extraction dir (`sys._MEIPASS`)
      - script directory (dev mode)
    - In frozen mode, automatically sets:
      - `TUNEBRIDGE_BUNDLED=1`
      - `TUNEBRIDGE_PROJECT_DIR=<resolved bundle resource dir>`
    - Removes reliance on launcher-injected env for packaged app startup.

  3. Documentation updates (`README.md`)
    - Packaging section updated to self-contained app + drag-drop DMG flow.
    - Clarified first-run behavior and App Support data location.
    - Data files table now reflects runtime location under `~/Library/Application Support/TuneBridge/`.
    - Requirements clarified:
      - end-user install does not require separate Python.
      - developer workflow still requires Python 3.10+.

- Notes:
  - Existing `app.py` App Support strategy already met requirement #3 and was retained.
  - `create_app.sh`/`launcher.c` remain in repo for legacy/dev workflows; distribution now centers on `build_app.sh`.

- Validation performed:
  - `bash -n build_app.sh` passed.
  - `PYTHONPYCACHEPREFIX=/tmp python3 -m py_compile tunebridge_gui.py app.py` passed.

- Validation not run in this session:
  - Full end-to-end DMG build execution (PyInstaller build + macOS launch test) was not executed in this turn.

### 2026-04-03 (README full-pass cleanup for distribution + profile-driven setup)
- User request:
  - Commit current state to `main` and ensure README no longer references outdated hardcoded devices/setup.

- README updates made:
  - Replaced hardcoded DAP preset wording with profile-driven wording in Features.
  - Fixed Quick Start config key hint:
    - `music_base` -> `library_path`.
  - Updated project structure section to include `data/gear_profiles.json`.
  - Marked `create_app.sh` as legacy dev launcher workflow.
  - Replaced old "Device Export Reference" hardcoded table with a new "DAP Profiles" section describing runtime profile registry and override path.

- Intent:
  - Ensure docs match current architecture (self-contained packaging + profile-based DAP behavior).

### 2026-04-03 (Insights Sonic Profile compact layout pass)
- User request:
  - Tighten `Insights > Sonic Profile` to reduce vertical space usage.

- UI changes implemented (no functionality/data logic changes):
  - `static/app.js`
    - Reduced chart canvas heights in Sonic Profile renderer:
      - Brightness histogram: `180px` -> `138px`
      - RMS energy histogram: `180px` -> `138px`
      - Tonal demand (12-band) chart: `180px` -> `148px`
    - Wrapped Sonic Profile blocks in a new container: `.sonic-profile-stack` for tighter vertical rhythm.
  - `static/style.css`
    - Added `.sonic-profile-stack` with compact vertical gap.
    - Reduced Sonic block spacing:
      - `.sonic-insight-grid` bottom margin tightened.
      - `.sonic-caveat` top margin/padding/line-height tightened.
      - `.sonic-band-card` top margin removed.
    - Tightened Sonic card internals:
      - `.sonic-chart-card, .sonic-band-card` padding reduced.
      - `.sonic-chart-title` and `.sonic-chart-subtitle` bottom margins reduced.
      - `.sonic-stat-row` gap and top margin reduced.

- Expected outcome:
  - Sonic Profile occupies less vertical screen real estate while preserving all existing charts, metrics, and compatibility cues.

### 2026-04-03 (Player UI facelift aligned with Obsidian design language)
- User request:
  - Review and update player design to match the new UI/UX aesthetic.

- Scope:
  - UI-only refresh for bottom player, PEQ popover, and queue drawer.
  - No changes to playback logic in `static/player.js`.

- Implemented changes in `static/style.css`:
  - Player shell:
    - Increased player bar height (`74px` -> `86px`) and adjusted layout bottom padding.
    - Added layered glass background, stronger blur, top glow line, and rounded top corners.
    - Updated grid columns (`260/1fr/260` -> `300/1fr/300`) with refined spacing.
  - Left now-playing block:
    - Larger, rounded album art container with subtle ghost edge and ambient shadow.
    - Refined title/artist/quality typography for better hierarchy.
  - Transport controls:
    - Converted icon controls to pill/ghost button style with hover lift.
    - Enhanced active state visibility.
    - Updated play/pause to primary gradient CTA style.
  - Seek/progress:
    - Increased track thickness (`4px` -> `6px`), rounded rails, gradient progress fill.
    - Refined timestamp styling and hover-state contrast.
  - Right controls:
    - Slightly increased spacing and restyled volume slider/knob to match accent system.
  - PEQ popover:
    - Upgraded to glass panel look (radial tint + blur + ghost edge + softer ambient shadow).
    - Updated close button and divider to match no-hard-line aesthetic.
  - Queue drawer:
    - Repositioned to sit above new player height (`bottom: 86px`).
    - Updated with glass background, blur, ghost edge, and rounded corners.
  - Responsive behavior:
    - Added dedicated breakpoints at `1180px`, `900px`, and `620px`.
    - On smaller widths, player compacts into a single-column stack with adjusted paddings/heights.
    - Queue drawer bottom offset tracks responsive player height; on very small screens drawer uses full width.

- Expected outcome:
  - Player, popovers, and queue visuals now align with the modern “Obsidian/Luminous depth” facelift across Insights/Gear while retaining existing functionality.

### 2026-04-03 (Player micro-interaction polish pass)
- User request:
  - Continue with micro-interactions for the refreshed player.

- Changes made:
  - `static/style.css`
    - Added subtle player-bar entrance animation (`player-bar-rise`) for first paint.
    - Improved control feedback:
      - Press-state scale for `.player-btn`
      - Enhanced hover/press motion for `.player-play-pause`
      - Hover glow around seek rail (`.player-seek-wrap::after`)
      - Volume rail hover tint + inset glow
    - Enhanced queue motion:
      - Drawer now animates with opacity + slight scale, not only translate.
      - Added lightweight stagger for first queue items (`queue-item-fade-up`) on open.
    - Added animated PEQ popover state class:
      - Base popover has hidden/offset state.
      - `.peq-popover.open` handles smooth fade/slide/scale in.
    - Added `prefers-reduced-motion: reduce` fallback to disable these transitions/animations for accessibility.
  - `static/player.js`
    - Added `_setPeqPopoverOpen(open)` helper to coordinate class-based popover animation with delayed `display:none`.
    - Updated all PEQ close/open paths to use helper:
      - `togglePeqPopover()`
      - `applyPeqProfile()`
      - outside-click close handler
    - Added `_peqCloseTimer` guard to avoid race conditions when quickly toggling popover.

- Functional impact:
  - UI behavior is visually smoother.
  - Playback, queue logic, and EQ processing remain unchanged.

### 2026-04-03 (First-run onboarding modal for new users)
- User request:
  - Add an onboarding modal for first-time app launch with hype copy and setup prompts for:
    - default library location
    - folder structure
    - primary file format
  - Keep design aligned with existing modal system.

- Backend updates (`app.py`):
  - Extended `DEFAULT_SETTINGS`:
    - `library_structure` (default: `artist_album_track`)
    - `preferred_audio_format` (default: `flac`)
    - `onboarding_completed` (default: `False`)
  - Extended `GET /api/settings` response with:
    - `_settings_exists` (boolean, based on `settings.json` presence)
  - Rationale:
    - Frontend can now distinguish true first-run installs from existing users with migrated settings.

- Frontend updates:
  - `static/index.html`
    - Added `#onboarding-modal` using shared `.modal-overlay` + `.modal` pattern.
    - Included:
      - hype intro text
      - library folder input + Browse action
      - folder structure select
      - file format select
      - actions: `Set Up Later` / `Save & Continue`
  - `static/style.css`
    - Added onboarding-specific modal polish classes:
      - `.onboarding-modal`
      - `.onboarding-subtitle`
      - `.onboarding-hype`
      - row sizing tweaks for labels
  - `static/app.js`
    - `loadSettings()` now returns settings object after populating Settings view.
    - Added onboarding helpers:
      - `closeOnboarding()`
      - `_showOnboarding(settings)`
      - `completeOnboarding()`
    - `completeOnboarding()` persists:
      - `library_path`
      - `library_structure`
      - `preferred_audio_format`
      - `onboarding_completed: true`
    - Init flow (`DOMContentLoaded`) now shows onboarding only when:
      - `!settings._settings_exists && !settings.onboarding_completed`
    - Exported onboarding methods via `App` for modal button callbacks.

- Documentation updates:
  - `README.md`
    - Added onboarding mention under Settings & Tools and First Run Behavior.

- Validation:
  - `node --check static/app.js` passed.
  - `python3 -m py_compile app.py` passed.

### 2026-04-03 (build_app.sh console readability pass)
- User request:
  - Improve readability/consumability of `bash build_app.sh --dmg` console output while running.

- Changes made (`build_app.sh`):
  - Added structured log helpers:
    - `phase`, `step`, `ok`, `warn`, `err`, `kv`, and `hr`.
  - Replaced ad-hoc echo output with consistent tagged logs:
    - `[PHASE]`, `[STEP ]`, `[OK   ]`, `[WARN ]`, `[ERROR]`
  - Added startup metadata lines:
    - Project path, output path, mode (`App only` vs `App + DMG`)
  - Added explicit phase grouping:
    - Environment checks
    - Build environment
    - Bundle assembly
    - DMG packaging (when enabled)
  - Clarified long-running step messaging:
    - `Running PyInstaller (this can take a few minutes)`
  - Improved final summary with split install instructions for:
    - DMG builds
    - app-only builds

- Functional impact:
  - No change to build behavior/artifacts.
  - Output is easier to scan in real-time and easier to parse after long runs.

- Validation:
  - `bash -n build_app.sh` passed.

### 2026-04-03 (DMG publish to distro/ folder)
- User request:
  - Save latest compiled DMGs to a dedicated distribution folder that can be shared with users.

- Implemented (`build_app.sh`):
  - Added `DISTRO_DIR="${PROJECT_DIR}/distro"`.
  - During `--dmg` builds:
    - Ensures `distro/` exists.
    - Publishes the generated DMG to:
      - `distro/TuneBridge-latest.dmg` (stable path for sharing)
      - `distro/TuneBridge-v<version>-<timestamp>.dmg` (archived build copy)
  - Updated final console summary to list both `dist/` and `distro/` artifacts.

- Documentation:
  - `README.md` macOS Distribution section now documents `distro/TuneBridge-latest.dmg` and versioned archive naming.

- Functional impact:
  - Build behavior unchanged except new post-build publish/copy step for DMGs.

### 2026-04-03 (Insights IEM "View all" PEQ-aware scoring fix)
- User request:
  - In `Insights > Gear compatibility analysis > IEM`, when PEQ is applied for comparison, the `%` values in "View all" modals must reflect PEQ-adjusted match scores.

- Root cause:
  - "View all" modal logic relied on cached PEQ variant scores that could be missing/stale vs the currently rendered accordion state.

- Fix implemented (`static/app.js`):
  - Added `_iemFitActiveScores12` state map:
    - stores the exact 12-band score map used by the current visible IEM panel render.
  - In `_renderIemFRPanel(...)`:
    - persist active scores to `_iemFitActiveScores12[iemId]`.
  - Enhanced score resolution path:
    - `_activePeqScores12(iemId)` now prefers `_iemFitActiveScores12`.
    - added async `_resolveActivePeqScores12(iemId)` fallback that refreshes radar PEQ variant scores from API and merges them into cached variant data when needed.
  - Updated modal handlers:
    - `showAllIemGenres(iemId)` -> async and uses `_resolveActivePeqScores12`.
    - `showAllIemBlindspots(iemId)` -> async and uses `_resolveActivePeqScores12`.

- Outcome:
  - "View all" modal scores now align with the currently selected PEQ comparison context (same scoring basis as the inline panels).

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-03 (Insights IEM modal row parity with main table)
- User request:
  - Make "View all" modal rows show info similar to main table rows (score + delta badge when PEQ is active).

- Update made (`static/app.js`):
  - In both modal renderers:
    - `showAllIemGenres(iemId)`
    - `showAllIemBlindspots(iemId)`
  - Extended row data to carry:
    - factory score
    - PEQ score (if active)
    - computed delta (`PEQ - factory`)
  - Added `deltaBadge` rendering using existing class/style logic:
    - `iemfit-score-delta` with `pos|neg|neu`
  - Modal score cell now renders:
    - `XX%` + `delta badge` (e.g. `75%  -8`)

- Outcome:
  - Modal rows now visually and semantically match the main table behavior when PEQ comparison is enabled.

### 2026-04-03 (GitHub-visible distro folder + latest DMG tracking)
- User request:
  - Make the `distro/` folder visible on GitHub and include the latest local build DMG.

- Changes made:
  - Updated `.gitignore` to keep only one installer artifact in git:
    - allow `distro/`
    - ignore `distro/*.dmg` by default
    - explicitly allow `distro/TuneBridge-latest.dmg`
  - Added `distro/README.md` to document distribution intent.
  - Prepared `distro/TuneBridge-latest.dmg` for tracking in repository.

- Outcome:
  - GitHub will show a stable `distro/` folder with the latest installer available for users.

### 2026-04-03 (ML Playlist Generation v1 - initial implementation on new branch)
- Branch:
  - `feature/ml-playlist-generation-v1`

- Requirement context:
  - Launch generation from both Playlists view and Playlist detail view.
  - Generate preview first, save explicitly, and warn on navigation/close when preview is unsaved.
  - Use numeric controls, deterministic mode ON by default.
  - API-only v1.
  - Handle missing feature data with penalties/fallback scoring.

- Backend work completed (`app.py`):
  - Added configurable generation support via:
    - `data/genre_families.json`
    - `data/playlist_gen_config.json`
  - Added helper loading functions with safe fallbacks:
    - `load_genre_families()`
    - `load_playlist_gen_config()`
  - Added generation/scoring pipeline:
    - candidate filtering (`mode`, `target_genre`, `genre_mode`, year range, excludes)
    - fallback-safe feature extraction from `features/track_features.json`
    - weighted candidate scoring (similarity/genre/mood/sound/diversity)
    - transition continuity + playlist arc sequencing
    - deterministic generation option
  - Added new APIs:
    - `GET /api/playlists/generate/options`
    - `POST /api/playlists/generate/preview`
    - `POST /api/playlists/generate/save`
  - Added new config files to backup/export/import payload lists.

- Frontend work completed (`static/index.html`, `static/app.js`):
  - Added `Generate with ML` CTA in:
    - Playlist detail hero
    - Playlists page toolbar
  - Added `ML Playlist Generator` modal with controls:
    - name, mode, target genre, genre mode, seed note
    - playlist length, energy target, brightness target
    - diversity strength, transition smoothness, arc
    - actions: Close / Preview / Save Playlist
  - Implemented end-to-end modal behavior:
    - `openMlPlaylistGenerator(context)`
    - `closeMlPlaylistGenerator()`
    - `runMlPlaylistPreview()`
    - `saveMlGeneratedPlaylist()`
  - Implemented preview rendering:
    - summary metrics from backend
    - generated track list table with computed fit percentage
  - Implemented unsaved preview guard:
    - confirmation on in-app navigation if modal is open with unsaved preview
    - `beforeunload` browser guard for tab/window close with unsaved preview
  - Added App API exports for all new ML functions used by inline UI handlers.

- Validation:
  - `node --check static/app.js` passed.
  - `python3 -m py_compile app.py` was blocked in sandbox due cache write permissions; no syntax error observed from backend runtime changes.

- Open follow-up (next step):
  - Run manual UI verification in app for:
    - context-aware seed behavior
    - preview/save flow
    - unsaved preview guard edge cases across all nav paths.

### 2026-04-03 (ML generator modal UX polish)
- User request:
  - Tighten modal UI and make controls mode-aware.

- Updates made:
  - `static/index.html`
    - Refactored ML generator modal form into a compact two-column grid layout (`.ml-gen-body`).
    - Added structural row IDs for dynamic visibility:
      - `ml-gen-target-row`
      - `ml-gen-genre-mode-row`
      - `ml-gen-seed-row`
    - Added semantic class for seed hint (`.ml-gen-seed-note`).
  - `static/style.css`
    - Added dedicated ML generator modal styling:
      - larger but bounded modal shell
      - scrollable form body
      - compact row rhythm
      - styled preview container
      - responsive single-column fallback on smaller widths
  - `static/app.js`
    - Added mode-aware UI controller:
      - `_applyMlModeUi()`
      - `_bindMlModeHandlers()`
    - Behavior:
      - `genre` mode shows genre controls, hides seed info row.
      - `seed` mode shows seed row, hides genre controls.
      - `hybrid` mode shows both.
    - Added user guidance toast when running `seed` mode with no seed tracks selected.

- Validation:
  - `node --check static/app.js` passed.
  - `python3 -m compileall -q -f -b app.py` passed.

### 2026-04-03 (Smart Playlist naming + reference picker + context-aware shuffle)
- User-requested UX updates implemented:

- Smart Playlist naming + terminology:
  - Replaced user-facing label `Generate with ML` with `Smart Playlist`.
  - Renamed modal title from `ML Playlist Generator` to `Smart Playlist`.
  - Reframed mode terminology:
    - `Genre` -> `Genre Focus`
    - `Seed` -> `Reference Match`
    - `Hybrid` -> `Reference + Genre`
  - Updated helper copy to refer to `reference songs` (no seed wording in UI).

- Smart Playlist reference-song browser:
  - Added in-modal reference picker with:
    - searchable song input
    - selected reference chips with remove action
    - results list with add action
    - clear references action
  - Backend payload remains compatible (`seed_track_ids`) while UI uses reference terminology.
  - Reference selection cap: 12 tracks.

- Right-click launch path:
  - Added context-menu action:
    - `Create Smart Playlist from This Song` (dynamic text for multi-track selections).
  - This opens Smart Playlist modal pre-populated with selected track(s) as references and defaults to `Reference Match` mode.

- Player shuffle context fix:
  - Added player playback context model (`setPlaybackContext(tracks, label)`).
  - Wired app views to set active context:
    - playlist view
    - artist/album tracks view
    - songs view
  - Updated `playTrackById` to prefer active context collection so row double-click plays inside that context.
  - Updated shuffle toggle:
    - if queue only has one track but active context has more, shuffle now promotes the full context into queue first.
  - Result: shuffle now behaves as expected relative to current user context (playlist/artist/album/songs).

- Files touched:
  - `static/index.html`
  - `static/style.css`
  - `static/app.js`
  - `static/player.js`

- Validation:
  - `node --check static/app.js` passed.
  - `node --check static/player.js` passed.
  - `python3 -m compileall -q -f -b app.py` passed.

### 2026-04-03 (Smart Playlist phase-2 UX + regenerate + spec controls)
- User feedback addressed:
  1. Add refresh/regenerate capability during preview.
  2. Improve reference song selection UX (current inline picker felt incomplete).
  3. Progress toward full implementation from requirements spec.

- Implemented:

- Regenerate during preview:
  - Added `Regenerate` action in Smart Playlist modal actions.
  - Regeneration increments run seed while preserving current filters/options.
  - Preview summary now shows run identifier (seed-based run tag) for traceability.

- Reference selection UX redesign:
  - Replaced inline reference search/results block with cleaner actions:
    - `Browse Library`
    - `Use Current Selection`
    - `Clear`
  - Added dedicated reference browser modal:
    - searchable library list
    - checkbox multi-select
    - selected count
    - apply/cancel flow
  - Retained quick selected-reference chips in main Smart Playlist modal.
  - Reference cap remains 12 tracks.

- Spec-aligned generation controls (phase-2):
  - Added UI controls for:
    - mood preset (`focus`, `late_night`, `energetic`, `warm_relaxed`)
    - year range (`year_min`, `year_max`)
    - artist repetition toggle (`allow_repeat_artists`)
    - deterministic toggle (`deterministic`)
  - Wired all controls to payload object sent to generation preview endpoint.
  - Backend now applies mood preset bias when explicit energy/brightness targets are not set.

- Files updated:
  - `static/index.html`
  - `static/style.css`
  - `static/app.js`
  - `app.py`

- Validation:
  - `node --check static/app.js` passed.
  - `node --check static/player.js` passed.
  - `python3 -m compileall -q -f -b app.py` passed.

### 2026-04-03 (Smart Playlist visual tightening pass)
- User feedback:
  - Modal still felt cramped in the lower area and preview/actions competed for space.

- UX adjustments applied:
  - Added dedicated preview pane container (`ml-gen-preview-pane`) that is hidden until first preview run.
  - Kept controls area cleaner on initial open by removing empty preview shell.
  - Tightened form spacing/rhythm:
    - slightly smaller grid gaps
    - reduced action section vertical padding/margin
  - Improved layout containment:
    - Smart Playlist modal now uses internal overflow management (`overflow: hidden`)
    - controls body scroll and preview scroll are isolated for better readability.
  - Added subtle section separators around actions/preview for clearer visual hierarchy.

- Files updated:
  - `static/index.html`
  - `static/style.css`
  - `static/app.js`

- Validation:
  - `node --check static/app.js` passed.
  - `python3 -m compileall -q -f -b app.py` passed.

### 2026-04-03 (Smart Playlist simplification + regenerate fix)
- User feedback:
  - Smart Playlist flow still felt too complex for typical users.
  - Regenerate button did not produce alternative playlist outcomes.

- Simplification updates:
  - Reduced primary controls to essentials:
    - Playlist name
    - Strategy
    - Target genre (when relevant)
    - Reference songs (when relevant)
    - Length (short/standard/long)
    - Vibe (balanced/chill/energetic)
  - Moved technical controls into collapsible `Advanced options`:
    - genre mode
    - arc
    - energy / brightness targets
    - diversity
    - transition smoothness
    - year range
    - artist repeat toggle
    - deterministic toggle
  - Result: cleaner default UX with optional depth for power users.

- Regenerate fix (backend):
  - Root cause:
    - deterministic mode previously avoided any run-seed-sensitive jitter, so regenerate runs could return identical ordered lists.
  - Fix:
    - added deterministic, reproducible tie-break jitter keyed by:
      - `seed` (run identifier),
      - position index,
      - track id.
    - regenerate now increments run seed on the frontend and backend uses it to produce alternate deterministic selections.
  - Outcome:
    - same settings + new regenerate run => different but reproducible playlist ordering/candidate picks.

- Files updated:
  - `static/index.html`
  - `static/style.css`
  - `app.py`

- Validation:
  - `node --check static/app.js` passed.
  - `python3 -m compileall -q -f -b app.py` passed.

### 2026-04-03 (Modern terminology + expanded vibe presets)
- User request:
  - Add more Strategy and Vibe options.
  - Make wording more fun/modern.
  - Ensure regenerate actually returns different song options.

- UX copy updates:
  - `Strategy` -> `Mix style`
  - Strategy labels updated:
    - `Track DNA` (`seed`)
    - `Genre Lane` (`genre`)
    - `Blend Mode` (`hybrid`)
  - `Target genre` -> `Genre lane`
  - `Reference songs` -> `Reference tracks`

- Vibe expansion:
  - Added additional vibe options in UI:
    - `Hype`
    - `After Hours`
    - `Deep Focus`
    - `Bright Pop`
    - `Dark & Heavy`
    - `Cardio`
    - plus existing `Balanced`, `Chill`
  - Added corresponding frontend + backend mood presets:
    - `hype`, `bright_bouncy`, `dark_heavy` (new)
    - existing keys retained for compatibility.

- Regenerate hardening:
  - Frontend now sends `regenerate: true` on regenerate runs.
  - Backend uses regenerate mode to choose from a top candidate window per step (seeded), not only best-ranked item.
  - Outcome: regenerate reliably yields alternate high-quality playlists under deterministic mode.

- Files updated:
  - `static/index.html`
  - `static/app.js`
  - `app.py`

- Validation:
  - `node --check static/app.js` passed.
  - `python3 -m compileall -q -f -b app.py` passed.

### 2026-04-03 (Playlist detail hero: connected DAP dropdown)
- User request:
  - Playlist detail hero should not render all DAPs as individual buttons.
  - Replace with scalable dropdown and only show connected DAPs.

- Implementation:
  - Refactored playlist hero DAP export UI from per-device pill list to a single dropdown trigger:
    - Label: `Connected DAPs (N)`
    - Menu entries: connected devices only (`mounted == true` from `/daps`).
  - Added empty-state copy when no devices are connected:
    - `No connected DAPs detected`
  - Added dropdown behavior helpers:
    - `togglePlaylistDapMenu()`
    - `closePlaylistDapMenu()`
    - `pickConnectedDapExport(did)`
  - Added close behavior:
    - outside-click closes menu
    - `Escape` closes menu

- Styling:
  - Added new playlist DAP dropdown styles for trigger/menu/item states to match existing TuneBridge hero aesthetics.

- Files updated:
  - `static/app.js`
  - `static/style.css`

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-03 (Playlist detail hero compact pass + DAP dropdown persistence)
- User request:
  - Tighten Playlist Detail hero vertical footprint.
  - Keep DAP export dropdown visible even with no connected DAPs.
  - Remove Smart Playlist CTA from hero.
  - Make Delete Playlist action compact (pill style), not full-width.

- Implementation:
  - Removed hero-level Smart Playlist button from playlist detail header.
  - Updated DAP export render logic:
    - Dropdown always renders.
    - Trigger now shows:
      - `Connected DAPs (N)` when mounted devices exist.
      - `No DAP Connected` when none are mounted.
    - Empty-state menu item is shown disabled with guidance copy.
  - Compact hero layout refinements:
    - Reduced header padding, margins, and inter-element gaps.
    - Reduced playlist cover dimensions across desktop/tablet/mobile breakpoints.
    - Reduced title/stat spacing and play button bottom margin.
    - Increased action spacing consistency between hero controls.
  - Delete Playlist CTA styling updated to match compact pill treatment:
    - `align-self: flex-start`
    - rounded pill radius + compact padding
    - subtle elevated background/border consistent with app action pills.

- Files updated:
  - `static/index.html`
  - `static/app.js`
  - `static/style.css`

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-03 (Playlist hero balance + queue clear safety)
- User request:
  - Playlist hero: move delete action to right side as icon-only, improve visual balance, and make cover ratio more prominent.
  - Player queue: `Clear` should preserve currently playing track to avoid playback errors.

- Implementation:
  - Playlist hero:
    - Moved delete control to top-right in hero container.
    - Converted delete CTA to icon-only bin button with tooltip + aria label.
    - Adjusted hero spacing/padding to remain compact while preserving button separation.
    - Updated cover dimensions to a portrait ratio for stronger visual prominence next to title/meta.
  - Queue clear behavior:
    - `Player.clearQueue()` now keeps current track when one is active.
    - Clears only history/upcoming items; queue resets to `[currentTrack]` and keeps playback stable.
    - Falls back to full clear only when no current track exists.

- Files updated:
  - `static/index.html`
  - `static/style.css`
  - `static/player.js`

- Validation:
  - `node --check static/app.js` passed.
  - `node --check static/player.js` passed.

### 2026-04-03 (Playlist hero cover ratio correction)
- User request:
  - Keep Playlist Detail hero cover strictly 1:1.

- Implementation:
  - Updated `#view-playlist .playlist-cover-wrap` dimensions to square across breakpoints:
    - desktop: `122x122`
    - <=1200px: `112x112`
    - <=860px: `104x104`

- Files updated:
  - `static/style.css`

### 2026-04-04 (Add DAP modal + template-driven sync roots)
- Goal:
  - Improve Add DAP UX to support configurable DAP music location and folder-structure templates.
  - Ensure sync scan/copy logic uses this configuration bidirectionally.
  - Keep migration behavior copy-only (do not delete old DAP files).

- Add DAP modal updates:
  - Added `Storage location` selector (`SD card` / `Internal storage`).
  - Added `Music folder on DAP` input + browse (relative to mount root expected).
  - Added `Folder structure` preset selector and custom token template builder.
  - Added token chips (`%artist%`, `%albumartist%`, `%album%`, `%track%`, `%title%`, `%year%`, `%genre%`).
  - Added live template preview line.
  - Added help/disclaimer copy:
    - one active storage location per DAP profile
    - sync uses configured folder + template
    - remap is copy-only when template changes.

- DAP data model changes:
  - New fields persisted per DAP:
    - `storage_type` (`sd`/`internal`)
    - `music_root` (relative folder under mount path; default `Music`)
    - `path_template` (default `%artist%/%album%/%track% - %title%`)
  - Added load-time normalization/migration for existing `daps.json` records.

- Sync engine changes:
  - Device scan root now uses DAP-configured `mount_path + music_root` instead of hardcoded `mount/Music`.
  - Local-to-device diff now uses template-rendered expected paths from library metadata.
  - Added case-insensitive path matching for diffing (reduces case-sensitivity false positives across filesystems).
  - Added sanitization for invalid FAT/exFAT path characters and problematic segments.
  - Added pre-sync warnings list (missing metadata, sanitized paths, potential case collisions).
  - Added `local_copy_map` so selected device-target paths map back to local source paths during copy.

- Sync preview UI updates:
  - Added `Needs review` section with warning count and detailed issues before execution.

- Migration behavior:
  - Template changes produce new `Copy to device` candidates (copy-only remap behavior).
  - Existing old-layout device files are not auto-deleted.

- Files updated:
  - `static/index.html`
  - `static/app.js`
  - `static/style.css`
  - `app.py`

- Validation:
  - `node --check static/app.js` passed.
  - Python syntax validated via AST parse: `python3 -c "import ast, pathlib; ast.parse(pathlib.Path('app.py').read_text())"`.

### 2026-04-04 (Add DAP template UX polish)
- User-requested UX refinements:
  - Moved long path-template help copy behind a compact `?` help button.
  - Made token chips human-readable (hide `%...%` in labels).
  - Enforced terminal `Title` behavior in token builder:
    - once `Title` token is present, token chips are disabled.
  - For `Folder structure = Custom`, template input placeholder is cleared (no guide text in textbox).
  - Added live path-template validation with inline warnings + save-time guard.

- Validation rules added (path template field):
  - must not be empty
  - must include `Title` token
  - must use `/` separators (not `\\`)
  - must not contain `//`
  - must not include invalid filesystem characters
  - `Title` token must be terminal (no folder tokens after it)

- Files updated:
  - `static/index.html`
  - `static/app.js`
  - `static/style.css`

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-04 (Add DAP template UX refinements v2)
- User-requested updates:
  - Clear path template when `Folder structure` is switched to `Custom`.
  - Provide more explicit guidance around `Title` terminal behavior.
  - Improve alignment of helper text with form fields.
  - Make preview visually distinct from help text.

- Implemented:
  - `Custom` preset now clears `Path template` value and removes placeholder guidance text.
  - Added template status banner under token chips:
    - warning state: asks user to select `Title` last.
    - ready state: explains `Title` is already selected and token chips are locked.
  - Updated blocked-token toast with verbose explanation about why tokens are disabled after `Title`.
  - Converted top helper paragraphs to aligned inline hints (`settings-hint-inline`) so they line up with input column.
  - Upgraded preview UI to a dedicated preview card with icon/title + code styling.
  - Help note styling refined with left accent border for separation from preview.

- Files updated:
  - `static/index.html`
  - `static/app.js`
  - `static/style.css`

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-04 (Add DAP template simplification)
- User-requested simplification:
  - Keep path-template options to `Artist`, `Album`, `Year`, `Genre` only.
  - Auto-generate file name segment (`%track% - %title%`) instead of exposing Title/Track token picks.
  - Remove title-terminal messaging.
  - Show preview as single-line path with folder icon and include selected `Music folder on DAP` root.

- Implemented:
  - Token chips reduced to: Artist / Album / Year / Genre.
  - Path template field is now read-only and generated from selected chips.
  - Presets updated to map into allowed folder-token combinations only.
  - `Custom` preset now clears the template field; users build structure by toggling chips.
  - Preview switched to single-line compact card:
    - format: `📁 <music_root>/<rendered_path>`
  - Removed prior title-lock status messaging from UI and logic.

- Files updated:
  - `static/index.html`
  - `static/app.js`
  - `static/style.css`

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-05 (DAP mount identity hardening: UUID/device-id recognition)
- Requirement implemented:
  - DAP connectivity should remain stable even when users rename SD cards/volumes.
  - Add UUID-based recognition with backward-compatible path fallback.

- Backend (`app.py`) updates:
  - `/api/system/mounts` now returns identity metadata per mount:
    - `volume_uuid`
    - `disk_uuid`
    - `device_identifier`
  - Added mount identity helpers:
    - `_normalize_mount_id(...)`
    - `_mount_identity_fields()`
    - `_dap_mount_identity(...)`
    - `_mount_matches_dap(...)`
    - `_resolve_dap_mount(...)`
  - macOS mount discovery now enriches each mount using:
    - `diskutil info -plist <mount-path>`
    - parsed via `plistlib`
  - DAP persistence model now stores mount identity fields:
    - `mount_volume_uuid`
    - `mount_disk_uuid`
    - `mount_device_identifier`
  - `load_daps()` migration normalizes/backfills these fields for existing DAP records.
  - DAP mounted-state evaluation now resolves mount by identity first, then path fallback:
    - `/api/daps` (list)
    - `/api/daps/<id>` (detail)
    - `/api/health/status`
  - Export/sync flows now resolve live mount from identity-aware resolver:
    - `get_dap_music_path(...)`
    - `/api/daps/<id>/export/<pid>`
    - `/api/iems/<iid>/peq/<peq_id>/copy`
    - sync space checks use resolved mount root.

- Frontend (`static/index.html`, `static/app.js`) updates:
  - Add DAP modal now includes hidden identity fields:
    - `dap-mount-volume-uuid`
    - `dap-mount-disk-uuid`
    - `dap-mount-device-identifier`
  - Device dropdown selection stores identity metadata alongside `mount_path`.
  - Edit DAP preloads stored identity and preselects currently connected mount by identity.
  - Manual path mode clears identity fields (explicitly path-only mode).
  - Save payload now submits the three new mount identity fields.
  - Mount refresh logic now matches by identity first, then by path.

- Compatibility behavior:
  - Existing DAP profiles without identity fields continue to work via legacy path fallback.
  - Newly saved/edited DAP profiles become resilient to volume renames.

- Validation:
  - `node --check static/app.js` passed.
  - Python syntax validated via AST parse:
    - `python3 -c "import ast, pathlib; ast.parse(pathlib.Path('app.py').read_text()); print('ok')"`

### 2026-04-05 (Gear DAP cards: compact two-row layout)
- UX update:
  - Reduced DAP card vertical footprint in Gear view.
  - New structure aligns with requested pattern:
    - Row 1: DAP label, device name, connection status
    - Row 2: Music sync status, playlist sync status, compact detail text

- Implementation:
  - `loadDapsView()` now renders DAP cards with dedicated compact classes:
    - `gear-card-dap`
    - `gear-card-dap-top`
    - `gear-card-dap-bottom`
  - Low-space warning now appears as compact detail text in row 2 (`Short <bytes>`), instead of an extra row.
  - Added DAP-specific styling in CSS so IEM cards are not affected.

- Files updated:
  - `static/app.js`
  - `static/style.css`

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-05 (Gear Add IEM modal aligned to Add DAP pattern)
- UX/UI alignment update:
  - Refactored `Add IEM / Headphone` modal to match `Add DAP` modal structure and visual language.
  - Applied the same section-card pattern, label/help layout, and action footer rhythm.

- Implemented:
  - Modal shell switched to shared `dap-modal-shell` style treatment for consistent depth and contrast.
  - Added section blocks:
    - `Profile` (name, type)
    - `Measurement Sources` (up to 3 source label + URL rows)
  - Added `?` help toggle for source guidance (`toggleIemHelp`).
  - Moved source guidance into inline help panel (instead of static paragraph) to match DAP interaction pattern.
  - Error feedback now uses shared inline validation styling (`dap-inline-validation`) for consistency.
  - Save button label updated to `Save IEM`.

- Files updated:
  - `static/index.html`
  - `static/app.js`
  - `static/style.css`

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-05 (Gear DAP cards + detail status language refinement)
- User-requested UX updates:
  - Removed redundant `DAP` label chip from Gear DAP cards.
  - Updated music/playlist sync messaging to plain-language states.
  - Removed device-type/model chip from DAP detail hero.
  - Added connection + music + playlist sync pills to DAP detail hero (aligned with card semantics).

- Status language now:
  - Music:
    - `Music: Synced`
    - or `Music: X new / Y removed`
  - Playlists:
    - `Playlists: Synced`
    - or `Playlists: Out of sync` + detail (`N new · M out of sync`)

- Implementation details:
  - Added shared formatters in `static/app.js`:
    - `_dapMusicStatus(summary)`
    - `_dapPlaylistStatus(dap, summary)`
  - Reused formatters in both:
    - `loadDapsView()` card rendering
    - `showDapDetail()` hero rendering

- Files updated:
  - `static/app.js`

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-05 (Gear screen card scalability + signal density pass)
- Design alignment pass for Gear list views (`DAP` + `IEM`) based on Luminous Depth:
  - improved at-a-glance relevance while keeping cards compact.
  - added scalable grid behavior for larger device libraries.

- DAP cards:
  - Added identity subline under title:
    - `<model> • <active mount label/path>`
  - Keeps card useful when many similarly named devices are added.
  - Sync pills remain prominent, with playlist breakdown included in pill text.

- IEM cards:
  - Expanded quick status row to include:
    - gear type pill (`IEM` / `Headphone`)
    - FR readiness (`FR Ready` / `No FR`)
    - source count (`Sources N`)
    - PEQ count (`PEQ N`)
  - Ensures users can compare readiness and configuration coverage without opening each detail page.

- Layout/scalability:
  - Gear grid changed from fixed 2-column to responsive auto-fit:
    - `repeat(auto-fit, minmax(360px, 1fr))`
    - falls back to single-column on narrower widths.

- Files updated:
  - `static/app.js`
  - `static/style.css`

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-05 (Gear card pill hierarchy tuning)
- Follow-up visual hierarchy refinement to improve scanability:
  - Critical state pills (`synced` / `out of sync`) now have stronger contrast and subtle glow outlines.
  - Neutral metadata pills (`Sources`, `PEQ`) are intentionally quieter via new `gear-sync-neutral` style.

- Rationale:
  - First glance should prioritize actionable status (connection/sync).
  - Secondary metadata remains visible but no longer competes with critical status color channels.

- Files updated:
  - `static/style.css`
  - `static/app.js`

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-05 (IEM comparison modal FR chart aspect-ratio rebalance)
- UX issue addressed:
  - FR comparison chart appeared too horizontally stretched, reducing readability.

- Changes:
  - Narrowed comparison modal max width:
    - from `min(1040px, 96vw)` to `min(940px, 92vw)`
  - Reworked chart container sizing:
    - removed overly wide/flexible behavior
    - set explicit responsive height with clamp:
      - desktop: `clamp(340px, 48vh, 520px)`
      - small screens: `clamp(300px, 44vh, 420px)`
  - Forced canvas to fully fill chart container (`width/height: 100%`) for predictable rendering.

- File updated:
  - `static/style.css`

### 2026-04-05 (Settings screen refinement + FR Baseline alignment fix)
- Scope:
  - UI cleanup and scalability pass for Settings view to better match Luminous Depth guidelines.
  - Fixed Frequency Response Baselines add-row alignment and list readability.

- Settings screen improvements:
  - Added dedicated Settings view atmospheric background (`#view-settings`) to match app-wide visual language.
  - Increased section-card depth using tonal gradients + soft ambient shadow.
  - Tightened section overline typography (`Label-Sm` style treatment).
  - Replaced several inline layout styles with reusable classes:
    - `settings-inline-actions`
    - `settings-inline-actions-wrap`
    - `settings-hint-inline-start`
    - `settings-hint-block-gap`

- Frequency Response Baselines UI cleanup:
  - Intro and example text moved to dedicated classes for consistent spacing.
  - Baseline list rows now use a stable grid:
    - color dot | name | URL | Remove action
  - Baseline remove action switched to compact pill button (`baseline-remove-btn`) for cleaner alignment.
  - Add row redesigned as responsive grid:
    - Label input | URL input | color picker | Add button
  - Enforced consistent control heights across row elements.
  - Added responsive breakpoints for tablet/mobile wrapping without misalignment.

- Files updated:
  - `static/index.html`
  - `static/style.css`
  - `static/app.js`

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-05 (Gear card responsive alignment + copy simplification)
- DAP cards:
  - Reworked status-pill layout for responsive stability:
    - desktop: 2-column grid (`music` + `playlist`)
    - compact widths: single-column stack
  - Prevented long label overflow by truncating text inside each pill and moving details to a dedicated secondary line.
  - Removed verbose label prefixes and switched to icon-led status pills for space efficiency.
  - Simplified status copy:
    - `Library in sync` / `Library update needed`
    - `Playlists up to date` / `Playlists need sync`
    - details shown separately as `+X to copy`, `Y extra on device`, `N new`, `M changed`.

- IEM/Headphone cards:
  - Removed zero-value PEQ pill.
  - `PEQ N` now renders only when `N > 0`.

- Files updated:
  - `static/app.js`
  - `static/style.css`

- Validation:
  - `node --check static/app.js` passed.

### 2026-04-05 (Sync regression fix: false mismatches + noisy review cleanup)
- Issue investigated:
  - Sync review showed massive false diffs (thousands in both directions) even when local and device libraries were effectively in sync.
  - Filenames in preview appeared corrupted/underscored.
  - Warning list flooded with low-signal entries.

- Root cause:
  - Filesystem sanitization regex had a malformed character-class escape, causing normal filename characters to be replaced with `_`.
  - This broke expected path generation, so almost every file looked mismatched.

- Backend fixes (`app.py`):
  - Corrected invalid-filesystem-char regex:
    - `_INVALID_FS_CHARS_RE = re.compile(r'[<>:"/\\|?*\\x00-\\x1f]')` (effective pattern now matches only real invalid chars and control range).
  - Added stricter local track filtering by extension during sync mapping (`_is_music_file_path`) so only music files are considered.
  - Expanded supported sync extension set for parity with broader library formats.
  - Added dual-path matching guardrail per track:
    - considers both rendered template path and original local relative path as valid expected matches.
    - prevents false diffs when device already has local-structured files but template mapping differs.
  - Added destination collision detection for rendered paths and emits explicit collision warnings.
  - Reduced warning noise:
    - suppresses low-signal “missing metadata” warnings for optional tokens (`track`, `discnumber`, `year`, `genre`, `albumartist`).
    - caps warning list to 250 entries with overflow summary.

- Sync review UX fix (`static/style.css`):
  - `Select all` control in sync review header now uses no-wrap and no-shrink behavior for stable alignment.

- Validation:
  - `python3` AST parse of `app.py` passed.
  - `node --check static/app.js` passed.
  - Live AP80 verification (mounted `/Volumes/AP80`, cache from `/Volumes/Storage/Music/FLAC`):
    - `sync_scan` result: `0` files to copy to device, `0` files to copy to local.
    - Warnings: `0`.
    - Device free space read successfully.

### 2026-04-05 (Manual "Check Sync Status" + live local-files sync reliability)
- Implemented manual sync verification actions:
  - Gear Home (`Digital Audio Players`): new `Check Sync Status` action.
  - DAP Detail: per-device `Check Sync Status` action.
  - New backend routes:
    - `POST /api/daps/sync-status/check`
    - `POST /api/daps/<did>/sync-status/check`
- Added sync summary confidence/state model:
  - `sync_status_state`: `estimated | checking | verified | error`
  - `sync_status_message`
  - `last_verified_at`
- Reliability fix for song diff checks:
  - Root cause: previous sync diff relied on cached/in-memory `library` rows only, so newly-added filesystem files not yet in cache were invisible to sync checks.
  - Fix: sync diff now builds candidates from live local filesystem (`walk_music_files(get_music_base())`) and augments with cached metadata only when available.
  - Result: newly-added tracks are detected without requiring a full library rescan first.
- Verified with real user-reported case:
  - Local: `/Volumes/Storage/Music/FLAC/Dire Straits/Dire Straits`
  - Device: `/Volumes/AP80/Music/Dire Straits/Dire Straits`
  - New diff correctly reports 7 missing `.flac` files to copy to AP80.

### 2026-04-05 (Gear first-load performance: no deep sync/mount probing)
- Clarified and enforced behavior:
  - Gear home does **not** run deep sync-status checks on first load.
  - Live/deep checks are initiated only by explicit user action (`Check Sync Status`).
- Performance tweak:
  - `_discover_mount_points()` now supports `include_identity` flag.
  - `/api/daps` uses `include_identity=False` fast path to avoid expensive per-volume `diskutil info -plist` calls during initial card rendering.
  - Identity-aware/deep checks remain in explicit sync verification paths.

### 2026-04-05 (DAP detail open performance + trusted sync labels)
- DAP detail open performance:
  - Updated `GET /api/daps/<did>` mount discovery to use fast mount listing (`include_identity=False`) during detail open.
  - This removes slow deep identity probing from the detail-page critical path and improves open responsiveness.

- Sync status trust model on Gear/DAP detail:
  - Prevented misleading `Synced` badges when devices are not mounted or not recently verified.
  - Music sync status now shows neutral `Check status` unless all trust conditions pass:
    - device is mounted
    - `sync_status_state = verified`
    - `last_verified_at` is present
    - verification is within a 24-hour freshness window
  - Only trusted, mounted, recently verified state can render `Synced`.
  - Out-of-sync verified states still show actionable warning copy (`Library update needed`).

- UI support:
  - Added neutral tone class for DAP music value text (`gear-dap-value--neutral`) to visually separate unknown/unverified state from true warning/error.

- Files updated:
  - `app.py`
  - `static/app.js`
  - `static/style.css`

- Validation:
  - `node --check static/app.js` passed.
  - Python AST parse for `app.py` passed.

### 2026-04-05 (IEM icon refresh)
- Replaced the IEM icon asset with the latest user-provided version:
  - Source: `earphones_transparent-2.ico`
  - Output: `static/icons/iem-earphones.png`
  - Render target remains unchanged in card UI (`gear-iem-icon-image`).

- Files updated:
  - `static/icons/iem-earphones.png`

### 2026-04-05 (Favourites feature — foundational implementation)
- Added backend favourites persistence and APIs (`data/favourites.json`):
  - `GET /api/favourites`
  - `POST/DELETE /api/favourites/songs/<id>`
  - `POST/DELETE /api/favourites/albums/<id>`
  - `POST/DELETE /api/favourites/artists/<id>`
  - `PUT /api/favourites/<category>/reorder`
  - `GET /api/favourites/songs/tracks` (resolved tracks + orphan count)
  - `GET /api/favourites/songs/export/<fmt>` (`poweramp` / `ap80`)
  - `POST /api/daps/<did>/export/favourites`
- Added backup integration for favourites:
  - `favourites.json` is now included in backup export/import.

- Added UI scaffolding and interactions:
  - New sidebar nav item: `Favourites`
  - New views:
    - `view-favourites` (summary landing)
    - `view-fav-artists`
    - `view-fav-albums`
    - `view-fav-songs`
  - Star toggle UI added to:
    - Artist cards
    - Album cards
    - Track rows (tracks/songs/playlist tables)
    - Player bar (current track)
    - Context menu (track/artist/album-aware label)
  - Playlists home now shows a pinned `Favourite Songs` virtual card when favourites exist.
  - Bulk actions include:
    - `★ Favourite`
    - `☆ Unfavourite`

- Added app state + lifecycle support:
  - Global favourites state (`sets + ordered meta`) loaded on startup.
  - Track-change event bridge from `player.js` to refresh player favourite button state.
  - Favourites-aware view refresh paths after toggles.

- Files updated:
  - `app.py`
  - `static/index.html`
  - `static/app.js`
  - `static/style.css`
  - `static/player.js`

### 2026-04-06 (Design governance lock: master design + checklist + Gear CSS consolidation)
- Created a canonical design source-of-truth document:
  - `master-design.md` added at repo root.
  - Captures: design north star, principles, tokens, typography, spacing rhythm, component rules, iconography, interaction contracts, governance, and DoD.

- Locked product/design decisions in `master-design.md`:
  - Typography source of truth: keep system font stack canonical.
  - Icon policy: runtime UI emoji prohibited (hard rule); use SVG/curated assets.
  - Border policy: ghost-border fallback is standard when containment affordance is needed.
  - Grid policy: artist/album-family cards use canonical 6→5→4→3→2→1 responsive ladder.

- Added governance scaffolding:
  - New section in `README.md`: `UI Change Checklist (Required)`.
  - Checklist enforces validation against `master-design.md`, token/rhythm consistency, state coverage, and behavior contracts.

- Refactored Gear stylesheet duplication:
  - Removed redundant late-stage Gear override block in `static/style.css` (old compact/tight variant) to avoid competing declarations.
  - Kept one canonical `#view-gear` facelift block for final visual output.
  - Removed conflicting early `#view-gear` padding declaration so spacing is controlled by the canonical block.

- Files updated:
  - `master-design.md` (new)
  - `README.md`
  - `static/style.css`
  - `codex.md`

### 2026-04-06 (Player Improvements v1 finalization on `feature/player-improvements-v1`)
- Finalized Custom PEQ workspace, PEQ graph behavior, and player EQ interactions for production readiness.

- Custom PEQ workspace implementation and UX decisions:
  - Workspace title standardized to **Custom PEQ**.
  - Added a new entry point in **Settings → Parametric EQ** (`Open Custom PEQ Workspace`).
  - Removed noisy workspace open/close toasts.
  - Workspace graph uses IEM-detail graph conventions (L/R base curves + Custom PEQ overlay + optional baseline targets).
  - Baselines are only rendered when explicitly selected; **No target selected** shows no target overlays.
  - Added divider + tightened layout around graph/preamp/table.
  - Preamp input width aligned to PEQ table numeric-field density (same compact width intent as Q field).

- Dirty-state (`Unsaved changes`) behavior fixes:
  - Loading an existing PEQ no longer triggers dirty state.
  - Loading a new PEQ template no longer triggers dirty state.
  - Dirty pill appears only on actual value edits.
  - Resolved stale-baseline issue by snapshotting right after profile/new-state hydration.

- EQ button behavior and active-state fixes:
  - EQ button no longer closes Custom PEQ workspace when workspace is already open (no-op while open).
  - Removed forced “Custom PEQ selected” side effects when merely opening workspace.
  - Active state now reflects true PEQ selection intent:
    - active for selected non-custom profile, or
    - active for meaningful custom PEQ configuration only.

- Backend/API additions for Custom PEQ graphing:
  - Added `POST /api/iems/<iid>/graph/custom` for workspace graph payloads.
  - Added `POST /api/peq/graph/custom` support path for custom graph rendering without selected IEM fallback usage.
  - Baseline inclusion logic is selection-driven (`baseline_ids`) to avoid unintended overlays.

- Validation performed:
  - `node --check static/app.js` passed.
  - `node --check static/player.js` passed.
  - Python compile parse for `app.py` passed.

- Branch commits (key):
  - `df10daf` — Fix Custom EQ workspace UX and functional FR graph rendering
  - `278fbb4` — Update bundled TuneBridge latest DMG
  - `839cb4a` — Fix Custom PEQ dirty-state, EQ button behavior, and workspace UI alignment

- Packaging/distribution note:
  - Latest local `distro/TuneBridge-latest.dmg` included in branch updates.

### 2026-04-08 (mpv output-device reliability, playback-state preservation, and Settings playback UX refinements)
- Stabilized mpv reinitialization behavior:
  - Persist and reapply runtime mpv state across reinit paths:
    - volume (`_mpv_last_volume`)
    - active PEQ/lavfi chain (`_mpv_last_af`)
  - Prevents audible regressions when reinitializing for sample-rate changes, exclusive-mode toggles, and output-device switches.

- Preserved play/pause intent across device/exclusive changes:
  - Backend now returns `was_playing` with:
    - `POST /api/player/audio_device`
    - `POST /api/player/exclusive`
  - Frontend resume logic now respects this flag so paused sessions remain paused after reinit.

- Hardened output-device selection and effective-device reporting:
  - Fixed player-popover device selection binding bug by switching to `data-device` + dataset-based click handling.
  - Added backend validation of requested device names against current mpv-visible device list; falls back to `auto` when unavailable.
  - `player_capabilities` now reports effective runtime `audio_device` from mpv (when available), not only saved settings.
  - `player_set_audio_device` response now includes:
    - `requested_device`
    - effective `audio_device`
  - Frontend now syncs popover/settings selection from effective applied device and surfaces fallback in toast.

- Fixed player transport UI state while output popover is open:
  - In mpv mode, `_loadTrack()` now updates the play/pause button immediately after setting `ps.isPlaying = true`.
  - Resolves case where audio starts but button icon remains on play.

- Playback settings UI reorganization and polish:
  - Moved Playback controls out of nested `App` subsection into a standalone **Playback** settings section.
  - Kept **App** section focused on restart/reload action.
  - Refined row layout with consistent content/control alignment and responsive behavior.
  - Improved hint text measure and spacing for readability.

- Player output popover active-state visuals:
  - Active output now indicated by a green status dot with subtle glow.
  - Active row text color normalized for readability against the current visual theme.

- Files updated:
  - `app.py`
  - `static/app.js`
  - `static/index.html`
  - `static/player.js`
  - `static/style.css`
  - `codex.md`
