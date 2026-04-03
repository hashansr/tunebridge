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
    isPlaying:    false,
    activePeqIemId:     null,
    activePeqProfileId: null,
    crossfadeDuration:  0,    // seconds; 0 = disabled
    queueOpen:       false,
    peqOpen:         false,
    historyExpanded: false,
  };

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
  let _volNode    = null;   // GainNode — user volume
  let _peqNodes   = [];     // BiquadFilterNode[] — PEQ chain

  // Crossfade state
  let _xfadeTriggered = false;  // true while a crossfade is in progress
  let _xfadeTimeout   = null;   // setTimeout handle for _completeCrossfade

  let _queueSortable        = null;
  let _seekDragging         = false;
  let _saveSeekThrottle     = -1;  // last 5-second bucket saved (throttles timeupdate writes)
  let _remoteSaveTimer      = null; // debounce handle for server-side state saves
  let _remoteSeekThrottle   = -1;  // last 30-second bucket that triggered a remote save
  let _peqCloseTimer        = null; // delayed hide timer for animated popover close

  /* ── Web Audio graph init ───────────────────────────────────────────── */
  function _initAudioContext() {
    if (_ctx) return;
    try {
      _ctx        = new (window.AudioContext || window.webkitAudioContext)();
      // One MediaElementSource per audio element (can only be created once per element)
      _srcA       = _ctx.createMediaElementSource(_audioA);
      _srcB       = _ctx.createMediaElementSource(_audioB);
      _fadeGainA  = _ctx.createGain();
      _fadeGainB  = _ctx.createGain();
      _preampNode = _ctx.createGain();
      _volNode    = _ctx.createGain();
      _volNode.gain.value    = ps.muted ? 0 : ps.volume;
      _preampNode.gain.value = 1.0;
      _fadeGainA.gain.value  = 1.0;   // A starts as active
      _fadeGainB.gain.value  = 0.0;   // B starts as standby
      // Both paths feed into the shared PEQ chain
      _srcA.connect(_fadeGainA);
      _srcB.connect(_fadeGainB);
      _fadeGainA.connect(_preampNode);
      _fadeGainB.connect(_preampNode);
      _preampNode.connect(_volNode);
      _volNode.connect(_ctx.destination);
      // Re-apply any stored PEQ
      if (ps.activePeqIemId && ps.activePeqProfileId) {
        _loadAndApplyPeq(ps.activePeqIemId, ps.activePeqProfileId);
      }
    } catch (e) {
      console.warn('Player: Web Audio API init failed', e);
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
    if (_xfadeTimeout) { clearTimeout(_xfadeTimeout); _xfadeTimeout = null; }
    _xfadeTriggered = false;
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

  function _startCrossfade() {
    if (_xfadeTriggered || !_ctx || ps.crossfadeDuration <= 0) return;
    if (!ps.isPlaying) return;

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
    if (!_ctx || !_preampNode || !_volNode) return;

    // Tear down existing chain
    try { _preampNode.disconnect(); } catch (_) {}
    _peqNodes.forEach(n => { try { n.disconnect(); } catch (_) {} });
    _peqNodes = [];

    if (!peqProfile) {
      _preampNode.gain.value = 1.0;
      _preampNode.connect(_volNode);
      return;
    }

    // Preamp
    const preampDb = typeof peqProfile.preamp_db === 'number' ? peqProfile.preamp_db : 0;
    _preampNode.gain.value = _dBToLinear(preampDb);

    // Build filter nodes for enabled filters only
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

    // Chain: preamp → f[0] → f[1] → ... → volNode
    const chain = [_preampNode, ..._peqNodes, _volNode];
    for (let i = 0; i < chain.length - 1; i++) {
      chain[i].connect(chain[i + 1]);
    }
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
    _cancelCrossfade();
    _audio.src = `/api/stream/${track.id}`;
    _audio.load();
    _updateTrackUI(track);
    _highlightActiveRow();
    _saveState();
  }

  function _startPlay() {
    _initAudioContext();
    if (_ctx && _ctx.state === 'suspended') _ctx.resume();
    const promise = _audio.play();
    if (promise) promise.catch(e => console.warn('Player: play() rejected', e));
    ps.isPlaying = true;
    _updatePlayBtn();
  }

  function _pauseAudio() {
    _audio.pause();
    ps.isPlaying = false;
    _updatePlayBtn();
  }

  /* ── Public playback controls ───────────────────────────────────────── */
  function togglePlay() {
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
    if (ps.queue.length === 0) return;
    // Restart current track if more than 3 s in
    if (_audio.currentTime > 3) {
      _audio.currentTime = 0;
      return;
    }
    // Capture BEFORE _loadTrack — _audio.load() fires 'pause' synchronously,
    // which sets ps.isPlaying = false before we can check it.
    const wasPlaying = ps.isPlaying;
    ps.queueIdx = ps.queueIdx > 0 ? ps.queueIdx - 1 : ps.queue.length - 1;
    _loadTrack(currentTrack());
    if (wasPlaying) _startPlay();
    if (ps.queueOpen) _renderQueue();
  }

  function next() {
    if (ps.queue.length === 0) return;
    // Capture BEFORE _loadTrack — _audio.load() fires 'pause' synchronously,
    // which sets ps.isPlaying = false before we can check it.
    const wasPlaying = ps.isPlaying;
    ps.queueIdx = (ps.queueIdx + 1) % ps.queue.length;
    _loadTrack(currentTrack());
    if (wasPlaying) _startPlay();
    if (ps.queueOpen) _renderQueue();
  }

  function seekInput(value) {
    // Guard: no-op if nothing is loaded
    if (!currentTrack() || !isFinite(_audio.duration) || _audio.duration === 0) return;
    // Called on input (dragging) — update visuals only, not audio
    _seekDragging = true;
    const pct = parseFloat(value) / 1000;
    const fillEl = document.getElementById('player-progress-fill');
    const curEl  = document.getElementById('player-current-time');
    if (fillEl) fillEl.style.width = (pct * 100) + '%';
    if (curEl) curEl.textContent = _fmtTime(pct * _audio.duration);
  }

  function seek(value) {
    // Guard: no-op if nothing is loaded
    if (!currentTrack() || !isFinite(_audio.duration) || _audio.duration === 0) {
      _seekDragging = false;
      return;
    }
    // Called on change (release) — commit seek to audio element
    // Use timeout to ensure _seekDragging is cleared even if oninput fires late
    _audio.currentTime = (parseFloat(value) / 1000) * _audio.duration;
    setTimeout(() => { _seekDragging = false; }, 50);
  }

  function setVolume(value) {
    ps.volume = Math.max(0, Math.min(1, parseFloat(value) / 100));
    _applyVolume();
    _updateVolumeUI();
    _saveState();
  }

  function toggleMute() {
    ps.muted = !ps.muted;
    _applyVolume();
    _updateVolumeUI();
    _saveState();
  }

  function _applyVolume() {
    const v = ps.muted ? 0 : ps.volume;
    if (_volNode) {
      _volNode.gain.value = v;
    } else {
      // Fallback when Web Audio isn't initialised
      _audioA.volume = v;
      _audioB.volume = 0;   // B is always silent when not in a crossfade without Web Audio
    }
  }

  function toggleShuffle() {
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
  }

  function cycleRepeat() {
    const modes = ['off', 'all', 'one'];
    ps.repeatMode = modes[(modes.indexOf(ps.repeatMode) + 1) % modes.length];
    _updateRepeatBtn();
    _saveState();
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
    const fromQueue = ps.queue.find(t => t.id === id);
    if (fromQueue) { playTrack(fromQueue); return; }
    const fromReg   = _registry.get(id);
    if (fromReg)   { playTrack(fromReg);   return; }
    console.warn('Player: track not found in registry', id);
  }

  /** Replace the entire queue with tracks[], start at startIdx */
  function playAll(tracks, startIdx = 0) {
    if (!tracks || tracks.length === 0) return;
    tracks.forEach(t => _registry.set(t.id, t));
    ps.queue    = [...tracks];
    ps.queueIdx = Math.max(0, Math.min(startIdx, tracks.length - 1));
    ps.shuffleOrder = [];
    if (ps.shuffle) {
      const rest = ps.queue.map((_, i) => i).filter(i => i !== ps.queueIdx);
      ps.shuffleOrder = [ps.queueIdx, ..._fisherYates(rest)];
      ps.queueIdx = 0;
    }
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
      _audio.src = '';
      ps.isPlaying = false;
      _updateTrackUI(null);
      _updatePlayBtn();
    } else if (wasActive) {
      if (ps.queueIdx >= ps.queue.length) ps.queueIdx = 0;
      _loadTrack(currentTrack());
      if (wasPlaying) _startPlay();
    }
    _renderQueue();
    _saveState();
  }

  function clearQueue() {
    ps.queue        = [];
    ps.queueIdx     = -1;
    ps.shuffleOrder = [];
    _audio.src      = '';
    ps.isPlaying    = false;
    _updateTrackUI(null);
    _updatePlayBtn();
    _highlightActiveRow();
    _renderQueue();
    _saveState();
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

  /* ── Audio element events (attached to both A and B; guard ignores inactive) ── */
  function _onTimeUpdate() {
    if (this !== _audio) return;   // ignore events from the standby element
    if (_seekDragging) return;
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

    // Throttled seek-position save: write at most once per 5-second bucket
    const bucket = Math.floor(_audio.currentTime / 5);
    if (bucket !== _saveSeekThrottle) {
      _saveSeekThrottle = bucket;
      try { localStorage.setItem(_LS.seekTime, _audio.currentTime); } catch (_) {}
      const remoteBucket = Math.floor(_audio.currentTime / 30);
      if (remoteBucket !== _remoteSeekThrottle) {
        _remoteSeekThrottle = remoteBucket;
        _scheduleRemoteSave();
      }
    }

    // Crossfade trigger: start when `crossfadeDuration` seconds remain
    if (!_xfadeTriggered && ps.crossfadeDuration > 0) {
      const remaining = dur - _audio.currentTime;
      if (remaining > 0.1 && remaining <= ps.crossfadeDuration && _audio.currentTime > 0.5) {
        _startCrossfade();
      }
    }
  }

  function _onLoadedMetadata() {
    if (this !== _audio) return;
    const durEl = document.getElementById('player-duration');
    if (durEl) durEl.textContent = _fmtTime(_audio.duration);
  }

  function _onEnded() {
    if (this !== _audio) return;   // crossfade already swapped _audio before this fires
    if (_xfadeTriggered) return;   // crossfade handles advancement — don't double-advance
    if (ps.repeatMode === 'one') {
      _audio.currentTime = 0;
      _startPlay();
    } else if (ps.repeatMode === 'all' || ps.queueIdx < ps.queue.length - 1) {
      ps.queueIdx = (ps.queueIdx + 1) % ps.queue.length;
      _loadTrack(currentTrack());
      _startPlay();
      if (ps.queueOpen) _renderQueue();
    } else {
      ps.isPlaying = false;
      _updatePlayBtn();
      _highlightActiveRow();
      if (ps.queueOpen) _renderQueue();
    }
  }

  function _onError() {
    if (this !== _audio) return;
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
  function _onPause() { if (this !== _audio) return; ps.isPlaying = false; _updatePlayBtn(); }

  [_audioA, _audioB].forEach(el => {
    el.addEventListener('timeupdate',    _onTimeUpdate);
    el.addEventListener('loadedmetadata', _onLoadedMetadata);
    el.addEventListener('ended',         _onEnded);
    el.addEventListener('error',         _onError);
    el.addEventListener('play',          _onPlay);
    el.addEventListener('pause',         _onPause);
  });

  /* ── PEQ UI ─────────────────────────────────────────────────────────── */
  function _updatePeqBtn() {
    const btn = document.getElementById('player-peq-btn');
    if (!btn) return;
    // 'active' = EQ profile is selected (persistent indicator, independent of popover state)
    btn.classList.toggle('active', !!ps.activePeqProfileId);
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

  async function _populatePeqIemList() {
    const sel = document.getElementById('peq-iem-select');
    if (!sel) return;
    try {
      const iems = await fetch('/api/iems').then(r => r.json());
      sel.innerHTML = '<option value="">— Off —</option>' +
        iems.map(iem =>
          `<option value="${iem.id}"${iem.id === ps.activePeqIemId ? ' selected' : ''}>${_esc(iem.name)}</option>`
        ).join('');
      await _updatePeqProfileList(ps.activePeqIemId, ps.activePeqProfileId);
    } catch (e) {
      console.warn('Player: IEM fetch failed', e);
    }
  }

  async function onPeqIemChange(iemId) {
    ps.activePeqIemId     = iemId || null;
    ps.activePeqProfileId = null;
    await _updatePeqProfileList(iemId, null);
    _buildPeqChain(null);  // clear PEQ until a profile is chosen
    _updatePeqBtn();
    _saveState();
  }

  async function _updatePeqProfileList(iemId, activeProfileId) {
    const row = document.getElementById('peq-profile-row');
    const sel = document.getElementById('peq-profile-select');
    if (!row || !sel) return;
    if (!iemId) { row.style.display = 'none'; return; }
    try {
      const iem      = await fetch(`/api/iems/${iemId}`).then(r => r.json());
      const profiles = iem.peq_profiles || [];
      if (profiles.length === 0) { row.style.display = 'none'; return; }
      row.style.display = '';
      sel.innerHTML = '<option value="">— Off —</option>' +
        profiles.map(p =>
          `<option value="${p.id}"${p.id === activeProfileId ? ' selected' : ''}>${_esc(p.name)}</option>`
        ).join('');
    } catch (e) {
      row.style.display = 'none';
    }
  }

  async function onPeqProfileChange(profileId) {
    ps.activePeqProfileId = profileId || null;
    if (_ctx) {
      await _loadAndApplyPeq(ps.activePeqIemId, ps.activePeqProfileId);
    }
    _updatePeqBtn();
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
    const fromLabel = currentTrackObj?.album || upcomingItems[0]?.t?.album || '';
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

    // Upcoming tracks (draggable in non-shuffle mode)
    html += `<div id="queue-upcoming-list">`;
    upcomingItems.forEach(({ t, realIdx }) => {
      html += _queueItemHtml(t, realIdx, true, false);
    });
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
      document.title = 'TuneBridge';
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
    document.title = `${track.title} — TuneBridge`;
  }

  /* ── Crossfade control ──────────────────────────────────────────────── */
  function setXfade(value) {
    ps.crossfadeDuration = Math.max(0, Math.min(12, parseInt(value, 10)));
    try { localStorage.setItem('tb_xfade', ps.crossfadeDuration); } catch (_) {}
    _updateXfadeUI();
  }

  function _updateXfadeUI() {
    const valEl    = document.getElementById('xfade-val');
    const sliderEl = document.getElementById('xfade-slider');
    if (valEl)    valEl.textContent = ps.crossfadeDuration === 0 ? 'Off' : `${ps.crossfadeDuration}s`;
    if (sliderEl) sliderEl.value   = ps.crossfadeDuration;
  }

  function _updatePlayBtn() {
    const btn = document.getElementById('player-play-btn');
    if (!btn) return;
    if (ps.isPlaying) {
      btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
      btn.title = 'Pause';
    } else {
      // translate(1.5,0) optically centres the right-pointing triangle in the circle
      btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21" transform="translate(1.5,0)"/></svg>`;
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
    // Same SVG for all modes — the 'repeat-one' CSS class adds a "1" badge via ::after
    btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
  }

  function _updateVolumeUI() {
    const slider = document.getElementById('player-volume');
    const btn    = document.getElementById('player-mute-btn');
    if (slider) slider.value = Math.round(ps.volume * 100);
    if (btn) {
      if (ps.muted || ps.volume === 0) {
        btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
      } else if (ps.volume < 0.4) {
        btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
      } else {
        btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
      }
    }
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
    return JSON.stringify({
      queue:        ps.queue,
      queueIdx:     ps.queueIdx,
      shuffle:      ps.shuffle,
      shuffleOrder: ps.shuffleOrder,
      repeatMode:   ps.repeatMode,
      volume:       ps.volume,
      muted:        ps.muted,
      peqIem:       ps.activePeqIemId     || '',
      peqProfile:   ps.activePeqProfileId || '',
      seekTime:     _audio.currentTime    || 0,
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
      localStorage.setItem(_LS.peqIem,     ps.activePeqIemId     || '');
      localStorage.setItem(_LS.peqProfile, ps.activePeqProfileId || '');
      localStorage.setItem(_LS.seekTime,   _audio.currentTime    || 0);
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

      ps.shuffle    = localStorage.getItem(_LS.shuffle)    === 'true';
      const soRaw   = localStorage.getItem(_LS.shuffleOrd);
      ps.shuffleOrder = soRaw ? JSON.parse(soRaw) : [];
      ps.repeatMode = localStorage.getItem(_LS.repeat)  || 'off';

      const vol   = parseFloat(localStorage.getItem(_LS.volume));
      ps.volume   = isNaN(vol) ? 1.0 : Math.max(0, Math.min(1, vol));
      ps.muted    = localStorage.getItem(_LS.muted) === 'true';

      ps.activePeqIemId     = localStorage.getItem(_LS.peqIem)     || null;
      ps.activePeqProfileId = localStorage.getItem(_LS.peqProfile) || null;

      const xfade = parseInt(localStorage.getItem('tb_xfade') ?? '0', 10);
      ps.crossfadeDuration  = isNaN(xfade) ? 0 : Math.max(0, Math.min(12, xfade));

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
    if (typeof sv.shuffle    !== 'undefined') ps.shuffle    = !!sv.shuffle;
    if (sv.shuffleOrder)                      ps.shuffleOrder = sv.shuffleOrder;
    if (sv.repeatMode)                        ps.repeatMode   = sv.repeatMode;
    if (typeof sv.volume     !== 'undefined') ps.volume = Math.max(0, Math.min(1, sv.volume));
    if (typeof sv.muted      !== 'undefined') ps.muted  = !!sv.muted;
    ps.activePeqIemId     = sv.peqIem     || sv.activePeqIemId     || null;
    ps.activePeqProfileId = sv.peqProfile || sv.activePeqProfileId || null;
    ps.queue.forEach(t => { if (t && t.id) _registry.set(t.id, t); });
    return seekTimeOverride ?? sv.seekTime ?? 0;
  }

  async function init() {
    // 1. Fast path — try localStorage (synchronous)
    _restoreState();
    let seekTime = parseFloat(localStorage.getItem(_LS.seekTime) || '0');

    // 2. Fetch server state (authoritative — survives WKWebView ephemeral localStorage)
    try {
      const res = await fetch('/api/player/state');
      if (res.ok) {
        const sv = await res.json();
        // Server wins when it has a queue (localStorage may be empty in WKWebView)
        if (sv && Array.isArray(sv.queue) && sv.queue.length > 0) {
          seekTime = _applyRestoredState(sv);
        }
      }
    } catch (_) {}

    // 3. Apply volume before audio context (HTMLAudioElement fallback)
    _audioA.volume = ps.muted ? 0 : ps.volume;
    _audioB.volume = 0;

    // 4. Sync UI to restored state
    _updateVolumeUI();
    _updateShuffleBtn();
    _updateRepeatBtn();
    _updatePlayBtn();
    _updatePeqBtn();

    // 5. Restore track display (no autoplay)
    const track = currentTrack();
    if (track) {
      _updateTrackUI(track);
      _audio.src = `/api/stream/${track.id}`;
      _audio.load();

      if (seekTime > 0) {
        const _applySeek = () => {
          if (isFinite(_audio.duration) && seekTime < _audio.duration) {
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
    } else {
      _updateTrackUI(null);
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

    // 9. Periodic server save — every 10 s while app is open (belt-and-suspenders)
    setInterval(_saveStateToServer, 10000);

    // 10. Final save on page close
    window.addEventListener('beforeunload', () => {
      try { localStorage.setItem(_LS.seekTime, _audio.currentTime || 0); } catch (_) {}
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
    playAll,
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
    // PEQ
    togglePeqPopover,
    onPeqIemChange,
    onPeqProfileChange,
    applyPeqProfile,
    // Crossfade
    setXfade,
    // State snapshot (called by tunebridge_gui.py via evaluate_js on window close)
    getStateJSON,
    // Read-only getters
    get currentTrack() { return currentTrack(); },
    get isPlaying()    { return ps.isPlaying; },
    get queue()        { return ps.queue; },
  };
})();

window.Player = Player;
