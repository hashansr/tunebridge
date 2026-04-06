# TuneBridge Player — Implementation Spec

## Scope

This document is a spec for an implementing agent. It covers three categories of work:

1. **Bug fixes** — correctness issues in `static/player.js`
2. **Design alignment** — CSS fixes in `static/style.css` to match `master-design.md`
3. **New feature** — Custom 10-band PEQ editor (frontend only, no backend changes)

Files touched: `static/player.js`, `static/style.css`, `static/index.html`

Everything else (gapless playback, ReplayGain, MediaSession, PEQ chain rebuild optimisation,
keyboard shortcut expansion, `ps.queueIdx` refactor) is **out of scope** and should not be
implemented.

---

## 1. Bug Fixes

### 1.1 Seek position desync on app close (user-reported)

**Files:** `static/player.js`

**Problem:** After closing and reopening the app near the end of a song, the progress indicator
shows the restored position but audio plays from an earlier point. Two independent fixes needed.

**Fix A — Reduce save throttle granularity**

The seek position is saved to localStorage in 5-second buckets and to the server in 30-second
buckets. This means up to 5 seconds of position can be lost at close time.

In `player.js`, find `_saveSeekThrottle` and `_remoteSeekThrottle` and change the bucket sizes:

```js
// In _onTimeUpdate():

// BEFORE:
const bucket = Math.floor(_audio.currentTime / 5);
if (bucket !== _saveSeekThrottle) {
  _saveSeekThrottle = bucket;
  try { localStorage.setItem(_LS.seekTime, _audio.currentTime); } catch (_) {}
  const remoteBucket = Math.floor(_audio.currentTime / 30);
  if (remoteBucket !== _remoteSeekThrottle) {

// AFTER:
const bucket = Math.floor(_audio.currentTime / 1);   // was 5
if (bucket !== _saveSeekThrottle) {
  _saveSeekThrottle = bucket;
  try { localStorage.setItem(_LS.seekTime, _audio.currentTime); } catch (_) {}
  const remoteBucket = Math.floor(_audio.currentTime / 5);   // was 30
  if (remoteBucket !== _remoteSeekThrottle) {
```

**Fix B — Suppress UI flicker during seek with `seeking` / `seeked` guards**

When `_audio.currentTime = seekTime` is set (during init restore or manual seek), the browser
fires `seeking` and then `seeked`. Between those events `timeupdate` fires with intermediate
positions, causing the seek bar to flicker to earlier positions before settling.

Add a `_seeking` flag (analogous to the existing `_seekDragging` flag) that suppresses
`_onTimeUpdate` UI updates while a seek is in progress.

```js
// Add near other state flags at the top of the IIFE (~line 71):
let _seeking = false;

// In _onTimeUpdate(), add guard after the existing _seekDragging guard:
if (_seeking) return;

// Add event listeners alongside the other audio element listeners (~line 798):
[_audioA, _audioB].forEach(el => {
  // existing listeners...
  el.addEventListener('seeking',  function() { if (this === _audio) _seeking = true;  });
  el.addEventListener('seeked',   function() { if (this === _audio) _seeking = false; });
});
```

Also add `_seeking = false` at the start of `_cancelCrossfade()` to ensure it is cleared on
track load.

### 1.2 Crossfade fires immediately on restored seek near end of song

**File:** `static/player.js`

**Problem:** If the restored `seekTime` falls within the crossfade window (e.g., seekTime=4:57,
duration=5:00, crossfadeDuration=5s), crossfade triggers on the very first `timeupdate` after
play. If the FLAC seek was imprecise and audio is actually playing from an earlier position, this
causes audio from both tracks to be heard simultaneously.

**Fix:** Add a guard to `_startCrossfade()` that prevents crossfade from firing within the first
2 seconds of playback after a seek restoration. Track this with a `_seekRestored` flag.

```js
// Add near other state flags:
let _seekRestored = false;   // true for 2s after a seek-restore, suppresses crossfade

// In _startCrossfade(), add at the top:
if (_seekRestored) return;

// In _applySeek (inside init()), after setting _audio.currentTime:
_seekRestored = true;
setTimeout(() => { _seekRestored = false; }, 2000);

// Also clear it in _cancelCrossfade() and _loadTrack() alongside other flag resets:
_seekRestored = false;
```

### 1.3 Crossfade triggers at start of very short tracks

**File:** `static/player.js`

**Problem:** If `crossfadeDuration = 12` and a track is 10 seconds long, the crossfade trigger
fires at `currentTime = 0.5` — effectively at the start of the track.

**Fix:** Add a guard so crossfade only triggers if the track duration is at least
`crossfadeDuration + 2` seconds.

```js
// In _onTimeUpdate(), inside the crossfade trigger block:
// BEFORE:
if (!_xfadeTriggered && ps.crossfadeDuration > 0) {
  const remaining = dur - _audio.currentTime;
  if (remaining > 0.1 && remaining <= ps.crossfadeDuration && _audio.currentTime > 0.5) {

// AFTER:
if (!_xfadeTriggered && ps.crossfadeDuration > 0) {
  const remaining = dur - _audio.currentTime;
  if (remaining > 0.1 && remaining <= ps.crossfadeDuration
      && _audio.currentTime > 0.5
      && dur > ps.crossfadeDuration + 2) {   // ← added guard
```

### 1.4 `removeFromQueue` doesn't adjust `queueIdx` in shuffle mode

**File:** `static/player.js`

**Problem:** In shuffle mode, `ps.queueIdx` is a position in `ps.shuffleOrder`. When a history
track is removed and its entry is filtered from `shuffleOrder`, if the removed entry was before
the current shuffle position, `ps.queueIdx` should decrement to keep pointing at the same track.
The current code only adjusts `queueIdx` for non-shuffle mode.

**Fix:**

```js
// In removeFromQueue(), replace:
if (!ps.shuffle && idx < ps.queueIdx) ps.queueIdx--;

// With:
if (ps.shuffle) {
  // Find where this queue index appeared in shuffleOrder before filtering
  const shufflePos = ps.shuffleOrder.indexOf(idx);
  if (shufflePos !== -1 && shufflePos < ps.queueIdx) ps.queueIdx--;
} else {
  if (idx < ps.queueIdx) ps.queueIdx--;
}
```

Note: this adjustment must happen **before** the `ps.shuffleOrder` filter/map that removes the
entry, so `indexOf(idx)` still finds it.

### 1.5 `next()` / `prev()` modulus should use `shuffleOrder.length` in shuffle mode

**File:** `static/player.js`

**Problem:** Both `next()` and `prev()` use `ps.queue.length` as the modulus/bound. In shuffle
mode, `ps.queueIdx` is a shuffleOrder position and `ps.shuffleOrder.length` is the correct bound.
These are normally equal but diverge if bug 1.4 above causes them to get out of sync.

**Fix:**

```js
// In next():
// BEFORE:
ps.queueIdx = (ps.queueIdx + 1) % ps.queue.length;
// AFTER:
const len = ps.shuffle ? ps.shuffleOrder.length : ps.queue.length;
ps.queueIdx = (ps.queueIdx + 1) % Math.max(1, len);

// In prev():
// BEFORE:
ps.queueIdx = ps.queueIdx > 0 ? ps.queueIdx - 1 : ps.queue.length - 1;
// AFTER:
const len = ps.shuffle ? ps.shuffleOrder.length : ps.queue.length;
ps.queueIdx = ps.queueIdx > 0 ? ps.queueIdx - 1 : Math.max(0, len - 1);
```

---

## 2. Design Alignment Fixes

Reference: `master-design.md`. All three player surfaces have CSS deviations.
Tokens in use: `--radius: 12px`, `--radius-lg: 24px`, `--accent: #adc6ff`,
`--bg-elevated: #1c1b1b`, `--border-focus: rgba(173,198,255,0.4)`.

### 2.1 PEQ Popover — opacity (user-confirmed readability bug)

**File:** `static/style.css`

The base layer `rgba(28, 27, 27, 0.78)` is too transparent. With backdrop-filter active,
background content bleeds through and makes popover text hard to read.

```css
/* In .peq-popover — BEFORE: */
background:
  radial-gradient(360px 160px at 12% -40%, rgba(173,198,255,0.19), transparent 65%),
  rgba(28, 27, 27, 0.78);

/* AFTER: */
background:
  radial-gradient(360px 160px at 12% -40%, rgba(173,198,255,0.19), transparent 65%),
  rgba(28, 27, 27, 0.96);
```

### 2.2 PEQ Popover — border radius, shadow, and select focus

**File:** `static/style.css`

```css
/* border-radius: off-token 20px → canonical --radius-lg */
/* In .peq-popover: */
border-radius: 24px;   /* was 20px */

/* box-shadow: add accent tint to the dark shadow */
box-shadow: 0 24px 56px rgba(4, 8, 24, 0.55);   /* was rgba(8,10,18,0.55) */

/* select focus: browser default outline → design-system glow */
/* Add new rule: */
.peq-select:focus {
  outline: none;
  box-shadow: 0 0 0 2px rgba(173,198,255,0.35);
}
```

### 2.3 Queue Drawer — shadow and border radius

**File:** `static/style.css`

```css
/* In .queue-drawer: */

/* border-radius: off-token 20px → canonical --radius-lg (top corners only, drawer slides up) */
border-radius: 24px 24px 0 0;   /* was 20px 20px 0 0 */

/* box-shadow: pure black → accent-tinted */
box-shadow: 0 -4px 48px rgba(4, 8, 24, 0.52);   /* was rgba(0,0,0,0.5) */
```

### 2.4 Player Bar — border radius

**File:** `static/style.css`

```css
/* In #player-bar: */
border-radius: 24px 24px 0 0;   /* was 20px 20px 0 0 */
```

---

## 3. Feature: Custom 10-Band PEQ Editor

### Overview

A full parametric EQ editor the user configures from scratch. No preset values. Each band is
independently configured: ON/OFF, filter type, Fc, Gain, Q — matching APO filter file format.
Edits apply to live audio in real-time. Stored in `localStorage`, independent of any IEM object.
No backend changes required.

### Entry Point

In the existing PEQ popover (`#peq-popover`), add a "Custom EQ" option to the IEM select
dropdown. Place it at the top, above "— Off —":

```html
<select id="peq-iem-select" ...>
  <option value="__custom__">Custom EQ</option>
  <option value="">— Off —</option>
  <!-- IEMs populated dynamically -->
</select>
```

When `__custom__` is selected, `onPeqIemChange` detects this value and opens `#peq-editor-modal`
instead of populating the profile dropdown. The popover closes when the modal opens.

### State Schema

```js
// localStorage key: 'tb_custom_peq'
// Default (first open — all bands blank, nothing pre-filled):
{
  enabled: false,
  preamp_db: 0,
  bands: [
    { enabled: false, type: 'PK', fc: 1000, gain: 0, q: 1.0 },
    // × 10 bands, identical default
  ]
}
```

`enabled` at the top level tracks whether the custom EQ is currently active (i.e., the user
selected it and applied it). The individual band `enabled` fields control whether each band
contributes to the chain.

### Applying the Custom EQ

The existing `_buildPeqChain(peqProfile)` function accepts `{preamp_db, filters}`. Reuse it
unchanged — map the custom EQ state to this shape by filtering out disabled bands:

```js
function _applyCustomPeq(state) {
  const profile = {
    preamp_db: state.preamp_db,
    filters: state.bands
      .filter(b => b.enabled)
      .map(b => ({ type: b.type, fc: b.fc, gain: b.gain, q: b.q })),
  };
  _buildPeqChain(profile.filters.length > 0 ? profile : null);
}
```

### Real-Time Editing

When the user edits a parameter in the modal:

- **Gain / Fc / Q change on an enabled band:** Update the corresponding live `BiquadFilterNode`
  parameter directly — **no chain rebuild**:
  ```js
  const node = _peqNodes[enabledBandIndex];
  if (node) {
    node.frequency.setValueAtTime(newFc, _ctx.currentTime);
    node.gain.setValueAtTime(newGain, _ctx.currentTime);
    node.Q.setValueAtTime(newQ, _ctx.currentTime);
  }
  ```
  `_peqNodes` is the array of live `BiquadFilterNode` objects built by `_buildPeqChain`.
  The `enabledBandIndex` is the index of this band within enabled bands only.

- **Toggling a band ON/OFF or changing filter type:** These change the number or types of nodes
  in the chain — call `_applyCustomPeq(state)` (full rebuild via `_buildPeqChain`).

- **Preamp change:** Update `_preampNode.gain.value` directly — no rebuild:
  ```js
  if (_preampNode) _preampNode.gain.value = _dBToLinear(newPreampDb);
  ```

- **Redraw the FR curve** on every parameter change (see section below).

### Modal HTML (`#peq-editor-modal`)

Add to `static/index.html` alongside the other modals:

```html
<div id="peq-editor-modal" class="modal-overlay" style="display:none" onclick="App.closePeqEditor(event)">
  <div class="modal peq-editor-modal-inner" onclick="event.stopPropagation()">
    <!-- Header -->
    <div class="modal-header">
      <div>
        <div class="modal-title">Custom EQ</div>
        <div class="modal-subtitle">All changes apply live while music plays</div>
      </div>
      <div class="peq-editor-header-actions">
        <button class="btn-secondary" onclick="App.resetCustomPeq()">Reset</button>
        <button class="btn-secondary" onclick="App.saveCustomPeqAsProfile()">Save as Profile</button>
        <button class="modal-close-btn" onclick="App.closePeqEditor()">
          <!-- SVG × icon -->
        </button>
      </div>
    </div>

    <!-- FR Curve Canvas -->
    <div class="peq-editor-curve-wrap">
      <canvas id="peq-editor-canvas" width="660" height="160"></canvas>
    </div>

    <!-- Preamp -->
    <div class="peq-editor-preamp-row">
      <span class="peq-editor-col-label">PREAMP</span>
      <input type="number" id="peq-preamp" class="peq-editor-num-input"
             min="-30" max="30" step="0.1" value="0"
             oninput="App.onPeqPreampChange(this.value)" />
      <span class="peq-editor-unit">dB</span>
    </div>

    <!-- Band Table Header -->
    <div class="peq-editor-band-header">
      <span class="peq-editor-col-label">#</span>
      <span class="peq-editor-col-label">ON</span>
      <span class="peq-editor-col-label">TYPE</span>
      <span class="peq-editor-col-label">Fc (Hz)</span>
      <span class="peq-editor-col-label">GAIN (dB)</span>
      <span class="peq-editor-col-label">Q</span>
    </div>

    <!-- Band Rows — rendered dynamically by App.renderPeqEditorBands() -->
    <div id="peq-editor-bands"></div>

    <!-- Footer -->
    <div class="peq-editor-footer">
      <button class="btn-primary" onclick="App.applyAndClosePeqEditor()">Apply & Close</button>
    </div>
  </div>
</div>
```

### Per-Band Row HTML

Each band row is rendered dynamically. Band index `i` runs 0–9:

```html
<div class="peq-editor-band-row" data-band="${i}">
  <span class="peq-editor-band-num">${i + 1}</span>

  <!-- ON/OFF toggle: small pill button, green when on -->
  <button class="peq-band-toggle ${band.enabled ? 'active' : ''}"
          onclick="App.togglePeqBand(${i})">
    ${band.enabled ? 'ON' : 'OFF'}
  </button>

  <!-- Filter type -->
  <select class="peq-band-type" onchange="App.onPeqBandTypeChange(${i}, this.value)">
    <option value="PK"  ${band.type==='PK'  ? 'selected':''}>PK</option>
    <option value="LSC" ${band.type==='LSC' ? 'selected':''}>LSC</option>
    <option value="HSC" ${band.type==='HSC' ? 'selected':''}>HSC</option>
    <option value="LPQ" ${band.type==='LPQ' ? 'selected':''}>LPQ</option>
    <option value="HPQ" ${band.type==='HPQ' ? 'selected':''}>HPQ</option>
    <option value="NO"  ${band.type==='NO'  ? 'selected':''}>NO</option>
    <option value="AP"  ${band.type==='AP'  ? 'selected':''}>AP</option>
  </select>

  <!-- Fc -->
  <input type="number" class="peq-editor-num-input" value="${band.fc}"
         min="20" max="20000" step="1"
         oninput="App.onPeqBandFcChange(${i}, this.value)" />

  <!-- Gain — hidden for types where gain has no effect -->
  <input type="number" class="peq-editor-num-input ${gainHidden ? 'peq-input-hidden' : ''}"
         value="${band.gain.toFixed(1)}" min="-30" max="30" step="0.1"
         oninput="App.onPeqBandGainChange(${i}, this.value)" />

  <!-- Q -->
  <input type="number" class="peq-editor-num-input" value="${band.q.toFixed(3)}"
         min="0.1" max="10" step="0.001"
         oninput="App.onPeqBandQChange(${i}, this.value)" />
</div>
```

Gain input is hidden (`visibility: hidden` — keep the column width, just hide the field) when
`type` is one of: `LPQ`, `HPQ`, `NO`, `AP`.

### FR Curve Canvas

**Implementation:** Use `BiquadFilterNode.getFrequencyResponse()` on the live `_peqNodes` array.
This queries the actual nodes in the audio chain, so the curve always reflects what is heard.

```js
function _redrawPeqEditorCurve() {
  const canvas = document.getElementById('peq-editor-canvas');
  if (!canvas || !_ctx) return;
  const ctx2d = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // Build log-spaced frequency array 20Hz–20kHz
  const N = 512;
  const freqs = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    freqs[i] = 20 * Math.pow(1000, i / (N - 1));
  }

  // Multiply magnitude responses across all enabled peqNodes
  const combined = new Float32Array(N).fill(1);
  for (const node of _peqNodes) {
    const mag = new Float32Array(N);
    node.getFrequencyResponse(freqs, mag, new Float32Array(N));
    for (let i = 0; i < N; i++) combined[i] *= mag[i];
  }

  // Convert to dB
  const dbRange = 20;   // ±20 dB
  const toDB = v => 20 * Math.log10(Math.max(v, 1e-6));

  ctx2d.clearRect(0, 0, W, H);

  // Draw 0 dB line
  const zeroY = H / 2;
  ctx2d.strokeStyle = 'rgba(107,107,123,0.4)';
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  ctx2d.moveTo(0, zeroY);
  ctx2d.lineTo(W, zeroY);
  ctx2d.stroke();

  // Draw EQ curve
  ctx2d.strokeStyle = '#adc6ff';   // --accent
  ctx2d.lineWidth = 2;
  ctx2d.beginPath();
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * W;
    const db = Math.max(-dbRange, Math.min(dbRange, toDB(combined[i])));
    const y = zeroY - (db / dbRange) * (H / 2);
    i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
  }
  ctx2d.stroke();
}
```

Call `_redrawPeqEditorCurve()` on every band parameter change, debounced to one
`requestAnimationFrame` per frame.

Expose `_redrawPeqEditorCurve` via the `Player` public API so `App` can call it:
`redrawEqCurve: _redrawPeqEditorCurve`

### `app.js` Functions Required

Add these functions to `app.js` and expose them on the `App` object:

| Function | Action |
|---|---|
| `openPeqEditor()` | Show `#peq-editor-modal`, load state from `localStorage`, call `renderPeqEditorBands()`, trigger `Player.redrawEqCurve()` |
| `closePeqEditor(event)` | Hide modal (if `event`, only close on overlay click) |
| `applyAndClosePeqEditor()` | Save state to `localStorage`, call `_applyCustomPeq(state)` via Player, close modal |
| `resetCustomPeq()` | Show confirm modal, on confirm reset all bands to defaults, re-render, redraw curve |
| `renderPeqEditorBands()` | Rebuild the `#peq-editor-bands` innerHTML from current state |
| `togglePeqBand(i)` | Toggle `bands[i].enabled`, rebuild chain, redraw curve |
| `onPeqBandTypeChange(i, val)` | Update `bands[i].type`, toggle gain input visibility, rebuild chain, redraw curve |
| `onPeqBandFcChange(i, val)` | Update `bands[i].fc`, update live node, redraw curve |
| `onPeqBandGainChange(i, val)` | Update `bands[i].gain`, update live node, redraw curve |
| `onPeqBandQChange(i, val)` | Update `bands[i].q`, update live node, redraw curve |
| `onPeqPreampChange(val)` | Update `preamp_db`, update `_preampNode.gain` directly, redraw curve |
| `saveCustomPeqAsProfile()` | Serialise bands to APO `.txt`, POST to `/api/iems/{id}/peq` after user picks an IEM |

The "update live node" operations (Fc, Gain, Q, Preamp) must check that `Player._ctx` is
initialised and that the target `_peqNode` index exists before attempting the `AudioParam` update.
Expose a `updateBandParam(enabledIndex, fc, gain, q)` function on the `Player` public API for
`app.js` to call.

Also expose `applyCustomPeq(state)` on `Player` so `app.js` can trigger a full chain rebuild:
```js
applyCustomPeq: (state) => _applyCustomPeq(state),
```

### Persistence

- Load from `localStorage` key `'tb_custom_peq'` on `openPeqEditor()`.
- Save to `localStorage` on every band change and on `applyAndClosePeqEditor()`.
- On `Player.init()`, check if `'tb_custom_peq'` exists and `enabled === true`; if so, call
  `_applyCustomPeq(state)` to restore the EQ automatically on app startup.
- The "EQ" button in the player bar (`#player-peq-btn`) should remain `.active` when custom EQ
  is enabled, consistent with how it shows active for IEM profiles.

### "Save as Profile" Flow

1. User clicks "Save as Profile"
2. A small inline sub-panel (or the existing `_showConfirm` approach) asks: IEM name (dropdown
   from `/api/iems`) and profile name (text input)
3. On confirm: serialise bands to APO `.txt` format:
   ```
   Preamp: -0.0 dB
   Filter 1: ON PK Fc 1000 Hz Gain 0.0 dB Q 1.000
   ...
   ```
   (omit disabled bands; omit Gain field for LPQ/HPQ/NO/AP types)
4. POST as multipart to `POST /api/iems/{iemId}/peq` with the `.txt` file content — the existing
   backend endpoint already parses this format.

### Modal CSS

The modal follows `master-design.md` §6.7 and the design tokens. Add to `static/style.css`:

```css
/* PEQ Editor Modal */
.peq-editor-modal-inner {
  width: 720px;
  max-height: 88vh;
  overflow-y: auto;
  background:
    radial-gradient(480px 200px at 10% -30%, rgba(173,198,255,0.13), transparent 60%),
    rgba(20, 20, 24, 0.96);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(173,198,255,0.18);
  border-radius: 24px;   /* --radius-lg */
  padding: 24px;
  box-shadow: 0 32px 80px rgba(4, 8, 24, 0.55);
}

.peq-editor-curve-wrap {
  background: rgba(255,255,255,0.025);
  border-radius: 12px;
  padding: 8px;
  margin-bottom: 16px;
  border: 1px solid rgba(173,198,255,0.08);
}

#peq-editor-canvas {
  display: block;
  width: 100%;
  height: 160px;
  border-radius: 8px;
}

.peq-editor-preamp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0 12px;
  border-bottom: 1px solid rgba(173,198,255,0.10);
  margin-bottom: 10px;
}

.peq-editor-band-header,
.peq-editor-band-row {
  display: grid;
  grid-template-columns: 24px 52px 72px 90px 90px 80px;
  gap: 8px;
  align-items: center;
}

.peq-editor-band-header {
  padding: 4px 0 6px;
}

.peq-editor-band-row {
  padding: 4px 0;
}

.peq-editor-col-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}

.peq-editor-band-num {
  font-size: 12px;
  color: var(--text-muted);
  text-align: right;
}

.peq-band-toggle {
  font-size: 11px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 9999px;
  border: 1px solid rgba(107,107,123,0.4);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.peq-band-toggle.active {
  background: rgba(83,225,111,0.18);
  color: var(--accent-success);
  border-color: rgba(83,225,111,0.4);
}

.peq-band-type {
  /* same treatment as .peq-select */
  background: var(--bg-active);
  color: var(--text);
  border: 1px solid rgba(173,198,255,0.12);
  border-radius: 8px;
  padding: 4px 6px;
  font-size: 12px;
  width: 100%;
}

.peq-editor-num-input {
  background: var(--bg-active);
  color: var(--text);
  border: 1px solid rgba(173,198,255,0.12);
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 12px;
  text-align: right;
  width: 100%;
}
.peq-editor-num-input:focus {
  outline: none;
  box-shadow: 0 0 0 2px rgba(173,198,255,0.35);
}

.peq-input-hidden {
  visibility: hidden;
}

.peq-editor-unit {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
}

.peq-editor-footer {
  display: flex;
  justify-content: center;
  padding-top: 16px;
  border-top: 1px solid rgba(173,198,255,0.10);
  margin-top: 12px;
}
```

---

## 4. Out of Scope

Do not implement the following. They are noted for future work only:

- Gapless playback (requires `AudioBufferSourceNode` rebuild)
- ReplayGain normalisation
- MediaSession API integration
- Keyboard shortcut expansion (← / → seek ±10s, ↑/↓ volume)
- Queue "Play from here" context menu action
- Error recovery UI (error state on play button)
- PEQ chain rebuild optimisation (click on profile switch)
- `ps.queueIdx` / `ps.shufflePos` refactor
- Seek bar buffering/loading indicator

---

## 5. Implementation Order

Work through tasks in this order to avoid conflicts between CSS and JS changes:

1. CSS-only fixes (§2.1–2.4) — no JS or HTML changes, safe to do first
2. Bug fix 1.1 (seek throttle) — two constant changes in `player.js`
3. Bug fix 1.2 (`seeking`/`seeked` flags) — small additions to `player.js`
4. Bug fix 1.3 (crossfade short-track guard) — one condition change in `player.js`
5. Bug fix 1.4 (`removeFromQueue` shuffle) — logic change in `player.js`
6. Bug fix 1.5 (`next`/`prev` modulus) — two small changes in `player.js`
7. Custom PEQ editor — HTML (modal), CSS (styles), `player.js` (new public API), `app.js` (editor logic)
