## TuneBridge Release

This folder is the public handoff location for installer artifacts.

- `TuneBridge-latest.dmg`: latest shareable macOS installer build.
- Current release: `v0.542` (`2026-06-26`).

Older timestamped DMGs remain local-only and are not committed.

### Feature Highlights

- Local-first FLAC/music library manager for macOS with no cloud service or subscription.
- Browse by artists, albums, songs, playlists, and library insights.
- Albums support grid, dense grid, list, and Cover Flow layouts, including keyboard/mouse navigation and last-selected album memory.
- Build playlists with drag-and-drop ordering, multi-select, duplicate handling, custom artwork, pinned playlists, and playlist filtering/sorting.
- Import M3U/M3U8 playlists with mapping for unmatched tracks.
- Resolve broken playlists by finding missing tracks and applying suggested replacements or removals.
- Export playlists as M3U, M3U8, XML, or CSV.
- Generate Smart Playlists from vibe/style/reference-track controls, or save refreshable Smart Rules discovery playlists.
- In-app player with queue drawer, shuffle/repeat, crossfade, quality display, PEQ popover, keyboard shortcuts, and context-aware playback.
- Optional mpv/libmpv bit-perfect playback mode with output-device handling.
- Manage DAP profiles, export playlists directly to devices, and run bidirectional music sync with diff preview and progress.
- Rockbox PEQ copy converts APO/AutoEQ filters to Rockbox `.cfg` files.
- Manage IEM/headphone measurements from squig.link, compare frequency response overlays, add target baselines, and import PEQ profiles.
- Library Insights cover file formats, sample rates, bit depth, tag health, genre distribution, sonic profile, gear fit, and unplayed album discovery.
- File Organisation wizard supports library reorganisation and song imports with templates, field chips, live previews, duplicate checks, and failed-file reporting.
- Export the full library catalogue to CSV with selectable columns.
- Backup/restore app data, run health checks, configure artist artwork lookup, ReplayGain, update checks, and other app settings.
- Full Help Center page explains setup, workflows, export paths, and where TuneBridge stores files.

### Install Notes

1. Open `TuneBridge-latest.dmg`.
2. Drag `TuneBridge.app` to `Applications`.
3. Launch TuneBridge from Applications.

Because this build is unsigned/not notarized, macOS may require a first launch via right-click `Open`, or `System Settings -> Privacy & Security -> Open Anyway`.
