/* ═══════════════════════════════════════════════════════════════════════
   TuneBridge Player
   ───────────────────────────────────────────────────────────────────────
   Handles in-app playback, queue management, PEQ via Web Audio API,
   and the bottom player bar UI.

   Dependencies (loaded before this file):
     • SortableJS (global Sortable)
     • app.js exposes toast() globally

   Exposed as window.Player — called from inline onclick attrs and app.js
   ═══════════════════════════════════════════════════════════════════════ */

const Player = (function () {
  'use strict';

  /* ── State ─────────────────────────────────────────────────────────── */
  const ps = {
    queue:        [],
    queueIdx:     -1,
    shuffleOrder: [],   // shuffled index list when shuffle is on
    shuffle:      false,
    repeatMode:   'off',   // 'off' | 'all' | 'one'
    volume:       1.0,
    muted:        false,
    muteExplicit: false,
    isPlaying:    false,
    activePeqIemId:     null,
    activePeqProfileId: null,
    crossfadeDuration:  0,    // seconds; 0 = disabled (Web Audio mode only)
    queueOpen:       false,
    peqOpen:         false,
    historyExpanded: false,
    playbackContextTracks: [],
    playbackContextLabel: '',
    playbackContext: { sourceType: 'unknown', sourceId: '', sourceLabel: '' },
    recentContexts: [],
    lastShuffleFirstIdx: -1,
  };

  /* ── mpv backend state ──────────────────────────────────────────────── */
  let _mpvAvailable  = false;  // set by init() after /api/player/capabilities
  let _exclusiveMode = false;  // CoreAudio exclusive (bit-perfect); mirrors settings
  let _pollTimer     = null;   // setInterval handle for mpv state polling
  let _mpvPosition   = 0;      // last known position from mpv (seconds)
  let _mpvDuration   = 0;      // last known duration from mpv (seconds)
  let _lastMpvActive = false;

  function _isMpvActive() {
    if (!_mpvAvailable) return false;
    // Crossfade is now handled by the mpv dual-instance backend path.
    // The Web Audio path is only used when mpv is not available at all.
    return true;
  }

  /* ── Track registry (populated by app.js via Player.registerTracks) ── */
  const _registry = new Map();   // id → track object

  /* ── Audio elements (A/B for crossfade) ─────────────────────────────── */
  const _audioA = new Audio();
  _audioA.preload = 'metadata';
  // crossOrigin = 'anonymous' is required for createMediaElementSource in WKWebView.
  // Without it, WKWebView may reject the Web Audio API routing even for same-origin
  // requests. The stream endpoint returns Access-Control-Allow-Origin: * so this works.
  _audioA.crossOrigin = 'anonymous';

  const _audioB = new Audio();
  _audioB.preload = 'auto';   // pre-buffer next track during crossfade
  _audioB.crossOrigin = 'anonymous';

  let _audio = _audioA;       // pointer to currently active element — swaps on crossfade
  let _consecutiveErrors = 0; // stops rapid-fire skipping when music volume is unmounted

  // Web Audio API graph (lazy — created on first play gesture)
  let _ctx        = null;
  let _srcA       = null;   // MediaElementSource for _audioA
  let _srcB       = null;   // MediaElementSource for _audioB
  let _fadeGainA  = null;   // GainNode — crossfade gain for A
  let _fadeGainB  = null;   // GainNode — crossfade gain for B
  let _preampNode = null;   // GainNode — PEQ preamp headroom
  let _rgGainNode = null;   // GainNode — ReplayGain gain compensation (1.0 = passthrough)
  let _volNode    = null;   // GainNode — user volume
  let _peqNodes   = [];     // BiquadFilterNode[] — PEQ chain

  // ReplayGain mode: 'off' | 'track' | 'album' — persisted to localStorage
  let _rgMode = 'off';

  // Crossfade state (Web Audio path)
  let _xfadeTriggered = false;  // true while a Web Audio crossfade is in progress
  let _xfadeTimeout   = null;   // setTimeout handle for _completeCrossfade

  // Crossfade state (mpv backend path)
  let _mpvXfadeTriggered = false;  // true after crossfade_start sent to backend
  let _mpvXfadeQueueIdx  = -1;     // queue index of the fading-in track

  let _queueSortable        = null;
  let _seekDragging         = false;
  let _seeking              = false;
  let _seekRestored         = false;
  let _saveSeekThrottle     = -1;  // last 1-second bucket saved (throttles timeupdate writes)
  let _remoteSaveTimer      = null; // debounce handle for server-side state saves
  let _remoteSeekThrottle   = -1;  // last 5-second bucket that triggered a remote save
  let _eventPostInFlight    = false;
  let _pendingPlaybackEvents = [];
  let _peqCloseTimer        = null; // delayed hide timer for animated popover close
  let _peqCurveRaf          = null;
  let _customPeqState       = null;
  let _activeHistoryTrack    = null;
  let _trackSessionStartedAt = 0;
  let _trackSessionStartPos = 0;
  let _trackHistorySessionId = '';
  let _lastPauseEventAt = 0;
  let _suppressPauseFlush = false;
  let _startupRestoreGuardActive = true;

  const _CUSTOM_PEQ_KEY = 'tb_custom_peq';
  const _CUSTOM_EQ_ID = '__custom__';
  const _CREATE_PEQ_ID = '__create__';
  const _NO_GAIN_TYPES = new Set(['LPQ', 'HPQ', 'NO', 'AP']);
  const _LOSSLESS_FORMATS = new Set(['FLAC', 'ALAC', 'WAV', 'AIFF', 'AIF', 'APE', 'WV', 'DSF', 'DFF']);
  const _LOSSY_FORMATS = new Set(['MP3', 'AAC', 'M4A', 'MP4', 'OGG', 'OPUS', 'WMA']);

  function _boolFromState(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (!v) return false;
      if (['true', '1', 'yes', 'on'].includes(v)) return true;
      if (['false', '0', 'no', 'off'].includes(v)) return false;
    }
    return fallback;
  }

  function _defaultCustomPeqState() {
    return {
      enabled: false,
      preamp_db: 0,
      bands: Array.from({ length: 10 }, () => ({
        enabled: false,
        type: 'PK',
        fc: 1000,
        gain: 0,
        q: 1.0,
      })),
    };
  }

  function _sanitizeCustomPeqState(raw) {
    const base = _defaultCustomPeqState();
    if (!raw || typeof raw !== 'object') return base;
    const bands = Array.isArray(raw.bands) ? raw.bands : [];
    base.enabled = !!raw.enabled;
    base.preamp_db = Math.max(-30, Math.min(30, Number(raw.preamp_db) || 0));
    for (let i = 0; i < 10; i++) {
      const b = bands[i] || {};
      const t = String(b.type || 'PK').toUpperCase();
      const type = _FILTER_TYPE[t] ? t : 'PK';
      base.bands[i] = {
        enabled: !!b.enabled,
        type,
        fc: Math.max(20, Math.min(20000, Number(b.fc) || 1000)),
        gain: Math.max(-30, Math.min(30, Number(b.gain) || 0)),
        q: Math.max(0.1, Math.min(10, Number(b.q) || 1.0)),
      };
    }
    return base;
  }

  function _loadCustomPeqState() {
    if (_customPeqState) return _customPeqState;
    try {
      const raw = localStorage.getItem(_CUSTOM_PEQ_KEY);
      _customPeqState = _sanitizeCustomPeqState(raw ? JSON.parse(raw) : null);
    } catch (_) {
      _customPeqState = _defaultCustomPeqState();
    }
    return _customPeqState;
  }

  function _saveCustomPeqState(state) {
    _customPeqState = _sanitizeCustomPeqState(state);
    try { localStorage.setItem(_CUSTOM_PEQ_KEY, JSON.stringify(_customPeqState)); } catch (_) {}
    return _customPeqState;
  }

  /* ── Web Audio graph init (fallback mode only) ─────────────────────── */

  function _teardownAudioContext() {
    // Disconnect all nodes and close the context. close() is async but we don't
    // await it — the old context is abandoned and GC'd; creating a new context
    // immediately after is safe because MediaElementSource bindings are per-context.
    try {
      if (_volNode)    { try { _volNode.disconnect();    } catch (_) {} }
      if (_preampNode) { try { _preampNode.disconnect(); } catch (_) {} }
      if (_rgGainNode) { try { _rgGainNode.disconnect(); } catch (_) {} }
      if (_fadeGainA)  { try { _fadeGainA.disconnect();  } catch (_) {} }
      if (_fadeGainB)  { try { _fadeGainB.disconnect();  } catch (_) {} }
      if (_srcA)       { try { _srcA.disconnect();       } catch (_) {} }
      if (_srcB)       { try { _srcB.disconnect();       } catch (_) {} }
      _peqNodes.forEach(n => { try { n.disconnect(); } catch (_) {} });
      if (_ctx) _ctx.close().catch(() => {});
    } catch (_) {}
    _ctx = _srcA = _srcB = _fadeGainA = _fadeGainB = _rgGainNode = _preampNode = _volNode = null;
    _peqNodes = [];
  }

  function _initAudioContext(sampleRate) {
    if (_isMpvActive()) return;
    const targetSr = (sampleRate && sampleRate > 0) ? sampleRate : 44100;

    // Recreate context if sample rate changed — avoids resampling hi-res sources
    if (_ctx) {
      if (Math.round(_ctx.sampleRate) === targetSr) return;  // already matched
      _teardownAudioContext();
    }

    try {
      // sampleRate is advisory: WKWebView silently clamps to nearest hardware-supported rate
      _ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: targetSr });
    } catch (_) {
      // Fallback if sampleRate arg is rejected (older WebKit)
      try { _ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { console.warn('Player: Web Audio API init failed', e); return; }
    }

    try {
      // One MediaElementSource per audio element (can only be created once per element,
      // but closing the old context destroys the binding, allowing rebind to new context)
      _srcA       = _ctx.createMediaElementSource(_audioA);
      _srcB       = _ctx.createMediaElementSource(_audioB);
      _fadeGainA  = _ctx.createGain();
      _fadeGainB  = _ctx.createGain();
      _rgGainNode = _ctx.createGain();
      _preampNode = _ctx.createGain();
      _volNode    = _ctx.createGain();
      _volNode.gain.value    = ps.muted ? 0 : ps.volume;
      _preampNode.gain.value = 1.0;
      _rgGainNode.gain.value = 1.0;   // passthrough until a track with RG data is loaded
      _fadeGainA.gain.value  = 1.0;   // A starts as active
      _fadeGainB.gain.value  = 0.0;   // B starts as standby
      // Both paths feed into the shared PEQ chain
      // Graph: srcA/B → fadeGainA/B → rgGainNode → preampNode → peqNodes[] → volNode → destination
      _srcA.connect(_fadeGainA);
      _srcB.connect(_fadeGainB);
      _fadeGainA.connect(_rgGainNode);
      _fadeGainB.connect(_rgGainNode);
      _rgGainNode.connect(_preampNode);
      _preampNode.connect(_volNode);
      _volNode.connect(_ctx.destination);
      // Re-apply any stored PEQ
      if (ps.activePeqIemId === _CUSTOM_EQ_ID) {
        const custom = _loadCustomPeqState();
        if (custom.enabled) _applyCustomPeq(custom);
      } else if (ps.activePeqIemId && ps.activePeqProfileId) {
        _loadAndApplyPeq(ps.activePeqIemId, ps.activePeqProfileId);
      }
    } catch (e) {
      console.warn('Player: Web Audio graph wiring failed', e);
    }
  }

  /* ── mpv helpers ────────────────────────────────────────────────────── */
  function _mpvCmd(route, body) {
    return fetch(`/api/player/${route}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body || {}),
    }).catch(e => console.warn(`Player: mpv ${route} failed`, e));
  }

  /* ── mpv state polling ──────────────────────────────────────────────── */
  function _startPolling() {
    if (_pollTimer) return;
    _pollTimer = setInterval(_pollMpvState, 250);
  }

  function _stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  async function _pollMpvState() {
    let state;
    try {
      const r = await fetch('/api/player/mpv_state');
      if (!r.ok) return;
      state = await r.json();
    } catch (_) { return; }

    if (!state || !state.available) return;

    _mpvPosition = state.position || 0;
    _mpvDuration = state.duration || 0;

    // Sync play/pause indicator (only when not seek-dragging)
    if (!_seekDragging && !_seeking) {
      const wasPlaying = ps.isPlaying;
      ps.isPlaying = !!state.playing;
      if (wasPlaying !== ps.isPlaying) _updatePlayBtn();

      // Update seek bar + time display
      if (_mpvDuration > 0) {
        const pct     = _mpvPosition / _mpvDuration;
        const seekEl  = document.getElementById('player-seek');
        const fillEl  = document.getElementById('player-progress-fill');
        const curEl   = document.getElementById('player-current-time');
        const durEl   = document.getElementById('player-duration');
        if (seekEl) seekEl.value = Math.min(1, pct) * 1000;
        if (fillEl) fillEl.style.width = (Math.min(1, pct) * 100) + '%';
        if (curEl)  curEl.textContent  = _fmtTime(_mpvPosition);
        if (durEl)  durEl.textContent  = _fmtTime(_mpvDuration);
      }
    }

    // Crossfade trigger: when remaining time falls within crossfade window
    if (!_mpvXfadeTriggered && ps.crossfadeDuration > 0 && ps.isPlaying && _mpvDuration > 0) {
      const remaining = _mpvDuration - _mpvPosition;
      // Extra 150 ms buffer absorbs afade filter activation lag
      if (remaining > 0.1
          && remaining <= ps.crossfadeDuration + 0.15
          && _mpvPosition > 0.5
          && _mpvDuration > ps.crossfadeDuration + 2) {
        _startMpvCrossfade();
      }
    }

    // xfade_track_ended: secondary finished naturally before our timeout — complete early
    if (state.xfade_track_ended && _mpvXfadeTriggered && _mpvXfadeQueueIdx >= 0) {
      const nextRealIdx = (ps.shuffle && ps.shuffleOrder.length > 0)
        ? (ps.shuffleOrder[_mpvXfadeQueueIdx] ?? _mpvXfadeQueueIdx)
        : _mpvXfadeQueueIdx;
      const nextTrack = ps.queue[nextRealIdx];
      if (nextTrack) _completeMpvCrossfade(nextTrack, _mpvXfadeQueueIdx);
    }

    // Track ended — advance queue (suppressed by backend during xfade)
    if (state.track_ended) {
      _onMpvTrackEnded();
    }
  }

  function _onMpvTrackEnded() {
    _flushCurrentTrackEvent('ended', { completed: true, minElapsed: 1 });
    if (ps.repeatMode === 'one') {
      // Re-play current track from start
      const t = currentTrack();
      if (t) {
        _mpvCmd('play', { track_id: t.id, position: 0 });
        _activeHistoryTrack = t;
        _markTrackSessionStart();
      }
    } else if (ps.repeatMode === 'all' || ps.queueIdx < ps.queue.length - 1) {
      const len = ps.shuffle ? ps.shuffleOrder.length : ps.queue.length;
      ps.queueIdx = (ps.queueIdx + 1) % Math.max(1, len);
      const t = currentTrack();
      if (t) {
        _activeHistoryTrack = t;
        _updateTrackUI(t);
        _highlightActiveRow();
        _mpvCmd('play', { track_id: t.id }).then(() => {
          ps.isPlaying = true;
          _updatePlayBtn();
        });
        _markTrackSessionStart();
        if (ps.queueOpen) _renderQueue();
        _saveState();
      }
    } else {
      // End of queue, no repeat
      ps.isPlaying = false;
      _activeHistoryTrack = null;
      _updatePlayBtn();
      _highlightActiveRow();
      if (ps.queueOpen) _renderQueue();
    }
  }

  /* ── Crossfade helpers ──────────────────────────────────────────────── */
  // Returns the fade GainNode for the currently active slot
  function _curFadeGain()  { return _audio === _audioA ? _fadeGainA : _fadeGainB; }
  // Returns the OTHER audio element (standby / next)
  function _nextAudioEl()  { return _audio === _audioA ? _audioB : _audioA; }
  // Returns the fade GainNode for the standby slot
  function _nxtFadeGain()  { return _audio === _audioA ? _fadeGainB : _fadeGainA; }

  function _cancelCrossfade() {
    if (_isMpvActive()) {
      _cancelMpvCrossfade();
      return;
    }
    // Web Audio path
    if (_xfadeTimeout) { clearTimeout(_xfadeTimeout); _xfadeTimeout = null; }
    _xfadeTriggered = false;
    _seeking = false;
    _seekRestored = false;
    if (!_ctx) return;
    const now = _ctx.currentTime;
    // Abort any scheduled ramps and hard-reset gains
    if (_fadeGainA) { _fadeGainA.gain.cancelScheduledValues(now); }
    if (_fadeGainB) { _fadeGainB.gain.cancelScheduledValues(now); }
    const activeFade = _curFadeGain();
    const standbyFade = _nxtFadeGain();
    const standbyEl   = _nextAudioEl();
    if (activeFade)  activeFade.gain.setValueAtTime(1, now);
    if (standbyFade) standbyFade.gain.setValueAtTime(0, now);
    standbyEl.pause();
    standbyEl.src = '';
  }

  /* ── mpv backend crossfade ───────────────────────────────────────────── */

  function _cancelMpvCrossfade() {
    if (_xfadeTimeout) { clearTimeout(_xfadeTimeout); _xfadeTimeout = null; }
    _mpvXfadeTriggered = false;
    _mpvXfadeQueueIdx  = -1;
    _seeking           = false;
    _seekRestored      = false;
    // Fire-and-forget — don't block UI on this
    _mpvCmd('crossfade_cancel', {}).catch(() => {});
  }

  function _startMpvCrossfade() {
    if (_mpvXfadeTriggered || !ps.isPlaying || ps.crossfadeDuration <= 0) return;
    if (_seekRestored) return;

    // Determine next queue position (same shuffle-aware logic as _startCrossfade)
    let nextQueueIdx;
    if (ps.repeatMode === 'one') {
      nextQueueIdx = ps.queueIdx;
    } else if (ps.queueIdx < ps.queue.length - 1) {
      nextQueueIdx = ps.queueIdx + 1;
    } else if (ps.repeatMode === 'all') {
      nextQueueIdx = 0;
    } else {
      return;  // end of queue, no repeat — let it finish naturally
    }

    const nextRealIdx = (ps.shuffle && ps.shuffleOrder.length > 0)
      ? (ps.shuffleOrder[nextQueueIdx] ?? nextQueueIdx)
      : nextQueueIdx;
    const nextTrack = ps.queue[nextRealIdx];
    if (!nextTrack) return;

    _mpvXfadeTriggered = true;
    _mpvXfadeQueueIdx  = nextQueueIdx;

    const dur = ps.crossfadeDuration;

    _mpvCmd('crossfade_start', { next_track_id: nextTrack.id, duration: dur })
      .then(r => {
        if (!r || !r.ok) {
          // Backend rejected — reset and let track end naturally
          _mpvXfadeTriggered = false;
          _mpvXfadeQueueIdx  = -1;
          return;
        }
        // Schedule completion after fade duration
        _xfadeTimeout = setTimeout(
          () => _completeMpvCrossfade(nextTrack, nextQueueIdx),
          dur * 1000
        );
      })
      .catch(() => {
        _mpvXfadeTriggered = false;
        _mpvXfadeQueueIdx  = -1;
      });
  }

  function _completeMpvCrossfade(nextTrack, nextQueueIdx) {
    if (_xfadeTimeout) { clearTimeout(_xfadeTimeout); _xfadeTimeout = null; }

    // Capture position before any state change (for accurate playback event logging)
    const finishPos = _mpvPosition;

    // Flush playback event for the track that just faded out
    const prevTrack = currentTrack();
    if (prevTrack) {
      const elapsed = Math.max(0, finishPos - (_trackSessionStartPos || 0));
      if (elapsed >= 1) {
        const duration = Number(prevTrack.duration || finishPos || 0);
        const completed = duration > 0 && finishPos >= Math.max(duration - 1.0, duration * 0.98);
        _pushRecentContext(prevTrack, 'xfade');
        _postPlaybackEvents([{
          track_id:                prevTrack.id,
          played_at:               Math.floor(_safeNowSec()),
          play_seconds:            elapsed,
          track_duration_seconds:  duration,
          completed,
          skipped:      false,
          source_type:  (ps.playbackContext || {}).sourceType  || 'unknown',
          source_id:    (ps.playbackContext || {}).sourceId    || '',
          source_label: (ps.playbackContext || {}).sourceLabel || ps.playbackContextLabel || '',
          artist:  prevTrack.artist  || '',
          album:   prevTrack.album   || '',
          title:   prevTrack.title   || '',
          format:  prevTrack.format  || '',
          reason:  'xfade',
        }]);
      }
    }

    // Tell backend to promote secondary → primary
    _mpvCmd('crossfade_complete', {})
      .catch(() => {})
      .finally(() => {
        ps.queueIdx = nextQueueIdx;
        _activeHistoryTrack = nextTrack;
        _updateTrackUI(nextTrack);
        _highlightActiveRow();
        _markTrackSessionStart();
        _saveState();
        if (ps.queueOpen) _renderQueue();
        _mpvXfadeTriggered = false;
        _mpvXfadeQueueIdx  = -1;
      });
  }

  function _startCrossfade() {
    if (_xfadeTriggered || !_ctx || ps.crossfadeDuration <= 0) return;
    if (!ps.isPlaying) return;
    if (_seekRestored) return;

    // Determine next queue position
    let nextQueueIdx;
    if (ps.repeatMode === 'one') {
      nextQueueIdx = ps.queueIdx;
    } else if (ps.queueIdx < ps.queue.length - 1) {
      nextQueueIdx = ps.queueIdx + 1;
    } else if (ps.repeatMode === 'all') {
      nextQueueIdx = 0;
    } else {
      return;  // end of queue with no repeat — let it finish naturally
    }

    // Resolve the real queue index (shuffle-aware)
    const nextRealIdx = (ps.shuffle && ps.shuffleOrder.length > 0)
      ? (ps.shuffleOrder[nextQueueIdx] ?? nextQueueIdx)
      : nextQueueIdx;
    const nextTrack = ps.queue[nextRealIdx];
    if (!nextTrack) return;

    _xfadeTriggered = true;

    const nextEl   = _nextAudioEl();
    const nextFade = _nxtFadeGain();
    const curFade  = _curFadeGain();
    const dur      = ps.crossfadeDuration;
    const now      = _ctx.currentTime;

    // Cancel any existing ramps
    curFade.gain.cancelScheduledValues(now);
    nextFade.gain.cancelScheduledValues(now);

    // Load and start playing next track (silently — gain will ramp up)
    nextFade.gain.setValueAtTime(0, now);
    nextEl.src = `/api/stream/${nextTrack.id}`;
    nextEl.load();
    nextEl.play().catch(() => {});

    // Schedule smooth linear crossfade over `dur` seconds
    curFade.gain.setValueAtTime(curFade.gain.value, now);
    curFade.gain.linearRampToValueAtTime(0, now + dur);
    nextFade.gain.linearRampToValueAtTime(1, now + dur);

    // Complete the swap after the fade finishes
    _xfadeTimeout = setTimeout(() => _completeCrossfade(nextTrack, nextQueueIdx), dur * 1000);
  }

  function _completeCrossfade(nextTrack, nextQueueIdx) {
    const oldEl   = _audio;
    const oldFade = _curFadeGain();

    // Flush play event for the track that just finished, BEFORE swapping _audio.
    // We must capture pos from oldEl directly (not _audio) because _capturePlaybackSeconds
    // reads _audio, which is about to be re-pointed.
    const prevTrack = currentTrack();
    if (prevTrack) {
      const pos = _isMpvActive() ? (_mpvPosition || 0) : (oldEl.duration || 0);
      const elapsed = Math.max(0, pos - (_trackSessionStartPos || 0));
      if (elapsed >= 1) {
        const duration = Number(prevTrack.duration || pos || 0);
        const completed = duration > 0 && pos >= Math.max(duration - 1.0, duration * 0.98);
        _pushRecentContext(prevTrack, 'xfade');
        _postPlaybackEvents([{
          track_id: prevTrack.id,
          played_at: Math.floor(_safeNowSec()),
          play_seconds: elapsed,
          track_duration_seconds: duration,
          completed,
          skipped: false,
          source_type: (ps.playbackContext || {}).sourceType || 'unknown',
          source_id:   (ps.playbackContext || {}).sourceId   || '',
          source_label:(ps.playbackContext || {}).sourceLabel || ps.playbackContextLabel || '',
          artist: prevTrack.artist || '',
          album:  prevTrack.album  || '',
          title:  prevTrack.title  || '',
          format: prevTrack.format || '',
          reason: 'xfade',
        }]);
      }
    }

    // Swap active pointer
    _audio = _nextAudioEl();

    // Hard-silence and stop the old element
    if (_ctx) oldFade.gain.setValueAtTime(0, _ctx.currentTime);
    oldEl.pause();
    oldEl.src = '';

    // Advance queue
    ps.queueIdx = nextQueueIdx;

    // Update UI
    _updateTrackUI(nextTrack);

    // Manually set duration/time (loadedmetadata already fired on the inactive element)
    const durEl  = document.getElementById('player-duration');
    const curEl  = document.getElementById('player-current-time');
    const seekEl = document.getElementById('player-seek');
    const fillEl = document.getElementById('player-progress-fill');
    const activeDur = _audio.duration;
    if (isFinite(activeDur) && activeDur > 0) {
      const pct = _audio.currentTime / activeDur;
      if (durEl)  durEl.textContent       = _fmtTime(activeDur);
      if (curEl)  curEl.textContent       = _fmtTime(_audio.currentTime);
      if (seekEl) seekEl.value            = pct * 1000;
      if (fillEl) fillEl.style.width      = (pct * 100) + '%';
    }

    _markTrackSessionStart();
    _highlightActiveRow();
    _saveState();
    if (ps.queueOpen) _renderQueue();

    _xfadeTriggered = false;
    _xfadeTimeout   = null;
  }

  /* ── PEQ ─────────────────────────────────────────────────────────────── */
  // Map APO/AutoEQ filter type strings → BiquadFilterNode.type
  const _FILTER_TYPE = {
    'PK': 'peaking', 'PEQ': 'peaking',
    'LSC': 'lowshelf', 'LS': 'lowshelf', 'LSQ': 'lowshelf',
    'HSC': 'highshelf', 'HS': 'highshelf', 'HSQ': 'highshelf',
    'LPQ': 'lowpass', 'LP': 'lowpass',
    'HPQ': 'highpass', 'HP': 'highpass',
    'NO': 'notch', 'NOTCH': 'notch',
    'AP': 'allpass',
  };

  function _dBToLinear(db) { return Math.pow(10, db / 20); }

  function _buildPeqChain(peqProfile) {
    if (_isMpvActive()) {
      // mpv mode: send profile to backend as a lavfi audio filter
      if (!peqProfile) {
        _mpvCmd('peq', { preamp_db: 0, filters: [] });
      } else {
        const filters = (peqProfile.filters || []).map(f => ({
          enabled: f.enabled !== false,
          type:    f.type  || 'PK',
          fc:      f.fc    || 1000,
          gain:    f.gain  || 0,
          q:       f.q     || 1.0,
        }));
        _mpvCmd('peq', { preamp_db: peqProfile.preamp_db || 0, filters });
      }
      _scheduleEqCurveRedraw();
      return;
    }

    // Web Audio fallback
    if (!_ctx || !_preampNode || !_volNode) return;

    try { _preampNode.disconnect(); } catch (_) {}
    _peqNodes.forEach(n => { try { n.disconnect(); } catch (_) {} });
    _peqNodes = [];

    if (!peqProfile) {
      _preampNode.gain.value = 1.0;
      _preampNode.connect(_volNode);
      return;
    }

    const preampDb = typeof peqProfile.preamp_db === 'number' ? peqProfile.preamp_db : 0;
    _preampNode.gain.value = _dBToLinear(preampDb);

    const active = (peqProfile.filters || []).filter(f => f.enabled !== false);
    _peqNodes = active.map(f => {
      const node = _ctx.createBiquadFilter();
      const typeKey = (f.type || 'PK').toUpperCase();
      node.type            = _FILTER_TYPE[typeKey] || 'peaking';
      node.frequency.value = f.fc   || 1000;
      node.gain.value      = f.gain || 0;
      node.Q.value         = f.q    || 1;
      return node;
    });

    const chain = [_preampNode, ..._peqNodes, _volNode];
    for (let i = 0; i < chain.length - 1; i++) {
      chain[i].connect(chain[i + 1]);
    }
  }

  function _applyCustomPeq(state) {
    const st = _saveCustomPeqState(state);
    if (!st.enabled) {
      _buildPeqChain(null);
      _scheduleEqCurveRedraw();
      _updatePeqBtn();
      return;
    }
    const filters = st.bands
      .filter(b => b.enabled)
      .map(b => ({
        type: b.type,
        fc: b.fc,
        gain: _NO_GAIN_TYPES.has(String(b.type || '').toUpperCase()) ? 0 : b.gain,
        q: b.q,
      }));
    const profile = { preamp_db: st.preamp_db, filters };
    _buildPeqChain(profile.filters.length > 0 ? profile : null);
    _scheduleEqCurveRedraw();
    _updatePeqBtn();
  }

  function _setCustomPeqEnabled(enabled) {
    const st = _loadCustomPeqState();
    st.enabled = !!enabled;
    _saveCustomPeqState(st);
    if (st.enabled) _applyCustomPeq(st);
    else {
      _buildPeqChain(null);
      _scheduleEqCurveRedraw();
      _updatePeqBtn();
    }
  }

  function _updateBandParam(enabledBandIndex, fc, gain, q) {
    if (_isMpvActive()) {
      // In mpv mode, re-send the entire custom PEQ state so all bands are in sync
      const st = _loadCustomPeqState();
      _applyCustomPeq(st);
      return true;
    }
    if (!_ctx || !Array.isArray(_peqNodes)) return false;
    const idx = Number(enabledBandIndex);
    if (!Number.isFinite(idx) || idx < 0 || idx >= _peqNodes.length) return false;
    const node = _peqNodes[idx];
    if (!node) return false;
    const now = _ctx.currentTime;
    if (Number.isFinite(fc)) node.frequency.setValueAtTime(Math.max(20, Math.min(20000, fc)), now);
    if (Number.isFinite(gain)) node.gain.setValueAtTime(Math.max(-30, Math.min(30, gain)), now);
    if (Number.isFinite(q)) node.Q.setValueAtTime(Math.max(0.1, Math.min(10, q)), now);
    return true;
  }

  function _updatePreamp(preampDb) {
    if (_isMpvActive()) {
      const st = _loadCustomPeqState();
      _applyCustomPeq(st);
      return;
    }
    const db = Math.max(-30, Math.min(30, Number(preampDb) || 0));
    if (_preampNode) _preampNode.gain.value = _dBToLinear(db);
  }

  /* ── Analytical biquad frequency response (used for PEQ canvas in mpv mode) ── */
  // Reference sample rate for display computation — high enough to be accurate across 20-20kHz
  const _BIQUAD_FS = 96000;

  function _biquadCoeffs(type, fc, gainDb, q) {
    const A   = Math.pow(10, gainDb / 40);
    const w0  = 2 * Math.PI * fc / _BIQUAD_FS;
    const cw  = Math.cos(w0);
    const sw  = Math.sin(w0);
    const alp = sw / (2 * Math.max(0.001, q));
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'peaking':
        b0 = 1 + alp * A;  b1 = -2 * cw;  b2 = 1 - alp * A;
        a0 = 1 + alp / A;  a1 = -2 * cw;  a2 = 1 - alp / A;
        break;
      case 'lowshelf':
        b0 =     A * ((A + 1) - (A - 1) * cw + 2 * Math.sqrt(A) * alp);
        b1 = 2 * A * ((A - 1) - (A + 1) * cw);
        b2 =     A * ((A + 1) - (A - 1) * cw - 2 * Math.sqrt(A) * alp);
        a0 =         (A + 1) + (A - 1) * cw + 2 * Math.sqrt(A) * alp;
        a1 =    -2 * ((A - 1) + (A + 1) * cw);
        a2 =         (A + 1) + (A - 1) * cw - 2 * Math.sqrt(A) * alp;
        break;
      case 'highshelf':
        b0 =      A * ((A + 1) + (A - 1) * cw + 2 * Math.sqrt(A) * alp);
        b1 = -2 * A * ((A - 1) + (A + 1) * cw);
        b2 =      A * ((A + 1) + (A - 1) * cw - 2 * Math.sqrt(A) * alp);
        a0 =          (A + 1) - (A - 1) * cw + 2 * Math.sqrt(A) * alp;
        a1 =      2 * ((A - 1) - (A + 1) * cw);
        a2 =          (A + 1) - (A - 1) * cw - 2 * Math.sqrt(A) * alp;
        break;
      case 'lowpass':
        b0 = (1 - cw) / 2;  b1 = 1 - cw;  b2 = (1 - cw) / 2;
        a0 = 1 + alp;       a1 = -2 * cw;  a2 = 1 - alp;
        break;
      case 'highpass':
        b0 = (1 + cw) / 2;  b1 = -(1 + cw);  b2 = (1 + cw) / 2;
        a0 = 1 + alp;       a1 = -2 * cw;     a2 = 1 - alp;
        break;
      case 'notch':
        b0 = 1;  b1 = -2 * cw;  b2 = 1;
        a0 = 1 + alp;  a1 = -2 * cw;  a2 = 1 - alp;
        break;
      default: // allpass / passthrough
        b0 = 1; b1 = 0; b2 = 0; a0 = 1; a1 = 0; a2 = 0;
    }
    return { b0, b1, b2, a0, a1, a2 };
  }

  function _biquadMagAt(c, f) {
    const w   = 2 * Math.PI * f / _BIQUAD_FS;
    const cw  = Math.cos(w);
    const sw  = Math.sin(w);
    const cw2 = 2 * cw * cw - 1;   // cos(2w)
    const sw2 = 2 * sw * cw;        // sin(2w)
    const nR  = c.b0 + c.b1 * cw + c.b2 * cw2;
    const nI  = -c.b1 * sw - c.b2 * sw2;
    const dR  = c.a0 + c.a1 * cw + c.a2 * cw2;
    const dI  = -c.a1 * sw - c.a2 * sw2;
    return Math.sqrt((nR * nR + nI * nI) / (dR * dR + dI * dI));
  }

  function _computeCombinedResponse(activeFilters, freqs) {
    // activeFilters: array of {type (BiquadFilterNode.type string), fc, gain, q}
    const combined = new Float32Array(freqs.length).fill(1);
    for (const f of activeFilters) {
      const c = _biquadCoeffs(f.type, f.fc, f.gain, f.q);
      for (let i = 0; i < freqs.length; i++) {
        combined[i] *= _biquadMagAt(c, freqs[i]);
      }
    }
    return combined;
  }

  function _redrawPeqEditorCurve() {
    if (typeof App !== 'undefined'
        && typeof App.isPeqWorkspaceOpen === 'function'
        && App.isPeqWorkspaceOpen()) {
      return;
    }
    const canvas = document.getElementById('peq-editor-canvas');
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const W = canvas.width;
    const H = canvas.height;
    const N = 512;
    const freqs = new Float32Array(N);
    for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1));

    let combined = new Float32Array(N).fill(1);
    let hasFilters = false;

    if (_isMpvActive()) {
      // Analytical computation from current custom PEQ state
      const st = _loadCustomPeqState();
      if (st && st.enabled) {
        const activeFilters = (st.bands || [])
          .filter(b => b && b.enabled)
          .map(b => ({
            type:  _FILTER_TYPE[(b.type || 'PK').toUpperCase()] || 'peaking',
            fc:    Math.max(20, Math.min(20000, b.fc   || 1000)),
            gain:  _NO_GAIN_TYPES.has(String(b.type || '').toUpperCase()) ? 0 : (b.gain || 0),
            q:     Math.max(0.1, b.q || 1.0),
          }));
        if (activeFilters.length > 0) {
          hasFilters = true;
          combined = _computeCombinedResponse(activeFilters, freqs);
        }
      }
    } else {
      // Web Audio: use getFrequencyResponse() from live BiquadFilterNodes
      const hasCtxNodes = !!_ctx && Array.isArray(_peqNodes) && _peqNodes.length > 0;
      if (hasCtxNodes) {
        hasFilters = true;
        for (const node of _peqNodes) {
          const mag = new Float32Array(N);
          node.getFrequencyResponse(freqs, mag, new Float32Array(N));
          for (let i = 0; i < N; i++) combined[i] *= mag[i];
        }
      }
    }

    const dbRange = 20;
    const toDB = v => 20 * Math.log10(Math.max(v, 1e-6));
    ctx2d.clearRect(0, 0, W, H);
    const zeroY = H / 2;
    ctx2d.strokeStyle = 'rgba(107,107,123,0.4)';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, zeroY);
    ctx2d.lineTo(W, zeroY);
    ctx2d.stroke();
    ctx2d.strokeStyle = '#adc6ff';
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * W;
      const db = Math.max(-dbRange, Math.min(dbRange, toDB(combined[i])));
      const y = zeroY - (db / dbRange) * (H / 2);
      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
    if (!hasFilters) {
      ctx2d.fillStyle = 'rgba(193,198,215,0.72)';
      ctx2d.font = '12px -apple-system,BlinkMacSystemFont,Helvetica Neue,Arial,sans-serif';
      const msg = _mpvAvailable
        ? 'Enable one or more bands to draw EQ response.'
        : (!_ctx
          ? 'Start playback to preview live EQ response.'
          : 'Enable one or more bands to draw EQ response.');
      ctx2d.fillText(msg, 12, H - 12);
    }
  }

  function _scheduleEqCurveRedraw() {
    if (_peqCurveRaf) return;
    _peqCurveRaf = requestAnimationFrame(() => {
      _peqCurveRaf = null;
      _redrawPeqEditorCurve();
    });
  }

  async function _loadAndApplyPeq(iemId, profileId) {
    if (!iemId || !profileId) {
      _buildPeqChain(null);
      return;
    }
    try {
      const iem = await fetch(`/api/iems/${iemId}`).then(r => r.json());
      const profile = (iem.peq_profiles || []).find(p => p.id === profileId);
      _buildPeqChain(profile || null);
    } catch (e) {
      console.warn('Player: PEQ load failed', e);
    }
  }

  /* ── Queue helpers ──────────────────────────────────────────────────── */
  function _fisherYates(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Returns the actual queue array index for the current position
  function _realIdx() {
    if (!ps.shuffle || ps.shuffleOrder.length === 0) return ps.queueIdx;
    return ps.shuffleOrder[ps.queueIdx] ?? ps.queueIdx;
  }

  function currentTrack() {
    const idx = _realIdx();
    return (idx >= 0 && idx < ps.queue.length) ? ps.queue[idx] : null;
  }

  /* ── Playback core ──────────────────────────────────────────────────── */
  function _loadTrack(track) {
    if (!track) return;
    const prev = _activeHistoryTrack || currentTrack();
    if (prev && prev.id && prev.id !== track.id) {
      _flushTrackEvent(prev, 'switch');
    }
    _seekRestored = false;
    if (_isMpvActive()) {
      _mpvCmd('play', { track_id: track.id });
      ps.isPlaying = true;
      _updatePlayBtn();
    } else {
      _cancelCrossfade();
      // Pass sample rate so the AudioContext is created (or recreated) at source rate
      _initAudioContext(track.sample_rate);
      _suppressPauseFlush = true;
      _audio.src = `/api/stream/${track.id}`;
      _audio.load();
      setTimeout(() => { _suppressPauseFlush = false; }, 0);
    }
    _activeHistoryTrack = track;
    _updateTrackUI(track);
    _highlightActiveRow();
    _applyReplayGain(track);
    // Immediately bump the active playback context to the front of Jump Back In.
    // This keeps rails responsive even before a track ends or pauses.
    _pushRecentContext(track, 'start');
    _markTrackSessionStart();
    _saveState();
    // Start buffering next track for gapless playback (no-op when crossfade > 0 or mpv active)
    _preloadNext();
  }

  function _startPlay() {
    if (_isMpvActive()) {
      // If mpv has no file loaded yet (e.g. first play after app restore),
      // _mpvDuration will be 0. Send a full loadfile instead of just unpause.
      if (_mpvDuration === 0) {
        const t = currentTrack();
        if (t) _loadTrack(t);
        return;
      }
      _mpvCmd('pause', { paused: false });
      // Reset session start to current position so elapsed time is measured from
      // the moment the user pressed play, not from position 0 (which is the default
      // when the track was restored from a previous session without calling _loadTrack).
      _markTrackSessionStart();
      ps.isPlaying = true;
      _updatePlayBtn();
      return;
    }
    _initAudioContext();
    if (_ctx && _ctx.state === 'suspended') _ctx.resume();
    // Reset session start to current position. Without this, a track restored mid-way
    // (e.g. at 2:30) would record elapsed from 0, inflating the listen duration by the
    // restored seek offset on the first play after app load.
    _markTrackSessionStart();
    const promise = _audio.play();
    if (promise) promise.catch(e => console.warn('Player: play() rejected', e));
    ps.isPlaying = true;
    _updatePlayBtn();
  }

  function _pauseAudio() {
    if (_isMpvActive()) {
      _mpvCmd('pause', { paused: true });
    } else {
      _audio.pause();
    }
    ps.isPlaying = false;
    _updatePlayBtn();
  }

  /* ── Public playback controls ───────────────────────────────────────── */
  function togglePlay() {
    _startupRestoreGuardActive = false;
    if (!currentTrack()) {
      if (ps.queue.length > 0) {
        ps.queueIdx = 0;
        if (ps.shuffle) {
          ps.shuffleOrder = _fisherYates(ps.queue.map((_, i) => i));
          ps.queueIdx = 0;
        }
        _loadTrack(currentTrack());
        _startPlay();
      }
      return;
    }
    if (ps.isPlaying) _pauseAudio(); else _startPlay();
  }

  function prev() {
    _startupRestoreGuardActive = false;
    if (ps.queue.length === 0) return;
    // Restart current track if more than 3 s in
    const curPos = _isMpvActive() ? _mpvPosition : _audio.currentTime;
    if (curPos > 3) {
      if (_isMpvActive()) { _mpvCmd('seek', { position: 0 }); }
      else { _audio.currentTime = 0; }
      return;
    }
    // Capture BEFORE _loadTrack — _audio.load() fires 'pause' synchronously,
    // which sets ps.isPlaying = false before we can check it.
    const wasPlaying = ps.isPlaying;
    const len = ps.shuffle ? ps.shuffleOrder.length : ps.queue.length;
    ps.queueIdx = ps.queueIdx > 0 ? ps.queueIdx - 1 : Math.max(0, len - 1);
    _loadTrack(currentTrack());
    if (wasPlaying) _startPlay();
    if (ps.queueOpen) _renderQueue();
  }

  function next() {
    _startupRestoreGuardActive = false;
    if (ps.queue.length === 0) return;
    // Capture BEFORE _loadTrack — _audio.load() fires 'pause' synchronously,
    // which sets ps.isPlaying = false before we can check it.
    const wasPlaying = ps.isPlaying;
    const len = ps.shuffle ? ps.shuffleOrder.length : ps.queue.length;
    ps.queueIdx = (ps.queueIdx + 1) % Math.max(1, len);
    _loadTrack(currentTrack());
    if (wasPlaying) _startPlay();
    if (ps.queueOpen) _renderQueue();
  }

  function seekInput(value) {
    // Guard: no-op if nothing is loaded
    const dur = _isMpvActive() ? _mpvDuration : _audio.duration;
    if (!currentTrack() || !isFinite(dur) || dur === 0) return;
    // Called on input (dragging) — update visuals only, not audio
    _seekDragging = true;
    const pct = parseFloat(value) / 1000;
    const fillEl = document.getElementById('player-progress-fill');
    const curEl  = document.getElementById('player-current-time');
    if (fillEl) fillEl.style.width = (pct * 100) + '%';
    if (curEl) curEl.textContent = _fmtTime(pct * dur);
  }

  function seek(value) {
    _startupRestoreGuardActive = false;
    const dur = _isMpvActive() ? _mpvDuration : _audio.duration;
    if (!currentTrack() || !isFinite(dur) || dur === 0) {
      _seekDragging = false;
      return;
    }
    const position = (parseFloat(value) / 1000) * dur;
    if (_isMpvActive()) {
      _mpvCmd('seek', { position });
    } else {
      _audio.currentTime = position;
    }
    setTimeout(() => { _seekDragging = false; }, 50);
  }

  function setVolume(value) {
    ps.volume = Math.max(0, Math.min(1, parseFloat(value) / 100));
    _applyVolume();
    _updateVolumeUI();
    _updateBitPerfectBadge();
    _saveState();
  }

  function toggleMute() {
    ps.muted = !ps.muted;
    ps.muteExplicit = true;
    _applyVolume();
    _updateVolumeUI();
    _updateBitPerfectBadge();
    _saveState();
  }

  function _applyVolume() {
    const v = ps.muted ? 0 : ps.volume;
    if (_isMpvActive()) {
      _mpvCmd('volume', { volume: v });
    } else if (_volNode) {
      _volNode.gain.value = v;
    } else {
      _audioA.volume = v;
      _audioB.volume = 0;
    }
  }

  function _applyReplayGain(track) {
    if (!_rgGainNode) return;
    if (_rgMode === 'off' || !track) { _rgGainNode.gain.value = 1.0; return; }

    const gainDb = _rgMode === 'album'
      ? (track.rg_album_gain ?? track.rg_track_gain ?? null)
      : (track.rg_track_gain ?? null);

    if (gainDb === null || gainDb === undefined) { _rgGainNode.gain.value = 1.0; return; }

    const peak = _rgMode === 'album'
      ? (track.rg_album_peak ?? track.rg_track_peak ?? 1.0)
      : (track.rg_track_peak ?? 1.0);

    const linearGain = Math.pow(10, gainDb / 20);
    // Clipping guard: cap so that gain × peak ≤ 1.0 (lossless — only ever attenuates)
    const safePeak = (peak > 0 && isFinite(peak)) ? peak : 1.0;
    _rgGainNode.gain.value = Math.min(linearGain, 1.0 / safePeak);
  }

  function setRgMode(mode) {
    if (!['off', 'track', 'album'].includes(mode)) return;
    _rgMode = mode;
    try { localStorage.setItem('tb_rg_mode', mode); } catch (_) {}
    _applyReplayGain(currentTrack());
    _updateRgModeUI();
    _updateBitPerfectBadge();
  }

  function _updateRgModeUI() {
    document.querySelectorAll('.rg-pill').forEach(el => {
      el.classList.toggle('rg-pill--active', el.dataset.mode === _rgMode);
    });
  }

  function toggleShuffle() {
    // If queue is only a single track but we have a richer active context
    // (playlist/artist/album/songs), promote that context into queue first.
    if (ps.queue.length <= 1 && ps.playbackContextTracks.length > 1 && currentTrack()) {
      const curId = currentTrack().id;
      const ctxIdx = ps.playbackContextTracks.findIndex(t => t.id === curId);
      if (ctxIdx >= 0) {
        ps.queue = [...ps.playbackContextTracks];
        ps.queueIdx = ctxIdx;
        ps.shuffleOrder = [];
      }
    }

    // IMPORTANT: read the real queue index BEFORE changing ps.shuffle.
    // _realIdx() branches on ps.shuffle, so toggling it first causes it to
    // return the wrong value when disabling shuffle (it would return the
    // shuffle-position index instead of the actual queue-array index).
    const curRealIdx = ps.shuffle
      ? (ps.shuffleOrder[ps.queueIdx] ?? ps.queueIdx)  // was ON → use shuffleOrder
      : ps.queueIdx;                                     // was OFF → already the real index

    ps.shuffle = !ps.shuffle;

    if (ps.shuffle) {
      // OFF → ON: pin current track at position 0 of a new shuffled order
      const rest = ps.queue.map((_, i) => i).filter(i => i !== curRealIdx);
      ps.shuffleOrder = [curRealIdx, ..._fisherYates(rest)];
      ps.queueIdx = 0;
    } else {
      // ON → OFF: restore queueIdx to the real queue-array index
      ps.queueIdx = curRealIdx;
      ps.shuffleOrder = [];
    }
    _updateShuffleBtn();
    _renderQueue();
    _saveState();
    _preloadNext();  // re-buffer with new shuffle order
  }

  function cycleRepeat() {
    const modes = ['off', 'all', 'one'];
    ps.repeatMode = modes[(modes.indexOf(ps.repeatMode) + 1) % modes.length];
    _updateRepeatBtn();
    _saveState();
    _preloadNext();  // repeat mode change may change which track is next
  }

  /* ── Queue management ───────────────────────────────────────────────── */

  /** Play a single track immediately, replacing the top of the queue */
  function playTrack(track) {
    if (!track) return;
    _registry.set(track.id, track);
    // If already in queue (and not shuffle), jump to it
    if (!ps.shuffle) {
      const existing = ps.queue.findIndex(t => t.id === track.id);
      if (existing >= 0) {
        ps.queueIdx = existing;
        _loadTrack(currentTrack());
        _startPlay();
        _renderQueue();
        return;
      }
    }
    // Insert at current position + 1 (or at start)
    const insertAt = ps.queueIdx >= 0 ? ps.queueIdx + 1 : 0;
    ps.queue.splice(insertAt, 0, track);
    ps.queueIdx = insertAt;
    if (ps.shuffle) {
      // Add new track to shuffleOrder at current position
      ps.shuffleOrder.splice(ps.queueIdx, 0, insertAt);
    }
    _loadTrack(currentTrack());
    _startPlay();
    _renderQueue();
    _saveState();
  }

  /** Look up track by ID (from registry or queue) and play it */
  function playTrackById(id) {
    // Prefer active playback context so double-click from a view starts from that
    // collection (playlist/artist/album/songs), not a single-track queue.
    const ctxIdx = ps.playbackContextTracks.findIndex(t => t.id === id);
    if (ctxIdx >= 0) {
      playAll(ps.playbackContextTracks, ctxIdx, ps.playbackContextLabel, { preserveStartOnShuffle: true });
      return;
    }

    const fromQueue = ps.queue.find(t => t.id === id);
    if (fromQueue) { playTrack(fromQueue); return; }
    const fromReg   = _registry.get(id);
    if (fromReg)   { playTrack(fromReg);   return; }
    console.warn('Player: track not found in registry', id);
  }

  /** Replace the entire queue with tracks[], start at startIdx */
  function playAll(tracks, startIdx = 0, contextLabel = '', options = {}) {
    if (!tracks || tracks.length === 0) return;
    _resetStandbyBuffer();
    tracks.forEach(t => _registry.set(t.id, t));
    ps.queue    = [...tracks];
    ps.queueIdx = Math.max(0, Math.min(startIdx, tracks.length - 1));
    if (contextLabel) ps.playbackContextLabel = contextLabel;
    ps.shuffleOrder = [];
    if (ps.shuffle) {
      // For "Play / Play All" actions, reshuffle and randomize the first track each run.
      // Explicit starts (e.g. clicking a specific row) can opt out and preserve startIdx.
      const preserveStart = options && options.preserveStartOnShuffle === true;
      let firstRealIdx = preserveStart
        ? ps.queueIdx
        : Math.floor(Math.random() * ps.queue.length);
      if (!preserveStart && ps.queue.length > 1 && firstRealIdx === ps.lastShuffleFirstIdx) {
        firstRealIdx = (firstRealIdx + 1 + Math.floor(Math.random() * (ps.queue.length - 1))) % ps.queue.length;
      }
      const rest = ps.queue.map((_, i) => i).filter(i => i !== firstRealIdx);
      ps.shuffleOrder = [firstRealIdx, ..._fisherYates(rest)];
      ps.lastShuffleFirstIdx = firstRealIdx;
      ps.queueIdx = 0;
    }
    _loadTrack(currentTrack());
    _startPlay();
    _renderQueue();
    _saveState();
  }

  /** Hero Shuffle CTA behavior: replace queue with randomized collection and start at top. */
  function playCollectionShuffled(tracks, contextLabel = '') {
    if (!tracks || tracks.length === 0) return;
    _resetStandbyBuffer();
    tracks.forEach(t => _registry.set(t.id, t));
    const shuffled = _fisherYates([...tracks]);
    ps.queue = shuffled;
    ps.queueIdx = 0;
    if (contextLabel) ps.playbackContextLabel = contextLabel;
    // Keep CTA shuffle independent from player shuffle toggle semantics.
    ps.shuffle = false;
    ps.shuffleOrder = [];
    _updateShuffleBtn();
    _loadTrack(currentTrack());
    _startPlay();
    _renderQueue();
    _saveState();
  }

  /** Append tracks to end of queue */
  function addToQueue(tracks) {
    if (!Array.isArray(tracks)) tracks = [tracks];
    if (tracks.length === 0) return;
    tracks.forEach(t => _registry.set(t.id, t));
    ps.queue.push(...tracks);
    if (ps.shuffle) {
      const newIndices = tracks.map((_, i) => ps.queue.length - tracks.length + i);
      ps.shuffleOrder.push(..._fisherYates(newIndices));
    }
    // Start playing if nothing was loaded
    if (ps.queueIdx < 0) {
      ps.queueIdx = 0;
      _loadTrack(currentTrack());
    }
    _renderQueue();
    _saveState();
    _invalidatePreload();  // queue changed — pre-buffered next may no longer be correct
    const n = tracks.length;
    _toast(`Added ${n} track${n !== 1 ? 's' : ''} to queue`);
  }

  /** Insert tracks to play right after the current track */
  function playNext(tracks) {
    if (!Array.isArray(tracks)) tracks = [tracks];
    if (tracks.length === 0) return;
    tracks.forEach(t => _registry.set(t.id, t));
    const n = tracks.length;

    if (ps.queueIdx < 0 || ps.queue.length === 0) {
      // Nothing playing — add to queue and start
      ps.queue.unshift(...tracks);
      ps.queueIdx = 0;
      if (ps.shuffle) {
        const rest = ps.queue.map((_, i) => i).filter(i => i >= n);
        ps.shuffleOrder = [...tracks.map((_, i) => i), ..._fisherYates(rest)];
        ps.queueIdx = 0;
      }
      _loadTrack(currentTrack());
      _startPlay();
    } else {
      const realIdx  = _realIdx();   // real queue index of current track
      const insertAt = realIdx + 1;
      ps.queue.splice(insertAt, 0, ...tracks);
      if (ps.shuffle) {
        // Shift all shuffleOrder values >= insertAt
        ps.shuffleOrder = ps.shuffleOrder.map(i => i >= insertAt ? i + n : i);
        // Insert new real indices right after current shuffleOrder position
        const newIndices = tracks.map((_, i) => insertAt + i);
        ps.shuffleOrder.splice(ps.queueIdx + 1, 0, ...newIndices);
      }
      // ps.queueIdx unchanged — current track keeps playing
    }

    _renderQueue();
    _saveState();
    _invalidatePreload();  // inserted after current — pre-buffered next is now wrong
    _preloadNext();
    _toast(n === 1 ? `"${tracks[0].title}" plays next` : `${n} tracks play next`);
  }

  /** Look up a track by ID from the registry */
  function getTrack(id) {
    return _registry.get(id) ?? ps.queue.find(t => t.id === id) ?? null;
  }

  /** Remove track at queue array index idx */
  function removeFromQueue(idx) {
    if (idx < 0 || idx >= ps.queue.length) return;
    const wasActive  = idx === _realIdx();
    const wasPlaying = ps.isPlaying;

    ps.queue.splice(idx, 1);

    // Adjust queueIdx before shuffleOrder rewrite while old index still exists.
    if (ps.shuffle) {
      const shufflePos = ps.shuffleOrder.indexOf(idx);
      if (shufflePos !== -1 && shufflePos < ps.queueIdx) ps.queueIdx--;
    }
    // Patch shuffleOrder: remove the entry for idx, decrement higher refs
    if (ps.shuffle) {
      ps.shuffleOrder = ps.shuffleOrder
        .filter(i => i !== idx)
        .map(i => (i > idx ? i - 1 : i));
    }

    // Adjust queueIdx
    if (!ps.shuffle && idx < ps.queueIdx) ps.queueIdx--;

    if (ps.queue.length === 0) {
      ps.queueIdx = -1;
      ps.shuffleOrder = [];
      if (_isMpvActive()) { _mpvCmd('stop', {}); } else { _audio.src = ''; }
      ps.isPlaying = false;
      _updateTrackUI(null);
      _updatePlayBtn();
    } else if (wasActive) {
      if (ps.queueIdx >= ps.queue.length) ps.queueIdx = 0;
      _loadTrack(currentTrack());
      if (wasPlaying) _startPlay();
    } else {
      _invalidatePreload();
      _preloadNext();
    }
    _renderQueue();
    _saveState();
  }

  function clearQueue() {
    const keep = currentTrack();
    if (!keep) {
      ps.queue        = [];
      ps.queueIdx     = -1;
      ps.shuffleOrder = [];
      if (_isMpvActive()) {
        _mpvCmd('stop', {});
      } else {
        _audio.src = '';
      }
      ps.isPlaying    = false;
      _updateTrackUI(null);
      _updatePlayBtn();
      _highlightActiveRow();
      _renderQueue();
      _saveState();
      _toast('Queue cleared');
      return;
    }

    // Preserve currently loaded/playing track and clear only upcoming/history items.
    ps.queue = [keep];
    ps.queueIdx = 0;
    ps.shuffleOrder = ps.shuffle ? [0] : [];
    _invalidatePreload();  // no next track after clear
    _highlightActiveRow();
    _renderQueue();
    _saveState();
    _toast('Queue cleared');
  }

  function moveQueueItem(fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    const [item] = ps.queue.splice(fromIdx, 1);
    ps.queue.splice(toIdx, 0, item);
    if (!ps.shuffle) {
      if      (ps.queueIdx === fromIdx)                        ps.queueIdx = toIdx;
      else if (fromIdx < ps.queueIdx && toIdx >= ps.queueIdx) ps.queueIdx--;
      else if (fromIdx > ps.queueIdx && toIdx <= ps.queueIdx) ps.queueIdx++;
    }
    _saveState();
    _invalidatePreload();
    _preloadNext();
  }

  /** Reorder the shuffleOrder array (used when drag/drop fires in shuffle mode) */
  function moveShuffleItem(fromPos, toPos) {
    if (fromPos === toPos) return;
    const [item] = ps.shuffleOrder.splice(fromPos, 1);
    ps.shuffleOrder.splice(toPos, 0, item);
    _saveState();
  }

  /* ── Register tracks from app.js views ─────────────────────────────── */
  function registerTracks(tracks) {
    if (!Array.isArray(tracks)) return;
    tracks.forEach(t => { if (t && t.id) _registry.set(t.id, t); });
  }

  function setPlaybackContext(tracks, context = '') {
    if (!Array.isArray(tracks)) {
      ps.playbackContextTracks = [];
      ps.playbackContextLabel = '';
      ps.playbackContext = { sourceType: 'unknown', sourceId: '', sourceLabel: '' };
      return;
    }
    ps.playbackContextTracks = tracks.filter(t => t && t.id);
    if (typeof context === 'string') {
      ps.playbackContextLabel = context || '';
      ps.playbackContext = {
        sourceType: 'unknown',
        sourceId: '',
        sourceLabel: context || '',
      };
    } else if (context && typeof context === 'object') {
      const sourceLabel = String(context.sourceLabel || context.label || '').trim();
      ps.playbackContextLabel = sourceLabel;
      ps.playbackContext = {
        sourceType: String(context.sourceType || 'unknown').toLowerCase() || 'unknown',
        sourceId: String(context.sourceId || context.id || ''),
        sourceLabel,
      };
    } else {
      ps.playbackContextLabel = '';
      ps.playbackContext = { sourceType: 'unknown', sourceId: '', sourceLabel: '' };
    }
    ps.playbackContextTracks.forEach(t => _registry.set(t.id, t));
  }

  /* ── Audio element events (attached to both A and B; Web Audio mode only) ── */
  function _onTimeUpdate() {
    if (_isMpvActive()) return;     // mpv mode: polling handles seeks
    if (this !== _audio) return;   // ignore events from the standby element
    if (_seekDragging) return;
    if (_seeking) return;
    const dur = _audio.duration;
    if (!isFinite(dur) || dur === 0) return;
    const pct = _audio.currentTime / dur;

    const seekEl = document.getElementById('player-seek');
    const fillEl = document.getElementById('player-progress-fill');
    const curEl  = document.getElementById('player-current-time');

    const clampedPct = Math.min(1, pct);
    if (seekEl) seekEl.value = clampedPct * 1000;
    if (fillEl) fillEl.style.width = (clampedPct * 100) + '%';
    if (curEl)  curEl.textContent  = _fmtTime(_audio.currentTime);

    // Throttled seek-position save: write at most once per 1-second bucket
    const bucket = Math.floor(_audio.currentTime / 1);
    if (bucket !== _saveSeekThrottle) {
      _saveSeekThrottle = bucket;
      try { localStorage.setItem(_LS.seekTime, _audio.currentTime); } catch (_) {}
      const remoteBucket = Math.floor(_audio.currentTime / 5);
      if (remoteBucket !== _remoteSeekThrottle) {
        _remoteSeekThrottle = remoteBucket;
        _scheduleRemoteSave();
      }
    }

    // Crossfade trigger: start when `crossfadeDuration` seconds remain
    if (!_xfadeTriggered && ps.crossfadeDuration > 0) {
      const remaining = dur - _audio.currentTime;
      if (remaining > 0.1
          && remaining <= ps.crossfadeDuration
          && _audio.currentTime > 0.5
          && dur > ps.crossfadeDuration + 2) {
        _startCrossfade();
      }
    }
  }

  function _onLoadedMetadata() {
    if (this !== _audio) return;
    const durEl = document.getElementById('player-duration');
    if (durEl) durEl.textContent = _fmtTime(_audio.duration);
  }

  /* ── Gapless playback helpers ───────────────────────────────────────── */

  function _peekNextTrack() {
    if (!ps.queue.length) return null;
    if (ps.repeatMode === 'one') return ps.queue[_realIdx(ps.queueIdx)];
    const nextQueueIdx = (ps.queueIdx + 1) % ps.queue.length;
    // Stop at end when repeat is off
    if (ps.repeatMode === 'off' && nextQueueIdx === 0 && ps.queue.length > 1) return null;
    return ps.queue[_realIdx(nextQueueIdx)];
  }

  function _preloadNext() {
    // Only active when crossfade is off — crossfade manages its own preloading
    if (ps.crossfadeDuration > 0 || _isMpvActive()) return;
    const next = _peekNextTrack();
    const standby = _nextAudioEl();
    if (!next) {
      standby.dataset.preloadedId = '';
      return;
    }
    if (standby.dataset.preloadedId === next.id) return;  // already buffering
    standby.src = `/api/stream/${next.id}`;
    standby.preload = 'auto';
    standby.load();
    standby.dataset.preloadedId = next.id;
  }

  function _invalidatePreload() {
    const standby = _nextAudioEl();
    standby.dataset.preloadedId = '';
  }

  function _resetStandbyBuffer() {
    const standby = _nextAudioEl();
    standby.dataset.preloadedId = '';
    standby.pause();
    standby.removeAttribute('src');
    try { standby.load(); } catch (_) {}
  }

  function _standbyMatchesTrack(standby, track) {
    if (!standby || !track || !track.id) return false;
    if (String(standby.dataset.preloadedId || '') !== String(track.id)) return false;
    const src = String(standby.currentSrc || standby.src || '');
    // Guard against stale prebuffer from a previous queue/context.
    return src.includes(`/api/stream/${encodeURIComponent(track.id)}`);
  }

  function _onEnded() {
    if (this !== _audio) return;   // crossfade already swapped _audio before this fires
    if (_xfadeTriggered) return;   // crossfade handles advancement — don't double-advance
    _flushCurrentTrackEvent('ended', { completed: true, minElapsed: 1 });
    if (ps.repeatMode === 'one') {
      _audio.currentTime = 0;
      _startPlay();
    } else if (ps.repeatMode === 'all' || ps.queueIdx < ps.queue.length - 1) {
      const nextQueueIdx = (ps.queueIdx + 1) % ps.queue.length;
      const nextTrack    = ps.queue[_realIdx(nextQueueIdx)];
      const standby      = _nextAudioEl();

      if (ps.crossfadeDuration === 0
          && _standbyMatchesTrack(standby, nextTrack)
          && standby.readyState >= 2) {
        // Gapless: standby element already buffered — instant A/B swap, zero silence
        ps.queueIdx = nextQueueIdx;
        _audio = standby;
        _fadeGainA.gain.value = (_audio === _audioA) ? 1 : 0;
        _fadeGainB.gain.value = (_audio === _audioB) ? 1 : 0;
        _audio.currentTime = 0;
        _startPlay();
        _updateTrackUI(nextTrack);
        _applyReplayGain(nextTrack);
        _highlightActiveRow();
        _saveState();
        if (ps.queueOpen) _renderQueue();
        _preloadNext();  // buffer the track after next
      } else {
        // Fallback: normal load (pre-buffer wasn't ready or crossfade > 0)
        _resetStandbyBuffer();
        ps.queueIdx = nextQueueIdx;
        _loadTrack(currentTrack());
        _startPlay();
        if (ps.queueOpen) _renderQueue();
      }
    } else {
      ps.isPlaying = false;
      _updatePlayBtn();
      _highlightActiveRow();
      if (ps.queueOpen) _renderQueue();
    }
  }

  function _onError() {
    if (this !== _audio) return;
    if (_startupRestoreGuardActive) {
      // Silent startup restore: avoid alarming toast/auto-skip before user intent.
      ps.isPlaying = false;
      _updatePlayBtn();
      return;
    }
    _consecutiveErrors++;
    if (_consecutiveErrors >= 3) {
      // All tracks failing — music folder likely unmounted
      ps.isPlaying = false;
      _updatePlayBtn();
      _consecutiveErrors = 0;
      _toast('Playback stopped — music files may be inaccessible. Check your music folder in Settings.', 5000);
      return;
    }
    _toast('Playback error — skipping track');
    if (ps.queue.length > 1) setTimeout(next, 800);
    else { ps.isPlaying = false; _updatePlayBtn(); _consecutiveErrors = 0; }
  }

  function _onPlay()  {
    if (this !== _audio) return;
    _consecutiveErrors = 0;  // successful playback resets the error counter
    ps.isPlaying = true;
    _updatePlayBtn();
    _highlightActiveRow();
  }
  function _onPause() {
    if (this !== _audio) return;
    if (_suppressPauseFlush) {
      ps.isPlaying = false;
      _updatePlayBtn();
      return;
    }
    const now = Date.now();
    if (now - _lastPauseEventAt > 12000) {
      _flushCurrentTrackEvent('pause', { minElapsed: 5 });
      _lastPauseEventAt = now;
    }
    ps.isPlaying = false;
    _updatePlayBtn();
  }

  [_audioA, _audioB].forEach(el => {
    el.addEventListener('timeupdate',    _onTimeUpdate);
    el.addEventListener('loadedmetadata', _onLoadedMetadata);
    el.addEventListener('ended',         _onEnded);
    el.addEventListener('error',         _onError);
    el.addEventListener('play',          _onPlay);
    el.addEventListener('pause',         _onPause);
    el.addEventListener('seeking',       function () { if (this === _audio) _seeking = true; });
    el.addEventListener('seeked',        function () { if (this === _audio) _seeking = false; });
  });

  /* ── PEQ UI ─────────────────────────────────────────────────────────── */
  function _hasMeaningfulCustomPeq(state) {
    const st = state || _loadCustomPeqState();
    if (!st || !st.enabled) return false;
    if (Math.abs(Number(st.preamp_db) || 0) > 0.0001) return true;
    const bands = Array.isArray(st.bands) ? st.bands : [];
    return bands.some(b => b && b.enabled && (
      Math.abs(Number(b.gain) || 0) > 0.0001 ||
      Math.abs((Number(b.fc) || 1000) - 1000) > 0.0001 ||
      Math.abs((Number(b.q) || 1) - 1) > 0.0001 ||
      String(b.type || 'PK').toUpperCase() !== 'PK'
    ));
  }

  function _isEqActive() {
    const profileActive = !!ps.activePeqProfileId && ps.activePeqProfileId !== _CUSTOM_EQ_ID;
    const customActive =
      ps.activePeqIemId === _CUSTOM_EQ_ID &&
      ps.activePeqProfileId === _CUSTOM_EQ_ID &&
      _hasMeaningfulCustomPeq();
    return profileActive || customActive;
  }

  function _updatePeqBtn() {
    const btn = document.getElementById('player-peq-btn');
    if (!btn) return;
    // 'active' = EQ profile is selected (persistent indicator, independent of popover state)
    btn.classList.toggle('active', _isEqActive());
    _updateBitPerfectBadge();
  }

  function _updatePeqWorkspaceCta() {
    const btn = document.getElementById('peq-workspace-cta');
    const profileSel = document.getElementById('peq-profile-select');
    if (!btn || !profileSel) return;
    const v = profileSel.value || '';
    btn.textContent = (v && v !== _CREATE_PEQ_ID) ? 'Edit PEQ' : 'Create PEQ';
  }

  function _setPeqPopoverOpen(open) {
    const pop = document.getElementById('peq-popover');
    if (!pop) return;
    if (_peqCloseTimer) {
      clearTimeout(_peqCloseTimer);
      _peqCloseTimer = null;
    }
    if (open) {
      pop.style.display = 'block';
      requestAnimationFrame(() => pop.classList.add('open'));
      return;
    }
    pop.classList.remove('open');
    _peqCloseTimer = setTimeout(() => {
      pop.style.display = 'none';
      _peqCloseTimer = null;
    }, 210);
  }

  async function togglePeqPopover() {
    ps.peqOpen = !ps.peqOpen;
    _setPeqPopoverOpen(ps.peqOpen);
    if (ps.peqOpen) {
      await _populatePeqIemList();
      _updateXfadeUI();
    }
  }

  async function resetPeqPopover() {
    const iemSel = document.getElementById('peq-iem-select');
    const profileSel = document.getElementById('peq-profile-select');

    if (iemSel) iemSel.value = '';
    await onPeqIemChange('');

    if (profileSel) profileSel.value = '';
    await onPeqProfileChange('');

    ps.crossfadeDuration = 0;
    try { localStorage.setItem('tb_xfade', '0'); } catch (_) {}
    _updateXfadeUI();
  }

  async function _populatePeqIemList() {
    const sel = document.getElementById('peq-iem-select');
    if (!sel) return;
    try {
      const iems = await fetch('/api/iems').then(r => r.json());
      const activeIemId = ps.activePeqIemId === _CUSTOM_EQ_ID ? '' : (ps.activePeqIemId || '');
      sel.innerHTML = `<option value=""${!activeIemId ? ' selected' : ''}>— None —</option>` +
        iems.map(iem =>
          `<option value="${iem.id}"${iem.id === activeIemId ? ' selected' : ''}>${_esc(iem.name)}</option>`
        ).join('');
      await _updatePeqProfileList(activeIemId, ps.activePeqProfileId);
      _updatePeqWorkspaceCta();
    } catch (e) {
      console.warn('Player: IEM fetch failed', e);
    }
  }

  async function onPeqIemChange(iemId) {
    if (_loadCustomPeqState().enabled) _setCustomPeqEnabled(false);
    ps.activePeqIemId     = iemId || null;
    ps.activePeqProfileId = null;
    await _updatePeqProfileList(iemId, null);
    _buildPeqChain(null);  // clear PEQ until a profile is chosen
    _updatePeqBtn();
    _updatePeqWorkspaceCta();
    _saveState();
  }

  async function _updatePeqProfileList(iemId, activeProfileId) {
    const row = document.getElementById('peq-profile-row');
    const sel = document.getElementById('peq-profile-select');
    if (!row || !sel) return;
    const base = `<option value="">— None —</option><option value="${_CREATE_PEQ_ID}">Create PEQ</option>`;
    row.style.display = '';
    if (!iemId) {
      sel.innerHTML = base;
      _updatePeqWorkspaceCta();
      return;
    }
    try {
      const iem      = await fetch(`/api/iems/${iemId}`).then(r => r.json());
      const profiles = iem.peq_profiles || [];
      sel.innerHTML = base +
        profiles.map(p =>
          `<option value="${p.id}"${p.id === activeProfileId ? ' selected' : ''}>${_esc(p.name)}</option>`
        ).join('');
      if (activeProfileId === _CREATE_PEQ_ID) sel.value = _CREATE_PEQ_ID;
    } catch (e) {
      sel.innerHTML = base;
    }
    _updatePeqWorkspaceCta();
  }

  async function onPeqProfileChange(profileId) {
    if (profileId === _CREATE_PEQ_ID) {
      if (_loadCustomPeqState().enabled) _setCustomPeqEnabled(false);
      ps.activePeqProfileId = null;
      _buildPeqChain(null);
      _updatePeqBtn();
      _updatePeqWorkspaceCta();
      _saveState();
      return;
    }
    if (_loadCustomPeqState().enabled) _setCustomPeqEnabled(false);
    ps.activePeqProfileId = profileId || null;
    if (_mpvAvailable || _ctx) {
      await _loadAndApplyPeq(ps.activePeqIemId, ps.activePeqProfileId);
    }
    _updatePeqBtn();
    _updatePeqWorkspaceCta();
    _saveState();
  }

  /** Apply current selections and close the popover */
  async function applyPeqProfile() {
    const profileSel = document.getElementById('peq-profile-select');
    if (profileSel && profileSel.closest('#peq-profile-row')?.style.display !== 'none') {
      await onPeqProfileChange(profileSel.value);
    }
    // Close popover
    ps.peqOpen = false;
    _setPeqPopoverOpen(false);
  }

  function openPeqWorkspaceFromPopover() {
    const iemSel = document.getElementById('peq-iem-select');
    const profileSel = document.getElementById('peq-profile-select');
    const iemId = iemSel ? (iemSel.value || '') : '';
    const profileId = profileSel ? (profileSel.value || '') : '';
    if (typeof App !== 'undefined' && typeof App.openPeqEditor === 'function') {
      if (iemId && profileId && profileId !== _CREATE_PEQ_ID) {
        App.openPeqEditor({ mode: 'edit_profile', iemId, peqId: profileId });
      } else {
        App.openPeqEditor({ mode: 'create', iemId });
      }
    }
    ps.peqOpen = false;
    _setPeqPopoverOpen(false);
  }

  /* ── Output device popover ─────────────────────────────────────────── */
  let _outputDevices = [];
  let _currentOutputDevice = 'auto';
  let _outputPopoverOpen = false;

  async function toggleOutputPopover() {
    const popover = document.getElementById('output-popover');
    if (!popover) return;
    _outputPopoverOpen = !_outputPopoverOpen;
    if (_outputPopoverOpen) {
      // Show but keep hidden until populated to avoid flicker
      popover.style.display = 'block';
      await _populateOutputDevices();
      // trigger open animation after a tick
      requestAnimationFrame(() => popover.classList.add('open'));
    } else {
      _closeOutputPopover();
    }
    const btn = document.getElementById('player-output-btn');
    if (btn) btn.classList.toggle('active', _outputPopoverOpen);
  }

  function _closeOutputPopover() {
    const popover = document.getElementById('output-popover');
    if (!popover) return;
    _outputPopoverOpen = false;
    popover.classList.remove('open');
    const btn = document.getElementById('player-output-btn');
    if (btn) btn.classList.remove('active');
    setTimeout(() => { if (!_outputPopoverOpen) popover.style.display = 'none'; }, 220);
  }

  async function _populateOutputDevices() {
    const list = document.getElementById('output-device-list');
    if (!list) return;
    try {
      const data = await fetch('/api/player/audio_devices').then(r => r.json());
      _outputDevices = data.devices || [];
      const cap = await fetch('/api/player/capabilities').then(r => r.json());
      _currentOutputDevice = cap.audio_device || 'auto';
    } catch (e) {
      console.warn('Player: audio device fetch failed', e);
    }
    list.innerHTML = _outputDevices.map(d => {
      const isActive = d.name === _currentOutputDevice ||
                       (d.name === 'auto' && (!_currentOutputDevice || _currentOutputDevice === 'auto'));
      return `<button class="output-device-item${isActive ? ' active' : ''}"
                data-device="${_esc(d.name)}"
                onclick="Player.selectOutputDevice(this.dataset.device)">
        <span class="output-device-dot"></span>
        <span>${_esc(d.description || d.name)}</span>
      </button>`;
    }).join('');
  }

  async function selectOutputDevice(deviceName) {
    _currentOutputDevice = deviceName;
    // Update dots immediately for snappy feedback
    document.querySelectorAll('.output-device-item').forEach(el => {
      const isActive = (el.dataset.device || '') === deviceName;
      el.classList.toggle('active', isActive);
      el.querySelector('.output-device-dot').style.background =
        isActive ? '#53e16f' : '';
    });
    _closeOutputPopover();
    // Delegate to App.setAudioDevice for the actual save + reinit
    if (typeof App !== 'undefined' && typeof App.setAudioDevice === 'function') {
      await App.setAudioDevice(deviceName);
    }
    // Sync the Settings select too
    const settingsSel = document.getElementById('audio-device-select');
    if (settingsSel) settingsSel.value = deviceName;
  }

  // Called by app.js when settings load or device changes — keeps player in sync
  function updateOutputDevice(deviceName) {
    _currentOutputDevice = deviceName || 'auto';
  }

  /* ── Queue drawer UI ────────────────────────────────────────────────── */
  function toggleQueue() {
    const drawer = document.getElementById('queue-drawer');
    if (!drawer) return;
    ps.queueOpen = !ps.queueOpen;
    drawer.classList.toggle('open', ps.queueOpen);
    const btn = document.getElementById('player-queue-btn');
    if (btn) btn.classList.toggle('active', ps.queueOpen);
    if (ps.queueOpen) _renderQueue();
  }

  /* ── Queue item HTML helper ─────────────────────────────────────────── */
  function _queueItemHtml(t, realIdx, draggable, isHistory) {
    const dragHandle = draggable
      ? `<div class="queue-drag-handle">
           <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
             <circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/>
             <circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/>
             <circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/>
             <circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/>
             <circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/>
             <circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/>
           </svg>
         </div>`
      : `<div class="queue-drag-spacer"></div>`;
    return `
      <div class="queue-item${isHistory ? ' queue-item-history' : ''}" data-idx="${realIdx}"
           ondblclick="Player.playTrackById('${_esc(t.id)}')">
        ${dragHandle}
        <div class="queue-item-art">
          ${t.artwork_key ? `<img src="/api/artwork/${t.artwork_key}" loading="lazy" onerror="this.style.display='none'">` : ''}
        </div>
        <div class="queue-item-info">
          <div class="queue-item-title">${_esc(t.title)}</div>
          <div class="queue-item-artist">${_esc(t.artist)}</div>
        </div>
        <div class="queue-item-dur">${_esc(t.duration_fmt || '')}</div>
        <button class="queue-item-remove" onclick="Player.removeFromQueue(${realIdx})" title="Remove">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>`;
  }

  function _renderQueue() {
    const list    = document.getElementById('queue-list');
    const countEl = document.getElementById('queue-count');
    if (countEl) countEl.textContent = `${ps.queue.length} track${ps.queue.length !== 1 ? 's' : ''}`;
    if (!list) return;

    if (_queueSortable) { _queueSortable.destroy(); _queueSortable = null; }

    if (ps.queue.length === 0) {
      list.innerHTML = '<div class="queue-empty">Your queue is empty</div>';
      return;
    }

    const curRealIdx = _realIdx();  // actual ps.queue index of current track

    // Split queue into history / current / upcoming
    let historyItems, upcomingItems;
    if (ps.shuffle && ps.shuffleOrder.length > 0) {
      historyItems  = ps.shuffleOrder.slice(0, ps.queueIdx).map(i => ({ t: ps.queue[i], realIdx: i }));
      upcomingItems = ps.shuffleOrder.slice(ps.queueIdx + 1).map(i => ({ t: ps.queue[i], realIdx: i }));
    } else {
      historyItems  = ps.queue.slice(0, curRealIdx).map((t, i) => ({ t, realIdx: i }));
      upcomingItems = ps.queue.slice(curRealIdx + 1).map((t, i) => ({ t, realIdx: curRealIdx + 1 + i }));
    }
    const currentTrackObj = ps.queue[curRealIdx];

    let html = '';

    // ── History section ──────────────────────────────────────────────
    if (historyItems.length > 0) {
      const chevronDir = ps.historyExpanded ? '90' : '-90';
      html += `<div class="queue-section">
        <div class="queue-section-hdr" onclick="Player.toggleHistory()">
          <svg class="queue-section-chevron" width="12" height="12" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="2.5"
               style="transform:rotate(${chevronDir}deg);transition:transform .2s">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          <span class="queue-section-title">History</span>
          <button class="queue-clear-history" onclick="event.stopPropagation();Player.clearHistory()" title="Clear history">Clear</button>
        </div>
        <div class="queue-history-items" style="display:${ps.historyExpanded ? 'block' : 'none'}">`;
      // Most-recently-played at top (reversed)
      [...historyItems].reverse().forEach(({ t, realIdx }) => {
        html += _queueItemHtml(t, realIdx, false, true);
      });
      html += `</div></div>`;
    }

    // ── Continue Playing section ─────────────────────────────────────
    const fromLabel = ps.playbackContextLabel || currentTrackObj?.album || upcomingItems[0]?.t?.album || '';
    html += `<div class="queue-section">
      <div class="queue-section-hdr queue-section-hdr-plain">
        <span class="queue-section-title">Continue Playing</span>
        ${fromLabel ? `<span class="queue-section-from">from ${_esc(fromLabel)}</span>` : ''}
      </div>`;

    // Current track (highlighted, not draggable, no remove)
    if (currentTrackObj) {
      html += `<div class="queue-item queue-item-active" data-idx="${curRealIdx}"
                    ondblclick="Player.playTrackById('${_esc(currentTrackObj.id)}')">
        <div class="queue-drag-spacer"></div>
        <div class="queue-item-playing-icon">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
        </div>
        <div class="queue-item-art">
          ${currentTrackObj.artwork_key ? `<img src="/api/artwork/${currentTrackObj.artwork_key}" loading="lazy" onerror="this.style.display='none'">` : ''}
        </div>
        <div class="queue-item-info">
          <div class="queue-item-title">${_esc(currentTrackObj.title)}</div>
          <div class="queue-item-artist">${_esc(currentTrackObj.artist)}</div>
        </div>
        <div class="queue-item-dur">${_esc(currentTrackObj.duration_fmt || '')}</div>
        <div class="queue-item-remove" style="opacity:0;pointer-events:none"></div>
      </div>`;
    }

    // Upcoming tracks (draggable in non-shuffle mode) — capped at 200 for perf
    const QUEUE_CAP = 200;
    const visibleUpcoming = upcomingItems.slice(0, QUEUE_CAP);
    const hiddenCount     = upcomingItems.length - visibleUpcoming.length;
    html += `<div id="queue-upcoming-list">`;
    visibleUpcoming.forEach(({ t, realIdx }) => {
      html += _queueItemHtml(t, realIdx, true, false);
    });
    if (hiddenCount > 0) {
      html += `<div class="queue-overflow-note">+ ${hiddenCount} more track${hiddenCount !== 1 ? 's' : ''}</div>`;
    }
    html += `</div></div>`;  // close upcoming list + section

    list.innerHTML = html;

    // Drag-and-drop on upcoming list (both normal and shuffle mode)
    const upcomingList = document.getElementById('queue-upcoming-list');
    if (upcomingList && typeof Sortable !== 'undefined' && upcomingItems.length > 1) {
      _queueSortable = Sortable.create(upcomingList, {
        animation: 150,
        handle: '.queue-drag-handle',
        onEnd(evt) {
          if (ps.shuffle) {
            // Reorder shuffleOrder positions (don't touch ps.queue array)
            const fromPos = ps.queueIdx + 1 + evt.oldIndex;
            const toPos   = ps.queueIdx + 1 + evt.newIndex;
            moveShuffleItem(fromPos, toPos);
          } else {
            const from = curRealIdx + 1 + evt.oldIndex;
            const to   = curRealIdx + 1 + evt.newIndex;
            moveQueueItem(from, to);
          }
          _renderQueue();
        },
      });
    }

    // Scroll current track into view
    const activeEl = list.querySelector('.queue-item-active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function toggleHistory() {
    ps.historyExpanded = !ps.historyExpanded;
    _renderQueue();
  }

  function clearHistory() {
    const curRealIdx = _realIdx();
    if (curRealIdx <= 0) return;
    // Remove all items before current from the queue
    ps.queue.splice(0, curRealIdx);
    ps.queueIdx = 0;
    if (ps.shuffle) {
      // Rebuild shuffle order (current at pos 0, rest unchanged)
      const remaining = ps.shuffleOrder
        .map(i => i - curRealIdx)
        .filter(i => i >= 0);
      ps.shuffleOrder = remaining;
      ps.queueIdx = 0;
    }
    _renderQueue();
    _saveState();
  }

  /* ── Quality label helper ───────────────────────────────────────────── */
  function _formatQuality(track) {
    if (!track) return '';
    const fmt = track.format || '';
    if (track.bits_per_sample && track.sample_rate) {
      const khz = track.sample_rate % 1000 === 0
        ? `${track.sample_rate / 1000} kHz`
        : `${(track.sample_rate / 1000).toFixed(1)} kHz`;
      return `${track.bits_per_sample}-bit · ${khz}${fmt ? ' · ' + fmt : ''}`;
    } else if (track.bitrate) {
      return `${track.bitrate} kbps${fmt ? ' · ' + fmt : ''}`;
    }
    return fmt;
  }

  function _isLosslessSource(track) {
    if (!track) return false;
    const fmt = String(track.format || '').toUpperCase();
    if (_LOSSLESS_FORMATS.has(fmt)) return true;
    if (_LOSSY_FORMATS.has(fmt)) return false;
    // Fallback: if bit-depth + sample-rate are present, likely a lossless source.
    return !!(track.bits_per_sample && track.sample_rate);
  }

  /* ── UI update helpers ──────────────────────────────────────────────── */
  function _updateTrackUI(track) {
    const titleEl   = document.getElementById('player-title');
    const artistEl  = document.getElementById('player-artist');
    const artEl     = document.getElementById('player-art');
    const curEl     = document.getElementById('player-current-time');
    const durEl     = document.getElementById('player-duration');
    const seekEl    = document.getElementById('player-seek');
    const fillEl    = document.getElementById('player-progress-fill');
    const qualityEl = document.getElementById('player-quality');

    if (!track) {
      if (titleEl)   { titleEl.textContent = 'Nothing playing'; titleEl.classList.remove('marquee'); }
      if (artistEl)  { artistEl.innerHTML = ''; artistEl.classList.remove('marquee'); artistEl.dataset.artist = ''; artistEl.dataset.album = ''; }
      if (artEl)     artEl.innerHTML      = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".35"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
      if (curEl)     curEl.textContent    = '0:00';
      if (durEl)     durEl.textContent    = '0:00';
      if (seekEl)    { seekEl.value = 0; seekEl.disabled = true; }
      if (fillEl)    fillEl.style.width   = '0%';
      if (qualityEl) qualityEl.textContent = '';
      const _bpb = document.getElementById('player-bitperfect');
      const _llb = document.getElementById('player-lossless');
      if (_bpb) _bpb.style.display = 'none';
      if (_llb) _llb.style.display = 'none';
      document.title = 'TuneBridge';
      window.dispatchEvent(new CustomEvent('tb-track-change', { detail: { trackId: null } }));
      return;
    }

    if (titleEl)  _setupMarquee(titleEl,  track.title  || 'Unknown');
    if (artistEl) {
      // Build clickable artist · album subtitle
      artistEl.classList.remove('marquee');
      artistEl.style.removeProperty('--marquee-dist');
      artistEl.style.removeProperty('--marquee-dur');
      const parts = [];
      if (track.artist) parts.push(`<span class="player-nav-link" data-nav="artist">${_esc(track.artist)}</span>`);
      if (track.artist && track.album) parts.push(`<span class="player-nav-sep"> · </span>`);
      if (track.album)  parts.push(`<span class="player-nav-link" data-nav="album">${_esc(track.album)}</span>`);
      artistEl.innerHTML = parts.join('');
      artistEl.dataset.artist = track.artist || '';
      artistEl.dataset.album  = track.album  || '';
      // Apply marquee after paint
      requestAnimationFrame(() => {
        const overflow = artistEl.scrollWidth - artistEl.clientWidth;
        if (overflow > 6) {
          const dur = Math.max(5, overflow / 25);
          artistEl.style.setProperty('--marquee-dist', `-${overflow}px`);
          artistEl.style.setProperty('--marquee-dur',  `${dur}s`);
          artistEl.classList.add('marquee');
        }
      });
    }
    if (artEl) {
      artEl.innerHTML = track.artwork_key
        ? `<img src="/api/artwork/${track.artwork_key}" onerror="this.style.display='none'">`
        : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".35"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    }
    if (seekEl)    { seekEl.value = 0; seekEl.disabled = false; }
    if (fillEl)    fillEl.style.width = '0%';
    if (curEl)     curEl.textContent  = '0:00';
    if (qualityEl) qualityEl.textContent = _formatQuality(track);
    _updateBitPerfectBadge();
    document.title = `${track.title} — TuneBridge`;
    window.dispatchEvent(new CustomEvent('tb-track-change', { detail: { trackId: track.id } }));
  }

  function _updateBitPerfectBadge() {
    const bpBadge = document.getElementById('player-bitperfect');
    const llBadge = document.getElementById('player-lossless');
    if (!bpBadge && !llBadge) return;
    const track = currentTrack();
    if (!track) {
      if (bpBadge) bpBadge.style.display = 'none';
      if (llBadge) { llBadge.style.display = 'none'; llBadge.classList.remove('player-hires-badge'); }
      return;
    }
    const lossless   = _isLosslessSource(track);
    const volAtUnity = !ps.muted && Math.abs((ps.volume ?? 1) - 1) < 0.0001;
    const bitPerfect = _mpvAvailable && _exclusiveMode && lossless && !_isEqActive() && volAtUnity;
    // HI-RES: exclusive mode + lossless + DSP (EQ or volume ≠ 100%) applied via mpv lavfi
    const hiRes = !bitPerfect && _mpvAvailable && _exclusiveMode && lossless;

    if (bpBadge) {
      bpBadge.style.display = bitPerfect ? '' : 'none';
      bpBadge.title = 'Bit-perfect: exclusive mode on, no EQ/DSP, volume 100%.';
    }
    if (llBadge) {
      if (bitPerfect) {
        llBadge.style.display = 'none';
        llBadge.classList.remove('player-hires-badge');
      } else if (hiRes) {
        llBadge.style.display = '';
        llBadge.textContent = 'HI-RES';
        llBadge.classList.add('player-hires-badge');
        llBadge.title = 'Lossless source. EQ/volume DSP applied via mpv lavfi in exclusive mode.';
      } else if (lossless) {
        llBadge.style.display = '';
        llBadge.textContent = 'LOSSLESS';
        llBadge.classList.remove('player-hires-badge');
        const reasons = [];
        if (!_mpvAvailable)   reasons.push('mpv backend unavailable');
        if (!_exclusiveMode)  reasons.push('exclusive mode off');
        if (_isEqActive())    reasons.push('EQ/DSP active');
        if (!volAtUnity)      reasons.push('volume not 100%');
        llBadge.title = reasons.length
          ? `Lossless source. Not bit-perfect: ${reasons.join(', ')}.`
          : 'Lossless source. Output path is not bit-perfect.';
      } else {
        llBadge.style.display = 'none';
        llBadge.classList.remove('player-hires-badge');
      }
    }
  }

  /* ── Crossfade control ──────────────────────────────────────────────── */
  function setXfade(value) {
    let next = Math.max(0, Math.min(12, parseInt(value, 10)));
    if (_mpvAvailable && _exclusiveMode && next > 0) {
      next = 0;
      _toast('Crossfade is unavailable while bit-perfect output is enabled.');
    }
    ps.crossfadeDuration = next;
    try { localStorage.setItem('tb_xfade', ps.crossfadeDuration); } catch (_) {}
    _updateXfadeUI();
    _syncBackendModeForCrossfade();
    // When crossfade is disabled, start gapless pre-buffering; when enabled, clear standby
    if (next === 0) { _preloadNext(); } else { _invalidatePreload(); }
  }

  function _updateXfadeUI() {
    const valEl    = document.getElementById('xfade-val');
    const sliderEl = document.getElementById('xfade-slider');
    const rowEl    = document.getElementById('xfade-row');
    const blocked  = _mpvAvailable && _exclusiveMode;
    if (rowEl)    rowEl.style.display = '';
    if (valEl)    valEl.textContent   = blocked ? 'Off (Bit-perfect)' : (ps.crossfadeDuration === 0 ? 'Off' : `${ps.crossfadeDuration}s`);
    if (sliderEl) {
      sliderEl.disabled = blocked;
      sliderEl.value = ps.crossfadeDuration;
    }
  }

  function _syncBackendModeForCrossfade() {
    const mpvActive = _isMpvActive();
    if (mpvActive === _lastMpvActive) return;

    const track = currentTrack();
    const wasPlaying = !!ps.isPlaying;
    const resumePos = _lastMpvActive ? (_mpvPosition || 0) : (_audio.currentTime || 0);

    if (mpvActive) {
      _cancelCrossfade();
      _audio.pause();
      _audio.src = '';
      if (track) {
        _mpvCmd('play', { track_id: track.id, position: resumePos }).then(() => {
          if (!wasPlaying) _mpvCmd('pause', { paused: true });
          _applyVolume();
        });
      }
      _startPolling();
    } else {
      _stopPolling();
      // Ensure mpv output path is fully torn down before starting Web Audio playback.
      _mpvCmd('stop', {});
      _initAudioContext(track ? track.sample_rate : null);
      _applyVolume();
      _cancelCrossfade();
      if (track) {
        _audio.src = `/api/stream/${track.id}`;
        _audio.load();
        const applySeek = () => {
          if (isFinite(_audio.duration) && resumePos < _audio.duration) {
            _audio.currentTime = resumePos;
          }
        };
        if (_audio.readyState >= 1) applySeek();
        else _audio.addEventListener('loadedmetadata', applySeek, { once: true });
        if (wasPlaying) {
          const p = _audio.play();
          if (p) p.catch(() => {});
        }
      }
      ps.isPlaying = wasPlaying;
      _updatePlayBtn();
    }
    _lastMpvActive = mpvActive;
  }

  function _updatePlayBtn() {
    const btn = document.getElementById('player-play-btn');
    if (!btn) return;
    if (ps.isPlaying) {
      btn.innerHTML = `<span class="tb-icon tb-icon-pause-lg" aria-hidden="true"></span>`;
      btn.title = 'Pause';
    } else {
      btn.innerHTML = `<span class="tb-icon tb-icon-play-lg" aria-hidden="true"></span>`;
      btn.title = 'Play';
    }
  }

  function _updateShuffleBtn() {
    const btn = document.getElementById('player-shuffle-btn');
    if (btn) btn.classList.toggle('active', ps.shuffle);
  }

  function _updateRepeatBtn() {
    const btn = document.getElementById('player-repeat-btn');
    if (!btn) return;
    btn.classList.toggle('active',     ps.repeatMode !== 'off');
    btn.classList.toggle('repeat-one', ps.repeatMode === 'one');
    const titles = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: one' };
    btn.title = titles[ps.repeatMode] || 'Repeat';
    btn.innerHTML = ps.repeatMode === 'one'
      ? `<span class="tb-icon tb-icon-repeat-song" aria-hidden="true"></span>`
      : `<span class="tb-icon tb-icon-repeat-list" aria-hidden="true"></span>`;
  }

  function _updateVolumeUI() {
    const slider = document.getElementById('player-volume');
    const btn    = document.getElementById('player-mute-btn');
    if (slider) slider.value = Math.round(ps.volume * 100);
    if (btn) {
      if (ps.muted || ps.volume === 0) {
        btn.innerHTML = `<span class="tb-icon tb-icon-speaker-x" aria-hidden="true"></span>`;
      } else if (ps.volume < 0.4) {
        btn.innerHTML = `<span class="tb-icon tb-icon-speaker-1" aria-hidden="true"></span>`;
      } else {
        btn.innerHTML = `<span class="tb-icon tb-icon-speaker-2" aria-hidden="true"></span>`;
      }
    }
    _updateBitPerfectBadge();
  }

  function _highlightActiveRow() {
    document.querySelectorAll('tr.player-active').forEach(el => el.classList.remove('player-active'));
    const track = currentTrack();
    if (!track) return;
    document.querySelectorAll(`tr[data-id="${track.id}"]`).forEach(el => el.classList.add('player-active'));
  }

  /* ── Keyboard shortcuts ─────────────────────────────────────────────── */
  function _initKeyboard() {
    document.addEventListener('keydown', (e) => {
      // Don't intercept when typing in an input/textarea/contenteditable
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag)) return;
      if (document.activeElement?.contentEditable === 'true') return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowRight':
          if (e.altKey) { e.preventDefault(); next(); }
          break;
        case 'ArrowLeft':
          if (e.altKey) { e.preventDefault(); prev(); }
          break;
        case 'KeyM':
          toggleMute();
          break;
      }
    });
  }

  /* ── Server-side persistence (survives WKWebView ephemeral localStorage) ── */
  function _scheduleRemoteSave() {
    clearTimeout(_remoteSaveTimer);
    _remoteSaveTimer = setTimeout(_saveStateToServer, 500);  // short debounce
  }

  function getStateJSON() {
    const seekTime = _isMpvActive() ? _mpvPosition : (_audio.currentTime || 0);
    return JSON.stringify({
      queue:        ps.queue,
      queueIdx:     ps.queueIdx,
      shuffle:      ps.shuffle,
      shuffleOrder: ps.shuffleOrder,
      repeatMode:   ps.repeatMode,
      volume:       ps.volume,
      muted:        ps.muted,
      muteExplicit: ps.muteExplicit,
      peqIem:       ps.activePeqIemId     || '',
      peqProfile:   ps.activePeqProfileId || '',
      recentContexts: Array.isArray(ps.recentContexts) ? ps.recentContexts.slice(0, 30) : [],
      seekTime,
    });
  }

  async function _saveStateToServer() {
    try {
      await fetch('/api/player/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: getStateJSON(),
      });
    } catch (_) {}
  }

  /* ── Persistence ────────────────────────────────────────────────────── */
  const _LS = {
    queue:      'tb_queue',
    idx:        'tb_queue_idx',
    shuffle:    'tb_shuffle',
    shuffleOrd: 'tb_shuffle_ord',
    repeat:     'tb_repeat',
    volume:     'tb_volume',
    muted:      'tb_muted',
    muteExplicit: 'tb_mute_explicit',
    peqIem:     'tb_peq_iem',
    peqProfile: 'tb_peq_profile',
    seekTime:   'tb_seek_time',
  };

  function _saveState() {
    try {
      localStorage.setItem(_LS.queue,      JSON.stringify(ps.queue));
      localStorage.setItem(_LS.idx,        ps.queueIdx);
      localStorage.setItem(_LS.shuffle,    ps.shuffle);
      localStorage.setItem(_LS.shuffleOrd, JSON.stringify(ps.shuffleOrder));
      localStorage.setItem(_LS.repeat,     ps.repeatMode);
      localStorage.setItem(_LS.volume,     ps.volume);
      localStorage.setItem(_LS.muted,      ps.muted);
      localStorage.setItem(_LS.muteExplicit, ps.muteExplicit);
      localStorage.setItem(_LS.peqIem,     ps.activePeqIemId     || '');
      localStorage.setItem(_LS.peqProfile, ps.activePeqProfileId || '');
      localStorage.setItem(_LS.seekTime,   _isMpvActive() ? _mpvPosition : (_audio.currentTime || 0));
      localStorage.setItem('tb_recent_contexts', JSON.stringify(ps.recentContexts || []));
    } catch (_) { /* quota exceeded — ignore */ }
    _scheduleRemoteSave();
  }

  function _restoreState() {
    try {
      const qRaw = localStorage.getItem(_LS.queue);
      ps.queue   = qRaw ? JSON.parse(qRaw) : [];

      ps.queueIdx = parseInt(localStorage.getItem(_LS.idx) ?? '-1');
      if (isNaN(ps.queueIdx)) ps.queueIdx = -1;
      if (ps.queueIdx >= ps.queue.length) ps.queueIdx = ps.queue.length - 1;

      ps.shuffle    = _boolFromState(localStorage.getItem(_LS.shuffle), false);
      const soRaw   = localStorage.getItem(_LS.shuffleOrd);
      ps.shuffleOrder = soRaw ? JSON.parse(soRaw) : [];
      ps.repeatMode = localStorage.getItem(_LS.repeat)  || 'off';

      const vol   = parseFloat(localStorage.getItem(_LS.volume));
      ps.volume   = isNaN(vol) ? 1.0 : Math.max(0, Math.min(1, vol));
      ps.muteExplicit = _boolFromState(localStorage.getItem(_LS.muteExplicit), false);
      const restoredMuted = _boolFromState(localStorage.getItem(_LS.muted), false);
      ps.muted = ps.muteExplicit ? restoredMuted : false;

      ps.activePeqIemId     = localStorage.getItem(_LS.peqIem)     || null;
      ps.activePeqProfileId = localStorage.getItem(_LS.peqProfile) || null;
      try {
        const rcRaw = localStorage.getItem('tb_recent_contexts');
        ps.recentContexts = rcRaw ? JSON.parse(rcRaw) : [];
      } catch (_) {
        ps.recentContexts = [];
      }

      const xfade = parseInt(localStorage.getItem('tb_xfade') ?? '0', 10);
      ps.crossfadeDuration  = isNaN(xfade) ? 0 : Math.max(0, Math.min(12, xfade));

      const storedRg = localStorage.getItem('tb_rg_mode') || 'off';
      _rgMode = ['off', 'track', 'album'].includes(storedRg) ? storedRg : 'off';

      // Populate registry from restored queue
      ps.queue.forEach(t => { if (t && t.id) _registry.set(t.id, t); });
    } catch (e) {
      console.warn('Player: state restore failed', e);
      ps.queue = []; ps.queueIdx = -1;
    }
  }

  /* ── Init ───────────────────────────────────────────────────────────── */
  // Helper: apply a resolved state object (from localStorage or server) to ps
  function _applyRestoredState(sv, seekTimeOverride) {
    if (sv.queue && sv.queue.length > 0) {
      ps.queue        = sv.queue;
      ps.queueIdx     = typeof sv.queueIdx === 'number' ? sv.queueIdx : 0;
      if (ps.queueIdx >= ps.queue.length) ps.queueIdx = ps.queue.length - 1;
    }
    if (typeof sv.shuffle    !== 'undefined') ps.shuffle    = _boolFromState(sv.shuffle, false);
    if (sv.shuffleOrder)                      ps.shuffleOrder = sv.shuffleOrder;
    if (sv.repeatMode)                        ps.repeatMode   = sv.repeatMode;
    if (typeof sv.volume     !== 'undefined') ps.volume = Math.max(0, Math.min(1, sv.volume));
    if (typeof sv.muteExplicit !== 'undefined') {
      ps.muteExplicit = _boolFromState(sv.muteExplicit, false);
    }
    if (typeof sv.muted      !== 'undefined') {
      const restoredMuted = _boolFromState(sv.muted, false);
      ps.muted = ps.muteExplicit ? restoredMuted : false;
    }
    ps.activePeqIemId     = sv.peqIem     || sv.activePeqIemId     || null;
    ps.activePeqProfileId = sv.peqProfile || sv.activePeqProfileId || null;
    if (Array.isArray(sv.recentContexts)) {
      ps.recentContexts = sv.recentContexts.slice(0, 30);
    }
    ps.queue.forEach(t => { if (t && t.id) _registry.set(t.id, t); });
    return seekTimeOverride ?? sv.seekTime ?? 0;
  }

  async function init() {
    // 1. Detect mpv backend availability + exclusive mode setting
    try {
      const cap = await fetch('/api/player/capabilities').then(r => r.json());
      _mpvAvailable  = !!(cap && cap.mpv_available);
      _exclusiveMode = !!(cap && cap.exclusive_mode);
    } catch (_) { _mpvAvailable = false; _exclusiveMode = false; }

    // 2. Fast path — try localStorage (synchronous)
    _restoreState();
    let seekTime = parseFloat(localStorage.getItem(_LS.seekTime) || '0');

    // 3. Fetch server state (authoritative — survives WKWebView ephemeral localStorage)
    try {
      const res = await fetch('/api/player/state');
      if (res.ok) {
        const sv = await res.json();
        if (sv && Array.isArray(sv.queue) && sv.queue.length > 0) {
          seekTime = _applyRestoredState(sv);
        }
      }
    } catch (_) {}

    // Custom EQ restore is local-only by design.
    const restoredCustom = _loadCustomPeqState();
    if (restoredCustom.enabled) {
      ps.activePeqIemId = _CUSTOM_EQ_ID;
      ps.activePeqProfileId = _CUSTOM_EQ_ID;
    }

    // 4. Apply volume
    if (_isMpvActive()) {
      _mpvCmd('volume', { volume: ps.muted ? 0 : ps.volume });
    } else {
      _audioA.volume = ps.muted ? 0 : ps.volume;
      _audioB.volume = 0;
    }

    // 5. Sync UI to restored state
    _updateVolumeUI();
    _updateShuffleBtn();
    _updateRepeatBtn();
    _updatePlayBtn();
    _updatePeqBtn();
    _updateRgModeUI();
    _updateXfadeUI();

    // 6. Restore track display (no autoplay)
    const track = currentTrack();
    if (track) {
      _updateTrackUI(track);
      if (!_isMpvActive()) {
        // Web Audio fallback: pre-load into HTMLAudioElement (no play)
        _audio.src = `/api/stream/${track.id}`;
        _audio.load();

        if (seekTime > 0) {
          const _applySeek = () => {
            if (isFinite(_audio.duration) && seekTime < _audio.duration) {
              _seekRestored = true;
              setTimeout(() => { _seekRestored = false; }, 2000);
              _audio.currentTime = seekTime;
              const pct    = seekTime / _audio.duration;
              const fillEl = document.getElementById('player-progress-fill');
              const curEl  = document.getElementById('player-current-time');
              const seekEl = document.getElementById('player-seek');
              if (fillEl) fillEl.style.width  = (pct * 100) + '%';
              if (curEl)  curEl.textContent   = _fmtTime(seekTime);
              if (seekEl) seekEl.value        = pct * 1000;
            }
          };
          if (_audio.readyState >= 1) _applySeek();
          else _audio.addEventListener('loadedmetadata', _applySeek, { once: true });
        }
      } else if (seekTime > 0) {
        // mpv mode: show saved seek position in the UI (no autoplay)
        const curEl  = document.getElementById('player-current-time');
        if (curEl) curEl.textContent = _fmtTime(seekTime);
      }
    } else {
      _updateTrackUI(null);
    }

    // Startup always begins paused; playback resumes only after explicit user action.
    if (_isMpvActive()) {
      await _mpvCmd('pause', { paused: true });
    } else {
      _audio.pause();
    }
    ps.isPlaying = false;
    _updatePlayBtn();

    if (restoredCustom.enabled) {
      if (_isMpvActive()) {
        _applyCustomPeq(restoredCustom);
      } else if (_ctx) {
        _applyCustomPeq(restoredCustom);
      }
    }

    // 7. Start mpv polling loop
    _lastMpvActive = _isMpvActive();
    if (_lastMpvActive) {
      _startPolling();
    }

    // 6. Popover / queue outside-click handler
    document.addEventListener('click', (e) => {
      // Close PEQ popover
      if (ps.peqOpen
          && !e.target.closest('#peq-popover')
          && !e.target.closest('#player-peq-btn')) {
        ps.peqOpen = false;
        _setPeqPopoverOpen(false);
      }
      // Close output device popover
      if (_outputPopoverOpen
          && !e.target.closest('#output-popover')
          && !e.target.closest('#player-output-btn')) {
        _closeOutputPopover();
      }
      // Close queue drawer — IMPORTANT: skip if target is no longer in the DOM
      // (happens when _renderQueue() re-builds innerHTML while the click is propagating)
      if (ps.queueOpen
          && document.contains(e.target)
          && !e.target.closest('#queue-drawer')
          && !e.target.closest('#player-queue-btn')) {
        toggleQueue();
      }
    });

    // 7. Seek slider: reset dragging flag on pointer release
    const seekSliderEl = document.getElementById('player-seek');
    if (seekSliderEl) {
      seekSliderEl.addEventListener('pointerup', () => {
        setTimeout(() => { _seekDragging = false; }, 60);
      });
    }

    // 8. Player bar artist/album: click to navigate
    const playerArtistEl = document.getElementById('player-artist');
    if (playerArtistEl) {
      playerArtistEl.addEventListener('click', (e) => {
        const link = e.target.closest('.player-nav-link');
        if (!link) return;
        const nav    = link.dataset.nav;
        const artist = playerArtistEl.dataset.artist;
        const album  = playerArtistEl.dataset.album;
        if (nav === 'artist' && artist && typeof App !== 'undefined') App.showArtist(artist);
        if (nav === 'album'  && artist && typeof App !== 'undefined') App.showAlbum(artist, album);
      });
    }

    // 9. Periodic persistence every 10 s:
    // - save player state
    // - flush play events during long sessions (so Home/stats update without track switches)
    setInterval(() => {
      _saveStateToServer();
      if (ps.isPlaying && currentTrack()) {
        _flushCurrentTrackEvent('heartbeat', {
          minElapsed: 30,
          contextMinElapsed: Number.POSITIVE_INFINITY,
          keepSessionStart: true,
        });
      } else if (_pendingPlaybackEvents.length > 0) {
        _postPlaybackEvents([]);
      }
    }, 10000);

    // Final save on page close
    window.addEventListener('beforeunload', () => {
      try {
        const t = _activeHistoryTrack || currentTrack();
        if (t) {
          const { pos, elapsed } = _capturePlaybackSeconds();
          if (elapsed >= 3) {
            const duration = Number(t.duration || (_isMpvActive() ? _mpvDuration : _audio.duration) || 0);
            const payload = JSON.stringify({
              events: [{
                track_id: t.id,
                played_at: Math.floor(_safeNowSec()),
                play_seconds: elapsed,
                track_duration_seconds: duration || 0,
                completed: duration > 0 && pos >= Math.max(duration - 1.0, duration * 0.98),
                skipped: false,
                source_type: (ps.playbackContext || {}).sourceType || 'unknown',
                source_id: (ps.playbackContext || {}).sourceId || '',
                source_label: (ps.playbackContext || {}).sourceLabel || ps.playbackContextLabel || '',
                artist: t.artist || '',
                album: t.album || '',
                title: t.title || '',
                format: t.format || '',
                reason: 'unload',
                session_id: _trackHistorySessionId || '',
              }],
            });
            if (navigator && typeof navigator.sendBeacon === 'function') {
              const blob = new Blob([payload], { type: 'application/json' });
              navigator.sendBeacon('/api/player/events', blob);
            }
          }
        }
      } catch (_) {}

      const seekPos = _isMpvActive() ? _mpvPosition : (_audio.currentTime || 0);
      try { localStorage.setItem(_LS.seekTime, seekPos); } catch (_) {}
      // Synchronous XHR blocks until Flask responds — more reliable than sendBeacon
      // in WKWebView where the server and page die simultaneously on os._exit(0).
      // (Python's closing handler writes the file directly via evaluate_js, so this
      //  is a fallback for non-pywebview use, e.g. plain browser.)
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/player/state', false); // false = synchronous
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(getStateJSON());
      } catch (_) {}
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && _pendingPlaybackEvents.length > 0) {
        _postPlaybackEvents([]);
      }
    });

    _initKeyboard();
  }

  /* ── Marquee ────────────────────────────────────────────────────────── */
  function _setupMarquee(el, text) {
    el.textContent = text;
    el.classList.remove('marquee');
    el.style.removeProperty('--marquee-dist');
    el.style.removeProperty('--marquee-dur');
    // Check overflow after paint
    requestAnimationFrame(() => {
      const overflow = el.scrollWidth - el.clientWidth;
      if (overflow > 6) {
        const dur = Math.max(5, overflow / 25); // ~25px/s
        el.style.setProperty('--marquee-dist', `-${overflow}px`);
        el.style.setProperty('--marquee-dur',  `${dur}s`);
        el.classList.add('marquee');
      }
    });
  }

  /* ── Utilities ──────────────────────────────────────────────────────── */
  function _fmtTime(s) {
    if (!isFinite(s) || isNaN(s) || s < 0) return '0:00';
    const m   = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _toast(msg, duration) {
    // Delegate to app.js toast if available
    if (typeof toast === 'function') toast(msg, duration);
  }

  function _safeNowSec() {
    return Date.now() / 1000;
  }

  function _capturePlaybackSeconds() {
    const pos = _isMpvActive() ? (_mpvPosition || 0) : (_audio.currentTime || 0);
    const elapsed = Math.max(0, pos - (_trackSessionStartPos || 0));
    return { pos, elapsed };
  }

  function _postPlaybackEvents(events) {
    if (Array.isArray(events) && events.length > 0) {
      const merged = [..._pendingPlaybackEvents, ...events];
      // Keep bounded queue; enough to survive brief outages without unbounded growth.
      _pendingPlaybackEvents = merged.slice(-120);
    }
    if (_eventPostInFlight || _pendingPlaybackEvents.length === 0) return Promise.resolve(false);
    _eventPostInFlight = true;
    const batch = _pendingPlaybackEvents.slice(0, 50);
    return fetch('/api/player/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        // Drop only after confirmed successful delivery.
        _pendingPlaybackEvents = _pendingPlaybackEvents.slice(batch.length);
      })
      .catch(() => {})
      .finally(() => {
        _eventPostInFlight = false;
        if (_pendingPlaybackEvents.length > 0) {
          setTimeout(() => _postPlaybackEvents([]), 250);
        }
      });
  }

  function _markTrackSessionStart() {
    _trackSessionStartedAt = _safeNowSec();
    _trackSessionStartPos = _isMpvActive() ? (_mpvPosition || 0) : (_audio.currentTime || 0);
    const t = _activeHistoryTrack || currentTrack();
    const trackId = t?.id || 'track';
    _trackHistorySessionId = `${trackId}-${Math.floor(_trackSessionStartedAt * 1000)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function _pushRecentContext(track, reason = '') {
    if (!track || !track.id) return;
    const ctx = ps.playbackContext || { sourceType: 'unknown', sourceId: '', sourceLabel: '' };
    const sourceType = String(ctx.sourceType || 'unknown').toLowerCase();
    const sourceId = String(ctx.sourceId || '');
    const sourceLabel = String(ctx.sourceLabel || ps.playbackContextLabel || '');
    const artist = String(track.album_artist || track.artist || '');
    const album = String(track.album || '');

    let kind = 'album';
    if (sourceType === 'playlist') kind = 'playlist';
    else if (sourceType === 'artist') kind = 'artist';
    else if (!album) kind = 'artist';

    const key = kind === 'playlist'
      ? `playlist:${sourceId || sourceLabel}`
      : kind === 'artist'
        ? `artist:${(sourceId || artist).toLowerCase()}`
        : `album:${artist.toLowerCase()}||${album.toLowerCase()}`;
    if (!key || key.endsWith(':') || key.endsWith('||')) return;

    const item = {
      key,
      kind,
      source_type: sourceType,
      source_id: sourceId,
      source_label: sourceLabel,
      track_id: String(track.id || ''),
      artist,
      album,
      title: String(track.title || ''),
      artwork_key: String(track.artwork_key || ''),
      played_at: Math.floor(_safeNowSec()),
      reason,
    };
    const previous = Array.isArray(ps.recentContexts) ? ps.recentContexts : [];
    ps.recentContexts = [item, ...previous.filter((r) => (r && r.key) !== key)].slice(0, 30);
    _saveState();
  }

  function _flushCurrentTrackEvent(reason = 'switch', opts = {}) {
    const t = _activeHistoryTrack || currentTrack();
    return _flushTrackEvent(t, reason, opts);
  }

  function _flushTrackEvent(t, reason = 'switch', opts = {}) {
    if (!t) return Promise.resolve(false);
    const { pos, elapsed } = _capturePlaybackSeconds();
    const contextMinElapsed = typeof opts.contextMinElapsed === 'number' ? opts.contextMinElapsed : 1;
    if (reason !== 'pause' && elapsed >= contextMinElapsed) {
      _pushRecentContext(t, reason);
    }
    const minElapsed = typeof opts.minElapsed === 'number' ? opts.minElapsed : 3;
    if (elapsed < minElapsed) return Promise.resolve(false);
    const duration = Number(t.duration || (_isMpvActive() ? _mpvDuration : _audio.duration) || 0);
    const completed = !!opts.completed || (duration > 0 && pos >= Math.max(duration - 1.0, duration * 0.98));
    const skipped = !!opts.skipped;
    const ctx = ps.playbackContext || { sourceType: 'unknown', sourceId: '', sourceLabel: '' };
    const posted = _postPlaybackEvents([{
      track_id: t.id,
      played_at: Math.floor(_safeNowSec()),
      play_seconds: elapsed,
      track_duration_seconds: duration || 0,
      completed,
      skipped,
      source_type: ctx.sourceType || 'unknown',
      source_id: ctx.sourceId || '',
      source_label: ctx.sourceLabel || ps.playbackContextLabel || '',
      artist: t.artist || '',
      album: t.album || '',
      title: t.title || '',
      format: t.format || '',
      reason,
      session_id: _trackHistorySessionId || '',
    }]);
    if (!opts.keepSessionStart) {
      _trackSessionStartPos = pos;
    }
    return posted;
  }

  function flushHistoryNow() {
    if (ps.isPlaying && currentTrack()) {
      return _flushCurrentTrackEvent('refresh', {
        minElapsed: 1,
        contextMinElapsed: Number.POSITIVE_INFINITY,
        keepSessionStart: true,
      });
    }
    return _postPlaybackEvents([]);
  }

  /* ── Public API ─────────────────────────────────────────────────────── */
  return {
    init,
    // Playback
    togglePlay,
    prev,
    next,
    seekInput,
    seek,
    setVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
    // Queue
    playTrack,
    playTrackById,
    flushHistoryNow,
    playAll,
    playCollectionShuffled,
    addToQueue,
    playNext,
    removeFromQueue,
    getTrack,
    clearQueue,
    toggleQueue,
    toggleHistory,
    clearHistory,
    // Registry
    registerTracks,
    setPlaybackContext,
    // PEQ
    togglePeqPopover,
    onPeqIemChange,
    onPeqProfileChange,
    applyPeqProfile,
    openPeqWorkspaceFromPopover,
    resetPeqPopover,
    openCustomEqWorkspace: () => {
      if (typeof App !== 'undefined' && typeof App.openPeqEditor === 'function') {
        App.openPeqEditor({ mode: 'create' });
      }
    },
    applyCustomPeq: (state) => _applyCustomPeq(state),
    updateBandParam: _updateBandParam,
    updatePreamp: _updatePreamp,
    redrawEqCurve: _scheduleEqCurveRedraw,
    getCustomPeqState: () => _loadCustomPeqState(),
    setCustomPeqEnabled: _setCustomPeqEnabled,
    // ReplayGain
    setRgMode,
    getRgMode: () => _rgMode,
    // Crossfade
    setXfade,
    // Output device popover
    toggleOutputPopover,
    selectOutputDevice,
    updateOutputDevice,
    // Bit-perfect badge sync (called by app.js when Settings toggle changes)
    updateExclusiveMode(enabled) {
      _exclusiveMode = !!enabled;
      if (_exclusiveMode && ps.crossfadeDuration > 0) {
        ps.crossfadeDuration = 0;
        try { localStorage.setItem('tb_xfade', '0'); } catch (_) {}
      }
      _updateXfadeUI();
      _syncBackendModeForCrossfade();
      _updateBitPerfectBadge();
    },
    updateCapabilities(cap) {
      _mpvAvailable = !!(cap && cap.mpv_available);
      _exclusiveMode = !!(cap && cap.exclusive_mode);
      if (_exclusiveMode && ps.crossfadeDuration > 0) {
        ps.crossfadeDuration = 0;
        try { localStorage.setItem('tb_xfade', '0'); } catch (_) {}
      }
      _updateXfadeUI();
      _syncBackendModeForCrossfade();
      _updateBitPerfectBadge();
    },
    // Resume a specific track at a position on the new mpv instance after
    // exclusive mode toggle (old instance was torn down, new one is lazy-created)
    async resumeAt(trackId, position, shouldPlay = true) {
      if (!_mpvAvailable) return;
      if (!trackId) return;
      if (!shouldPlay) {
        // Keep UI anchored to the resumed track/position without unpausing playback.
        const t = getTrack(trackId);
        if (t) {
          const idx = ps.queue.findIndex(x => x && x.id === trackId);
          if (idx >= 0) ps.queueIdx = idx;
          _updateTrackUI(t);
          _highlightActiveRow();
        }
        ps.isPlaying = false;
        _updatePlayBtn();
        const pos = Math.max(0, Number(position) || 0);
        _mpvPosition = pos;
        const curEl = document.getElementById('player-current-time');
        if (curEl) curEl.textContent = _fmtTime(pos);
        return;
      }
      // Give mpv a moment to fully terminate before sending loadfile
      await new Promise(r => setTimeout(r, 300));
      await _mpvCmd('play', { track_id: trackId, position: position || 0 });
    },
    // State snapshot (called by tunebridge_gui.py via evaluate_js on window close)
    getStateJSON,
    // Read-only getters
    get currentTrack() { return currentTrack(); },
    get isPlaying()    { return ps.isPlaying; },
    get queue()        { return ps.queue; },
  };
})();

window.Player = Player;
