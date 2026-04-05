# Favourites — Product Requirements Document

**Status:** Approved for implementation
**Last updated:** 2026-04-05

---

## 1. Overview

Users can mark songs, albums, and artists as favourites using a star toggle. Favourites are accessible from a dedicated **Favourites** section in the Library sidebar. Favourite Songs also surface as a pinned virtual playlist on the Playlists home, and can be exported to DAPs and kept in sync.

---

## 2. Goals

- Make it fast and frictionless to save songs, albums, and artists you love
- Surface favourites as a first-class section alongside Artists, Albums, Songs
- Treat Favourite Songs like a playlist — queue it, export it, sync it to a DAP
- Stay consistent with the rest of the app's UI patterns (no new visual language)

---

## 3. Non-Goals (v1)

- Favouriting playlists
- A rating system (1–5 stars) — favourites are binary only
- Sync to streaming services
- "Love" as a distinct concept from "Favourite"
- Smart playlists driven by favourites

---

## 4. Data Model

### `data/favourites.json`

Each category is an ordered array. Array position = the user's manual sort order. `added_at` is a Unix timestamp enabling "recently added" sort.

```json
{
  "songs": [
    { "id": "md5_of_path",     "added_at": 1712345678 },
    { "id": "md5_of_path_2",   "added_at": 1712345900 }
  ],
  "albums": [
    { "id": "artwork_key",     "added_at": 1712345678 },
    { "id": "artwork_key_2",   "added_at": 1712346000 }
  ],
  "artists": [
    { "id": "the beatles",     "added_at": 1712345678 },
    { "id": "radiohead",       "added_at": 1712346001 }
  ],
  "dap_exports": {
    "dap_id_1": 1712349000
  }
}
```

**Identity keys:**

| Category | Key | Rationale |
|---|---|---|
| Songs | `track.id` — MD5 of relative file path | Already used; stable within a rescan |
| Albums | `artwork_key` — MD5 of `"{artist}||{album}"` | Already used for artwork caching |
| Artists | Normalized artist name (lowercased) | Durable across file moves within same artist |

**New items are prepended** (position 0) so the default view is most-recently-favourited first.

**DAP export tracking** mirrors the existing `playlist_exports` pattern in playlists. `dap_exports[dap_id]` stores the Unix timestamp of the last export, so the sync status (up-to-date / stale) can be computed the same way.

### Orphaned references

After a library rescan, a favourited track's ID can become stale if its file path changed. On load:
- Resolve each song ID against the live library
- Silently skip any that no longer exist
- Surface a subtle, dismissible notice: *"X favourited song(s) are no longer in your library"*
- Do **not** auto-delete orphaned entries — the user may re-add the file later

Albums and artists are string-keyed and more durable; only disappear if the artist/album is fully removed from the library.

---

## 5. Backend API

### Endpoints

```
GET    /api/favourites
       → { songs: [...], albums: [...], artists: [...], dap_exports: {...} }

POST   /api/favourites/songs/<track_id>
DELETE /api/favourites/songs/<track_id>

POST   /api/favourites/albums/<artwork_key>
DELETE /api/favourites/albums/<artwork_key>

POST   /api/favourites/artists/<artist_id>
DELETE /api/favourites/artists/<artist_id>

PUT    /api/favourites/<category>/reorder
       body: { "order": ["id1", "id2", "id3"] }

GET    /api/favourites/songs/tracks
       → resolved track objects (same shape as /api/library/tracks), in favourites order

GET    /api/favourites/songs/export/<fmt>
       → M3U download   fmt = "poweramp" | "ap80"

POST   /api/daps/<did>/export/favourites
       → copies Favourite Songs M3U to DAP, records timestamp in favourites.dap_exports
```

All POST/DELETE operations return the updated category array so the frontend can sync state in one round-trip.

### Backup

`favourites.json` is included in the existing `GET /api/backup/export` ZIP and restored via `POST /api/backup/import`.

---

## 6. Frontend State

```js
// Added to the global state object
state.favourites = {
  songs:   new Set(),   // track IDs
  albums:  new Set(),   // artwork keys
  artists: new Set(),   // normalized artist names
}
```

Loaded once on app init alongside playlists. Updated optimistically on every toggle (no spinner, instant UI response) then confirmed/corrected by the API response.

**Toggle function:**

```js
App.toggleFavourite(type, id)
// type: 'songs' | 'albums' | 'artists'
// id:   track ID, artwork key, or normalized artist name
```

Internally: updates `state.favourites[type]`, re-renders any star icons for that item, then calls the appropriate POST or DELETE endpoint.

---

## 7. Star Toggle — Visual Design

**Icon:** Outlined star ☆ (unfavourited) / filled star ★ (favourited). SVG, no emoji.

**Colour:**
- Unfavourited, idle: transparent / not visible
- Unfavourited, hover: dim grey (opacity ~0.4)
- Favourited: accent amber — `#f5c542` (distinct from the blue `#adc6ff` accent to give it warmth)

**Behaviour:** Single click toggles. No confirmation. Instant visual feedback.

**Placement across the UI:**

| Location | Position | Visibility |
|---|---|---|
| Track row | New `col-fav` column, between duration and action | Dim on hover, always shown when ★ |
| Album card | Top-right corner of `.album-thumb-overlay` | Dim on card hover, always shown when ★ |
| Artist card | Top-right corner of `.artist-card-overlay` | Same |
| Player bar | Right control group, left of mute | Always visible for current track |
| Favourites sub-views | On each card/row (for easy un-favouriting) | Always visible (all items are ★) |

---

## 8. Right-Click Context Menu

A new item is added to all three context menus — **conditionally labelled** based on current state:

```
── existing items ──
☆ Add to Favourites       ← shown if NOT currently favourited
★ Remove from Favourites  ← shown if currently favourited
── existing items ──
```

Applies to:
- `showTrackCtxMenu` — checks `state.favourites.songs.has(trackId)`
- `showAlbumCtxMenu` — checks `state.favourites.albums.has(artworkKey)`
- `showArtistCtxMenu` — checks `state.favourites.artists.has(artistId)`

---

## 9. Sidebar Navigation

Under the **Library** section, between Songs and Playlists:

```
LIBRARY
  Artists
  Albums
  Songs
  Favourites    ← new  (star SVG icon)
  Playlists
```

No count badge on the nav item — keeps the sidebar clean. The Favourites landing page itself shows counts per category.

---

## 10. Favourites Landing Page (`view-favourites`)

A simple three-card summary grid. Each card shows the category name, count, and a preview (e.g., top 3 artist names / album art thumbnails / track titles). Clicking navigates to the relevant sub-view.

```
★  Favourites
────────────────────────────────────────

  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │  ★ Artists   │  │  ★ Albums    │  │  ★ Songs     │
  │              │  │              │  │              │
  │  5           │  │  12          │  │  87          │
  │  The Beatles │  │  [art grid]  │  │  Bohemian… │
  │  Radiohead   │  │              │  │  Comfortably…│
  │  a-ha        │  │              │  │  Take On Me  │
  └──────────────┘  └──────────────┘  └──────────────┘
```

Empty state (no favourites at all): a single centred message with a ☆ icon and "Star a song, album, or artist to save it here."

---

## 11. Favourite Artists Sub-view (`view-fav-artists`)

- Same `.artist-card` grid as the main Artists view
- Click card → navigates to artist page (same as main Artists view)
- Star toggle visible on each card (all filled ★, for easy removal)
- Sort controls: **Recently Added** (default) | **A–Z**
- Drag-to-reorder: SortableJS, same pattern as playlist tracks. Drag is disabled when sorted A–Z.
- Empty state: "No favourite artists yet. Click ★ on any artist card to add one."

---

## 12. Favourite Albums Sub-view (`view-fav-albums`)

- Same `.album-card` grid as the main Albums view
- Click card → navigates to album page
- Play and Add overlays same as regular album cards
- Star toggle in the overlay
- Sort controls: **Recently Added** (default) | **A–Z**
- Drag-to-reorder: same as artists sub-view
- Empty state similar to artists

---

## 13. Favourite Songs Sub-view + Virtual Playlist

### As a sub-view (`view-fav-songs`)

- Rendered using the same playlist track list component
- Columns: drag handle, #, title/artist, album, duration
- Sort controls: **My Order** (default, drag-to-reorder enabled) | **Recently Added** | **A–Z** | **Album**
- Star toggle in each row (all filled ★, for easy removal)
- When a sort other than "My Order" is active, drag is disabled (same pattern as playlists)

### As a virtual playlist in Playlists home

- **Pinned at the top** of the Playlists grid, before user-created playlists
- Card uses a mosaic of the top 4 favourite album artworks (same mosaic logic as regular playlists)
- Label: **Favourite Songs** with a small ★ badge
- Shows track count
- **No delete button** — it cannot be deleted (it's virtual)
- Clicking opens `view-fav-songs`
- Hidden from the Playlists home if there are 0 favourite songs

### Export to DAP

The Favourite Songs detail view renders the same DAP export pills as regular playlists:
- **Download M3U** button per DAP format
- **Copy to [DAP name]** button when the DAP is mounted
- Sync status badge (never / up-to-date / outdated) — driven by `favourites.dap_exports[dap_id]` vs the timestamp of the most recently modified favourite

Export uses the same M3U generation logic as playlists, with tracks in the current "My Order" sequence.

---

## 14. Multi-Select Bulk Actions

When tracks are multi-selected (existing bulk action bar), two new buttons appear:

- **★ Favourite** — adds all selected tracks to favourites (skips already-favourited)
- **☆ Unfavourite** — removes all selected tracks from favourites (skips non-favourited)

---

## 15. Player Bar Integration

A star toggle is added to the player bar's right control group (left of the mute button):

- Shows the favourite state of the currently playing track
- Clicking toggles `favourites.songs` for that track ID
- Updates any visible star in the track row / sub-view instantly

---

## 16. View & State Summary

| New view ID | Description |
|---|---|
| `view-favourites` | Landing page with 3 summary cards |
| `view-fav-artists` | Favourite artists grid |
| `view-fav-albums` | Favourite albums grid |
| `view-fav-songs` | Favourite songs list (playlist-style) |

New `showViewEl()` list additions: `'favourites'`, `'fav-artists'`, `'fav-albums'`, `'fav-songs'`

New `App` exports: `toggleFavourite`, `loadFavourites`, `loadFavArtists`, `loadFavAlbums`, `loadFavSongs`, `favSongsReorder`, `favArtistsReorder`, `favAlbumsReorder`, `exportFavSongs`, `copyFavSongsToDap`

---

## 17. Edge Cases

| Case | Handling |
|---|---|
| Favourite a track that's already in the list | No-op (idempotent POST) |
| Toggle while the Favourites sub-view is open | Re-render the list after toggle |
| Library rescan removes a favourited track | Silently skip on load; show dismissible notice if any skipped |
| DAP not mounted when trying to sync | Same disabled-button pattern as existing playlist export |
| Favourites.json missing or corrupt | Treat as empty `{ songs:[], albums:[], artists:[], dap_exports:{} }` |
| User drags in "Recently Added" sort | Sort mode switches to "My Order" automatically on drag |

---

*End of PRD. Ready for implementation.*
