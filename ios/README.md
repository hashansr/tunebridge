# TuneBridge iOS

Companion iOS app for [TuneBridge](https://github.com/hashansr/tunebridge) — lossless music playback with real-time PEQ, synced from your Mac over WiFi.

## What it does

| Feature | Detail |
|---|---|
| **Lossless playback** | FLAC, ALAC, WAV, AIFF via AVAudioEngine |
| **Real-time PEQ** | APO/AutoEQ profiles synced from TuneBridge Mac, applied via AVAudioUnitEQ |
| **WiFi sync** | Files pushed from TuneBridge Mac over local network (Bonjour discovery, port 7891) |
| **Playlists** | Playlists synced from Mac, played locally |
| **Lock screen / AirPods** | Full MPRemoteCommandCenter + MPNowPlayingInfoCenter |
| **Queue** | Shuffle, repeat, queue drawer |

## Requirements

- iOS 16.0+
- Xcode 15+
- Apple Developer account (for device deployment)
- TuneBridge running on Mac (same WiFi network for sync)

## Getting started

```bash
cd ios/
bash setup.sh        # installs xcodegen, generates TuneBridge.xcodeproj
open TuneBridge.xcodeproj
```

In Xcode:
1. Set your **Team** in Signing & Capabilities
2. Select a device or simulator (iOS 16+)
3. Build and run (⌘R)

On first launch:
- Allow **Local Network** access (required for WiFi sync)

## Architecture

```
ios/
├── project.yml                    xcodegen spec
├── setup.sh                       one-command project setup
└── TuneBridge/
    ├── App/
    │   ├── TuneBridgeApp.swift    @main entry, injects environment objects
    │   └── AppState.swift         global UI state (tab, sheet presentation)
    ├── Models/
    │   ├── Track.swift            Track, Album, Artist, LibrarySnapshot
    │   ├── Playlist.swift         Playlist, PlaylistsStore
    │   └── PEQProfile.swift       PEQFilter, PEQProfile, IEMRecord
    ├── Audio/
    │   ├── AudioEngine.swift      AVAudioEngine + PEQ + queue/shuffle/repeat
    │   └── NowPlayingManager.swift lock screen info + remote commands
    ├── Library/
    │   └── LibraryManager.swift   reads library.json, builds Artist/Album hierarchy
    ├── Sync/
    │   ├── SyncServer.swift       HTTP receiver (NWListener, port 7891)
    │   └── SyncManager.swift      Bonjour discovery + sync state
    ├── DesignSystem/
    │   ├── TBColors.swift         Obsidian palette matching TuneBridge web
    │   └── TBComponents.swift     TBCard, TrackRow, ArtworkView, TBEmptyState, …
    └── Views/
        ├── ContentView.swift      TabView root + MiniPlayer overlay
        ├── Library/               LibraryView → ArtistDetailView → AlbumDetailView
        ├── Playlists/             PlaylistsView → PlaylistDetailView
        ├── Player/                NowPlayingSheet + MiniPlayerView
        ├── Sync/                  SyncView
        └── Settings/              SettingsView + PEQProfilesView
```

## Sync protocol

The iOS app runs an HTTP-like server on **port 7891**, advertised via Bonjour as `_tunebridge._tcp`.

TuneBridge on Mac connects to it and pushes files:

| Request | Purpose |
|---|---|
| `GET /sync/status` | Returns on-device file list for delta computation |
| `POST /sync/file` | Uploads a single file (headers: `X-TB-Path`, `X-TB-Type`, `Content-Length`) |
| `POST /sync/done` | Signals end of batch; iOS reloads library |

**File types**: `music`, `playlist`, `artwork`, `peq`, `library`, `iems`

## Data format

All data formats match TuneBridge desktop exactly for zero-friction sync:

| File | Format |
|---|---|
| `library.json` | `{tracks: [...], scannedAt, version}` |
| `playlists.json` | `{playlists: [...]}` or `[...]` (both supported) |
| `iems.json` | `{iems: [{id, name, peq_profiles: [...]}]}` |
| Artwork | `{artworkKey}.jpg` — MD5(artist+album) |
| Music | `Music/{Artist}/{Album}/{Track}` |

## Phase 2 roadmap

- [ ] Mac-side "Sync to iPhone" button in TuneBridge sidebar
- [ ] Background URLSession for sync (survive app switching)
- [ ] Selective sync (choose playlists / artists to sync)
- [ ] Smart Playlist generation on iOS
- [ ] CarPlay support
- [ ] iPad split-view layout
