# TuneBridge Player — Review, Issues & Improvement Plan

## Overview

`player.js` (~1,570 lines) is a self-contained IIFE module that manages a dual-element A/B audio engine
with crossfade, a Web Audio PEQ chain, queue management, and state persistence.
The architecture is generally solid; the issues below are targeted rather than structural.

---

## Bug Report: Seek Position Desync on App Close

**Symptom (user-reported):** After closing and reopening the app near the end of a song, the progress
indicator shows the saved position, but the audio plays from an earlier (sometimes much earlier) point.
This can result in the indicator showing the song has ended while audio continues playing.

### Root Cause 1 — State save lag (5–30 seconds)

State is written to disk in two ways:

| Mechanism | Granularity | Path |
|---|---|---|
| `localStorage` throttle (`_saveSeekThrottle`) | 5-second buckets | Local only |
| Server remote throttle (`_remoteSeekThrottle`) | 30-second buckets | `player_state.json` |
| `beforeunload` synchronous XHR | Exact position | `player_state.json` |

The `beforeunload` XHR should capture the exact position at close, but in the WKWebView app
`os._exit(0)` races against the XHR completing. The Python background thread (which calls
`evaluate_js` every 5 s) is the actual authoritative save mechanism in the app context — meaning
up to **5 seconds of seek position can be lost** between the last thread tick and the moment the
user closes the window.

**Fix direction:** Reduce `_saveSeekThrottle` bucket to 1 s and `_remoteSeekThrottle` bucket to 5 s.
Both are pure throttle constants — changing them has no side effects beyond slightly more
localStorage/server writes.

### Root Cause 2 — FLAC seek inaccuracy in WKWebView (primary "plays from earlier" cause)

On `init()`, the seek restoration sequence is:

```
_audio.src = /api/stream/TRACK_ID   → browser requests full file (no Range header → HTTP 200)
_audio.load()                       → resets element, starts buffering from byte 0
loadedmetadata fires → _applySeek:
  _audio.currentTime = seekTime     → browser issues NEW Range request for byte offset
  UI updated immediately to seekTime
```

The server correctly returns HTTP 206 for Range requests. However, **FLAC is a block-framed format**:
WebKit must find a valid FLAC sync word (`0xFFF8xx`) to start decoding. The byte offset that
corresponds to `seekTime` seconds may not fall on a FLAC frame boundary. If it doesn't, the browser
silently backs up to the nearest valid frame, which can be **several seconds before** the requested
position.

Meanwhile the UI was already set to `seekTime` in `_applySeek`. When `timeupdate` fires (4×/second),
the seek bar jumps to the actual audio position, which is earlier. The user sees the correct position
for a fraction of a second, then it snaps back.

There is currently **no `seeked` event handler** to detect when the browser's seek actually completes
or fails. Adding one would allow the UI to confirm (or correct) the real position after the seek settles.

**Fix direction:** Listen for the `seeked` event on the audio element. In `_applySeek`, set a flag to
suppress `_onTimeUpdate` UI updates until `seeked` fires. On `seeked`, reconcile the UI with
`_audio.currentTime` (which is authoritative post-seek) and clear the flag.

### Root Cause 3 — Crossfade ghost audio (the "song plays in background" scenario)

If crossfade is enabled and `seekTime` falls within the crossfade window (last N seconds of the song),
the crossfade fires on the very **first** `timeupdate` after the user presses Play:

```
seekTime = 4:57, duration = 5:00, crossfadeDuration = 5s
→ remaining = 3s < 5s  →  _startCrossfade() triggers immediately
→ audioB starts loading + playing next track silently
→ 5 seconds later, _completeCrossfade runs
→ BUT audioA "ended" after only 3 more real seconds
→ _onEnded guard (if (_xfadeTriggered) return) correctly prevents double-advance
→ All good IF seek worked correctly
```

If the FLAC seek (Root Cause 2) **failed** and audio is actually at time 0:
- audioA is playing from 0 while the UI was momentarily set to 4:57
- `timeupdate` updates UI to ~0, user sees progress bar reset
- Song plays ~5 minutes from beginning
- Near the end (4:55), crossfade triggers properly, loads next track on audioB
- audioA ends → `_onEnded` → crossfade guard prevents advance → `_completeCrossfade` swaps to B

In this path there is **no ghost audio** — `_audio.load()` on the next track clears audioA.
However, a subtle concurrency window exists: if crossfade fires (audioB starts playing at low gain),
and the seek bar catches up to the actual audio end before `_completeCrossfade` completes its
`setTimeout`, the user may briefly hear both tracks simultaneously before the swap completes.
This is the most likely source of the "playing in background" perception.

**Fix direction:** After `_applySeek` confirms seek (via `seeked` event), check if the remaining
time is less than `crossfadeDuration`. If so, either reduce crossfade duration for this play-through
or skip crossfade entirely for the restoration.

---

## Other Bugs & Edge Cases

### `removeFromQueue` shuffle mode — `queueIdx` not adjusted

```js
// Current code — only adjusts for non-shuffle mode:
if (!ps.shuffle && idx < ps.queueIdx) ps.queueIdx--;
```

In shuffle mode, `ps.queueIdx` is a position in `ps.shuffleOrder`, not a direct queue index.
When an item is removed and its entry is filtered from `shuffleOrder`, if the removed item was
**before** the current shuffle position (i.e., `shuffleOrder.indexOf(idx) < ps.queueIdx`),
`ps.queueIdx` should decrement to keep pointing at the same track. This is missing.

**Impact:** In shuffle mode, removing a track that was already played (in history) shifts all
subsequent tracks up by one in shuffleOrder, making `ps.queueIdx` point to the wrong track.

### `next()` / `prev()` modulus uses `ps.queue.length`, not `ps.shuffleOrder.length`

```js
ps.queueIdx = (ps.queueIdx + 1) % ps.queue.length;
```

In shuffle mode `ps.queueIdx` is a shuffleOrder position. `ps.queue.length` and
`ps.shuffleOrder.length` should always be equal, but if they ever diverge (e.g., after the
removeFromQueue shuffle bug above), this can produce an out-of-bounds shuffleOrder access.
Using `Math.max(1, ps.shuffleOrder.length || ps.queue.length)` as the modulus would be safer.

### Crossfade: no upper-bound guard on `remaining <= crossfadeDuration`

```js
if (remaining > 0.1 && remaining <= ps.crossfadeDuration && _audio.currentTime > 0.5) {
```

If `ps.crossfadeDuration = 12` and a track is less than 12 seconds long, crossfade fires at
second 0.5 of the track (the very start). A guard of `remaining < duration - 1` (don't start
crossfade if the whole track is shorter than the fade) would prevent this degenerate case.

### Missing `seeking` / `seeked` event handlers

The player has no handlers for `seeking` or `seeked` events. During a seek:
- `seeking` fires when `currentTime` assignment is requested
- `seeked` fires when the browser has decoded to the requested position
- Between them, `currentTime` may return intermediate values

Without a `seeked` handler, the UI may flicker between the requested position (set in `_applySeek`)
and intermediate `timeupdate` positions during the seek. Adding a `_seeking` flag (true between
`seeking` and `seeked`) would suppress `_onTimeUpdate` UI updates during this window, similar
to how `_seekDragging` works for manual scrubbing.

---

## Feature Request: Custom 10-Band PEQ Editor

### Goal

Give users a full parametric EQ editor they can configure from scratch while music plays — no
preset frequencies, no locked Q values, no assumed filter types. Each of the 10 bands is fully
user-controlled: enabled/disabled toggle, filter type, centre frequency, gain, and Q. Equivalent
to creating an APO filter file in the UI, live.

Example of the target input format (APO notation, shown for reference):

```
Preamp: -0.0 dB
Filter 1:  ON  PK  Fc    23 Hz  Gain  1.6 dB  Q 1.300
Filter 2:  ON  PK  Fc    63 Hz  Gain -0.8 dB  Q 1.200
Filter 3:  ON  PK  Fc    66 Hz  Gain  3.0 dB  Q 0.500
Filter 4:  ON  PK  Fc   150 Hz  Gain  1.5 dB  Q 2.000
Filter 5:  ON  PK  Fc   350 Hz  Gain -1.5 dB  Q 1.500
Filter 6:  ON  PK  Fc  1300 Hz  Gain -0.4 dB  Q 2.000
Filter 7:  ON  PK  Fc  3200 Hz  Gain -1.8 dB  Q 2.000
Filter 8:  ON  PK  Fc  6200 Hz  Gain  2.0 dB  Q 1.600
Filter 9:  ON  PK  Fc 11000 Hz  Gain -6.3 dB  Q 2.000
Filter 10: ON  PK  Fc 15000 Hz  Gain  5.5 dB  Q 0.600
```

### Current Architecture

PEQ profiles are stored on IEM objects (`data/iems.json`), uploaded as APO/AutoEQ `.txt` files,
and applied as `BiquadFilterNode` chains via `_buildPeqChain(peqProfile)`.

Web Audio `BiquadFilterNode.frequency.value`, `.gain.value`, and `.Q.value` are `AudioParam`
objects — they support **real-time changes** without rebuilding the chain. The custom editor can
write directly to these `AudioParam` values and the change is heard on the next rendered buffer
(sub-millisecond latency).

### Architecture

**Storage: `localStorage`-backed, independent of IEM objects**

The custom EQ is a standalone entity — not tied to any IEM. This avoids polluting the IEM list
with editor artefacts and requires no backend changes.

```
localStorage key: 'tb_custom_peq'
Value: {
  enabled: bool,
  preamp_db: number,          // e.g. -0.0
  bands: [
    { enabled: true, type: 'PK', fc: 23, gain: 1.6, q: 1.300 },
    { enabled: true, type: 'PK', fc: 63, gain: -0.8, q: 1.200 },
    // ... 10 bands total, all user-defined
  ]
}
```

All 10 bands start blank on first open: `enabled: false, type: 'PK', fc: 1000, gain: 0, q: 1.0`.
No values are pre-filled — the user defines everything from scratch, the same way they would
configure APO or a hardware EQ.

Applying the custom EQ reuses `_buildPeqChain(peqProfile)` unchanged — the stored object already
matches the `{preamp_db, filters}` shape that `_buildPeqChain` expects (filtering out
`enabled: false` bands).

**Persistence to IEM profile (optional, later)**

A "Save as IEM Profile" button POSTs the current band state as a synthetic APO `.txt` string to
`POST /api/iems/{id}/peq`, creating a named profile on any chosen IEM. This is additive and
deferred — the core editor works entirely from `localStorage`.

### UI Placement

The PEQ popover is already at its practical size limit. The custom editor needs its own space.

**Recommendation:** Add a "Custom EQ" option at the top of the IEM selector dropdown in the
existing popover (above "— Off —"). Selecting it opens a dedicated modal overlay
(`#peq-editor-modal`) — similar in structure to the sync modal. The popover closes when the
modal opens. While the modal is open, the custom EQ is active and edits are heard live.

### Per-Band Controls

Each of the 10 filter rows has exactly the same controls, matching the APO format:

| Control | Input type | Range | Notes |
|---|---|---|---|
| ON/OFF toggle | Checkbox / pill | — | Disables band without deleting settings |
| Type | Dropdown | PK, LSC, HSC, LPQ, HPQ, NO, AP | Maps directly to `_FILTER_TYPE` in `_buildPeqChain` |
| Fc | Number input | 20 – 20000 Hz | Integer; validated on blur |
| Gain | Number input | −30 to +30 dB | One decimal place; hidden when type is LP/HP/notch/allpass |
| Q | Number input | 0.100 – 10.000 | Three decimal places |

Gain input should be hidden (greyed, not shown) for filter types where gain has no effect
(LPQ, HPQ, NO, AP) — matching how APO/AutoEQ files omit the gain field for those types.

**Real-time application:** Every `input` event on any field immediately calls a targeted update
function that sets the corresponding `BiquadFilterNode` parameter via `AudioParam.setValueAtTime(value, audioContext.currentTime)` — no chain rebuild needed. Only toggling a band ON/OFF (changing
the number of active nodes) requires a full `_buildPeqChain` rebuild.

### Global Preamp Row

A single preamp row sits above the 10 bands:

```
Preamp   [ -0.0 ] dB
```

Number input, −30 to +30 dB, one decimal place. Changes update `_preampNode.gain.value` directly
(no rebuild needed).

### Frequency Response Curve

A real-time FR curve is essential — without it, editing PEQ blind is guesswork.

**Implementation:** `BiquadFilterNode.getFrequencyResponse(frequencyArray, magResponse, phaseResponse)`
queries the exact nodes in the active playback chain. Call it on all enabled nodes, multiply the
magnitude responses together, and draw the combined curve on a `<canvas>` element with a log-scale
X-axis (20 Hz – 20 kHz) and a fixed dB Y-axis (±20 dB relative to 0).

```js
// Pseudo-code — called after any parameter change
function _redrawEqCurve() {
  const freqs = new Float32Array(512);  // log-spaced 20Hz–20kHz
  const combined = new Float32Array(512).fill(1);  // start at 1.0 (0 dB)
  for (const node of _peqNodes) {
    const mag = new Float32Array(512);
    const phase = new Float32Array(512);
    node.getFrequencyResponse(freqs, mag, phase);
    for (let i = 0; i < 512; i++) combined[i] *= mag[i];
  }
  // Draw combined[] on canvas, converting to dB: 20*log10(value)
}
```

The canvas renders at the top of the modal, above the band rows. Update it on every `input` event
(debounce to one `requestAnimationFrame` per frame to avoid redundant draws).

### Modal Layout Sketch

```
┌─ Custom EQ ──────────────────────────────────── [Reset] [Save as Profile] [✕] ─┐
│  [FR curve canvas — 400×150px, log-scale, ±20 dB grid]                          │
│                                                                                   │
│  Preamp  [ -0.0 ] dB                                                             │
│  ───────────────────────────────────────────────────────────────────────────     │
│  #   On   Type      Fc (Hz)   Gain (dB)   Q                                      │
│  1   ☑    [PK ▾]   [  23  ]  [  1.6  ]   [ 1.300 ]                             │
│  2   ☑    [PK ▾]   [  63  ]  [ -0.8  ]   [ 1.200 ]                             │
│  ...                                                                              │
│  10  ☑    [PK ▾]   [15000 ]  [  5.5  ]   [ 0.600 ]                             │
│                                                                                   │
│                              [Apply & Close]                                      │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Reset:** Clears all 10 bands to `enabled: false, gain: 0` and sets preamp to 0. Confirms via
the existing `_showConfirm` modal before clearing.

**Apply & Close:** Saves state to `localStorage`, closes modal. The EQ remains active (indicated
by the "EQ" button in the player bar staying lit).

**"Save as Profile":** Opens a small sub-modal asking the user to pick an existing IEM and supply
a profile name, then POSTs to `/api/iems/{id}/peq`. The band data is serialised to APO `.txt`
format on the client side before sending — the same format the backend already parses.

---

## Gaps & Improvement Opportunities

### Playback Quality

**Gapless playback:** There is no true gapless mode. Even with crossfade at 0s, there is a brief
silence between tracks (the time between `ended` firing and `_audio.play()` completing on the next
load). True gapless requires pre-buffering the next track before the current one ends and scheduling
playback via `AudioBufferSourceNode` at a precise time. This is a significant rebuild but worth noting
for future work.

**ReplayGain / loudness normalization:** No gain normalisation between tracks. Tracks at different
recording levels create jarring volume jumps. The FLAC metadata already contains `REPLAYGAIN_TRACK_GAIN`
tags that `mutagen` can read. A simple pre-gain step in `_loadTrack` (adjusting `_preampNode.gain.value`
based on the tag value) would flatten this.

### State & Persistence

**Seek save resolution:** As noted in the bug section, the 5-second localStorage throttle and
30-second remote throttle cause position loss on sudden close. Reducing both would be a safe change.

**`seekTime` source of truth:** `getStateJSON()` uses `_audio.currentTime || 0`. If called during
a crossfade (where `_audio` is the outgoing element), `currentTime` may be near the end but not
representative of the user's "last known position." Saving the incoming element's position
during crossfade would be more useful for resume.

### UX

**Loading / buffering indicator:** There is no visual feedback while a FLAC track is initially
buffering or seeking. The seek bar could show a "loading" state (e.g., pulsing fill) between the
`seeking` event and the `seeked` event.

**MediaSession API integration:** No integration with macOS media key controls, lock screen Now
Playing widget, or notification center. Adding `navigator.mediaSession.metadata` and action
handlers (`play`, `pause`, `previoustrack`, `nexttrack`) would allow hardware media keys to work
from the WKWebView window without keyboard focus.

```js
navigator.mediaSession.metadata = new MediaMetadata({
  title: track.title,
  artist: track.artist,
  album: track.album,
  artwork: track.artwork_key ? [{ src: `/api/artwork/${track.artwork_key}` }] : [],
});
navigator.mediaSession.setActionHandler('nexttrack', () => Player.next());
// etc.
```

**Keyboard shortcuts:** Current shortcuts are Space (play/pause), Alt+←/→ (prev/next), M (mute).
Missing: bare ← / → for seeking ±10 seconds (common music player convention), and ↑/↓ for volume.

**Queue: no "play from here" action:** Double-clicking a history item replays from that track but
does not remove subsequent items. A "Play from here" context menu item (re-queue from this track)
would make history more useful.

**Error recovery:** After 3 consecutive errors, playback stops with a toast. There is no visible
error state in the player bar and no retry button. Adding an error icon and a retry action on the
play button (`data-error="true"`) would make failure states more actionable.

### Audio Graph

**Overload / clipping protection:** `_preampNode.gain` is set to the profile's `preamp_db` value
without clamping. A very high preamp (e.g., APO file with +12 dB preamp) combined with positive
band gains can clip the output. A `DynamicsCompressorNode` at the end of the chain (set to soft
limiting rather than compression) would prevent this without audibly degrading the signal.

**PEQ chain rebuild on every profile change:** `_buildPeqChain` tears down and rebuilds the entire
`BiquadFilterNode` chain each time a profile is applied. This causes a brief audio click because
all nodes are disconnected and reconnected mid-playback. Nodes should be reused where possible
(same count, same types) and only gain/frequency/Q values updated via `AudioParam.setValueAtTime`.

### Code Clarity

**`playbackContextTracks` vs. `queue` duality:** The distinction between the playback context
(the full artist/album/playlist the user is browsing) and the actual queue (what will play) adds
complexity to `toggleShuffle` (context promotion) and `playTrackById` (context-first routing).
This is architecturally intentional but worth documenting inline more thoroughly — it is easy to
introduce bugs by conflating the two.

**`ps.queueIdx` semantics shift in shuffle mode:** In non-shuffle mode `ps.queueIdx` is a direct
`ps.queue` array index. In shuffle mode it is a position in `ps.shuffleOrder`. This dual meaning
makes every function that reads or writes `ps.queueIdx` a potential source of off-by-one bugs
(and already caused the `removeFromQueue` bug above). A future refactor could use a dedicated
`ps.shufflePos` for the shuffle-order position and keep `ps.queueIdx` always as the real queue
index, deriving the shuffle position separately.

---

## Priority Summary

| Item | Type | Effort |
|---|---|---|
| Reduce seek save throttle (1s local / 5s remote) | Bug fix | Trivial |
| Add `seeking` / `seeked` event handlers to suppress UI flicker | Bug fix | Small |
| Guard crossfade trigger when `seekTime` is near end of song | Bug fix | Small |
| Fix `removeFromQueue` `queueIdx` adjustment in shuffle mode | Bug fix | Small |
| Custom 10-band PEQ editor (localStorage-backed, no server changes) | Feature | Medium |
| FR curve visualisation in PEQ editor using `getFrequencyResponse` | Feature | Medium |
| MediaSession API integration | Enhancement | Small |
| ReplayGain normalisation | Enhancement | Small |
| Seek bar buffering/loading indicator | Enhancement | Small |
| True gapless playback | Enhancement | Large |
