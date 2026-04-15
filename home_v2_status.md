# Home v2 — Handoff Status

Branch: `feature/home-v2`  
Last updated: 2026-04-15

---

## How to run

```bash
cd "/Users/hashan/Documents/Claude/Projects/Playlist Creator"
source venv/bin/activate
python app.py          # runs on port 5001
# Preview proxy on port 5002 via ~/playlist_proxy.py
```

---

## What is built and working

### API endpoints
| Endpoint | Notes |
|---|---|
| `GET /api/home` | Returns `continue_listening`, `top_picks`, `recently_added`, `library_summary`, `last_scan`, `quick_actions`, `has_history`, `tracking_enabled` |
| `GET /api/home/stats?period=week\|month\|year\|all` | Returns `period`, `current` metrics, `previous` metrics, `comparison` (pct changes) |
| `GET /api/home/overview` | Legacy alias → `home()` |
| `POST /api/player/events` | Records playback events; requires `events[]` array with `track_id`, `played_at`, `play_seconds`, `track_duration_seconds`, etc. |

### Scoring model (Top Picks)
- **Weights (with sonic)**: recency 0.30, frequency 0.25, genre_affinity 0.20, novelty 0.15, sonic_affinity 0.10
- **Weights (no sonic)**: recency 0.30, frequency 0.25, genre_affinity 0.25, novelty 0.20
- **Diversity filter**: max 2 picks per artist; picks must not appear in Continue Listening
- **Cold start** (< 5 valid listens): falls back to recently-added albums, reason = "Based on your library"

### Continue Listening merge logic (`_home_continue_listening` in app.py)
1. **Phase 1**: client-side `recentContexts` from player state (most recent, survives sessions)
2. **Phase 2**: server-side `play_events` (last 60 days, sorted by `played_at` desc)
3. **Phase 3**: current queue fallback (active album if phases 1+2 are both empty)
- Deduplicates by `_dedup_key` = `album:artist||album` or `playlist:id`
- Max 10 items

### Play event validation
- `valid_listen = True` if `play_seconds >= 30` OR `play_seconds / duration >= 0.40`
- Events outside the 1-year window are pruned on insert and on `/api/home` load

### Frontend behaviour
- Home is the default landing view on app launch (`showView('home')` in `init()`)
- Home nav item is first under the "LIBRARY" section in the sidebar
- `loadHome()` — full render, sets `_homeLoading` guard
- `_homeApplyData(data, force)` — diff-based; only re-renders sections whose `JSON.stringify` differs from `_homeLastData`
- `_homeBackgroundRefresh()` — silent; skips if `_homeLoading`, view !== home, or `document.hidden`
- Auto-refresh: 30s timer, track-change event (1.2s debounce), visibility change — all use `_homeBackgroundRefresh()`
- `homeForceRefresh()` — clears `_homeLastData` and `_homeLastStatsData`, then calls `loadHome()` (used by the Refresh button)
- Stats period chips: cached in `_homeLastStatsData[period]`; shows cached data instantly then fades to 40% while re-fetching

---

## Bug fixed in this session

### Crossfade silently dropped all play events

**Root cause** (`static/player.js`, `_completeCrossfade()`):

When crossfade is active (`ps.crossfadeDuration > 0`, default 3s), `_onEnded()` exits early:
```javascript
if (_xfadeTriggered) return;  // crossfade handles advancement — don't double-advance
```
But `_completeCrossfade()` only swapped `_audio`, advanced the queue, and updated UI — it **never called `_flushCurrentTrackEvent()`**. Result: zero play events recorded, `recentContexts` never updated, Continue Listening always empty, all stats zeros.

**Fix applied**: At the top of `_completeCrossfade()`, before `_audio` is re-pointed:
```javascript
const prevTrack = currentTrack();
if (prevTrack) {
  const pos = _mpvAvailable ? (_mpvPosition || 0) : (oldEl.duration || 0);
  const elapsed = Math.max(0, pos - (_trackSessionStartPos || 0));
  if (elapsed >= 1) {
    // calls _pushRecentContext + _postPlaybackEvents
  }
}
// ... then swap _audio ...
_markTrackSessionStart();  // reset session tracking for the new track
```

---

## Remaining issue to verify

### Stats track count
The user reported stats are all zeros and don't update after playing songs. This was caused by the crossfade bug above. With the fix deployed:

1. Play a track to completion (or at least 30 seconds)
2. Open DevTools → Network → filter `/api/player/events`
3. Confirm response is `{"ok":true,"stored":1,"tracking_enabled":true}` with `stored > 0`
4. Navigate back to Home, check the "Week" stats chip — track count should increment

If `stored` is still 0 after the fix, check:
- `listening_tracking_enabled` in Settings (could be toggled off)
- Whether `play_seconds` in the POST body is ≥ 30 (use DevTools to inspect the request)

---

## Not yet done (Phase 2 — deferred per spec)

- **Rediscover** section (albums not played in 3–12 months)
- **Audio Snapshot** section (sonic profile summary)
- Period comparison delta arrows (↑↓ next to stat values)
- Deeper IEM/PEQ tie-in on Home

---

## Files modified (uncommitted changes as of 2026-04-15)

| File | Change |
|---|---|
| `static/app.js` | Diff-based refresh (`_homeApplyData`, `_homeBackgroundRefresh`, `homeForceRefresh`), stats opacity fade, 30s timer |
| `static/index.html` | Home nav item moved inside Library section (first item after label) |
| `static/player.js` | Crossfade play event flush fix in `_completeCrossfade()` |

Previously committed (commit `9239bb9`):
- `app.py` — all home routes and helpers
- `db.py` — `db_get_features_batch()`
- `static/style.css` — all `.home-*` CSS
- `static/index.html` — `#view-home` HTML structure
- `static/app.js` — initial `loadHome`, all renderers, default view change
