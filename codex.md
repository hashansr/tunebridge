# TuneBridge Codex Memory

Last updated: 2026-04-02 (Australia/Sydney)
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
  - `PYTHONPYCACHEPREFIX=/tmp python3 -m py_compile app.py` passed.
