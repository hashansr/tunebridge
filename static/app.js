/* ── State ──────────────────────────────────────────────────────────── */
const state = {
  view: 'artists',         // artists | albums | tracks | playlist
  artist: null,
  album: null,
  playlist: null,          // full playlist object (with enriched tracks)
  playlists: [],           // sidebar list
  tracks: [],              // tracks in current library view
  artists: [],
  albums: [],
  devices: {},
  scanStatus: null,
  activeTrackId: null,     // for add-to dropdown
  sortable: null,
  lastUsedPlaylistId: null, // most recently added-to playlist
  _pendingTrackIds: [],     // track IDs queued for a picker selection
  selectedTrackIds: new Set(),
  lastSelectedIdx: null,
  playlistSortMode: localStorage.getItem('sidebarSort') || 'created',
  plSortMode: 'original',
  plSortDir: 'asc',
  plFilter: '',
  favourites: {
    songs: new Set(),
    albums: new Set(),
    artists: new Set(),
  },
  favouritesMeta: {
    songs: [],
    albums: [],
    artists: [],
    dap_exports: {},
  },
  favSongsData: [],
  favSongsSort: 'my',
  favArtistsSort: 'recent',
  favAlbumsSort: 'recent',
  favPanel: 'artists',
  artistSearch: '',
  artistAlpha: '',
  albumSearch: '',
  albumAlpha: '',
  _albumScope: '__all__',
};
let _homeLoading = false;
let _homeAutoRefreshTimer = null;
let _homeTrackRefreshTimer = null;

let _currentGearTab = 'daps';
let _currentDapId = null;        // track current DAP being viewed (for nav history)
let _navHistory = [];             // back stack: array of nav snapshots
let _isNavigatingBack = false;    // suppresses history push during back/forward restoration

/* ── API helpers ────────────────────────────────────────────────────── */
/* ── Utilities ──────────────────────────────────────────────────────── */
function _debounce(fn, ms) {
  let t;
  return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

/* ── Toast System ───────────────────────────────────────────────────── */
const _toastQueue  = [];
const _toastActive = [];
const _TOAST_MAX   = 3;

function toast(msg, durationOrType, maybeType) {
  let duration, type;
  if (typeof durationOrType === 'string') {
    type = durationOrType; duration = null;
  } else {
    duration = (typeof durationOrType === 'number' && durationOrType > 0) ? durationOrType : null;
    type = typeof maybeType === 'string' ? maybeType : null;
  }
  if (!type) type = _toastClassify(msg);
  if (!duration) {
    const base = type === 'error' ? 2340 : 1800;
    duration = Math.min(4500, Math.max(base, base + msg.length * 12));
  }
  _toastEnqueue({ msg, type, duration });
}

function _toastClassify(msg) {
  const s = msg.toLowerCase();
  if (/error|fail|could not|unable|unavailable|invalid|required/.test(s)) return 'error';
  if (/warning|limit|works best|only first|double-check/.test(s)) return 'warning';
  if (/saved|updated|renamed|removed|copied|imported|exported|added.*to|enabled|complete|ready|cleared/.test(s)) return 'success';
  if (/downloading|analysing|checking|preparing|searching/.test(s)) return 'info';
  return 'neutral';
}

function _toastEnqueue(item) {
  if (_toastActive.length < _TOAST_MAX) _toastShow(item);
  else _toastQueue.push(item);
}

function _toastShow(item) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast-item toast-${item.type}`;
  el.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.className = 'toast-msg';
  text.textContent = item.msg;
  el.appendChild(text);
  el.addEventListener('click', () => _toastDismiss(el), { once: true });
  container.appendChild(el);
  _toastActive.push(el);
  el.getBoundingClientRect(); // force reflow before adding .show
  el.classList.add('show');
  el._toastTimer = setTimeout(() => _toastDismiss(el), item.duration);
}

function _toastDismiss(el) {
  clearTimeout(el._toastTimer);
  if (!_toastActive.includes(el)) return;
  el.classList.remove('show');
  el.classList.add('hide');
  const cleanup = () => {
    el.remove();
    const idx = _toastActive.indexOf(el);
    if (idx !== -1) _toastActive.splice(idx, 1);
    if (_toastQueue.length > 0) _toastShow(_toastQueue.shift());
  };
  el.addEventListener('transitionend', cleanup, { once: true });
  setTimeout(cleanup, 350); // fallback if transitionend doesn't fire
}

/* ── Artwork ────────────────────────────────────────────────────────── */
function artworkUrl(key) {
  return key ? `/api/artwork/${key}` : null;
}

function coverPlaceholder(kind = 'song', size = 38, rounded = '4px', full = false) {
  const validKind = ['artist', 'album', 'song', 'playlist'].includes(kind) ? kind : 'song';
  const style = full
    ? `width:100%;height:100%;border-radius:${rounded};`
    : `width:${size}px;height:${size}px;border-radius:${rounded};`;
  return `<div class="cover-placeholder cover-placeholder-${validKind}" style="${style}"><img src="/icons/empty-${validKind}.svg" alt="" aria-hidden="true" loading="lazy" /></div>`;
}

function thumbImg(key, size = 38, rounded = '4px') {
  const url = artworkUrl(key);
  if (url) {
    return `<img src="${url}" width="${size}" height="${size}" style="border-radius:${rounded};object-fit:cover" loading="lazy" onerror="this.style.display='none'" />`;
  }
  return coverPlaceholder('song', size, rounded);
}

function musicNote(size = 38) {
  const s = Math.round(size * 0.45);
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
}

function playSvg(size = 14) {
  return `<svg class="icon-play-svg" style="--play-icon-size:${Number(size) || 14}px" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5,3 19,12 5,21"/></svg>`;
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _normArtistId(name) {
  return String(name || '').trim().toLowerCase();
}

function _nameSortKey(name) {
  return String(name || '').replace(/^(the|a|an)\s+/i, '').toLowerCase();
}

const _STAR_OUTLINE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><polygon points="12 2.8 15.1 9 22 9.9 17 14.6 18.2 21.2 12 18 5.8 21.2 7 14.6 2 9.9 8.9 9"/></svg>`;
const _STAR_FILLED = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1"><polygon points="12 2.8 15.1 9 22 9.9 17 14.6 18.2 21.2 12 18 5.8 21.2 7 14.6 2 9.9 8.9 9"/></svg>`;
const _FAV_PLAYLIST_COVER = 'images/favourite-playlist-cover.png';
const _CUSTOM_PEQ_KEY = 'tb_custom_peq';
const _CREATE_PEQ_ID = '__create__';
const _WORKSPACE_NEW_PEQ_ID = '__new_peq__';
const _CUSTOM_NO_GAIN_TYPES = new Set(['LPQ', 'HPQ', 'NO', 'AP']);
let _customPeqEditorState = null;
let _peqWorkspaceOpen = false;
let _peqWorkspaceInitialJson = '';
let _peqWorkspaceDirty = false;
let _peqWorkspaceChart = null;
let _peqWorkspaceGraphTimer = null;
let _peqWorkspaceGraphReqId = 0;
let _peqWorkspaceSelectedIemId = '';
let _peqWorkspaceSelectedTargetId = '';
let _peqWorkspaceSelectedPeqId = _WORKSPACE_NEW_PEQ_ID;
let _peqWorkspaceCurveVisibility = {};
let _peqWorkspaceConnectedDaps = [];
let _peqWorkspaceCopyDapId = '';
let _peqWorkspaceEditContext = null;
let _peqWorkspaceIemCache = [];
const _FR_OVERLAY_STORAGE_KEY = 'tb.fr_overlays.v1';
const _FR_OVERLAY_DEFS = [
  { id: 'sub_bass',      label: 'Sub Bass',      f1: 20,   f2: 50,    tier: 'primary', defaultOn: true },
  { id: 'bass',          label: 'Bass',          f1: 50,   f2: 160,   tier: 'primary', defaultOn: true },
  { id: 'lower_mids',    label: 'Lower Mids',    f1: 160,  f2: 400,   tier: 'primary', defaultOn: true },
  { id: 'upper_mids',    label: 'Upper Mids',    f1: 400,  f2: 1200,  tier: 'primary', defaultOn: true },
  { id: 'lower_treble',  label: 'Lower Treble',  f1: 1200, f2: 4000,  tier: 'primary', defaultOn: true },
  { id: 'upper_treble',  label: 'Upper Treble',  f1: 4000, f2: 15000, tier: 'primary', defaultOn: true },
  { id: 'bass_feel',     label: 'Bass Feel',     f1: 20,   f2: 160,   tier: 'secondary', defaultOn: false },
  { id: 'slam',          label: 'Slam',          f1: 50,   f2: 75,    tier: 'secondary', defaultOn: false },
  { id: 'male_vocals',   label: 'Male Vocals',   f1: 100,  f2: 400,   tier: 'secondary', defaultOn: false },
  { id: 'female_vocals', label: 'Female Vocals', f1: 330,  f2: 3000,  tier: 'secondary', defaultOn: false },
  { id: 'note_weight',   label: 'Note Weight',   f1: 80,   f2: 1000,  tier: 'secondary', defaultOn: false },
  { id: 'sound_stage',   label: 'Sound Stage',   f1: 155,  f2: 15000, tier: 'secondary', defaultOn: false },
  { id: 'detail',        label: 'Detail',        f1: 4000, f2: 6000,  tier: 'secondary', defaultOn: false },
  { id: 'sibilance',     label: 'Sibilance',     f1: 4000, f2: 10000, tier: 'secondary', defaultOn: false },
  { id: 'texture',       label: 'Texture',       f1: 4000, f2: 8000,  tier: 'secondary', defaultOn: false },
  { id: 'timbre',        label: 'Timbre',        f1: 20,   f2: 1200,  tier: 'secondary', defaultOn: false },
];
const _FR_OVERLAY_DEF_MAP = Object.fromEntries(_FR_OVERLAY_DEFS.map(d => [d.id, d]));
let _frOverlaySelected = null;
let _frOverlayMenuOpen = null;
let _frOverlayRefreshTimer = null;
let _iemCompareLastData = null;

function _frOverlayDefaultIds() {
  // New product default: no overlays selected.
  return [];
}

function _initFrOverlaySelection() {
  if (_frOverlaySelected instanceof Set) return;
  const valid = new Set(_FR_OVERLAY_DEFS.map(d => d.id));
  let ids = [];
  let hasSaved = false;
  try {
    const raw = localStorage.getItem(_FR_OVERLAY_STORAGE_KEY);
    hasSaved = raw !== null;
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) ids = parsed.filter(id => valid.has(id));
  } catch (_) {}
  if (!hasSaved) ids = _frOverlayDefaultIds();
  _frOverlaySelected = new Set(ids);
}

function _saveFrOverlaySelection() {
  _initFrOverlaySelection();
  try {
    localStorage.setItem(_FR_OVERLAY_STORAGE_KEY, JSON.stringify([..._frOverlaySelected]));
  } catch (_) {}
}

function _frOverlaySelectedDefs() {
  _initFrOverlaySelection();
  return _FR_OVERLAY_DEFS.filter(d => _frOverlaySelected.has(d.id));
}

function _frOverlayCount() {
  _initFrOverlaySelection();
  return _frOverlaySelected.size;
}

function _frOverlayHzLabel(hz) {
  const n = Number(hz || 0);
  if (n >= 1000) {
    const k = n / 1000;
    return Number.isInteger(k) ? `${k}kHz` : `${k.toFixed(1)}kHz`;
  }
  return `${Math.round(n)}Hz`;
}

function _frOverlayMenuKey(rawKey) {
  return String(rawKey || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function _frOverlayControlInnerHtml(contextKey) {
  _initFrOverlaySelection();
  const menuKey = _frOverlayMenuKey(contextKey);
  const isOpen = _frOverlayMenuOpen === menuKey;
  const mk = (tier) => _FR_OVERLAY_DEFS
    .filter(d => d.tier === tier)
    .map(d => `
      <label class="fr-ov-opt">
        <input type="checkbox" data-overlay-id="${esc(d.id)}" ${_frOverlaySelected.has(d.id) ? 'checked' : ''} onchange="App.setFrOverlay('${d.id}', this.checked)" />
        <span class="fr-ov-opt-label">${esc(d.label)}</span>
        <span class="fr-ov-opt-range">${_frOverlayHzLabel(d.f1)} - ${_frOverlayHzLabel(d.f2)}</span>
      </label>
    `).join('');
  return `
    <div class="fr-ov-shell">
      <button class="fr-ov-trigger${isOpen ? ' open' : ''}" onclick="App.toggleFrOverlayMenu('${menuKey}', event)">Overlays (${_frOverlayCount()})</button>
      <div class="fr-ov-menu${isOpen ? ' open' : ''}">
        <div class="fr-ov-actions">
          <button onclick="App.frOverlaysDefault()">None</button>
          <button onclick="App.frOverlaysBasic()">Basic</button>
          <button onclick="App.frOverlaysAdvanced()">Advanced</button>
        </div>
        <div class="fr-ov-group-title">Primary</div>
        <div class="fr-ov-group">${mk('primary')}</div>
        <div class="fr-ov-group-title">Secondary</div>
        <div class="fr-ov-group">${mk('secondary')}</div>
      </div>
    </div>
  `;
}

function _syncFrOverlayControlsInPlace() {
  _initFrOverlaySelection();
  let synced = 0;
  document.querySelectorAll('[data-fr-overlay-host="1"]').forEach(host => {
    const ctx = host.dataset.frOverlayContext || '';
    const menuKey = _frOverlayMenuKey(ctx);
    const trigger = host.querySelector('.fr-ov-trigger');
    const menu = host.querySelector('.fr-ov-menu');
    if (!trigger || !menu) return;
    trigger.textContent = `Overlays (${_frOverlayCount()})`;
    trigger.classList.toggle('open', _frOverlayMenuOpen === menuKey);
    menu.classList.toggle('open', _frOverlayMenuOpen === menuKey);
    host.querySelectorAll('input[type="checkbox"][data-overlay-id]').forEach(inp => {
      const id = inp.getAttribute('data-overlay-id') || '';
      inp.checked = _frOverlaySelected.has(id);
    });
    synced++;
  });
  return synced > 0;
}

function _refreshFrOverlayControls() {
  _initFrOverlaySelection();
  document.querySelectorAll('[data-fr-overlay-host="1"]').forEach(host => {
    const ctx = host.dataset.frOverlayContext || '';
    host.innerHTML = _frOverlayControlInnerHtml(ctx);
  });
}

function _scheduleFrOverlayChartsRefresh() {
  if (_frOverlayRefreshTimer) clearTimeout(_frOverlayRefreshTimer);
  _frOverlayRefreshTimer = setTimeout(async () => {
    _frOverlayRefreshTimer = null;
    try {
      if (document.getElementById('freq-canvas') && _currentIemId) {
        await _loadIemGraph(_currentIemId, _activePeqId, _activeIemSourceId);
      }
      if (document.getElementById('iem-compare-modal')?.style.display === 'flex' && _iemCompareLastData) {
        _buildIemCompareChart(_iemCompareLastData);
      }
      if (_peqWorkspaceOpen && document.getElementById('peq-editor-canvas')) {
        await _refreshPeqWorkspaceGraph();
      }
      const openFitIds = Object.keys(_iemFitFRCharts || {}).filter(iemId => document.getElementById(`iemfit-fr-canvas-${iemId}`));
      for (const iemId of openFitIds) {
        await _renderIemFRPanel(iemId, _iemFitPeqState[iemId] || null);
      }
    } catch (_) {}
  }, 60);
}

function _setFrOverlaySelection(nextIds) {
  _initFrOverlaySelection();
  const valid = new Set(_FR_OVERLAY_DEFS.map(d => d.id));
  _frOverlaySelected = new Set((nextIds || []).filter(id => valid.has(id)));
  _saveFrOverlaySelection();
  if (!_syncFrOverlayControlsInPlace()) _refreshFrOverlayControls();
  _scheduleFrOverlayChartsRefresh();
}

function setFrOverlay(id, enabled) {
  _initFrOverlaySelection();
  const next = new Set(_frOverlaySelected);
  if (enabled) next.add(id);
  else next.delete(id);
  _setFrOverlaySelection([...next]);
}

function frOverlaysPrimaryOnly() {
  _setFrOverlaySelection(_FR_OVERLAY_DEFS.filter(d => d.tier === 'primary').map(d => d.id));
}

function frOverlaysDefault() {
  _setFrOverlaySelection([]);
}

function frOverlaysBasic() {
  _setFrOverlaySelection(_FR_OVERLAY_DEFS.filter(d => d.tier === 'primary').map(d => d.id));
}

function frOverlaysAdvanced() {
  _setFrOverlaySelection(_FR_OVERLAY_DEFS.map(d => d.id));
}

function frOverlaysAll() {
  _setFrOverlaySelection(_FR_OVERLAY_DEFS.map(d => d.id));
}

function frOverlaysNone() {
  _setFrOverlaySelection([]);
}

function frOverlaysClearSecondary() {
  _initFrOverlaySelection();
  const next = _FR_OVERLAY_DEFS
    .filter(d => d.tier === 'primary' && _frOverlaySelected.has(d.id))
    .map(d => d.id);
  _setFrOverlaySelection(next);
}

function frOverlaysResetDefaults() {
  _setFrOverlaySelection(_frOverlayDefaultIds());
}

function toggleFrOverlayMenu(menuKey, event) {
  if (event) event.stopPropagation();
  _frOverlayMenuOpen = _frOverlayMenuOpen === menuKey ? null : menuKey;
  if (!_syncFrOverlayControlsInPlace()) _refreshFrOverlayControls();
}

function _closeFrOverlayMenu() {
  if (_frOverlayMenuOpen == null) return;
  _frOverlayMenuOpen = null;
  if (!_syncFrOverlayControlsInPlace()) _refreshFrOverlayControls();
}

function _createFrOverlayPlugin(pluginId, opts = {}) {
  const showPrimaryLabels = opts.showPrimaryLabels !== false;
  const extraDraw = typeof opts.extraDraw === 'function' ? opts.extraDraw : null;
  return {
    id: pluginId,
    beforeDatasetsDraw(chart) {
      const area = chart?.chartArea;
      const x = chart?.scales?.x;
      if (!area || !x) return;
      const { left, right, top, bottom } = area;
      const ctx = chart.ctx;
      const selected = _frOverlaySelectedDefs();
      if (selected.length) {
        const primary = selected.filter(d => d.tier === 'primary');
        const secondary = selected.filter(d => d.tier === 'secondary');
        const primaryFillById = {
          sub_bass: 'rgba(173,198,255,0.10)',
          bass: 'rgba(173,198,255,0.06)',
          lower_mids: 'rgba(173,198,255,0.095)',
          upper_mids: 'rgba(173,198,255,0.06)',
          lower_treble: 'rgba(173,198,255,0.09)',
          upper_treble: 'rgba(173,198,255,0.06)',
        };
        const primaryEdgeById = {
          sub_bass: 'rgba(173,198,255,0.2)',
          bass: 'rgba(173,198,255,0.14)',
          lower_mids: 'rgba(173,198,255,0.2)',
          upper_mids: 'rgba(173,198,255,0.14)',
          lower_treble: 'rgba(173,198,255,0.2)',
          upper_treble: 'rgba(173,198,255,0.14)',
        };
        primary.forEach(d => {
          const x1 = Math.max(left, Math.min(right, x.getPixelForValue(d.f1)));
          const x2 = Math.max(left, Math.min(right, x.getPixelForValue(d.f2)));
          if ((x2 - x1) <= 0) return;
          ctx.fillStyle = primaryFillById[d.id] || 'rgba(173,198,255,0.14)';
          ctx.fillRect(x1, top, x2 - x1, bottom - top);
          // Subtle top edge to increase readability without overpowering the graph.
          ctx.strokeStyle = primaryEdgeById[d.id] || 'rgba(173,198,255,0.3)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x1, top + 0.5);
          ctx.lineTo(x2, top + 0.5);
          ctx.stroke();
        });

        if (secondary.length) {
          const sorted = [...secondary].sort((a, b) => a.f1 - b.f1 || a.f2 - b.f2);
          const rows = [];
          const rowEnds = [];
          sorted.forEach(d => {
            let rowIdx = -1;
            for (let i = 0; i < rowEnds.length; i++) {
              if (d.f1 >= rowEnds[i] * 1.01) {
                rowIdx = i;
                break;
              }
            }
            if (rowIdx < 0) {
              rows.push([]);
              rowEnds.push(0);
              rowIdx = rows.length - 1;
            }
            rows[rowIdx].push(d);
            rowEnds[rowIdx] = Math.max(rowEnds[rowIdx], d.f2);
          });
          // Secondary overlays as bars with in-bar labels, packed into non-overlapping rows.
          const barStyleById = {
            bass_feel:     { fill: 'rgba(173,198,255,0.32)', stroke: 'rgba(173,198,255,0.42)' },
            slam:          { fill: 'rgba(123,163,224,0.34)', stroke: 'rgba(123,163,224,0.44)' },
            male_vocals:   { fill: 'rgba(240,180,41,0.34)',  stroke: 'rgba(240,180,41,0.46)'  },
            female_vocals: { fill: 'rgba(83,225,111,0.28)',  stroke: 'rgba(83,225,111,0.42)'  },
            note_weight:   { fill: 'rgba(83,225,111,0.22)',  stroke: 'rgba(83,225,111,0.34)'  },
            sound_stage:   { fill: 'rgba(193,198,215,0.30)', stroke: 'rgba(193,198,215,0.42)' },
            detail:        { fill: 'rgba(173,198,255,0.28)', stroke: 'rgba(173,198,255,0.42)' },
            sibilance:     { fill: 'rgba(255,179,181,0.30)', stroke: 'rgba(255,179,181,0.42)' },
            texture:       { fill: 'rgba(240,180,41,0.24)',  stroke: 'rgba(240,180,41,0.38)'  },
            timbre:        { fill: 'rgba(107,107,123,0.32)', stroke: 'rgba(193,198,215,0.30)' },
          };
          const laneTop = top + 6;
          const rowH = 10;
          const rowGap = 4;
          rows.forEach((defs, rowIdx) => {
            const y = laneTop + rowIdx * (rowH + rowGap);
            defs.forEach(d => {
              const x1 = Math.max(left, Math.min(right, x.getPixelForValue(d.f1)));
              const x2 = Math.max(left, Math.min(right, x.getPixelForValue(d.f2)));
              const w = x2 - x1;
              if (w < 18) return;
              const st = barStyleById[d.id] || { fill: 'rgba(173,198,255,0.28)', stroke: 'rgba(173,198,255,0.40)' };
              ctx.save();
              ctx.fillStyle = st.fill;
              ctx.strokeStyle = st.stroke;
              ctx.lineWidth = 1;
              ctx.fillRect(x1, y, w, rowH);
              ctx.strokeRect(x1 + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, rowH - 1));
              if (w >= 54) {
                const label = d.label.length > 18 ? `${d.label.slice(0, 18)}…` : d.label;
                ctx.font = '600 9px Inter, sans-serif';
                ctx.fillStyle = 'rgba(229,226,225,0.95)';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, x1 + (w / 2), y + (rowH / 2) + 0.2);
              }
              ctx.restore();
            });
          });
        }
      }
      if (showPrimaryLabels) {
        const labels = selected.filter(d => d.tier === 'primary');
        ctx.save();
        ctx.font = '9px Inter, sans-serif';
        ctx.fillStyle = 'rgba(229,226,225,0.48)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        labels.forEach(d => {
          const x1 = Math.max(left, Math.min(right, x.getPixelForValue(d.f1)));
          const x2 = Math.max(left, Math.min(right, x.getPixelForValue(d.f2)));
          if ((x2 - x1) > 34) ctx.fillText(d.label, (x1 + x2) / 2, bottom - 2);
        });
        ctx.restore();
      }
      if (extraDraw) extraDraw(chart, { left, right, top, bottom, x, ctx });
    },
  };
}

function _isFavourite(type, id) {
  if (!state.favourites[type]) return false;
  return state.favourites[type].has(String(id || ''));
}

function _favToggleBtn(type, id, extraClass = '') {
  const itemId = String(id || '');
  if (!itemId) return '';
  const isFav = _isFavourite(type, itemId);
  const label = isFav ? 'Remove from favourites' : 'Add to favourites';
  return `<button class="fav-toggle ${extraClass} ${isFav ? 'is-fav' : ''}" data-type="${type}" data-id="${esc(itemId)}" onclick="event.stopPropagation();App.toggleFavourite('${type}','${encodeURIComponent(itemId)}')" title="${label}" aria-label="${label}">${isFav ? _STAR_FILLED : _STAR_OUTLINE}</button>`;
}

function _applyFavouriteDomState(type, id, isFav) {
  const itemId = String(id || '');
  document.querySelectorAll('.fav-toggle').forEach(btn => {
    if (btn.dataset.type !== type || btn.dataset.id !== itemId) return;
    btn.classList.toggle('is-fav', isFav);
    const label = isFav ? 'Remove from favourites' : 'Add to favourites';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = isFav ? _STAR_FILLED : _STAR_OUTLINE;
  });
}

function _setFavouritesState(payload = {}) {
  const songs = Array.isArray(payload.songs) ? payload.songs : [];
  const albums = Array.isArray(payload.albums) ? payload.albums : [];
  const artists = Array.isArray(payload.artists) ? payload.artists : [];
  const dapExports = (payload.dap_exports && typeof payload.dap_exports === 'object') ? payload.dap_exports : {};
  state.favouritesMeta = { songs, albums, artists, dap_exports: dapExports };
  state.favourites.songs = new Set(songs.map(r => String(r.id || '')).filter(Boolean));
  state.favourites.albums = new Set(albums.map(r => String(r.id || '')).filter(Boolean));
  state.favourites.artists = new Set(artists.map(r => String(r.id || '')).filter(Boolean));
}

async function loadFavourites() {
  try {
    const payload = await api('/favourites');
    _setFavouritesState(payload || {});
    refreshPlayerFavouriteButton();
  } catch (_) {
    _setFavouritesState({});
  }
}

function _replaceFavouriteCategory(type, rows) {
  const payload = { ...state.favouritesMeta };
  payload[type] = Array.isArray(rows) ? rows : [];
  _setFavouritesState(payload);
  refreshPlayerFavouriteButton();
}

async function toggleFavourite(type, encodedId) {
  const id = decodeURIComponent(String(encodedId || ''));
  if (!id || !['songs', 'albums', 'artists'].includes(type)) return;
  const had = _isFavourite(type, id);
  _applyFavouriteDomState(type, id, !had);
  if (had) state.favourites[type].delete(id);
  else state.favourites[type].add(id);
  refreshPlayerFavouriteButton();
  try {
    const method = had ? 'DELETE' : 'POST';
    const rows = await api(`/favourites/${type}/${encodeURIComponent(id)}`, { method });
    _replaceFavouriteCategory(type, rows);
    _refreshFavouritesViewsAfterToggle(type);
  } catch (e) {
    if (had) state.favourites[type].add(id);
    else state.favourites[type].delete(id);
    _applyFavouriteDomState(type, id, had);
    refreshPlayerFavouriteButton();
    toast('Could not update favourites');
  }
}

function refreshPlayerFavouriteButton() {
  const btn = document.getElementById('player-fav-btn');
  if (!btn) return;
  const track = Player?.currentTrack;
  const tid = track?.id ? String(track.id) : '';
  const isFav = tid ? _isFavourite('songs', tid) : false;
  btn.classList.toggle('is-fav', isFav);
  btn.disabled = !tid;
  const label = isFav ? 'Remove from favourites' : 'Add to favourites';
  btn.title = tid ? label : 'No track selected';
  btn.setAttribute('aria-label', tid ? label : 'No track selected');
  btn.innerHTML = isFav ? _STAR_FILLED : _STAR_OUTLINE;
}

async function toggleCurrentTrackFavourite() {
  const track = Player?.currentTrack;
  if (!track?.id) return;
  await toggleFavourite('songs', encodeURIComponent(track.id));
}

function _refreshFavouritesViewsAfterToggle(type) {
  if (state.view === 'favourites') loadFavouritesSummary();
  if (state.view === 'favourites' && state.favPanel === 'songs' && type === 'songs') loadFavSongs();
  if (state.view === 'favourites' && state.favPanel === 'artists' && type === 'artists') loadFavArtists();
  if (state.view === 'favourites' && state.favPanel === 'albums' && type === 'albums') loadFavAlbums();
  if (state.view === 'playlists') loadPlaylistsView();
}

/* ── Scan status ────────────────────────────────────────────────────── */
async function pollScanStatus() {
  const status = await api('/library/status').catch(() => null);
  if (!status) return;
  state.scanStatus = status;

  const msg = document.getElementById('scan-msg');
  const bar = document.getElementById('scan-bar');
  const barWrap = document.getElementById('scan-bar-wrap');

  if (status.status === 'scanning') {
    barWrap.style.display = 'block';
    const pct = status.total > 0 ? Math.round((status.progress / status.total) * 100) : 0;
    bar.style.width = pct + '%';
    msg.textContent = `Scanning… ${status.progress}/${status.total}`;
    msg.classList.add('scanning-pulse');
    setTimeout(pollScanStatus, 800);
  } else {
    barWrap.style.display = 'none';
    bar.style.width = '100%';
    msg.classList.remove('scanning-pulse');
    if (status.status === 'done' && status.total_tracks != null) {
      const newLine = status.new_tracks > 0
        ? `<span class="scan-new">+${status.new_tracks} new</span>`
        : status.new_tracks < 0
          ? `<span class="scan-removed">${status.new_tracks} removed</span>`
          : `<span class="scan-unchanged">No changes</span>`;
      msg.innerHTML = `<span class="scan-ready">Library ready</span><span class="scan-total">${status.total_tracks.toLocaleString()} tracks</span>${newLine}`;
    } else if (status.status === 'error') {
      msg.innerHTML = `<span class="scan-error">⚠ ${esc(status.message || 'Library error')}</span>`;
    } else {
      msg.textContent = status.message;
    }

    if (status.status === 'done') {
      // Refresh current view if it's a library view
      if (['artists', 'albums', 'tracks'].includes(state.view)) {
        refreshCurrentLibraryView();
      }
    }
  }
}

async function refreshCurrentLibraryView() {
  if (state.view === 'artists') await loadArtists();
  else if (state.view === 'albums') await loadAlbums(state.artist);
  else if (state.view === 'tracks') await loadTracks(state.artist, state.album);
}

/* ── Context menu state ─────────────────────────────────────────────── */
let _ctxTracks = [];
let _ctxFavTarget = null;
let _ctxDetailMode = null; // 'album' | 'artist' | null

/* ── Create playlist modal state ────────────────────────────────────── */
let _createPlPendingIds = [];
let _dapModalInitialJson = '';
let _iemModalInitialJson = '';
let _mlGenOptions = null;
let _mlGenPreviewTracks = [];
let _mlGenPreviewDirty = false;
let _mlGenContext = 'global';
let _mlGenSeedTrackIds = [];
let _mlModeBound = false;
let _mlSongCatalog = null;
let _mlRefQuery = '';
const _ML_MAX_REF_TRACKS = 12;
let _mlRefDraftIds = [];
let _mlPreviewSeed = 1337;

const _ML_MOOD_PRESETS = {
  focus: { energy: 0.42, brightness: 0.4 },
  late_night: { energy: 0.3, brightness: 0.35 },
  energetic: { energy: 0.78, brightness: 0.62 },
  warm_relaxed: { energy: 0.38, brightness: 0.28 },
  hype: { energy: 0.86, brightness: 0.7 },
  bright_bouncy: { energy: 0.72, brightness: 0.78 },
  dark_heavy: { energy: 0.68, brightness: 0.24 },
};

/* ── Generic confirm modal ──────────────────────────────────────────── */
let _confirmResolve = null;

function _showConfirm({ title = '', message = '', okText = 'Delete', cancelText = 'Cancel', danger = true, icon = null } = {}) {
  return new Promise(resolve => {
    _confirmResolve = resolve;
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-msg').textContent   = message;
    const okBtn = document.getElementById('confirm-modal-ok');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    okBtn.textContent  = okText;
    okBtn.className    = danger ? 'btn-danger-pill' : 'btn-danger-pill btn-danger-pill--neutral';
    if (cancelBtn) cancelBtn.textContent = cancelText;
    const iconEl = document.getElementById('confirm-modal-icon');
    if (icon) {
      iconEl.innerHTML  = icon;
      iconEl.className  = 'confirm-modal-icon';
    } else if (!danger) {
      iconEl.innerHTML  = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
      iconEl.className  = 'confirm-modal-icon icon-neutral';
    } else {
      iconEl.innerHTML  = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent-secondary)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
      iconEl.className  = 'confirm-modal-icon';
    }
    document.getElementById('confirm-modal').style.display = 'flex';
  });
}

function _confirmYes() {
  document.getElementById('confirm-modal').style.display = 'none';
  if (_confirmResolve) { _confirmResolve(true);  _confirmResolve = null; }
}

function _confirmNo() {
  document.getElementById('confirm-modal').style.display = 'none';
  if (_confirmResolve) { _confirmResolve(false); _confirmResolve = null; }
}

/* ── Sidebar playlists ──────────────────────────────────────────────── */
async function loadPlaylists() {
  const playlists = await api('/playlists');
  state.playlists = playlists;
  renderSidebarPlaylists();
}

function renderSidebarPlaylists() {
  // Sidebar playlist list removed — playlists now in their own view
  // Refresh the playlists view if currently active
  if (state.view === 'playlists') loadPlaylistsView();
}

function toggleSidebarSort(event) {
  event.stopPropagation();
  const dd = document.getElementById('sidebar-sort-dd');
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  // Update checkmarks
  ['alpha','created','updated'].forEach(m => {
    const el = document.getElementById(`sidebar-sort-check-${m}`);
    if (el) el.style.opacity = (m === state.playlistSortMode) ? '1' : '0';
  });
}

function setSidebarSort(mode) {
  state.playlistSortMode = mode;
  localStorage.setItem('sidebarSort', mode);
  const dd = document.getElementById('pl-view-sort-dd');
  if (dd) dd.style.display = 'none';
  ['alpha','created','updated'].forEach(m => {
    const el = document.getElementById(`pl-view-sort-check-${m}`);
    if (el) el.style.opacity = (m === mode) ? '1' : '0';
  });
  renderSidebarPlaylists();
}

function togglePlViewSort(event) {
  event.stopPropagation();
  const dd = document.getElementById('pl-view-sort-dd');
  if (!dd) return;
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  ['alpha','created','updated'].forEach(m => {
    const el = document.getElementById(`pl-view-sort-check-${m}`);
    if (el) el.style.opacity = (m === state.playlistSortMode) ? '1' : '0';
  });
}

async function loadPlaylistsView() {
  const grid = document.getElementById('playlists-view-grid');
  const empty = document.getElementById('playlists-view-empty');
  if (!grid) return;
  const favTracksRes = await api('/favourites/songs/tracks').catch(() => ({ tracks: [] }));
  const favTracks = Array.isArray(favTracksRes?.tracks) ? favTracksRes.tracks : [];
  const favCount = favTracks.length;

  // Sort playlists
  const pls = [...state.playlists];
  if (state.playlistSortMode === 'alpha') {
    pls.sort((a, b) => a.name.localeCompare(b.name));
  } else if (state.playlistSortMode === 'created') {
    pls.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  } else {
    pls.sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0));
  }

  if (!pls.length && favCount === 0) {
    grid.innerHTML = '';
    if (empty) empty.style.display = 'flex';
    return;
  }
  if (empty) empty.style.display = 'none';

  const playlistCards = pls.map(pl => {
    // Build cover art HTML
    let coverHtml;
    if (pl.has_artwork) {
      coverHtml = `<img src="/api/playlists/${pl.id}/artwork?t=${Date.now()}" style="width:100%;height:100%;object-fit:cover" loading="lazy" onerror="this.style.display='none'" />`;
    } else {
      const keys = (pl.artwork_keys || []).slice(0, 4);
      if (!keys.length) {
        coverHtml = coverPlaceholder('playlist', 40, '8px', true);
      } else if (keys.length === 1) {
        coverHtml = `<img src="/api/artwork/${keys[0]}" style="width:100%;height:100%;object-fit:cover" loading="lazy" />`;
      } else {
        coverHtml = keys.map(k => `<img src="/api/artwork/${k}" loading="lazy" />`).join('');
      }
    }
    const count = pl.track_count != null ? pl.track_count : (pl.tracks ? pl.tracks.length : 0);
    return `
      <div class="pl-view-card" onclick="App.openPlaylist('${pl.id}')">
        <div class="pl-view-cover ${pl.has_artwork || (pl.artwork_keys && pl.artwork_keys.length === 1) ? 'playlist-cover-single' : ''}">${coverHtml}</div>
        <div class="pl-view-info">
          <div class="pl-view-info-text">
            <div class="pl-view-name" title="${esc(pl.name)}">${esc(pl.name)}</div>
            <div class="pl-view-meta">${count} track${count !== 1 ? 's' : ''}</div>
          </div>
          <button class="pl-card-delete-btn" onclick="event.stopPropagation();App.deletePlaylist('${pl.id}')" title="Delete playlist">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </div>
      </div>
    `;
  }).join('');

  let favCard = '';
  if (favCount > 0) {
    const coverHtml = `<img src="${_FAV_PLAYLIST_COVER}" style="width:100%;height:100%;object-fit:cover" loading="lazy" />`;
    favCard = `
      <div class="pl-view-card pl-view-card-fav" onclick="App.showView('fav-songs')">
        <div class="pl-view-cover playlist-cover-single">${coverHtml}</div>
        <div class="pl-view-info">
          <div class="pl-view-info-text">
            <div class="pl-view-name" title="Favourite Songs">Favourite Songs <span class="fav-badge-inline">★</span></div>
            <div class="pl-view-meta">${favCount} track${favCount !== 1 ? 's' : ''}</div>
          </div>
        </div>
      </div>
    `;
  }
  grid.innerHTML = favCard + playlistCards;
}

/* ── Artists / Albums helpers ──────────────────────────────────────── */
function _libraryLetter(name) {
  const stripped = String(name || '').replace(/^(the|a|an)\s+/i, '').trim();
  const first = stripped.charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : '#';
}

function _librarySearchMatch(haystack, query) {
  if (!query) return true;
  return String(haystack || '').toLowerCase().includes(query);
}

function _scrollMainTop() {
  const main = document.getElementById('main');
  if (main) main.scrollTop = 0;
}

function _renderAlphaButtons({ barEl, presentLetters, activeLetter, clickFn }) {
  if (!barEl) return;
  const LETTERS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const allActive = !activeLetter;
  const allTitle = presentLetters.size ? 'Show all' : 'No entries';
  const allDisabled = !presentLetters.size;
  const allBtn = `<button class="alpha-btn alpha-btn-all ${allActive ? 'active' : ''}" ${allDisabled ? 'disabled' : ''} onclick="${clickFn}('')" title="${allTitle}">All</button>`;
  const letterBtns = LETTERS.map(l => `
    <button class="alpha-btn ${activeLetter === l ? 'active' : ''}" ${presentLetters.has(l) ? `onclick="${clickFn}('${l}')"` : 'disabled'}
      title="${l === '#' ? 'Numbers / symbols' : l}">${l}</button>
  `).join('');
  barEl.innerHTML = allBtn + letterBtns;
}

/* ── Artists view ───────────────────────────────────────────────────── */
const _debouncedRenderArtistsGrid = _debounce(() => { renderArtistsGrid(); _scrollMainTop(); }, 200);
function setArtistSearch(query) {
  state.artistSearch = String(query || '');
  const clearBtn = document.getElementById('artists-filter-clear');
  if (clearBtn) clearBtn.style.display = state.artistSearch ? 'block' : 'none';
  _debouncedRenderArtistsGrid();
}

function clearArtistSearch() {
  state.artistSearch = '';
  const inp = document.getElementById('artists-filter-input');
  if (inp) inp.value = '';
  const clearBtn = document.getElementById('artists-filter-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  renderArtistsGrid();
}

function setArtistAlphaFilter(letter = '') {
  const target = String(letter || '').toUpperCase();
  state.artistAlpha = state.artistAlpha === target ? '' : target;
  renderArtistsGrid();
  _scrollMainTop();
}

function _filteredArtistsData() {
  const q = state.artistSearch.trim().toLowerCase();
  const base = Array.isArray(state.artists) ? state.artists : [];
  const searched = q ? base.filter(a => _librarySearchMatch(a.name, q)) : base;
  const presentLetters = new Set(searched.map(a => _libraryLetter(a.name)));
  if (state.artistAlpha && !presentLetters.has(state.artistAlpha)) state.artistAlpha = '';
  const filtered = state.artistAlpha ? searched.filter(a => _libraryLetter(a.name) === state.artistAlpha) : searched;
  return { base, searched, filtered, presentLetters };
}

function renderArtistsGrid() {
  const grid = document.getElementById('artists-grid');
  const alphaBar = document.getElementById('alpha-bar');
  const artistsEmpty = document.getElementById('artists-empty');
  const countEl = document.getElementById('artists-count');
  const { base, filtered, presentLetters } = _filteredArtistsData();
  const hasFilters = !!(state.artistSearch || state.artistAlpha);

  if (countEl) {
    countEl.textContent = hasFilters
      ? `${filtered.length} of ${base.length} artists`
      : `${base.length} artists`;
  }

  if (!base.length) {
    if (grid) grid.innerHTML = '';
    if (alphaBar) alphaBar.innerHTML = '';
    if (artistsEmpty) {
      const [title, hint] = artistsEmpty.querySelectorAll('p');
      if (title) title.textContent = 'No artists found.';
      if (hint) hint.textContent = 'Rescan your library to load music.';
      artistsEmpty.style.display = 'flex';
    }
    return;
  }

  _renderAlphaButtons({
    barEl: alphaBar,
    presentLetters,
    activeLetter: state.artistAlpha,
    clickFn: 'App.setArtistAlphaFilter',
  });

  if (!filtered.length) {
    if (grid) grid.innerHTML = '';
    if (artistsEmpty) {
      const [title, hint] = artistsEmpty.querySelectorAll('p');
      if (title) title.textContent = 'No artists match your filters.';
      if (hint) hint.textContent = 'Try a different search or alphabet filter.';
      artistsEmpty.style.display = 'flex';
    }
    return;
  }

  if (artistsEmpty) artistsEmpty.style.display = 'none';
  if (grid) {
    grid.innerHTML = filtered.map(a => {
      const hasArtistArt = !!(a.image_key || a.artwork_key);
      const imgSrc = a.image_key
        ? `<img src="/api/artists/${a.image_key}/image" alt="${esc(a.name)}" loading="lazy" />`
        : (a.artwork_key
          ? thumbImg(a.artwork_key, 120, '6px')
          : coverPlaceholder('artist', 120, '6px'));
      return `
      <div class="artist-card" data-artist="${esc(a.name)}" onclick="App.showArtist(this.dataset.artist)" oncontextmenu="event.preventDefault();App.showArtistCtxMenu(event,this.dataset.artist)">
        <div class="artist-thumb${hasArtistArt ? '' : ' artist-thumb--placeholder'}">
          ${imgSrc}
          <div class="card-thumb-overlay">
            <button class="card-play-btn" data-artist="${esc(a.name)}" onclick="event.stopPropagation();App.playArtistCard(this.dataset.artist)" title="Play all songs">
              ${playSvg(15)}
            </button>
          </div>
          <button class="artist-img-btn" data-artist="${esc(a.name)}" onclick="event.stopPropagation();_openArtistImageForCard(this.dataset.artist)" title="Change artist image">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          </button>
          ${_favToggleBtn('artists', _normArtistId(a.name), 'card-fav-btn')}
        </div>
        <div class="artist-name" title="${esc(a.name)}">${esc(a.name)}</div>
        <div class="artist-meta">${a.album_count} album${a.album_count !== 1 ? 's' : ''} · ${a.track_count} songs</div>
        <button class="card-more-btn" data-artist="${esc(a.name)}" onclick="event.stopPropagation();App.showArtistCtxMenu(event,this.dataset.artist)" title="More options">⋮</button>
      </div>
    `;
    }).join('');
  }
}

function _openArtistImageForCard(artistName) {
  // Temporarily set state.artist so openArtistImageModal works
  const prevArtist = state.artist;
  state.artist = artistName;
  openArtistImageModal();
  // We deliberately keep state.artist set to the card's artist so the modal has context
  // Restore previous artist state after modal is used
}

async function loadArtists() {
  document.getElementById('artists-grid').innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  let artists;
  try {
    artists = await api('/library/artists');
  } catch (e) {
    document.getElementById('artists-grid').innerHTML =
      `<div class="library-error-banner"><p>Could not load library: ${esc(e.message)}</p>
       <p class="library-error-hint">Check that your music folder is accessible, then rescan in Settings.</p></div>`;
    return;
  }
  state.artists = artists;
  const artistFilterInput = document.getElementById('artists-filter-input');
  if (artistFilterInput) artistFilterInput.value = state.artistSearch || '';
  const clearBtn = document.getElementById('artists-filter-clear');
  if (clearBtn) clearBtn.style.display = state.artistSearch ? 'block' : 'none';
  renderArtistsGrid();

  // Restore saved scroll position (breadcrumb back) or reset to top (sidebar nav)
  const main = document.getElementById('main');
  if (main) main.scrollTop = state._artistsScrollTop || 0;
  state._artistsScrollTop = 0;
}

function scrollToLetter(letter) {
  setArtistAlphaFilter(letter);
}

/* ── Albums view ────────────────────────────────────────────────────── */
const _debouncedRenderAlbumsGrid = _debounce(() => { renderAlbumsGrid(); _scrollMainTop(); }, 200);
function setAlbumSearch(query) {
  state.albumSearch = String(query || '');
  const clearBtn = document.getElementById('albums-filter-clear');
  if (clearBtn) clearBtn.style.display = state.albumSearch ? 'block' : 'none';
  _debouncedRenderAlbumsGrid();
}

function clearAlbumSearch() {
  state.albumSearch = '';
  const inp = document.getElementById('albums-filter-input');
  if (inp) inp.value = '';
  const clearBtn = document.getElementById('albums-filter-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  renderAlbumsGrid();
}

function setAlbumAlphaFilter(letter = '') {
  const target = String(letter || '').toUpperCase();
  state.albumAlpha = state.albumAlpha === target ? '' : target;
  renderAlbumsGrid();
  _scrollMainTop();
}

function _filteredAlbumsData() {
  const artistFilter = state.artist || null;
  const q = state.albumSearch.trim().toLowerCase();
  const base = Array.isArray(state.albums) ? state.albums : [];
  const searched = q
    ? base.filter(al => _librarySearchMatch(`${al.name} ${artistFilter ? '' : al.artist || ''}`, q))
    : base;
  const presentLetters = new Set(searched.map(al => _libraryLetter(al.name)));
  if (artistFilter) state.albumAlpha = '';
  if (state.albumAlpha && !presentLetters.has(state.albumAlpha)) state.albumAlpha = '';
  const filtered = state.albumAlpha ? searched.filter(al => _libraryLetter(al.name) === state.albumAlpha) : searched;
  return { artistFilter, base, filtered, presentLetters };
}

function renderAlbumsGrid() {
  const grid = document.getElementById('albums-grid');
  const countEl = document.getElementById('albums-count');
  const albumsAlphaBar = document.getElementById('albums-alpha-bar');
  const albumsEmpty = document.getElementById('albums-empty');
  const { artistFilter, base, filtered, presentLetters } = _filteredAlbumsData();
  const hasFilters = !!(state.albumSearch || state.albumAlpha);

  if (countEl) {
    countEl.textContent = hasFilters
      ? `${filtered.length} of ${base.length} album${base.length !== 1 ? 's' : ''}`
      : `${base.length} album${base.length !== 1 ? 's' : ''}`;
  }

  if (!artistFilter && albumsAlphaBar) {
    albumsAlphaBar.style.display = 'flex';
    _renderAlphaButtons({
      barEl: albumsAlphaBar,
      presentLetters,
      activeLetter: state.albumAlpha,
      clickFn: 'App.setAlbumAlphaFilter',
    });
  } else if (albumsAlphaBar) {
    albumsAlphaBar.style.display = 'none';
    albumsAlphaBar.innerHTML = '';
  }

  if (!base.length) {
    if (grid) grid.innerHTML = '';
    if (albumsEmpty) {
      const [title, hint] = albumsEmpty.querySelectorAll('p');
      if (title) title.textContent = 'No albums found.';
      if (hint) hint.textContent = 'Browse by artist or rescan your library.';
      albumsEmpty.style.display = 'flex';
    }
    return;
  }

  if (!filtered.length) {
    if (grid) grid.innerHTML = '';
    if (albumsEmpty) {
      const [title, hint] = albumsEmpty.querySelectorAll('p');
      if (title) title.textContent = 'No albums match your filters.';
      if (hint) hint.textContent = 'Try a different search or alphabet filter.';
      albumsEmpty.style.display = 'flex';
    }
    return;
  }

  if (albumsEmpty) albumsEmpty.style.display = 'none';
  if (grid) {
    grid.innerHTML = filtered.map(al => `
      <div class="album-card" data-artist="${esc(al.artist)}" data-album="${esc(al.name)}" onclick="App.showAlbum(this.dataset.artist, this.dataset.album)" oncontextmenu="event.preventDefault();App.showAlbumCtxMenu(event,this.dataset.artist,this.dataset.album)">
        <div class="album-thumb">
          ${thumbImg(al.artwork_key, 160, '6px')}
          <div class="card-thumb-overlay">
            <button class="card-play-btn" data-artist="${esc(al.artist)}" data-album="${esc(al.name)}" onclick="event.stopPropagation();App.playAlbum(this.dataset.artist,this.dataset.album)" title="Play album">
              ${playSvg(15)}
            </button>
          </div>
          ${_favToggleBtn('albums', al.artwork_key || '', 'card-fav-btn')}
          <button class="album-art-btn" data-artist="${esc(al.artist)}" data-album="${esc(al.name)}" onclick="event.stopPropagation();App._openAlbumArtForCard(this.dataset.artist,this.dataset.album)" title="Change album art">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          </button>
        </div>
        <div class="album-name" title="${esc(al.name)}">${esc(al.name)}</div>
        ${!artistFilter ? `<div class="album-artist">${esc(al.artist)}</div>` : ''}
        ${al.year ? `<div class="album-year">${esc(al.year)}</div>` : ''}
        <button class="card-more-btn" data-artist="${esc(al.artist)}" data-album="${esc(al.name)}" onclick="event.stopPropagation();App.showAlbumCtxMenu(event,this.dataset.artist,this.dataset.album)" title="More options">⋮</button>
      </div>
    `).join('');
  }
}

function scrollToAlbumLetter(letter) {
  setAlbumAlphaFilter(letter);
}

async function loadAlbums(artistFilter = null) {
  document.getElementById('albums-grid').innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  const query = artistFilter ? `?artist=${encodeURIComponent(artistFilter)}` : '';
  let albums;
  try {
    albums = await api('/library/albums' + query);
  } catch (e) {
    document.getElementById('albums-grid').innerHTML =
      `<div class="library-error-banner"><p>Could not load library: ${esc(e.message)}</p>
       <p class="library-error-hint">Check that your music folder is accessible, then rescan in Settings.</p></div>`;
    return;
  }
  const _albumYearNum = (al) => {
    const raw = String((al && al.year) || '').trim();
    if (!raw) return Number.POSITIVE_INFINITY;
    const m = raw.match(/\d{4}/);
    if (!m) return Number.POSITIVE_INFINITY;
    const y = Number.parseInt(m[0], 10);
    return Number.isFinite(y) ? y : Number.POSITIVE_INFINITY;
  };
  if (artistFilter) {
    albums = [...albums].sort((a, b) => {
      const ay = _albumYearNum(a);
      const by = _albumYearNum(b);
      if (ay !== by) return ay - by;
      return String(a?.name || '').localeCompare(String(b?.name || ''));
    });
  }
  state.albums = albums;

  const scope = artistFilter ? `artist:${artistFilter}` : '__all__';
  if (state._albumScope !== scope) {
    state._albumScope = scope;
    state.albumSearch = '';
    state.albumAlpha = '';
  }

  const hero = document.getElementById('artist-hero');
  const albumsViewHeader = document.querySelector('#view-albums .view-header');
  const albumsViewTitle = document.querySelector('#view-albums .view-header h2');
  const albumsViewCount = document.getElementById('albums-count');

  if (artistFilter) {
    if (albumsViewHeader) albumsViewHeader.classList.add('artist-detail-mode');
    if (albumsViewTitle) albumsViewTitle.style.display = 'none';
    if (albumsViewCount) albumsViewCount.style.display = 'none';
    // Populate artist hero
    const artistData = state.artists?.find(a => a.name === artistFilter);
    const artKey = albums[0]?.artwork_key || artistData?.artwork_key || '';
    const artistImgKey = artistData?.image_key;
    document.getElementById('artist-hero-art').innerHTML = artistImgKey
      ? `<img src="/api/artists/${artistImgKey}/image?t=${Date.now()}" alt="${esc(artistFilter)}" />`
      : (artKey ? `<img src="${artworkUrl(artKey)}" />` : coverPlaceholder('artist', 64, 'var(--radius)', true));
    document.getElementById('artist-hero-name').textContent = artistFilter;
    const totalSongs = albums.reduce((s, al) => s + (al.track_count || 0), 0);
    document.getElementById('artist-hero-meta').textContent =
      `${albums.length} album${albums.length !== 1 ? 's' : ''} · ${totalSongs} songs`;
    const artistAddBtn = document.getElementById('artist-hero-add');
    if (artistAddBtn) {
      artistAddBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const menu = document.getElementById('artist-hero-more-menu');
        if (menu) menu.classList.remove('open');
        const anchor = document.getElementById('artist-hero-more') || artistAddBtn;
        App.addAllArtistSongs(artistFilter, { currentTarget: anchor });
      };
    }
    document.getElementById('artist-hero-browse').onclick = () => App.showArtistTracks(artistFilter);
    const artistFavBtn = document.getElementById('artist-hero-fav');
    if (artistFavBtn) {
      const artistId = _normArtistId(artistFilter);
      const isFav = _isFavourite('artists', artistId);
      artistFavBtn.classList.toggle('is-fav', isFav);
      artistFavBtn.onclick = async (e) => {
        e.stopPropagation();
        await toggleFavourite('artists', encodeURIComponent(artistId));
        const nowFav = _isFavourite('artists', artistId);
        artistFavBtn.classList.toggle('is-fav', nowFav);
      };
    }
    const artistPlayBtn = document.getElementById('artist-hero-play');
    if (artistPlayBtn) {
      artistPlayBtn.onclick = async () => {
        const t = await api(`/library/tracks?artist=${encodeURIComponent(artistFilter)}`);
        if (t && t.length) Player.playAll(t);
      };
    }
    const artistShuffleBtn = document.getElementById('artist-hero-shuffle');
    if (artistShuffleBtn) {
      artistShuffleBtn.onclick = async () => {
        const t = await api(`/library/tracks?artist=${encodeURIComponent(artistFilter)}`);
        if (t && t.length) {
          Player.registerTracks(t);
          Player.setPlaybackContext(t, { sourceType: 'artist', sourceId: artistFilter, sourceLabel: `Artist · ${artistFilter}` });
          Player.playCollectionShuffled(t, `Artist · ${artistFilter}`);
        }
      };
    }
    const artistMoreBtn = document.getElementById('artist-hero-more');
    if (artistMoreBtn) artistMoreBtn.onclick = (e) => App.showArtistDetailCtxMenu(e, artistFilter);
    hero.oncontextmenu = (e) => App.showArtistDetailCtxMenu(e, artistFilter);
    hero.style.display = 'flex';
  } else {
    if (albumsViewHeader) albumsViewHeader.classList.remove('artist-detail-mode');
    if (albumsViewTitle) albumsViewTitle.style.display = '';
    if (albumsViewCount) albumsViewCount.style.display = '';
    hero.oncontextmenu = null;
    hero.style.display = 'none';
  }

  const albumFilterInput = document.getElementById('albums-filter-input');
  if (albumFilterInput) albumFilterInput.value = state.albumSearch || '';
  const albumClearBtn = document.getElementById('albums-filter-clear');
  if (albumClearBtn) albumClearBtn.style.display = state.albumSearch ? 'block' : 'none';

  renderAlbumsGrid();
}

/* ── Tracks view ────────────────────────────────────────────────────── */
async function loadTracks(artist = null, album = null) {
  let q = [];
  if (artist) q.push(`artist=${encodeURIComponent(artist)}`);
  if (album) q.push(`album=${encodeURIComponent(album)}`);
  let tracks;
  try {
    tracks = await api('/library/tracks?' + q.join('&'));
  } catch (e) {
    toast('Could not load tracks — check your music folder in Settings');
    return;
  }
  state.tracks = tracks;

  // Album / artist hero
  const albumHero = document.getElementById('album-hero');
  if (album && tracks.length) {
    const artKey = tracks[0].artwork_key || '';
    document.getElementById('album-hero-art').innerHTML =
      artKey ? `<img src="${artworkUrl(artKey)}" />` : coverPlaceholder('album', 64, 'var(--radius)', true);
    document.getElementById('album-hero-name').textContent = album;
    document.getElementById('album-hero-artist').innerHTML = artist
      ? `<span class="link" data-artist="${esc(artist)}" onclick="App.showArtist(this.dataset.artist)">${esc(artist)}</span>` : '';
    const totalSecs = tracks.reduce((s, t) => s + (t.duration || 0), 0);
    const yr = tracks[0].year;
    const genre = tracks[0].genre;
    const fmt = tracks[0].format;
    const meta = [
      yr ? String(yr) : null,
      genre || null,
      `${tracks.length} songs`,
      totalSecs ? fmtDuration(totalSecs) : null,
      fmt || null,
    ].filter(Boolean).join(' · ');
    document.getElementById('album-hero-meta').textContent = meta;
    const albumFavBtn = document.getElementById('album-hero-fav');
    if (albumFavBtn) {
      const albumId = String(tracks[0].artwork_key || '');
      const isFav = albumId ? _isFavourite('albums', albumId) : false;
      albumFavBtn.style.display = albumId ? '' : 'none';
      albumFavBtn.classList.toggle('is-fav', isFav);
      albumFavBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!albumId) return;
        await toggleFavourite('albums', encodeURIComponent(albumId));
        albumFavBtn.classList.toggle('is-fav', _isFavourite('albums', albumId));
      };
    }
    const albumMoreBtn = document.getElementById('album-hero-more');
    if (albumMoreBtn) albumMoreBtn.onclick = (e) => App.showAlbumDetailCtxMenu(e, artist, album);
    albumHero.oncontextmenu = (e) => App.showAlbumDetailCtxMenu(e, artist, album);
    albumHero.style.display = 'flex';
  } else if (!album && artist && tracks.length) {
    const artKey = tracks[0].artwork_key || '';
    document.getElementById('album-hero-art').innerHTML =
      artKey ? `<img src="${artworkUrl(artKey)}" />` : coverPlaceholder('song', 64, 'var(--radius)', true);
    document.getElementById('album-hero-name').textContent = 'All Songs';
    document.getElementById('album-hero-artist').innerHTML =
      `<span class="link" data-artist="${esc(artist)}" onclick="App.showArtist(this.dataset.artist)">${esc(artist)}</span>`;
    const totalSecs = tracks.reduce((s, t) => s + (t.duration || 0), 0);
    document.getElementById('album-hero-meta').textContent =
      `${tracks.length} songs${totalSecs ? ' · ' + fmtDuration(totalSecs) : ''}`;
    const albumFavBtn = document.getElementById('album-hero-fav');
    if (albumFavBtn) albumFavBtn.style.display = 'none';
    const albumMoreBtn = document.getElementById('album-hero-more');
    if (albumMoreBtn) albumMoreBtn.onclick = (e) => App.showArtistDetailCtxMenu(e, artist);
    albumHero.oncontextmenu = (e) => App.showArtistDetailCtxMenu(e, artist);
    albumHero.style.display = 'flex';
  } else {
    albumHero.oncontextmenu = null;
    albumHero.style.display = 'none';
  }

  if (album) _tracksSort = { col: 'track_number', order: 'asc' };
  state.tracks = _tracksSortedRows(tracks);
  _renderTracksTable();
  Player.registerTracks(state.tracks);
  if (album) {
    Player.setPlaybackContext(state.tracks, { sourceType: 'album', sourceId: `${artist || ''}||${album}`, sourceLabel: `Album · ${album}` });
  } else if (artist) {
    Player.setPlaybackContext(state.tracks, { sourceType: 'artist', sourceId: artist, sourceLabel: `Artist · ${artist}` });
  } else {
    Player.setPlaybackContext(state.tracks, { sourceType: 'songs', sourceId: '', sourceLabel: 'Tracks' });
  }

  const addAllBtn = document.getElementById('add-all-btn');
  if (addAllBtn) {
    addAllBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = document.getElementById('album-hero-more-menu');
      if (menu) menu.classList.remove('open');
      const anchor = document.getElementById('album-hero-more') || addAllBtn;
      App.addAllToPlaylist(state.tracks.map(t => t.id), anchor);
    };
  }

  // Play / Shuffle buttons on album hero
  const albumPlayBtn = document.getElementById('album-hero-play');
  if (albumPlayBtn) albumPlayBtn.onclick = () => Player.playAll(state.tracks);
  const albumShuffleBtn = document.getElementById('album-hero-shuffle');
  if (albumShuffleBtn) albumShuffleBtn.onclick = () => {
    const label = album ? `Album · ${album}` : (artist ? `Artist · ${artist}` : 'Tracks');
    Player.playCollectionShuffled(state.tracks, label);
  };
}

function fmtDuration(totalSecs) {
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min`;
  return `${m} min`;
}

let _tracksSort = { col: 'track_number', order: 'asc' };

function _trackNumberSortValue(track) {
  const raw = String(track?.track_number || '').trim();
  if (!raw) return Number.POSITIVE_INFINITY;
  const main = raw.split('/')[0].trim();
  const n = Number.parseInt(main, 10);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function _trackDiscSortValue(track) {
  const direct = String(track?.disc_number || '').trim();
  if (direct) {
    const main = direct.split('/')[0].trim();
    const n = Number.parseInt(main, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Common metadata aliases from different scanners/tag readers.
  const aliasDirect = [track?.disc, track?.disk, track?.disc_no, track?.discnum, track?.discNum]
    .map(v => String(v || '').trim())
    .find(Boolean);
  if (aliasDirect) {
    const main = aliasDirect.split('/')[0].trim();
    const n = Number.parseInt(main, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const pathValue = String(track?.path || '').trim();
  const fileValue = String(track?.filename || '').trim();
  const source = (pathValue || fileValue).toLowerCase();
  if (source) {
    const m = source.match(/(?:^|[\\/._\-\s])(disc|cd|disk)\s*0*([1-9]\d?)(?:[\\/._\-\s]|$)/i);
    if (m && m[2]) {
      const n = Number.parseInt(m[2], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    // File-prefix patterns used by multi-disc releases, e.g. "1-01 Track.flac", "CD2-07 ...".
    const file = source.split(/[\\/]/).pop() || source;
    const prefixedCd = file.match(/^(?:disc|cd|disk)\s*0*([1-9]\d?)\s*[-_.\s]+\d{1,3}(?:[-_.\s]|$)/i);
    if (prefixedCd && prefixedCd[1]) {
      const n = Number.parseInt(prefixedCd[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const discTrackPrefix = file.match(/^([1-9]\d?)\s*[-_.]\s*\d{1,3}(?:[-_.\s]|$)/);
    if (discTrackPrefix && discTrackPrefix[1]) {
      const n = Number.parseInt(discTrackPrefix[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return 1;
}

function _hasMultiDiscTracks(rows) {
  const discs = new Set((rows || []).map(_trackDiscSortValue).filter(n => Number.isFinite(n) && n > 0));
  return discs.size > 1;
}

function _trackDiscLabelFromPath(track) {
  const p = String(track?.path || '');
  if (!p) return '';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return '';
  const parent = parts[parts.length - 2] || '';
  const grandParent = parts.length > 2 ? (parts[parts.length - 3] || '') : '';
  const albumName = String(state.album || '').trim().toLowerCase();
  const parentNorm = parent.trim().toLowerCase();
  const grandParentNorm = grandParent.trim().toLowerCase();
  if (!parentNorm) return '';
  // Typical pattern: ".../<Album>/<Disc Folder>/<Track>".
  if (albumName && parentNorm === albumName && grandParentNorm && grandParentNorm !== albumName) {
    const gm = grandParent.match(/(?:disc|cd|disk)\s*0*([1-9]\d?)/i);
    if (gm && gm[1]) return `disc:${Number.parseInt(gm[1], 10)}`;
    return `folder:${grandParentNorm}`;
  }
  if (albumName && parentNorm === albumName) return '';
  const m = parent.match(/(?:disc|cd)\s*0*([1-9]\d?)/i);
  if (m && m[1]) return `disc:${Number.parseInt(m[1], 10)}`;
  return `folder:${parentNorm}`;
}

function _buildAlbumDiscGroups(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!state.album || !list.length) return [{ key: 'disc:1', label: 'Disc 1', rows: list }];

  const explicitNums = [...new Set(list
    .map(t => _trackDiscSortValue(t))
    .filter(n => Number.isFinite(n) && n > 0)
  )];
  if (explicitNums.length > 1) {
    const groups = new Map();
    explicitNums.sort((a, b) => a - b).forEach(n => groups.set(`disc:${n}`, { key: `disc:${n}`, label: `Disc ${n}`, rows: [] }));
    list.forEach(t => {
      const n = _trackDiscSortValue(t);
      const k = groups.has(`disc:${n}`) ? `disc:${n}` : `disc:1`;
      groups.get(k).rows.push(t);
    });
    return [...groups.values()].filter(g => g.rows.length);
  }

  const folderKeys = list.map(_trackDiscLabelFromPath).filter(Boolean);
  const uniqueFolders = [...new Set(folderKeys)];
  if (uniqueFolders.length > 1) {
    const folderToDisc = new Map();
    uniqueFolders.forEach((k, i) => folderToDisc.set(k, i + 1));
    const groups = new Map();
    list.forEach(t => {
      const fk = _trackDiscLabelFromPath(t);
      const disc = fk ? (folderToDisc.get(fk) || 1) : 1;
      const key = `disc:${disc}`;
      if (!groups.has(key)) groups.set(key, { key, label: `Disc ${disc}`, rows: [] });
      groups.get(key).rows.push(t);
    });
    const out = [...groups.values()].sort((a, b) => {
      const an = Number.parseInt(a.key.split(':')[1], 10) || 1;
      const bn = Number.parseInt(b.key.split(':')[1], 10) || 1;
      return an - bn;
    });
    if (out.length > 1) return out;
  }

  return [{ key: 'disc:1', label: 'Disc 1', rows: list }];
}

function _tracksSortedRows(rows) {
  const col = String(_tracksSort.col || 'track_number');
  const dir = _tracksSort.order === 'desc' ? -1 : 1;
  const out = [...(rows || [])];
  out.sort((a, b) => {
    if (col === 'track_number') {
      if (state.album) {
        const ad = _trackDiscSortValue(a);
        const bd = _trackDiscSortValue(b);
        if (ad !== bd) return (ad - bd) * dir;
      }
      const an = _trackNumberSortValue(a);
      const bn = _trackNumberSortValue(b);
      if (an !== bn) return (an - bn) * dir;
      return String(a?.title || '').localeCompare(String(b?.title || ''));
    }
    if (col === 'duration') {
      const ad = Number(a?.duration || 0);
      const bd = Number(b?.duration || 0);
      if (ad !== bd) return (ad - bd) * dir;
      return String(a?.title || '').localeCompare(String(b?.title || ''));
    }
    if (col === 'album') {
      const cmpAlbum = String(a?.album || '').localeCompare(String(b?.album || ''));
      if (cmpAlbum !== 0) return cmpAlbum * dir;
      const an = _trackNumberSortValue(a);
      const bn = _trackNumberSortValue(b);
      if (an !== bn) return an - bn;
      return String(a?.title || '').localeCompare(String(b?.title || ''));
    }
    const cmp = String(a?.title || '').localeCompare(String(b?.title || ''));
    if (cmp !== 0) return cmp * dir;
    return _trackNumberSortValue(a) - _trackNumberSortValue(b);
  });
  return out;
}

function _renderTracksTable() {
  const rows = state.tracks || [];
  const wrap = document.getElementById('tracks-table-wrap');
  const baseTable = document.getElementById('tracks-table');
  const tbody = document.getElementById('tracks-tbody');
  if (!wrap || !baseTable || !tbody) return;
  const existingMulti = document.getElementById('tracks-multi-disc-container');

  const discGroups = _buildAlbumDiscGroups(rows);
  const shouldGroupByDisc = !!(state.album && discGroups.length > 1);
  if (!shouldGroupByDisc) {
    if (existingMulti) existingMulti.remove();
    baseTable.style.display = 'table';
    tbody.innerHTML = rows.map((t, i) => trackRow(t, i + 1, false)).join('');
    document.querySelectorAll('#tracks-table .sort-arrow').forEach(el => { el.textContent = ''; });
    const arrow = document.getElementById(`tracks-sort-${_tracksSort.col}`);
    if (arrow) arrow.textContent = _tracksSort.order === 'asc' ? '▲' : '▼';
  } else {
    baseTable.style.display = 'none';
    tbody.innerHTML = '';
    if (existingMulti) existingMulti.remove();

    const headerHtml = `
      <thead><tr>
        <th class="col-num" data-col="track_number"><span class="th-sort-label">Track #</span></th>
        <th class="col-title" data-col="title"><span class="th-sort-label">Title</span></th>
        <th class="col-album" data-col="album"><span class="th-sort-label">Album</span></th>
        <th class="col-genre" data-col="genre"><span class="th-sort-label">Genre</span></th>
        <th class="col-dur" data-col="duration"><span class="th-sort-label">Time</span></th>
        <th class="col-fav" data-col="favourite"></th>
        <th class="col-act" data-col="actions"><span class="th-sort-label">Actions</span></th>
      </tr></thead>`;
    const multi = document.createElement('div');
    multi.id = 'tracks-multi-disc-container';
    multi.className = 'tracks-multi-disc-container';
    multi.innerHTML = discGroups.map((group) => {
      const bodyRows = (group.rows || [])
        .map((track, idx) => trackRow(track, idx + 1, false))
        .join('');
      return `
        <section class="tracks-disc-block">
          <h3 class="tracks-disc-heading">${esc(group.label)}</h3>
          <table class="tracks-table-disc">
            ${headerHtml}
            <tbody>${bodyRows}</tbody>
          </table>
        </section>
      `;
    }).join('');
    wrap.appendChild(multi);

    document.querySelectorAll('#tracks-table .sort-arrow').forEach(el => { el.textContent = ''; });
  }
  _applyTableColumnVisibility();
}

function sortTracks(col) {
  const key = String(col || '').trim();
  if (!key) return;
  if (_tracksSort.col === key) {
    _tracksSort.order = _tracksSort.order === 'asc' ? 'desc' : 'asc';
  } else {
    _tracksSort.col = key;
    _tracksSort.order = 'asc';
  }
  state.tracks = _tracksSortedRows(state.tracks || []);
  _renderTracksTable();
  Player.registerTracks(state.tracks);
  if (state.album) {
    Player.setPlaybackContext(state.tracks, { sourceType: 'album', sourceId: `${state.artist || ''}||${state.album}`, sourceLabel: `Album · ${state.album}` });
  } else if (state.artist) {
    Player.setPlaybackContext(state.tracks, { sourceType: 'artist', sourceId: state.artist, sourceLabel: `Artist · ${state.artist}` });
  } else {
    Player.setPlaybackContext(state.tracks, { sourceType: 'songs', sourceId: '', sourceLabel: 'Tracks' });
  }
}

function _formatTrackNumber(trackNumber, fallbackNum) {
  const raw = String(trackNumber || '').trim();
  if (!raw) return String(fallbackNum);
  const main = raw.split('/')[0].trim();
  if (!main) return String(fallbackNum);
  const parsed = Number.parseInt(main, 10);
  if (Number.isFinite(parsed) && parsed > 0) return String(parsed);
  return main;
}

/* ── Track row (library) ────────────────────────────────────────────── */
function trackRow(t, num, inPlaylist) {
  const trackNumLabel = inPlaylist ? String(num) : _formatTrackNumber(t.track_number, num);
  const isFavVirtualPlaylist = !!(inPlaylist && state.playlist?.is_favourites);
  const removeAction = inPlaylist
    ? `<button class="remove-btn" onclick="event.stopPropagation();${isFavVirtualPlaylist ? `App.removeSongFromFavourites('${t.id}')` : `App.removeFromPlaylist('${t.id}')`}" title="${isFavVirtualPlaylist ? 'Remove from favourites' : 'Remove from playlist'}">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
       </button>`
    : '';
  const addAction = inPlaylist
    ? ''
    : `<button class="add-btn" onclick="App.showAddDropdown(event, '${t.id}')" title="Add to playlist">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
       </button>`;

  const dragHandle = inPlaylist
    ? `<div class="drag-handle" title="Drag to reorder" onclick="event.stopPropagation()">
         <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg>
       </div>`
    : '';

  const checkIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><polyline points="20 6 9 17 4 12"/></svg>`;
  const playIcon  = playSvg(12);

  return `
    <tr data-id="${t.id}" ondblclick="Player.playTrackById('${t.id}')" oncontextmenu="App.showTrackCtxMenu(event,'${t.id}')">
      <td class="col-num" data-col="track_number" onclick="App.toggleTrackSelection('${t.id}', ${num - 1}, event)">
        <div class="num-cell">
          ${dragHandle}
          <span class="track-check-indicator">${checkIcon}</span>
          <span class="track-num">${esc(trackNumLabel)}</span>
        </div>
      </td>
      <td data-col="title">
        <div class="title-cell">
          <div class="thumb-wrap">
            <div class="thumb">${thumbImg(t.artwork_key, 38, '4px')}</div>
            <button class="thumb-play-btn" onclick="event.stopPropagation();Player.playTrackById('${t.id}')" title="Play">${playIcon}</button>
          </div>
          <div class="track-info">
            <div class="track-title" title="${esc(t.title)}">${esc(t.title)}</div>
            <div class="track-artist" title="${esc(t.artist)}">${esc(t.artist)}</div>
          </div>
        </div>
      </td>
      ${inPlaylist ? `<td data-col="artist" class="cell-artist" title="${esc(t.artist)}">${esc(t.artist)}</td>` : ''}
      <td data-col="album" class="cell-album" title="${esc(t.album)}">${esc(t.album)}</td>
      <td data-col="duration" class="col-dur">${esc(t.duration_fmt || '')}</td>
      ${inPlaylist ? `<td data-col="genre" class="col-genre" style="color:var(--text-muted);font-size:var(--text-sm)">${esc(t.genre || '')}</td>` : ''}
      ${inPlaylist ? `<td data-col="year" class="col-year" style="color:var(--text-muted);font-size:var(--text-sm)">${t.year || ''}</td>` : ''}
      <td data-col="favourite" class="col-fav-cell">${_favToggleBtn('songs', t.id, `track-fav-btn${inPlaylist ? '' : ''}`)}</td>
      <td data-col="actions"><div class="col-act-inner">
        ${removeAction}
        <button class="row-ctx-btn" onclick="event.stopPropagation();App.showTrackCtxMenu(event,'${t.id}')" title="More actions">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>
        <button class="track-edit-btn" onclick="event.stopPropagation();App.openTagEditor('${t.id}')" title="Edit tags">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        ${addAction}
      </div></td>
    </tr>`;
}


/* ── Playlist view ──────────────────────────────────────────────────── */
async function openPlaylist(pid) {
  if (!_guardMlGeneratorNavigation()) return;
  _pushToNavHistory();
  const pl = await api(`/playlists/${pid}`);
  state.playlist = pl;
  state.view = 'playlist';
  clearSelection();
  setActiveNav('playlist');
  renderSidebarPlaylists();
  showViewEl('playlist');


  document.getElementById('pl-name').textContent = pl.name;
  _applyPlaylistDetailMode(false);

  renderPlaylistTracks(pl.tracks);
  updatePlaylistCover(pl.tracks);
  updatePlaylistStats(pl.tracks);
  renderDapExportPills(pid);

  // Register tracks with player
  Player.registerTracks(pl.tracks);
  Player.setPlaybackContext(pl.tracks, { sourceType: 'playlist', sourceId: pl.id, sourceLabel: `Playlist · ${pl.name}` });
  const playAllBtn = document.getElementById('pl-play-all-btn');
  const shuffleBtn = document.getElementById('pl-shuffle-btn');
  if (playAllBtn) {
    playAllBtn.onclick = () => Player.playAll(pl.tracks);
    playAllBtn.style.display = pl.tracks.length ? '' : 'none';
  }
  if (shuffleBtn) {
    shuffleBtn.onclick = () => {
      Player.playCollectionShuffled(pl.tracks, `Playlist · ${pl.name}`);
    };
    shuffleBtn.style.display = pl.tracks.length ? '' : 'none';
  }
}

function _applyPlaylistDetailMode(isFavouriteVirtual) {
  const delBtn = document.getElementById('pl-toolbar-delete-btn');
  const renameBtn = document.getElementById('pl-rename-btn');
  const moreBtn = document.getElementById('pl-more-btn');
  const coverWrap = document.querySelector('.playlist-cover-wrap');
  const removeBtn = document.getElementById('pl-cover-remove');
  const fileInput = document.getElementById('artwork-file-input');
  const nameEl = document.getElementById('pl-name');
  if (delBtn) delBtn.style.display = isFavouriteVirtual ? 'none' : '';
  if (renameBtn) renameBtn.style.display = isFavouriteVirtual ? 'none' : '';
  if (moreBtn) moreBtn.style.display = isFavouriteVirtual ? 'none' : '';
  if (removeBtn) removeBtn.style.display = isFavouriteVirtual ? 'none' : removeBtn.style.display;
  if (fileInput) fileInput.disabled = !!isFavouriteVirtual;
  if (coverWrap) {
    coverWrap.style.pointerEvents = isFavouriteVirtual ? 'none' : '';
    coverWrap.title = isFavouriteVirtual ? 'Favourite Songs cover' : 'Click to set cover art';
  }
  if (nameEl) {
    nameEl.contentEditable = isFavouriteVirtual ? 'false' : 'true';
  }
}

async function openFavouriteSongsPlaylist() {
  if (!_guardMlGeneratorNavigation()) return;
  _pushToNavHistory();
  const res = await api('/favourites/songs/tracks').catch(() => ({ tracks: [] }));
  const tracks = Array.isArray(res?.tracks) ? res.tracks : [];
  const pl = {
    id: '__favourite_songs__',
    name: 'Favourite Songs',
    tracks,
    is_favourites: true,
    created_at: 0,
    updated_at: Math.max(0, ...((state.favouritesMeta.songs || []).map(r => Number(r.added_at || 0)))),
  };
  state.playlist = pl;
  state.view = 'playlist';
  clearSelection();
  setActiveNav('favourites');
  renderSidebarPlaylists();
  showViewEl('playlist');


  document.getElementById('pl-name').textContent = pl.name;
  _applyPlaylistDetailMode(true);
  renderPlaylistTracks(pl.tracks);
  const cover = document.getElementById('pl-cover');
  if (cover) {
    cover.className = 'playlist-cover playlist-cover-single';
    cover.innerHTML = `<img src="${_FAV_PLAYLIST_COVER}" style="width:100%;height:100%;object-fit:cover;border-radius:8px" />`;
  }
  updatePlaylistStats(pl.tracks);
  renderDapExportPills(pl.id);

  Player.registerTracks(pl.tracks);
  Player.setPlaybackContext(pl.tracks, { sourceType: 'playlist', sourceId: pl.id, sourceLabel: 'Playlist · Favourite Songs' });
  const favPlayBtn = document.getElementById('pl-play-all-btn');
  const favShuffleBtn = document.getElementById('pl-shuffle-btn');
  if (favPlayBtn) {
    favPlayBtn.onclick = () => Player.playAll(pl.tracks);
    favPlayBtn.style.display = pl.tracks.length ? '' : 'none';
  }
  if (favShuffleBtn) {
    favShuffleBtn.onclick = () => {
      Player.playCollectionShuffled(pl.tracks, 'Playlist · Favourite Songs');
    };
    favShuffleBtn.style.display = pl.tracks.length ? '' : 'none';
  }
}

async function renderDapExportPills(pid) {
  const container = document.getElementById('dap-export-pills');
  if (!container) return;
  const isFavVirtual = state.playlist?.is_favourites || pid === '__favourite_songs__';

  const daps = await api('/daps').catch(() => []);
  const connected = daps.filter(d => d.mounted);
  if (!connected.length) {
    container.innerHTML = '';
    return;
  }

  const svgDevice = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18" stroke-width="3"/></svg>`;
  const latestFavAt = Math.max(0, ...((state.favouritesMeta.songs || []).map(r => Number(r.added_at || 0))));
  const favExports = state.favouritesMeta.dap_exports || {};
  container.innerHTML = connected.map(dap => {
    const isFavUpToDate = Number(favExports[dap.id] || 0) >= latestFavAt && latestFavAt > 0;
    const label = isFavVirtual
      ? (isFavUpToDate ? `Copy to ${dap.name} (up to date)` : `Copy to ${dap.name}`)
      : `Copy to ${dap.name}`;
    const isBusy = _playlistDapExportBusyDid === String(dap.id);
    const disabled = !!_playlistDapExportBusyDid;
    return `
      <button
        class="btn-export btn-export-device${isBusy ? ' is-busy' : ''}"
        data-dap-id="${esc(dap.id)}"
        data-default-label="${esc(label)}"
        ${disabled ? 'disabled' : ''}
        onclick="${isFavVirtual ? `App.copyFavSongsToDap('${dap.id}', this)` : `App.pickConnectedDapExport('${dap.id}', this)`}"
      >
        ${svgDevice}
        <span class="dap-export-label">${esc(label)}</span>
      </button>
    `;
  }).join('');
  if (_playlistDapExportBusyDid) _startPlaylistDapExportTicker();
}

function togglePlaylistDapMenu() {
  const menu = document.getElementById('pl-dap-export-menu');
  if (!menu) return;
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function closePlaylistDapMenu() {
  const menu = document.getElementById('pl-dap-export-menu');
  if (menu) menu.style.display = 'none';
}

async function pickConnectedDapExport(did) {
  closePlaylistDapMenu();
  await exportToDeviceDap(did);
}

let _playlistDapExportBusyDid = null;
let _playlistDapExportStartedAt = 0;
let _playlistDapExportTicker = null;

function _stopPlaylistDapExportTicker() {
  if (_playlistDapExportTicker) {
    clearInterval(_playlistDapExportTicker);
    _playlistDapExportTicker = null;
  }
}

function _updatePlaylistDapExportProgressLabel() {
  if (!_playlistDapExportBusyDid) return;
  const container = document.getElementById('dap-export-pills');
  if (!container) return;
  const btn = container.querySelector(`.btn-export-device[data-dap-id="${_playlistDapExportBusyDid}"]`);
  if (!btn) return;
  const labelEl = btn.querySelector('.dap-export-label');
  if (!labelEl) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - _playlistDapExportStartedAt) / 1000));
  labelEl.textContent = `Copying… ${elapsed}s`;
}

function _startPlaylistDapExportTicker() {
  _stopPlaylistDapExportTicker();
  _updatePlaylistDapExportProgressLabel();
  _playlistDapExportTicker = setInterval(_updatePlaylistDapExportProgressLabel, 1000);
}

function _setPlaylistDapExportBusy(did, busy) {
  const busyDid = busy ? String(did || '') : null;
  _playlistDapExportBusyDid = busyDid;
  _playlistDapExportStartedAt = busy ? Date.now() : 0;

  const container = document.getElementById('dap-export-pills');
  if (!container) {
    if (busy) _startPlaylistDapExportTicker();
    else _stopPlaylistDapExportTicker();
    return;
  }

  container.querySelectorAll('.btn-export-device[data-dap-id]').forEach((btn) => {
    const btnDid = String(btn.getAttribute('data-dap-id') || '');
    const labelEl = btn.querySelector('.dap-export-label');
    const defaultLabel = String(btn.getAttribute('data-default-label') || '').trim();
    if (busyDid) {
      btn.disabled = true;
      btn.classList.toggle('is-busy', btnDid === busyDid);
      if (btnDid !== busyDid && labelEl && defaultLabel) labelEl.textContent = defaultLabel;
    } else {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      if (labelEl && defaultLabel) labelEl.textContent = defaultLabel;
    }
  });

  if (busyDid) _startPlaylistDapExportTicker();
  else _stopPlaylistDapExportTicker();
}

/* ── Hero / playlist toolbar helpers ───────────────────────────────── */
function toggleHeroMore(which) {
  const menu = document.getElementById(`${which}-hero-more-menu`);
  if (!menu) return;
  const isOpen = menu.classList.contains('open');
  // close all hero menus first
  document.querySelectorAll('.hero-more-menu.open').forEach(m => m.classList.remove('open'));
  if (!isOpen) menu.classList.add('open');
}

function togglePlMoreMenu() {
  const menu = document.getElementById('pl-more-menu');
  if (!menu) return;
  const isOpen = menu.style.display !== 'none';
  menu.style.display = isOpen ? 'none' : 'block';
}

function focusPlaylistName() {
  const el = document.getElementById('pl-name');
  if (!el) return;
  el.focus();
  // move cursor to end
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function _getDisplayedTracks() {
  let tracks = state.playlist?.tracks || [];
  // Apply filter
  const q = state.plFilter.toLowerCase().trim();
  if (q) {
    tracks = tracks.filter(t =>
      (t.title || '').toLowerCase().includes(q) ||
      (t.artist || '').toLowerCase().includes(q) ||
      (t.album || '').toLowerCase().includes(q)
    );
  }
  // Apply sort
  if (state.plSortMode === 'az') {
    tracks = [...tracks].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  } else if (state.plSortMode === 'album') {
    tracks = [...tracks].sort((a, b) => {
      const ac = (a.album || '').localeCompare(b.album || '');
      if (ac !== 0) return ac;
      return (a.track_number || 0) - (b.track_number || 0);
    });
  } else if (state.plSortMode === 'year') {
    tracks = [...tracks].sort((a, b) =>
      state.plSortDir === 'asc'
        ? (a.year || 0) - (b.year || 0)
        : (b.year || 0) - (a.year || 0)
    );
  }
  return tracks;
}

function renderPlaylistTracks(tracks) {
  if (tracks && tracks.length) {
    Player.registerTracks(tracks);
    Player.setPlaybackContext(tracks, {
      sourceType: 'playlist',
      sourceId: state.playlist?.id || '',
      sourceLabel: `Playlist · ${state.playlist?.name || 'Current'}`,
    });
  }
  const tbody = document.getElementById('pl-tbody');
  const table = document.getElementById('pl-table');
  const empty = document.getElementById('pl-empty');

  const displayed = _getDisplayedTracks();
  const isFiltered = state.plFilter.trim().length > 0;
  const isSorted = state.plSortMode !== 'original';
  const isDragEnabled = !isFiltered && !isSorted;
  const totalTracks = (state.playlist?.tracks || []).length;
  const emptyTitleEl = empty ? empty.querySelector('p') : null;
  const emptySubEl = empty ? empty.querySelector('p.muted') : null;

  if (emptyTitleEl && emptySubEl) {
    if (state.playlist?.is_favourites) {
      if (isFiltered && totalTracks > 0) {
        emptyTitleEl.textContent = 'No songs match this filter.';
        emptySubEl.textContent = 'Try a different search or clear the filter.';
      } else {
        emptyTitleEl.textContent = 'No favourite songs yet.';
        emptySubEl.textContent = 'Add songs to Favourites and they will show up here.';
      }
    } else if (isFiltered && totalTracks > 0) {
      emptyTitleEl.textContent = 'No songs match this filter.';
      emptySubEl.textContent = 'Try a different search or clear the filter.';
    } else {
      emptyTitleEl.textContent = 'This playlist is empty.';
      emptySubEl.innerHTML = 'Browse the library and click <strong>+</strong> to add songs.';
    }
  }

  // Update filter count in stats if filtering
  if (isFiltered) {
    const info = document.getElementById('pl-filter-info');
    if (info) info.textContent = `${displayed.length} of ${(state.playlist?.tracks || []).length} songs`;
  }

  if (!displayed.length) {
    table.style.display = 'none';
    empty.style.display = 'flex';
    tbody.innerHTML = '';
    return;
  }

  table.style.display = 'table';
  empty.style.display = 'none';
  tbody.innerHTML = displayed.map((t, i) => trackRow(t, i + 1, true)).join('');
  _applyTableColumnVisibility();

  // Toggle drag handles
  tbody.classList.toggle('pl-sort-drag-disabled', !isDragEnabled);

  // Re-init drag-and-drop (only in original+unfiltered mode)
  if (state.sortable) state.sortable.destroy();
  if (isDragEnabled) {
    state.sortable = new Sortable(tbody, {
      animation: 150,
      handle: '.drag-handle',
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onEnd: async () => {
        const rows = Array.from(tbody.querySelectorAll('tr'));
        const ids = rows.map(r => r.dataset.id);
        await api(`/playlists/${state.playlist.id}`, {
          method: 'PUT',
          body: { tracks: ids },
        });
        rows.forEach((r, i) => {
          const numEl = r.querySelector('.track-num');
          if (numEl) numEl.textContent = i + 1;
        });
        state.playlist.tracks = ids.map(id => state.playlist.tracks.find(t => t.id === id)).filter(Boolean);
      },
    });
  } else {
    state.sortable = null;
  }
}

const _debouncedRenderPlaylistTracks = _debounce(() => renderPlaylistTracks(state.playlist?.tracks || []), 200);
function filterPlaylist(query) {
  state.plFilter = query;
  const clearBtn = document.getElementById('pl-filter-clear');
  if (clearBtn) clearBtn.style.display = query ? 'block' : 'none';
  _debouncedRenderPlaylistTracks();
}

function clearPlaylistFilter() {
  state.plFilter = '';
  const input = document.getElementById('pl-filter-input');
  if (input) input.value = '';
  const clearBtn = document.getElementById('pl-filter-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  renderPlaylistTracks(state.playlist?.tracks || []);
}

function setPlaylistInSort(mode) {
  if (mode === 'year' && state.plSortMode === 'year') {
    // Toggle direction on second click
    state.plSortDir = state.plSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.plSortDir = 'asc';
  }
  state.plSortMode = mode;
  // Update pill active state
  document.querySelectorAll('.pl-sort-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sort === mode);
  });
  // Update year direction indicator
  const dirEl = document.getElementById('pl-sort-year-dir');
  if (dirEl) dirEl.textContent = mode === 'year' ? (state.plSortDir === 'asc' ? '↑' : '↓') : '';
  renderPlaylistTracks(state.playlist?.tracks || []);
}

/* ── Multi-select ───────────────────────────────────────────────────── */
function _getCurrentViewTrackList() {
  if (state.view === 'tracks') return state.tracks;
  if (state.view === 'playlist') return _getDisplayedTracks();
  if (state.view === 'songs') return _getSongsFilteredTracks();
  return [];
}

function _getSelectedTracksInCurrentView() {
  if (!state.selectedTrackIds.size) return [];
  const tracks = _getCurrentViewTrackList() || [];
  if (!tracks.length) return [];
  const byId = new Map(tracks.map((t) => [String(t.id), t]));
  return [...state.selectedTrackIds]
    .map((id) => byId.get(String(id)))
    .filter(Boolean);
}

function toggleTrackSelection(id, idx, event) {
  event.stopPropagation();
  if (event.shiftKey && state.lastSelectedIdx !== null) {
    const tracks = _getCurrentViewTrackList();
    const min = Math.min(idx, state.lastSelectedIdx);
    const max = Math.max(idx, state.lastSelectedIdx);
    for (let i = min; i <= max; i++) {
      if (tracks[i]) state.selectedTrackIds.add(tracks[i].id);
    }
  } else {
    if (state.selectedTrackIds.has(id)) {
      state.selectedTrackIds.delete(id);
    } else {
      state.selectedTrackIds.add(id);
    }
    state.lastSelectedIdx = idx;
  }
  updateSelectionUI();
}

function updateSelectionUI() {
  const count = state.selectedTrackIds.size;
  const bar = document.getElementById('bulk-bar');
  const countEl = document.getElementById('bulk-count');
  const removeBtn = document.getElementById('bulk-remove-btn');
  const addBtn = document.getElementById('bulk-add-btn');
  const favBtn = document.getElementById('bulk-fav-btn');
  const unfavBtn = document.getElementById('bulk-unfav-btn');

  countEl.textContent = `${count} song${count !== 1 ? 's' : ''} selected`;
  bar.classList.toggle('visible', count > 0);
  if (removeBtn) removeBtn.style.display = state.view === 'playlist' && count > 0 ? 'inline-flex' : 'none';
  if (favBtn) favBtn.style.display = count > 0 ? 'inline-flex' : 'none';
  if (unfavBtn) unfavBtn.style.display = count > 0 ? 'inline-flex' : 'none';

  // Wire add button each time (event could differ)
  if (addBtn) {
    addBtn.onclick = (e) => {
      e.stopPropagation();
      showPlaylistPicker(e.currentTarget, [...state.selectedTrackIds]);
    };
  }

  // Update row visual states across all track tables
  ['tracks-tbody', 'search-tbody', 'songs-tbody', 'pl-tbody'].forEach(tbodyId => {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    tbody.classList.toggle('has-selection', count > 0);
    tbody.querySelectorAll('tr[data-id]').forEach(tr => {
      tr.classList.toggle('track-selected', state.selectedTrackIds.has(tr.dataset.id));
    });
  });
}

function clearSelection() {
  state.selectedTrackIds.clear();
  state.lastSelectedIdx = null;
  updateSelectionUI();
}

async function removeSelectedFromPlaylist() {
  if (state.view !== 'playlist' || !state.playlist || state.playlist?.is_favourites) return;
  const ids = [...state.selectedTrackIds];
  if (!ids.length) return;
  await _removeTracksFromCurrentPlaylist(ids, {
    toastText: `Removed ${ids.length} song${ids.length !== 1 ? 's' : ''} from playlist`,
  });
}

function updatePlaylistCover(tracks) {
  const cover = document.getElementById('pl-cover');
  const removeBtn = document.getElementById('pl-cover-remove');

  // Custom artwork takes priority
  if (state.playlist && state.playlist.has_artwork) {
    cover.className = 'playlist-cover playlist-cover-single';
    cover.innerHTML = `<img src="/api/playlists/${state.playlist.id}/artwork?t=${Date.now()}" style="width:100%;height:100%;object-fit:cover;border-radius:8px" />`;
    if (removeBtn) removeBtn.style.display = 'flex';
    return;
  }

  if (removeBtn) removeBtn.style.display = 'none';

  const keys = [...new Set(tracks.map(t => t.artwork_key).filter(Boolean))].slice(0, 4);

  if (!keys.length) {
    cover.className = 'playlist-cover';
    cover.innerHTML = coverPlaceholder('playlist', 56, '8px', true);
    return;
  }

  if (keys.length === 1) {
    cover.className = 'playlist-cover playlist-cover-single';
    cover.innerHTML = `<img src="${artworkUrl(keys[0])}" style="width:100%;height:100%;object-fit:cover;border-radius:8px" />`;
  } else {
    cover.className = 'playlist-cover';
    cover.innerHTML = keys.map(k => `<img src="${artworkUrl(k)}" />`).join('');
  }
}

/* ── Playlist artwork upload ─────────────────────────────────────────── */
function triggerArtworkUpload() {
  document.getElementById('artwork-file-input').click();
}

async function handleArtworkFile(input) {
  const file = input.files[0];
  if (!file || !state.playlist) return;
  input.value = '';  // reset so same file can be re-selected

  const form = new FormData();
  form.append('file', file);
  try {
    const res = await fetch(`/api/playlists/${state.playlist.id}/artwork`, { method: 'POST', body: form });
    const data = await res.json();
    if (data.ok) {
      state.playlist.has_artwork = true;
      updatePlaylistCover(state.playlist.tracks || []);
      loadPlaylists();  // refresh has_artwork + artwork_keys in list view
      toast('Cover art updated');
    }
  } catch (e) {
    toast('Failed to upload cover art');
  }
}

async function removePlaylistArtwork(e) {
  e.stopPropagation();  // don't trigger upload overlay
  if (!state.playlist) return;
  await api(`/playlists/${state.playlist.id}/artwork`, { method: 'DELETE' });
  state.playlist.has_artwork = false;
  updatePlaylistCover(state.playlist.tracks || []);
  loadPlaylists();  // refresh has_artwork in list view
  toast('Cover art removed');
}

function downloadPlaylistArtwork() {
  if (!state.playlist || !state.playlist.has_artwork) return;
  const a = document.createElement('a');
  a.href = `/api/playlists/${state.playlist.id}/artwork/download`;
  a.click();
}

function updatePlaylistStats(tracks) {
  const total = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const timeStr = h > 0 ? `${h} hr ${m} min` : `${m} min`;
  document.getElementById('pl-stats').textContent =
    `${tracks.length} song${tracks.length !== 1 ? 's' : ''} · ${timeStr}`;
}

// checkDevices() removed — device status is now embedded in the DAP list
// (GET /api/daps returns mounted:true/false per DAP)

/* ── Playlist picker (shared by all add-to entry points) ─────────────── */
function _sortedPlaylists() {
  // Most recently used first, then by creation date descending
  return [...state.playlists].sort((a, b) => {
    if (a.id === state.lastUsedPlaylistId) return -1;
    if (b.id === state.lastUsedPlaylistId) return 1;
    return (b.created_at || 0) - (a.created_at || 0);
  });
}

function _positionDropdown(anchorEl) {
  const dd = document.getElementById('add-dropdown');
  const rect = anchorEl.getBoundingClientRect();
  dd.style.left = '-9999px';
  dd.style.top  = '-9999px';
  dd.style.display = 'block';
  requestAnimationFrame(() => {
    const ddW = dd.offsetWidth;
    const ddH = dd.offsetHeight;
    const vw  = window.innerWidth;
    const vh  = window.innerHeight;
    const gap = 6;
    const pad = 8;
    // Horizontal: right-align to anchor, clamped to viewport
    let left = rect.right - ddW;
    if (left < pad) left = pad;
    if (left + ddW > vw - pad) left = vw - ddW - pad;
    // Vertical: prefer below, flip above if not enough room, always clamp
    let top = rect.bottom + gap;
    if (top + ddH > vh - pad) top = rect.top - ddH - gap;
    if (top < pad) top = pad;
    dd.style.left = left + 'px';
    dd.style.top  = top  + 'px';
  });
}

function showPlaylistPicker(anchorEl, trackIds) {
  state._pendingTrackIds = trackIds;
  const items = document.getElementById('dropdown-items');
  const sorted = _sortedPlaylists();

  if (!sorted.length) {
    items.innerHTML = `<div class="dropdown-item" onclick="App.createPlaylistAndAdd()">+ Create new playlist</div>`;
  } else {
    const playlistIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    const recentIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="opacity:.5;flex-shrink:0"><polyline points="12 8 12 12 14 14"/><circle cx="12" cy="12" r="10"/></svg>`;
    items.innerHTML = sorted.map((pl, i) => {
      const isRecent = pl.id === state.lastUsedPlaylistId;
      return `<div class="dropdown-item" onclick="App._commitToPlaylist('${pl.id}','${pl.name.replace(/'/g, "\\'")}')">
        ${playlistIcon}
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pl.name)}</span>
        ${isRecent ? recentIcon : ''}
      </div>`;
    }).join('') +
    `<div class="dropdown-item" style="border-top:1px solid var(--border);margin-top:4px" onclick="App.createPlaylistAndAdd()">+ Create new playlist</div>`;
  }

  _positionDropdown(anchorEl);
}

function hideDropdown() {
  document.getElementById('add-dropdown').style.display = 'none';
}

// Single shared commit handler — works for 1 track or many
async function _commitToPlaylist(pid, plName) {
  hideDropdown();
  const trackIds = state._pendingTrackIds;
  if (!trackIds.length) return;
  try {
    const res = await api(`/playlists/${pid}/tracks`, {
      method: 'POST',
      body: { track_ids: trackIds },
    });
    if (res.duplicates?.length) {
      await showDupDialog(res, pid, plName);
      return;
    }
    state.lastUsedPlaylistId = pid;
    const n = res.added;
    toast(n === 1 ? `Added to "${plName}"` : `Added ${n} songs to "${plName}"`);
    loadPlaylists();  // refresh track_count + artwork_keys in list view (non-blocking)
    if (state.playlist?.id === pid) await openPlaylist(pid);
  } catch (e) {
    toast('Could not add to playlist. Try again.');
  }
}

function showAddDropdown(event, trackId) {
  event.stopPropagation();
  showPlaylistPicker(event.currentTarget, [trackId]);
}

/* ── Right-click context menu ───────────────────────────────────────── */
function _showCtxMenu(x, y, tracks, label, favTarget = null) {
  _ctxTracks = tracks;
  _ctxFavTarget = favTarget;
  const menu = document.getElementById('ctx-menu');
  const labelEl = document.getElementById('ctx-label');
  const smartLabel = document.getElementById('ctx-smart-playlist-label');
  const favItem = document.getElementById('ctx-favourite-item');
  const favLabel = document.getElementById('ctx-favourite-label');
  const removeItem = document.getElementById('ctx-remove-from-playlist-item');
  const removeLabel = document.getElementById('ctx-remove-from-playlist-label');
  if (labelEl) labelEl.textContent = label || (tracks.length === 1 ? tracks[0].title : `${tracks.length} songs`);
  if (smartLabel) {
    smartLabel.textContent = tracks.length === 1
      ? 'Create Smart Playlist from This Song'
      : `Create Smart Playlist from ${tracks.length} Songs`;
  }
  if (favItem && favLabel) {
    if (!favTarget?.id || !favTarget?.type) {
      favItem.style.display = 'none';
    } else {
      favItem.style.display = '';
      favLabel.textContent = _isFavourite(favTarget.type, favTarget.id)
        ? 'Remove from Favourites'
        : 'Add to Favourites';
    }
  }
  if (removeItem && removeLabel) {
    const canRemove = state.view === 'playlist' && !!state.playlist && !state.playlist?.is_favourites && tracks.length > 0;
    removeItem.style.display = canRemove ? '' : 'none';
    if (canRemove) {
      removeLabel.textContent = tracks.length === 1
        ? 'Remove from Playlist'
        : `Remove ${tracks.length} from Playlist`;
    }
  }
  menu.style.display = 'block';
  menu.style.left = '-9999px';
  menu.style.top  = '-9999px';
  requestAnimationFrame(() => {
    const w  = menu.offsetWidth, h  = menu.offsetHeight;
    const vw = window.innerWidth,  vh = window.innerHeight;
    const pad = 8;
    let left = x + 4, top = y + 4;
    if (left + w > vw - pad) left = x - w - 4;
    if (left < pad)           left = pad;
    if (top  + h > vh - pad)  top  = y - h - 4;
    if (top  < pad)           top  = pad;
    menu.style.left = left + 'px';
    menu.style.top  = top  + 'px';
  });
}

function hideCtxMenu() {
  const menu = document.getElementById('ctx-menu');
  if (menu) menu.style.display = 'none';
  closeCtxSubmenu();
  clearTimeout(_ctxSubmenuTimer);
  _ctxTracks = [];
  _ctxFavTarget = null;
  _ctxDetailMode = null;
  const editAlbumItem = document.getElementById('ctx-edit-album-tags-item');
  const editArtistItem = document.getElementById('ctx-rename-artist-item');
  const removeItem = document.getElementById('ctx-remove-from-playlist-item');
  if (editAlbumItem) editAlbumItem.style.display = 'none';
  if (editArtistItem) editArtistItem.style.display = 'none';
  if (removeItem) removeItem.style.display = 'none';
}

function showTrackCtxMenu(e, trackId) {
  e.preventDefault();
  e.stopPropagation();
  hideDropdown();
  const id = String(trackId || '');
  const selectedTracks = _getSelectedTracksInCurrentView();
  const clickedIsSelected = state.selectedTrackIds.has(id);

  if (selectedTracks.length > 1 && clickedIsSelected) {
    _showCtxMenu(
      e.clientX,
      e.clientY,
      selectedTracks,
      `${selectedTracks.length} songs selected`
    );
    return;
  }

  if (selectedTracks.length && !clickedIsSelected) {
    state.selectedTrackIds.clear();
    state.selectedTrackIds.add(id);
    state.lastSelectedIdx = null;
    updateSelectionUI();
  }

  const track = Player.getTrack(id);
  if (!track) return;
  _showCtxMenu(e.clientX, e.clientY, [track], track.title, { type: 'songs', id });
}

async function playArtistCard(artistName) {
  try {
    const tracks = await api(`/library/tracks?artist=${encodeURIComponent(artistName)}`);
    if (tracks && tracks.length) Player.playAll(tracks);
  } catch (_) {}
}

async function showArtistCtxMenu(e, artistName) {
  e.preventDefault();
  e.stopPropagation();
  hideDropdown();
  try {
    const tracks = await api(`/library/tracks?artist=${encodeURIComponent(artistName)}`);
    _showCtxMenu(e.clientX, e.clientY, tracks,
      `${artistName} · ${tracks.length} song${tracks.length !== 1 ? 's' : ''}`,
      { type: 'artists', id: _normArtistId(artistName) });
  } catch (_) {}
}

async function showAlbumCtxMenu(e, artist, album) {
  e.preventDefault();
  e.stopPropagation();
  hideDropdown();
  try {
    const tracks = await api(`/library/tracks?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`);
    const artworkKey = tracks[0]?.artwork_key || '';
    _showCtxMenu(e.clientX, e.clientY, tracks,
      `${album} · ${tracks.length} song${tracks.length !== 1 ? 's' : ''}`,
      artworkKey ? { type: 'albums', id: artworkKey } : null);
  } catch (_) {}
}

function _ctxAnchorEvent(e) {
  const anchor = e?.currentTarget || e?.target || null;
  const rect = anchor?.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  const x = rect ? Math.round(rect.left + rect.width / 2) : (e?.clientX ?? Math.round(window.innerWidth / 2));
  const y = rect ? Math.round(rect.bottom - 2) : (e?.clientY ?? Math.round(window.innerHeight / 2));
  return {
    clientX: x,
    clientY: y,
    preventDefault() {},
    stopPropagation() {},
  };
}

async function showArtistDetailCtxMenu(e, artistName = null) {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  const artist = artistName || state.artist || document.getElementById('artist-hero-name')?.textContent || '';
  if (!artist) return;
  await showArtistCtxMenu(_ctxAnchorEvent(e), artist);
  _ctxDetailMode = 'artist';
  const editArtistItem = document.getElementById('ctx-rename-artist-item');
  if (editArtistItem) editArtistItem.style.display = '';
}

async function showAlbumDetailCtxMenu(e, artistName = null, albumName = null) {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  const artist = artistName || state.artist || null;
  const album = albumName || state.album || document.getElementById('album-hero-name')?.textContent || null;
  if (!artist || !album) return;
  await showAlbumCtxMenu(_ctxAnchorEvent(e), artist, album);
  _ctxDetailMode = 'album';
  const editAlbumItem = document.getElementById('ctx-edit-album-tags-item');
  if (editAlbumItem) editAlbumItem.style.display = '';
}

function ctxPlayNext() {
  const tracks = _ctxTracks.slice();
  hideCtxMenu();
  if (!tracks.length) return;
  Player.playNext(tracks);
}

function ctxAddToQueue() {
  const tracks = _ctxTracks.slice();
  hideCtxMenu();
  if (!tracks.length) return;
  Player.addToQueue(tracks);
}

function ctxCreateSmartPlaylist() {
  const refs = _ctxTracks.slice(0, _ML_MAX_REF_TRACKS).map(t => t.id).filter(Boolean);
  hideCtxMenu();
  if (!refs.length) return;
  openMlPlaylistGenerator('global', { referenceTrackIds: refs, preferredMode: 'seed' });
}

async function ctxToggleFavourite() {
  const target = _ctxFavTarget;
  hideCtxMenu();
  if (!target?.type || !target?.id) return;
  await toggleFavourite(target.type, encodeURIComponent(target.id));
}

function ctxEditAlbumTags() {
  hideCtxMenu();
  openAlbumTagEditor();
}

function ctxRenameArtist() {
  hideCtxMenu();
  openArtistRename();
}

function ctxAddToPlaylist(e) {
  // Legacy path — now handled by submenu; kept as fallback
  openCtxSubmenu(e);
}

async function ctxRemoveFromPlaylist() {
  const ids = _ctxTracks.map(t => String(t?.id || '')).filter(Boolean);
  hideCtxMenu();
  if (!ids.length || !state.playlist || state.playlist?.is_favourites) return;
  await _removeTracksFromCurrentPlaylist(ids, {
    toastText: ids.length === 1
      ? 'Removed from playlist'
      : `Removed ${ids.length} songs from playlist`,
  });
}

let _ctxSubmenuTimer = null;

function openCtxSubmenu(e) {
  clearTimeout(_ctxSubmenuTimer);
  if (!_ctxTracks.length) return;

  const sub  = document.getElementById('ctx-submenu');
  const list = document.getElementById('ctx-submenu-list');
  const item = document.getElementById('ctx-playlist-item');
  if (!sub || !list) return;

  // Highlight parent item
  item && item.classList.add('active');

  // Build playlist list
  const pls = [...state.playlists].sort((a, b) => {
    if (a.id === state.lastUsedPlaylistId) return -1;
    if (b.id === state.lastUsedPlaylistId) return  1;
    return a.name.localeCompare(b.name);
  });

  const newIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  const noteIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;

  list.innerHTML =
    `<div class="ctx-item" onclick="App._ctxNewPlaylistAndAdd()">${newIcon} New Playlist</div>` +
    `<div class="ctx-sep"></div>` +
    pls.map(pl => `<div class="ctx-item" onclick="App._ctxPickPlaylist('${pl.id}','${pl.name.replace(/'/g,"\\'")}')">${noteIcon} ${esc(pl.name)}</div>`).join('');

  // Position: right of parent item, aligned to its top
  const menuEl = document.getElementById('ctx-menu');
  const menuRect = menuEl.getBoundingClientRect();
  sub.style.display = 'block';
  sub.style.left = '-9999px';
  sub.style.top  = '-9999px';

  requestAnimationFrame(() => {
    const sw = sub.offsetWidth, sh = sub.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    const pad = 8;
    let left = menuRect.right + 4;
    let top  = menuRect.top;
    if (left + sw > vw - pad) left = menuRect.left - sw - 4;
    if (left < pad) left = pad;
    if (top  + sh > vh - pad) top = vh - sh - pad;
    if (top  < pad) top = pad;
    sub.style.left = left + 'px';
    sub.style.top  = top  + 'px';
  });
}

function closeCtxSubmenu() {
  const sub  = document.getElementById('ctx-submenu');
  const item = document.getElementById('ctx-playlist-item');
  if (sub)  sub.style.display = 'none';
  if (item) item.classList.remove('active');
}

function _ctxSubmenuLeaveItem(e) {
  // Start timer — cancel if mouse enters submenu
  _ctxSubmenuTimer = setTimeout(() => closeCtxSubmenu(), 150);
}
function _ctxSubmenuEnter() {
  clearTimeout(_ctxSubmenuTimer);
}
function _ctxSubmenuLeave() {
  _ctxSubmenuTimer = setTimeout(() => closeCtxSubmenu(), 120);
}

async function _ctxPickPlaylist(pid, plName) {
  const ids = _ctxTracks.map(t => t.id);
  hideCtxMenu();
  closeCtxSubmenu();
  if (!ids.length) return;
  state._pendingTrackIds = ids;
  await _commitToPlaylist(pid, plName);
}

async function _ctxNewPlaylistAndAdd() {
  const ids = _ctxTracks.map(t => t.id);
  hideCtxMenu();
  closeCtxSubmenu();
  if (!ids.length) return;
  showCreatePlaylistModal(ids);
}

// Keep for backward compat (duplicate dialog "Add Anyway" path uses this)
async function addToPlaylist(pid, plName) {
  state._pendingTrackIds = state._pendingTrackIds.length ? state._pendingTrackIds : [state.activeTrackId];
  await _commitToPlaylist(pid, plName);
}

async function addAllToPlaylist(trackIds, anchorEl) {
  if (!state.playlists.length) {
    state._pendingTrackIds = trackIds;
    showCreatePlaylistModal(trackIds);
    return;
  }
  const anchor = anchorEl || document.getElementById('album-hero-more') || document.getElementById('artist-hero-more') || document.getElementById('add-all-btn');
  showPlaylistPicker(anchor, trackIds);
}

// Kept for backward compat
async function addAllToSpecificPlaylist(pid, plName) {
  await _commitToPlaylist(pid, plName);
}

/* ── Quick-add helpers (artist / album cards) ───────────────────────── */
async function addAllArtistSongs(artistName, event) {
  const anchor = (event && event.currentTarget) || document.getElementById('artist-hero-more') || document.getElementById('artist-hero-add');
  const tracks = await api(`/library/tracks?artist=${encodeURIComponent(artistName)}`);
  if (!tracks.length) { toast('No tracks found'); return; }
  await addAllToPlaylist(tracks.map(t => t.id), anchor);
}

async function addAlbumToPlaylist(artist, album, event) {
  const anchor = (event && event.currentTarget) || document.getElementById('album-hero-more') || document.getElementById('add-all-btn');
  const tracks = await api(`/library/tracks?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`);
  if (!tracks.length) { toast('No tracks found'); return; }
  await addAllToPlaylist(tracks.map(t => t.id), anchor);
}

async function playAlbum(artist, album) {
  const tracks = await api(`/library/tracks?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`);
  if (!tracks || !tracks.length) { toast('No tracks found'); return; }
  Player.playAll(tracks);
}

/* ── Duplicate dialog ───────────────────────────────────────────────── */
let _dupResolve = null;
let _dupContext = null;

function showDupDialog(res, pid, plName) {
  return new Promise((resolve) => {
    _dupResolve = resolve;
    _dupContext = { pid, plName, dups: res.duplicates, newCount: res.new_count, newIds: res.new_ids };

    const { dups, newCount } = _dupContext;
    const isSingle = dups.length === 1 && newCount === 0;
    const hasMixed = newCount > 0;

    document.getElementById('dup-modal-title').textContent =
      dups.length === 1 ? 'Already in Playlist' : `${dups.length} Duplicates Found`;

    const trackLabel = dups.length === 1
      ? `"${dups[0].title}" by ${dups[0].artist}`
      : `${dups.length} song${dups.length !== 1 ? 's' : ''}`;

    document.getElementById('dup-modal-msg').textContent = hasMixed
      ? `${trackLabel} ${dups.length === 1 ? 'is' : 'are'} already in "${plName}". ${newCount} new song${newCount !== 1 ? 's' : ''} will be added if you skip duplicates.`
      : `${trackLabel} ${dups.length === 1 ? 'is' : 'are'} already in "${plName}".`;

    // Show up to 5 duplicate titles
    const shown = dups.slice(0, 5);
    document.getElementById('dup-modal-list').innerHTML = shown.map(d =>
      `<div style="font-size:12px;color:var(--text-muted);padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
        ${esc(d.title)} <span style="opacity:0.6">— ${esc(d.artist)}</span>
      </div>`
    ).join('') + (dups.length > 5
      ? `<div style="font-size:12px;color:var(--text-muted);padding:2px 0">…and ${dups.length - 5} more</div>`
      : '');

    // "Skip Duplicates" only makes sense when there are also new tracks to add
    document.getElementById('dup-skip-btn').style.display = hasMixed ? 'inline-flex' : 'none';

    document.getElementById('dup-modal').style.display = 'flex';
  });
}

function dupCancel() {
  document.getElementById('dup-modal').style.display = 'none';
  if (_dupResolve) _dupResolve('cancel');
  _dupResolve = null; _dupContext = null;
}

async function dupSkip() {
  document.getElementById('dup-modal').style.display = 'none';
  const { pid, plName, newIds } = _dupContext;
  _dupResolve = null; _dupContext = null;
  const res = await api(`/playlists/${pid}/tracks`, {
    method: 'POST',
    body: { track_ids: newIds },
  });
  toast(`Added ${res.added} new song${res.added !== 1 ? 's' : ''} to "${plName}"`);
  if (state.playlist?.id === pid) await openPlaylist(pid);
}

async function dupAddAnyway() {
  document.getElementById('dup-modal').style.display = 'none';
  const { pid, plName, dups, newIds } = _dupContext;
  _dupResolve = null; _dupContext = null;
  const allIds = [...dups.map(d => d.id), ...newIds];
  const res = await api(`/playlists/${pid}/tracks`, {
    method: 'POST',
    body: { track_ids: allIds, force: true },
  });
  toast(`Added ${res.added} song${res.added !== 1 ? 's' : ''} to "${plName}"`);
  if (state.playlist?.id === pid) await openPlaylist(pid);
}

async function removeFromPlaylist(trackId) {
  if (!trackId || !state.playlist || state.playlist?.is_favourites) return;
  await _removeTracksFromCurrentPlaylist([trackId], { toastText: 'Removed from playlist' });
}

async function _removeTracksFromCurrentPlaylist(trackIds, { toastText = '' } = {}) {
  if (!state.playlist || state.playlist?.is_favourites) return;
  const uniqueIds = [...new Set((trackIds || []).map(id => String(id || '').trim()).filter(Boolean))];
  if (!uniqueIds.length) return;
  if (uniqueIds.length >= 5) {
    const ok = await _showConfirm({
      title: 'Remove Songs',
      message: `Remove ${uniqueIds.length} songs from "${state.playlist.name || 'this playlist'}"?`,
      okText: 'Remove',
      danger: true,
    });
    if (!ok) return;
  }

  const ids = new Set(uniqueIds);
  const remaining = (state.playlist.tracks || [])
    .filter(t => !ids.has(String(t.id || '')))
    .map(t => t.id);

  await api(`/playlists/${state.playlist.id}`, {
    method: 'PUT',
    body: { tracks: remaining },
  });

  clearSelection();
  const pl = await api(`/playlists/${state.playlist.id}`);
  state.playlist = pl;
  renderPlaylistTracks(pl.tracks);
  updatePlaylistCover(pl.tracks);
  updatePlaylistStats(pl.tracks);
  loadPlaylists();  // refresh track_count in list view
  if (toastText) toast(toastText);
}

/* ── Playlist CRUD ──────────────────────────────────────────────────── */
function showCreatePlaylistModal(trackIds = []) {
  _createPlPendingIds = trackIds;
  const modal = document.getElementById('create-playlist-modal');
  const input = document.getElementById('create-playlist-input');
  modal.style.display = 'flex';
  input.value = '';
  setTimeout(() => input.focus(), 60);
}

function closeCreatePlaylistModal() {
  document.getElementById('create-playlist-modal').style.display = 'none';
  _createPlPendingIds = [];
}

function _isOverlayOpen(id) {
  const el = document.getElementById(id);
  if (!el) return false;
  return el.style.display && el.style.display !== 'none';
}

function _collectDapModalDraft() {
  return {
    id: document.getElementById('dap-modal-id')?.value || '',
    name: document.getElementById('dap-name')?.value || '',
    model: document.getElementById('dap-model')?.value || '',
    mount: document.getElementById('dap-mount')?.value || '',
    music_root: document.getElementById('dap-music-root')?.value || '',
    template: document.getElementById('dap-path-template')?.value || '',
    export_folder: document.getElementById('dap-export-folder')?.value || '',
    peq_folder: document.getElementById('dap-peq-folder')?.value || '',
    prefix: document.getElementById('dap-prefix')?.value || '',
  };
}

function _updateDapModalUnsavedBanner() {
  const banner = document.getElementById('dap-unsaved-banner');
  if (!banner) return;
  if (!_isOverlayOpen('dap-modal')) {
    banner.style.display = 'none';
    return;
  }
  banner.style.display = _isDapModalDirty() ? '' : 'none';
}

function _commitDapModalBaseline() {
  _dapModalInitialJson = JSON.stringify(_collectDapModalDraft());
  _updateDapModalUnsavedBanner();
}

function _collectIemModalDraft() {
  return {
    id: document.getElementById('iem-modal-id')?.value || '',
    name: document.getElementById('iem-name')?.value || '',
    type: document.getElementById('iem-type')?.value || '',
    s1l: document.getElementById('iem-source-label-1')?.value || '',
    s1u: document.getElementById('iem-source-url-1')?.value || '',
    s2l: document.getElementById('iem-source-label-2')?.value || '',
    s2u: document.getElementById('iem-source-url-2')?.value || '',
    s3l: document.getElementById('iem-source-label-3')?.value || '',
    s3u: document.getElementById('iem-source-url-3')?.value || '',
  };
}

function _updateIemModalUnsavedBanner() {
  const banner = document.getElementById('iem-unsaved-banner');
  if (!banner) return;
  if (!_isOverlayOpen('iem-modal')) {
    banner.style.display = 'none';
    return;
  }
  banner.style.display = _isIemModalDirty() ? '' : 'none';
}

function _commitIemModalBaseline() {
  _iemModalInitialJson = JSON.stringify(_collectIemModalDraft());
  _updateIemModalUnsavedBanner();
}

function _isDapModalDirty() {
  if (!_isOverlayOpen('dap-modal')) return false;
  const current = JSON.stringify(_collectDapModalDraft());
  return !!_dapModalInitialJson && current !== _dapModalInitialJson;
}

function _isIemModalDirty() {
  if (!_isOverlayOpen('iem-modal')) return false;
  const current = JSON.stringify(_collectIemModalDraft());
  return !!_iemModalInitialJson && current !== _iemModalInitialJson;
}

function _isPeqUploadModalDirty() {
  if (!_isOverlayOpen('peq-modal')) return false;
  const name = (document.getElementById('peq-name')?.value || '').trim();
  const fileChosen = !!document.getElementById('peq-file-input')?.files?.length;
  return !!(name || fileChosen);
}

function _isCreatePlaylistModalDirty() {
  if (!_isOverlayOpen('create-playlist-modal')) return false;
  return !!(document.getElementById('create-playlist-input')?.value || '').trim();
}

function _isImportModalDirty() {
  if (!_isOverlayOpen('import-modal')) return false;
  return !!(_importData || Object.keys(_importMappings || {}).length);
}

function _isSyncBusy() {
  if (!_isOverlayOpen('sync-modal')) return false;
  const modal = document.getElementById('sync-modal');
  const phase = modal?.getAttribute('data-phase') || 'pick';
  return phase === 'scanning' || phase === 'copying';
}

function _guardModalNavigation() {
  if (_isOverlayOpen('confirm-modal')) return false;
  if (_isSyncBusy() && !window.confirm('Sync is in progress. Leave this screen and stop monitoring sync?')) {
    return false;
  }
  if (_isDapModalDirty() && !window.confirm('Discard unsaved Device changes?')) return false;
  if (_isIemModalDirty() && !window.confirm('Discard unsaved IEM changes?')) return false;
  if (_isPeqUploadModalDirty() && !window.confirm('Discard unsaved PEQ upload details?')) return false;
  if (_isCreatePlaylistModalDirty() && !window.confirm('Discard new playlist name?')) return false;
  if (_isImportModalDirty() && !window.confirm('Discard current playlist import mapping?')) return false;
  return true;
}

function _closeModalOverlaysForNavigation() {
  if (_isOverlayOpen('ml-ref-modal')) closeMlReferenceBrowser();
  if (_isOverlayOpen('ml-gen-modal')) {
    _resetMlPreviewState();
    closeMlPlaylistGenerator();
  }
  if (_isOverlayOpen('dap-modal')) closeDapModal();
  if (_isOverlayOpen('iem-modal')) closeIemModal();
  if (_isOverlayOpen('peq-modal')) closePeqModal();
  if (_isOverlayOpen('rename-modal')) document.getElementById('rename-modal').style.display = 'none';
  if (_isOverlayOpen('settings-modal')) closeSettings();
  if (_isOverlayOpen('help-modal')) closeHelp();
  if (_isOverlayOpen('sync-modal')) closeSyncModal();
  if (_isOverlayOpen('import-modal')) closeImportModal();
  if (_isOverlayOpen('dup-modal')) document.getElementById('dup-modal').style.display = 'none';
  if (_isOverlayOpen('problem-tracks-modal')) closeProblemTracksModal();
  if (_isOverlayOpen('genre-distribution-modal')) closeGenreDistributionModal();
  if (_isOverlayOpen('iem-blindspot-modal')) closeAllBlindspots();
  if (_isOverlayOpen('iem-compare-modal')) closeIemCompare();
  if (_isOverlayOpen('create-playlist-modal')) closeCreatePlaylistModal();
}

async function submitCreatePlaylist() {
  const input = document.getElementById('create-playlist-input');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  const trackIds = [..._createPlPendingIds];
  closeCreatePlaylistModal();
  const pl = await api('/playlists', { method: 'POST', body: { name } });
  await loadPlaylists();
  if (trackIds.length) {
    const res = await api(`/playlists/${pl.id}/tracks`, { method: 'POST', body: { track_ids: trackIds } });
    state.lastUsedPlaylistId = pl.id;
    toast(`Added ${res.added} song${res.added !== 1 ? 's' : ''} to "${pl.name}"`);
  } else {
    toast(`Playlist "${pl.name}" created`);
  }
  await openPlaylist(pl.id);
}

function _isMlModalOpen() {
  const modal = document.getElementById('ml-gen-modal');
  return !!(modal && modal.style.display !== 'none');
}

function _hasUnsavedMlPreview() {
  return _mlGenPreviewDirty && _mlGenPreviewTracks.length > 0;
}

function _resetMlPreviewState() {
  _mlGenPreviewTracks = [];
  _mlGenPreviewDirty = false;
  _mlPreviewSeed = 1337;
  const summaryEl = document.getElementById('ml-gen-summary');
  const previewEl = document.getElementById('ml-gen-preview');
  const previewPane = document.getElementById('ml-gen-preview-pane');
  const saveBtn = document.getElementById('ml-gen-save-btn');
  const regenBtn = document.getElementById('ml-gen-regen-btn');
  if (summaryEl) summaryEl.textContent = '';
  if (previewEl) previewEl.innerHTML = '';
  if (previewPane) previewPane.style.display = 'none';
  if (saveBtn) saveBtn.disabled = true;
  if (regenBtn) regenBtn.disabled = true;
}

function _confirmMlDiscard() {
  if (!_hasUnsavedMlPreview()) return true;
  return window.confirm('You have an unsaved generated playlist preview. Click OK to discard it and continue.');
}

function _guardMlGeneratorNavigation() {
  if (!_isMlModalOpen()) return true;
  if (!_confirmMlDiscard()) return false;
  _resetMlPreviewState();
  const modal = document.getElementById('ml-gen-modal');
  if (modal) modal.style.display = 'none';
  return true;
}

function _getMlSeedCandidates() {
  const selectedIds = [...state.selectedTrackIds];
  if (selectedIds.length) return selectedIds.slice(0, 15);
  if (_mlGenContext === 'playlist' && state.playlist?.tracks?.length) {
    return state.playlist.tracks.slice(0, 8).map(t => t.id).filter(Boolean);
  }
  if (state.playlist?.tracks?.length) {
    return state.playlist.tracks.slice(0, 5).map(t => t.id).filter(Boolean);
  }
  if (state.tracks?.length) {
    return state.tracks.slice(0, 5).map(t => t.id).filter(Boolean);
  }
  return [];
}

function _renderMlSeedNote() {
  const note = document.getElementById('ml-gen-seed-note');
  if (!note) return;
  if (!_mlGenSeedTrackIds.length) {
    note.textContent = 'No reference songs selected yet.';
    return;
  }
  note.textContent = `${_mlGenSeedTrackIds.length} reference song${_mlGenSeedTrackIds.length !== 1 ? 's' : ''} selected.`;
}

async function _ensureMlSongCatalog() {
  if (_mlSongCatalog) return _mlSongCatalog;
  _mlSongCatalog = await api('/library/songs?sort=title&order=asc').catch(() => []);
  return _mlSongCatalog;
}

function _renderMlReferenceSelected() {
  const el = document.getElementById('ml-gen-ref-selected');
  if (!el) return;
  if (!_mlGenSeedTrackIds.length) {
    el.innerHTML = '';
    return;
  }
  const map = new Map((_mlSongCatalog || []).map(t => [t.id, t]));
  el.innerHTML = _mlGenSeedTrackIds.map(tid => {
    const t = map.get(tid) || {};
    const name = t.title || tid;
    const meta = t.artist ? ` · ${t.artist}` : '';
    return `<span class="ml-gen-ref-chip">${esc(name)}${esc(meta)}<button onclick="App.mlGenRemoveReference('${tid}')" title="Remove">✕</button></span>`;
  }).join('');
}

function _renderMlReferenceResults(query = '') {
  const el = document.getElementById('ml-gen-ref-results');
  if (!el) return;
  const q = (query || '').trim().toLowerCase();
  let pool = _mlSongCatalog || [];
  if (q) {
    pool = pool.filter(t =>
      `${t.title || ''} ${t.artist || ''} ${t.album || ''}`.toLowerCase().includes(q)
    );
  }
  pool = pool.filter(t => t && t.id && !_mlGenSeedTrackIds.includes(t.id)).slice(0, 25);
  if (!pool.length) {
    el.innerHTML = '<div class="ml-gen-ref-empty">No matching songs found.</div>';
    return;
  }
  el.innerHTML = pool.map(t => `
    <button class="ml-gen-ref-option" onclick="App.mlGenAddReference('${t.id}')">
      <div class="ml-gen-ref-option-title">${esc(t.title || 'Untitled')}</div>
      <div class="ml-gen-ref-option-meta">${esc(t.artist || 'Unknown Artist')} · ${esc(t.album || 'Unknown Album')}</div>
    </button>
  `).join('');
}

function mlGenSearchRefSongs(query = '') {
  _mlRefQuery = query || '';
  _renderMlReferenceResults(_mlRefQuery);
}

function mlGenAddReference(trackId) {
  if (!trackId) return;
  if (_mlGenSeedTrackIds.includes(trackId)) return;
  if (_mlGenSeedTrackIds.length >= _ML_MAX_REF_TRACKS) {
    toast(`You can add up to ${_ML_MAX_REF_TRACKS} reference songs.`);
    return;
  }
  _mlGenSeedTrackIds.push(trackId);
  _renderMlSeedNote();
  _renderMlReferenceSelected();
  _renderMlReferenceResults(_mlRefQuery);
}

function mlGenRemoveReference(trackId) {
  _mlGenSeedTrackIds = _mlGenSeedTrackIds.filter(id => id !== trackId);
  _renderMlSeedNote();
  _renderMlReferenceSelected();
  _renderMlReferenceResults(_mlRefQuery);
}

function mlGenClearReferences() {
  _mlGenSeedTrackIds = [];
  _renderMlSeedNote();
  _renderMlReferenceSelected();
  _renderMlReferenceResults(_mlRefQuery);
}

function _mlRefRowHtml(t, checked) {
  return `<label class="ml-ref-row">
    <input type="checkbox" ${checked ? 'checked' : ''} onchange="App.mlRefBrowserToggle('${t.id}', this.checked)" />
    <div class="ml-ref-cell-title" title="${esc(t.title || '')}">${esc(t.title || 'Untitled')}</div>
    <div class="ml-ref-cell-meta" title="${esc(t.artist || '')}">${esc(t.artist || 'Unknown Artist')}</div>
    <div class="ml-ref-cell-meta" title="${esc(t.album || '')}">${esc(t.album || 'Unknown Album')}</div>
  </label>`;
}

function _renderMlRefBrowserResults() {
  const container = document.getElementById('ml-ref-results');
  const countEl = document.getElementById('ml-ref-count');
  if (!container) return;
  const q = (_mlRefQuery || '').trim().toLowerCase();
  let rows = _mlSongCatalog || [];
  if (q) {
    rows = rows.filter(t => `${t.title || ''} ${t.artist || ''} ${t.album || ''}`.toLowerCase().includes(q));
  }
  rows = rows.slice(0, 500);
  if (!rows.length) {
    container.innerHTML = '<div class="ml-gen-ref-empty">No matching songs found.</div>';
  } else {
    container.innerHTML = rows.map(t => _mlRefRowHtml(t, _mlRefDraftIds.includes(t.id))).join('');
  }
  if (countEl) countEl.textContent = `${_mlRefDraftIds.length} selected`;
}

async function openMlReferenceBrowser() {
  await _ensureMlSongCatalog();
  _mlRefDraftIds = [..._mlGenSeedTrackIds];
  _mlRefQuery = '';
  const input = document.getElementById('ml-ref-search');
  const modal = document.getElementById('ml-ref-modal');
  if (input) input.value = '';
  _renderMlRefBrowserResults();
  if (modal) modal.style.display = 'flex';
}

function closeMlReferenceBrowser() {
  const modal = document.getElementById('ml-ref-modal');
  if (modal) modal.style.display = 'none';
}

function mlRefBrowserSearch(query = '') {
  _mlRefQuery = query || '';
  _renderMlRefBrowserResults();
}

function mlRefBrowserToggle(trackId, checked) {
  if (!trackId) return;
  if (checked) {
    if (_mlRefDraftIds.includes(trackId)) return;
    if (_mlRefDraftIds.length >= _ML_MAX_REF_TRACKS) {
      toast(`You can add up to ${_ML_MAX_REF_TRACKS} reference songs.`);
      _renderMlRefBrowserResults();
      return;
    }
    _mlRefDraftIds.push(trackId);
  } else {
    _mlRefDraftIds = _mlRefDraftIds.filter(id => id !== trackId);
  }
  _renderMlRefBrowserResults();
}

function applyMlReferenceBrowser() {
  _mlGenSeedTrackIds = [..._mlRefDraftIds];
  _renderMlSeedNote();
  _renderMlReferenceSelected();
  closeMlReferenceBrowser();
}

function mlGenUseCurrentSelection() {
  const ids = [...state.selectedTrackIds].slice(0, _ML_MAX_REF_TRACKS);
  if (!ids.length) {
    toast('Select songs in a list first, then use this action.');
    return;
  }
  _mlGenSeedTrackIds = ids;
  _renderMlSeedNote();
  _renderMlReferenceSelected();
}

function _applyMlModeUi() {
  const mode = document.getElementById('ml-gen-mode')?.value || 'genre';
  const targetRow = document.getElementById('ml-gen-target-row');
  const genreModeRow = document.getElementById('ml-gen-genre-mode-row');
  const seedRow = document.getElementById('ml-gen-seed-row');

  const showGenre = mode === 'genre' || mode === 'hybrid';
  const showReference = mode === 'seed' || mode === 'hybrid';

  if (targetRow) targetRow.style.display = showGenre ? '' : 'none';
  if (genreModeRow) genreModeRow.style.display = showGenre ? '' : 'none';
  if (seedRow) seedRow.style.display = showReference ? '' : 'none';
}

function _bindMlModeHandlers() {
  if (_mlModeBound) return;
  const modeEl = document.getElementById('ml-gen-mode');
  const moodEl = document.getElementById('ml-gen-mood');
  if (modeEl) {
    modeEl.addEventListener('change', _applyMlModeUi);
  }
  if (moodEl) moodEl.addEventListener('change', _applyMlMoodPreset);
  _mlModeBound = true;
}

async function _loadMlGenerationOptions() {
  if (_mlGenOptions) return _mlGenOptions;
  _mlGenOptions = await api('/playlists/generate/options');
  return _mlGenOptions;
}

function _renderMlGenreOptions(genres = []) {
  const genreSel = document.getElementById('ml-gen-target-genre');
  if (!genreSel) return;
  genreSel.innerHTML = `<option value="">Any</option>${genres.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}`;
}

function _setMlDefaults(opts) {
  const defaults = opts?.defaults || {};
  const limits = opts?.limits || {};
  const lenRange = limits.playlist_length || [8, 80];

  const modeEl = document.getElementById('ml-gen-mode');
  const genreModeEl = document.getElementById('ml-gen-genre-mode');
  const lenEl = document.getElementById('ml-gen-length');
  const arcEl = document.getElementById('ml-gen-arc');
  const diversityEl = document.getElementById('ml-gen-diversity');
  const smoothEl = document.getElementById('ml-gen-smoothness');
  const deterministicEl = document.getElementById('ml-gen-deterministic');
  const repeatEl = document.getElementById('ml-gen-repeat-artists');
  const yearMinEl = document.getElementById('ml-gen-year-min');
  const yearMaxEl = document.getElementById('ml-gen-year-max');

  if (modeEl) modeEl.value = defaults.mode || 'genre';
  if (genreModeEl) genreModeEl.value = defaults.genre_mode || 'strict';
  if (lenEl) {
    lenEl.min = String(lenRange[0] ?? 8);
    lenEl.max = String(lenRange[1] ?? 80);
    lenEl.value = String(defaults.playlist_length ?? 20);
  }
  if (arcEl) arcEl.value = defaults.playlist_arc || 'steady';
  if (diversityEl) diversityEl.value = String(defaults.diversity_strength ?? 0.7);
  if (smoothEl) smoothEl.value = String(defaults.transition_smoothness ?? 0.8);
  if (deterministicEl) deterministicEl.value = String(!!(defaults.deterministic ?? true));
  if (repeatEl) repeatEl.value = String(!!(defaults.allow_repeat_artists ?? false));
  if (yearMinEl) yearMinEl.value = '';
  if (yearMaxEl) yearMaxEl.value = '';
  _applyMlModeUi();
}

function _mlReadNumber(id, fallback, min = null, max = null) {
  const el = document.getElementById(id);
  if (!el) return fallback;
  if (String(el.value || '').trim() === '') return fallback;
  const raw = Number(el.value);
  if (!Number.isFinite(raw)) return fallback;
  let out = raw;
  if (min !== null) out = Math.max(min, out);
  if (max !== null) out = Math.min(max, out);
  return out;
}

function _applyMlMoodPreset() {
  const mood = document.getElementById('ml-gen-mood')?.value || '';
  const preset = _ML_MOOD_PRESETS[mood];
  if (!preset) return;
  const energyEl = document.getElementById('ml-gen-energy');
  const brightnessEl = document.getElementById('ml-gen-brightness');
  if (energyEl) energyEl.value = String(preset.energy);
  if (brightnessEl) brightnessEl.value = String(preset.brightness);
}

function _currentMlPayload() {
  const opts = _mlGenOptions || {};
  const defaults = opts.defaults || {};
  const mode = document.getElementById('ml-gen-mode')?.value || defaults.mode || 'genre';
  const targetGenre = document.getElementById('ml-gen-target-genre')?.value || '';
  const genreMode = document.getElementById('ml-gen-genre-mode')?.value || defaults.genre_mode || 'strict';
  const arc = document.getElementById('ml-gen-arc')?.value || defaults.playlist_arc || 'steady';
  const mood = document.getElementById('ml-gen-mood')?.value || '';
  const yearMin = _mlReadNumber('ml-gen-year-min', null, 1900, 2100);
  const yearMax = _mlReadNumber('ml-gen-year-max', null, 1900, 2100);
  const deterministic = String(document.getElementById('ml-gen-deterministic')?.value || 'true') === 'true';
  const allowRepeatArtists = String(document.getElementById('ml-gen-repeat-artists')?.value || 'false') === 'true';

  return {
    mode,
    target_genre: targetGenre || null,
    genre_mode: genreMode,
    seed_track_ids: _mlGenSeedTrackIds,
    mood: mood || null,
    year_range: (yearMin !== null && yearMax !== null && yearMin <= yearMax) ? [yearMin, yearMax] : null,
    playlist_length: _mlReadNumber('ml-gen-length', defaults.playlist_length || 20, 8, 80),
    energy_target: _mlReadNumber('ml-gen-energy', 0.5, 0, 1),
    brightness_target: _mlReadNumber('ml-gen-brightness', 0.5, 0, 1),
    diversity_strength: _mlReadNumber('ml-gen-diversity', defaults.diversity_strength || 0.7, 0, 1),
    transition_smoothness: _mlReadNumber('ml-gen-smoothness', defaults.transition_smoothness || 0.8, 0, 1),
    playlist_arc: arc,
    deterministic,
    allow_repeat_artists: allowRepeatArtists,
    seed: _mlPreviewSeed,
  };
}

function _renderMlPreviewSummary(summary = {}) {
  const el = document.getElementById('ml-gen-summary');
  const previewPane = document.getElementById('ml-gen-preview-pane');
  if (!el) return;
  if (previewPane) previewPane.style.display = 'block';
  const generated = summary.generated_length ?? 0;
  const requested = summary.requested_length ?? generated;
  const mode = ({ genre: 'Genre Lane', seed: 'Track DNA', hybrid: 'Blend Mode' }[summary.mode] || '-');
  const pool = summary.candidate_pool_size ?? 0;
  const considered = summary.library_tracks_considered ?? 0;
  const target = summary.target_genre || 'Any genre';
  const seedTag = `run: ${_mlPreviewSeed}`;
  el.innerHTML = `
    <strong>${generated}/${requested}</strong> tracks generated ·
    mode: <strong>${esc(mode)}</strong> ·
    target: <strong>${esc(target)}</strong> ·
    pool: <strong>${pool}</strong> from <strong>${considered}</strong> tracks ·
    <strong>${seedTag}</strong>
  `;
}

function _renderMlPreviewTracks(tracks = [], explanations = []) {
  const el = document.getElementById('ml-gen-preview');
  const previewPane = document.getElementById('ml-gen-preview-pane');
  if (!el) return;
  if (previewPane) previewPane.style.display = 'block';
  if (!tracks.length) {
    el.innerHTML = '<p class="insights-empty-note">No tracks generated with current constraints.</p>';
    return;
  }
  const explainById = new Map((explanations || []).map(e => [e.track_id, e]));
  el.innerHTML = `
    <table class="insights-table" style="width:100%;min-width:640px">
      <thead>
        <tr>
          <th style="width:44px">#</th>
          <th>Title</th>
          <th>Artist</th>
          <th>Album</th>
          <th style="width:84px;text-align:right">Fit</th>
        </tr>
      </thead>
      <tbody>
        ${tracks.map((t, i) => {
          const ex = explainById.get(t.id) || {};
          const fitPct = Math.max(0, Math.min(100, Math.round((Number(ex.placement_score) || 0) * 100)));
          return `<tr>
            <td>${i + 1}</td>
            <td title="${esc(t.title)}">${esc(t.title)}</td>
            <td title="${esc(t.artist)}">${esc(t.artist)}</td>
            <td title="${esc(t.album)}">${esc(t.album)}</td>
            <td style="text-align:right;color:var(--text-secondary);font-weight:600">${fitPct}%</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

async function openMlPlaylistGenerator(context = 'global', options = {}) {
  if (_isMlModalOpen()) {
    if (!_confirmMlDiscard()) return;
    _resetMlPreviewState();
  }
  _mlGenContext = context === 'playlist' ? 'playlist' : 'global';
  _mlGenSeedTrackIds = (options.referenceTrackIds && options.referenceTrackIds.length)
    ? options.referenceTrackIds.slice(0, _ML_MAX_REF_TRACKS).map(String)
    : _getMlSeedCandidates();
  _mlRefQuery = '';

  const modal = document.getElementById('ml-gen-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  _bindMlModeHandlers();

  const nameEl = document.getElementById('ml-gen-name');
  if (nameEl) {
    const stamp = new Date().toISOString().slice(0, 10);
    nameEl.value = `Smart Playlist ${stamp}`;
  }
  _resetMlPreviewState();
  try {
    const opts = await _loadMlGenerationOptions();
    await _ensureMlSongCatalog();
    _renderMlGenreOptions(opts.genres || []);
    _setMlDefaults(opts);
    const modeEl = document.getElementById('ml-gen-mode');
    if (options.preferredMode && modeEl) modeEl.value = options.preferredMode;
    const refSearchEl = document.getElementById('ml-gen-ref-search');
    if (refSearchEl) refSearchEl.value = '';
    _renderMlSeedNote();
    _renderMlReferenceSelected();
    _renderMlReferenceResults('');
    _applyMlModeUi();
  } catch (e) {
    toast('Could not load generation options');
  }
}

function closeMlPlaylistGenerator() {
  if (!_confirmMlDiscard()) return;
  _resetMlPreviewState();
  closeMlReferenceBrowser();
  const modal = document.getElementById('ml-gen-modal');
  if (modal) modal.style.display = 'none';
}

async function runMlPlaylistPreview({ regenerate = false } = {}) {
  const previewBtn = document.getElementById('ml-gen-preview-btn');
  const regenBtn = document.getElementById('ml-gen-regen-btn');
  const saveBtn = document.getElementById('ml-gen-save-btn');
  if (regenerate) _mlPreviewSeed += 1;
  if (previewBtn) { previewBtn.disabled = true; previewBtn.textContent = 'Generating…'; }
  if (regenBtn) { regenBtn.disabled = true; regenBtn.textContent = regenerate ? 'Regenerating…' : 'Regenerate'; }
  try {
    const payload = _currentMlPayload();
    if (regenerate) payload.regenerate = true;
    if (payload.mode === 'seed' && !payload.seed_track_ids.length) {
      toast('Works best when you pick some reference tracks first');
    }
    const res = await api('/playlists/generate/preview', { method: 'POST', body: payload });
    _mlGenPreviewTracks = Array.isArray(res.tracks) ? res.tracks : [];
    _mlGenPreviewDirty = _mlGenPreviewTracks.length > 0;
    _renderMlPreviewSummary(res.summary || {});
    _renderMlPreviewTracks(_mlGenPreviewTracks, res.explanations || []);
    if (saveBtn) saveBtn.disabled = !_mlGenPreviewTracks.length;
    if (regenBtn) regenBtn.disabled = !_mlGenPreviewTracks.length;
    if (!_mlGenPreviewTracks.length) toast('No tracks matched. Try relaxed genre mode or wider targets.');
  } catch (e) {
    toast('No results. Try adjusting the settings.');
  } finally {
    if (previewBtn) {
      previewBtn.disabled = false;
      previewBtn.textContent = 'Preview';
    }
    if (regenBtn) regenBtn.textContent = 'Regenerate';
  }
}

async function regenerateMlPlaylist() {
  await runMlPlaylistPreview({ regenerate: true });
}

async function saveMlGeneratedPlaylist() {
  if (!_mlGenPreviewTracks.length) {
    toast('Generate a preview first');
    return;
  }
  const name = (document.getElementById('ml-gen-name')?.value || '').trim();
  try {
    const res = await api('/playlists/generate/save', {
      method: 'POST',
      body: {
        name,
        track_ids: _mlGenPreviewTracks.map(t => t.id).filter(Boolean),
      },
    });
    _mlGenPreviewDirty = false;
    closeMlPlaylistGenerator();
    await loadPlaylists();
    toast(`Saved playlist "${res.name}" (${res.track_count} tracks)`);
    await openPlaylist(res.id);
  } catch (e) {
    toast('Could not save the playlist');
  }
}

async function createPlaylist() {
  showCreatePlaylistModal();
}

async function createPlaylistAndAdd() {
  hideDropdown();
  showCreatePlaylistModal([...state._pendingTrackIds]);
}

async function deletePlaylist(pid) {
  const pl = state.playlists.find(p => p.id === pid) || state.playlist;
  const ok = await _showConfirm({
    title:   'Delete Playlist',
    message: `"${pl?.name}" will be permanently deleted.`,
    okText:  'Delete',
  });
  if (!ok) return;
  await api(`/playlists/${pid}`, { method: 'DELETE' });
  toast(`"${pl?.name || 'Playlist'}" deleted`);
  if (state.playlist?.id === pid) {
    state.playlist = null;
    showView('playlists');
  }
  await loadPlaylists();
}

async function deleteCurrentPlaylist() {
  if (!state.playlist) return;
  if (state.playlist.is_favourites) return;
  await deletePlaylist(state.playlist.id);
}

let renameTarget = null;
function renamePlaylist(newName) {
  if (!state.playlist || !newName.trim()) return;
  if (state.playlist.is_favourites) return;
  if (newName.trim() === state.playlist.name) return;
  api(`/playlists/${state.playlist.id}`, { method: 'PUT', body: { name: newName.trim() } })
    .then(() => {
      state.playlist.name = newName.trim();
    
      loadPlaylists();
      toast('Playlist renamed');
    });
}

async function removeSongFromFavourites(trackId) {
  if (!trackId) return;
  await toggleFavourite('songs', encodeURIComponent(trackId));
  if (state.playlist?.is_favourites) {
    await openFavouriteSongsPlaylist();
  }
}

/* ── Export ─────────────────────────────────────────────────────────── */
async function exportPlaylistDap(did) {
  if (!state.playlist) return;
  if (state.playlist.is_favourites) {
    const aFav = document.createElement('a');
    aFav.href = '/api/favourites/songs/export/poweramp';
    document.body.appendChild(aFav);
    aFav.click();
    document.body.removeChild(aFav);
    toast('Downloading Favourite Songs M3U…');
    return;
  }
  const url = `/api/daps/${did}/export/${state.playlist.id}/download`;
  const a = document.createElement('a');
  a.href = url;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  const daps = await api('/daps').catch(() => []);
  const dap = daps.find(d => d.id === did);
  toast(`Downloading M3U for ${dap ? dap.name : 'DAP'}…`);
}

async function exportToDeviceDap(did) {
  if (!state.playlist) return;
  if (_playlistDapExportBusyDid) return;
  _setPlaylistDapExportBusy(did, true);
  try {
    if (state.playlist.is_favourites) {
      await api(`/daps/${did}/export/favourites`, { method: 'POST' });
      toast('Favourite songs copied to device');
      await loadFavourites();
      renderDapExportPills(state.playlist.id);
      return;
    }
    const res = await api(`/daps/${did}/export/${state.playlist.id}`, { method: 'POST' });
    const missingCount = Number(res?.missing_on_device_count || 0);
    if (missingCount > 0) {
      toast(`Playlist synced, but ${missingCount} track${missingCount === 1 ? '' : 's'} are missing on device. Run Sync Music to copy files.`);
    } else {
      toast('Exported to device');
    }
    // Refresh pills so sync status updates
    await renderDapExportPills(state.playlist.id);
  } catch (e) {
    toast('Export failed. Check the device is connected.');
  } finally {
    _setPlaylistDapExportBusy(null, false);
  }
}

/* ── Favourites views ───────────────────────────────────────────────── */
function _favAddedAtMap(type) {
  const rows = state.favouritesMeta[type] || [];
  const map = new Map();
  rows.forEach(r => map.set(String(r.id || ''), Number(r.added_at || 0)));
  return map;
}

function _favOrderIds(type) {
  return (state.favouritesMeta[type] || []).map(r => String(r.id || '')).filter(Boolean);
}

function _favSummaryCard(title, count, panel) {
  return `
    <button class="favourites-summary-card" data-fav-panel="${esc(panel)}" aria-pressed="false" onclick="App.selectFavouritesPanel('${esc(panel)}')">
      <div class="favourites-summary-title">${esc(title)}</div>
      <div class="favourites-summary-count">${count}</div>
    </button>
  `;
}

function _applyFavouritesPanelState() {
  document.querySelectorAll('.favourites-summary-card[data-fav-panel]').forEach(btn => {
    const isActive = btn.dataset.favPanel === state.favPanel;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

async function selectFavouritesPanel(panel) {
  const normalized = (panel === 'artists' || panel === 'albums' || panel === 'songs') ? panel : 'songs';
  state.favPanel = normalized;
  _applyFavouritesPanelState();

  const host = document.getElementById('favourites-inline-panels');
  if (!host) return;
  host.style.display = '';
  const panels = {
    artists: document.getElementById('favourites-panel-artists'),
    albums: document.getElementById('favourites-panel-albums'),
    songs: document.getElementById('favourites-panel-songs'),
  };
  Object.entries(panels).forEach(([key, el]) => {
    if (!el) return;
    const isActive = key === normalized;
    el.classList.toggle('is-active', isActive);
    el.style.display = '';
    el.setAttribute('aria-hidden', isActive ? 'false' : 'true');
  });

  if (normalized === 'artists') await loadFavArtists();
  else if (normalized === 'albums') await loadFavAlbums();
  else {
    await _renderFavSongsActionCtas();
    await loadFavSongs();
  }
}

async function _renderFavSongsActionCtas() {
  const copyBtn = document.getElementById('fav-songs-copy-btn');
  const downloadBtn = document.getElementById('fav-songs-download-btn');
  if (!copyBtn || !downloadBtn) return;
  downloadBtn.textContent = 'Download M3U';
  const daps = await api('/daps').catch(() => []);
  const connected = Array.isArray(daps) ? daps.filter(d => d.mounted) : [];
  if (!connected.length) {
    copyBtn.style.display = 'none';
    return;
  }
  copyBtn.style.display = '';
  copyBtn.textContent = connected.length === 1
    ? `Copy to ${connected[0].name}`
    : `Copy to Connected DAPs (${connected.length})`;
}

async function loadFavouritesSummary() {
  const grid = document.getElementById('favourites-summary-grid');
  const empty = document.getElementById('favourites-empty');
  if (!grid || !empty) return;
  // Always hydrate from full-library endpoints here; state.artists/state.albums
  // may currently hold scoped subsets (e.g. single-artist albums view).
  state.artists = await api('/library/artists').catch(() => state.artists || []);
  state.albums = await api('/library/albums').catch(() => state.albums || []);

  const favSongsRes = await api('/favourites/songs/tracks').catch(() => ({ tracks: [] }));
  const favSongs = Array.isArray(favSongsRes?.tracks) ? favSongsRes.tracks : [];

  const favArtistRows = state.artists.filter(a => state.favourites.artists.has(_normArtistId(a.name)));
  const favAlbumRows = state.albums.filter(a => state.favourites.albums.has(String(a.artwork_key || '')));

  const total = favArtistRows.length + favAlbumRows.length + favSongs.length;
  empty.style.display = total === 0 ? 'flex' : 'none';
  grid.style.display = total === 0 ? 'none' : 'grid';
  const inlinePanels = document.getElementById('favourites-inline-panels');
  if (inlinePanels) inlinePanels.style.display = total === 0 ? 'none' : '';
  grid.innerHTML = [
    _favSummaryCard('Artists', favArtistRows.length, 'artists'),
    _favSummaryCard('Albums', favAlbumRows.length, 'albums'),
    _favSummaryCard('Songs', favSongs.length, 'songs'),
  ].join('');
  if (total > 0) {
    await selectFavouritesPanel(state.favPanel || 'artists');
  }
}

function _renderFavArtistCards(rows) {
  const grid = document.getElementById('fav-artists-grid');
  if (!grid) return;
  if (!rows.length) {
    grid.innerHTML = `
      <div class="empty-state favourites-grid-empty">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="8" r="3.2"/><path d="M5 19c0-3.1 2.6-5.4 7-5.4s7 2.3 7 5.4"/></svg>
        <p>No favourite artists yet.</p>
        <p class="muted">Tap ★ on artists to build your quick-access artist list.</p>
        <button class="btn-secondary" onclick="App.showView('artists')">Browse Artists</button>
      </div>
    `;
    return;
  }
  grid.innerHTML = rows.map(a => `
    <div class="artist-card" data-artist="${esc(a.name)}" onclick="App.showArtist(this.dataset.artist)" oncontextmenu="event.preventDefault();App.showArtistCtxMenu(event,this.dataset.artist)">
      <div class="artist-thumb${(a.image_key || a.artwork_key) ? '' : ' artist-thumb--placeholder'}">
        ${a.image_key
          ? `<img src="/api/artists/${a.image_key}/image" alt="${esc(a.name)}" loading="lazy" />`
          : (a.artwork_key
            ? thumbImg(a.artwork_key, 120, '6px')
            : coverPlaceholder('artist', 120, '6px'))}
        <div class="card-thumb-overlay">
          <button class="card-play-btn" data-artist="${esc(a.name)}" onclick="event.stopPropagation();App.playArtistCard(this.dataset.artist)" title="Play all songs">
            ${playSvg(15)}
          </button>
        </div>
        ${_favToggleBtn('artists', _normArtistId(a.name), 'card-fav-btn is-fav')}
      </div>
      <div class="artist-name" title="${esc(a.name)}">${esc(a.name)}</div>
      <div class="artist-meta">${a.album_count} album${a.album_count !== 1 ? 's' : ''} · ${a.track_count} songs</div>
      <button class="card-more-btn" data-artist="${esc(a.name)}" onclick="event.stopPropagation();App.showArtistCtxMenu(event,this.dataset.artist)" title="More options">⋮</button>
    </div>
  `).join('');
}

function _getFavArtistsRowsSorted() {
  let rows = state.artists.filter(a => state.favourites.artists.has(_normArtistId(a.name)));
  if (state.favArtistsSort === 'az') {
    rows = [...rows].sort((a, b) => _nameSortKey(a.name).localeCompare(_nameSortKey(b.name)));
  } else {
    const order = _favOrderIds('artists');
    const idx = new Map(order.map((id, i) => [id, i]));
    rows = [...rows].sort((a, b) => (idx.get(_normArtistId(a.name)) ?? 1e9) - (idx.get(_normArtistId(b.name)) ?? 1e9));
  }
  return rows;
}

async function loadFavArtists() {
  state.artists = await api('/library/artists').catch(() => state.artists || []);
  const rows = _getFavArtistsRowsSorted();
  _renderFavArtistCards(rows);
}

function setFavArtistsSort(mode) {
  state.favArtistsSort = mode;
  document.querySelectorAll('[data-fav-artist-sort]').forEach(b => b.classList.toggle('active', b.dataset.favArtistSort === mode));
  loadFavArtists();
}

function _renderFavAlbumCards(rows) {
  const grid = document.getElementById('fav-albums-grid');
  if (!grid) return;
  if (!rows.length) {
    grid.innerHTML = `
      <div class="empty-state favourites-grid-empty">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4.5" y="4.5" width="15" height="15" rx="2.2"/><circle cx="12" cy="12" r="3.2"/></svg>
        <p>No favourite albums yet.</p>
        <p class="muted">Tap ★ on albums to keep your must-listen records here.</p>
        <button class="btn-secondary" onclick="App.showView('albums')">Browse Albums</button>
      </div>
    `;
    return;
  }
  grid.innerHTML = rows.map(al => `
    <div class="album-card" data-artist="${esc(al.artist)}" data-album="${esc(al.name)}" onclick="App.showAlbum(this.dataset.artist, this.dataset.album)" oncontextmenu="event.preventDefault();App.showAlbumCtxMenu(event,this.dataset.artist,this.dataset.album)">
      <div class="album-thumb">
        ${thumbImg(al.artwork_key, 160, '6px')}
        <div class="card-thumb-overlay">
          <button class="card-play-btn" data-artist="${esc(al.artist)}" data-album="${esc(al.name)}" onclick="event.stopPropagation();App.playAlbum(this.dataset.artist,this.dataset.album)" title="Play album">
            ${playSvg(15)}
          </button>
        </div>
        ${_favToggleBtn('albums', al.artwork_key || '', 'card-fav-btn is-fav')}
        <button class="album-art-btn" data-artist="${esc(al.artist)}" data-album="${esc(al.name)}" onclick="event.stopPropagation();App._openAlbumArtForCard(this.dataset.artist,this.dataset.album)" title="Change album art">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </button>
      </div>
      <div class="album-name" title="${esc(al.name)}">${esc(al.name)}</div>
      <div class="album-artist">${esc(al.artist)}</div>
      ${al.year ? `<div class="album-year">${esc(al.year)}</div>` : ''}
      <button class="card-more-btn" data-artist="${esc(al.artist)}" data-album="${esc(al.name)}" onclick="event.stopPropagation();App.showAlbumCtxMenu(event,this.dataset.artist,this.dataset.album)" title="More options">⋮</button>
    </div>
  `).join('');
}

function _getFavAlbumsRowsSorted() {
  let rows = state.albums.filter(a => state.favourites.albums.has(String(a.artwork_key || '')));
  if (state.favAlbumsSort === 'az') {
    rows = [...rows].sort((a, b) => _nameSortKey(a.name).localeCompare(_nameSortKey(b.name)));
  } else {
    const order = _favOrderIds('albums');
    const idx = new Map(order.map((id, i) => [id, i]));
    rows = [...rows].sort((a, b) => (idx.get(String(a.artwork_key || '')) ?? 1e9) - (idx.get(String(b.artwork_key || '')) ?? 1e9));
  }
  return rows;
}

async function loadFavAlbums() {
  state.albums = await api('/library/albums').catch(() => state.albums || []);
  const rows = _getFavAlbumsRowsSorted();
  _renderFavAlbumCards(rows);
}

function setFavAlbumsSort(mode) {
  state.favAlbumsSort = mode;
  document.querySelectorAll('[data-fav-album-sort]').forEach(b => b.classList.toggle('active', b.dataset.favAlbumSort === mode));
  loadFavAlbums();
}

function _favSongRow(t, idx) {
  const playIcon = playSvg(12);
  return `
    <tr data-id="${t.id}" ondblclick="Player.playTrackById('${t.id}')" oncontextmenu="App.showTrackCtxMenu(event,'${t.id}')">
      <td class="col-num" data-col="track_number">
        <div class="num-cell">
          <div class="drag-handle" title="Drag to reorder" onclick="event.stopPropagation()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg>
          </div>
          <span class="track-num">${idx + 1}</span>
        </div>
      </td>
      <td data-col="title">
        <div class="title-cell">
          <div class="thumb-wrap">
            <div class="thumb">${thumbImg(t.artwork_key, 38, '4px')}</div>
            <button class="thumb-play-btn" onclick="event.stopPropagation();Player.playTrackById('${t.id}')" title="Play">${playIcon}</button>
          </div>
          <div class="track-info">
            <div class="track-title" title="${esc(t.title)}">${esc(t.title)}</div>
            <div class="track-artist" title="${esc(t.artist)}">${esc(t.artist)}</div>
          </div>
        </div>
      </td>
      <td data-col="artist" class="cell-artist" title="${esc(t.artist)}">${esc(t.artist)}</td>
      <td data-col="album" class="cell-album" title="${esc(t.album)}">${esc(t.album)}</td>
      <td data-col="duration" class="col-dur">${esc(t.duration_fmt || '')}</td>
      <td data-col="favourite" class="col-fav-cell">${_favToggleBtn('songs', t.id, 'track-fav-btn is-fav')}</td>
      <td data-col="actions"><div class="col-act-inner">
        <button class="track-edit-btn" onclick="event.stopPropagation();App.openTagEditor('${t.id}')" title="Edit tags">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="add-btn" onclick="App.showAddDropdown(event, '${t.id}')" title="Add to playlist">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div></td>
    </tr>
  `;
}

async function favSongsReorder(orderIds) {
  const rows = await api('/favourites/songs/reorder', { method: 'PUT', body: { order: orderIds } });
  _replaceFavouriteCategory('songs', rows);
}

async function favArtistsReorder(orderIds) {
  const rows = await api('/favourites/artists/reorder', { method: 'PUT', body: { order: orderIds } });
  _replaceFavouriteCategory('artists', rows);
}

async function favAlbumsReorder(orderIds) {
  const rows = await api('/favourites/albums/reorder', { method: 'PUT', body: { order: orderIds } });
  _replaceFavouriteCategory('albums', rows);
}

async function loadFavSongs() {
  await _renderFavSongsActionCtas();
  const table = document.getElementById('fav-songs-table');
  const tbody = document.getElementById('fav-songs-tbody');
  const empty = document.getElementById('fav-songs-empty');
  const orphan = document.getElementById('fav-songs-orphans');
  if (!table || !tbody || !empty || !orphan) return;

  const res = await api('/favourites/songs/tracks').catch(() => ({ tracks: [], orphaned_count: 0 }));
  const tracks = Array.isArray(res?.tracks) ? res.tracks : [];
  const orphanedCount = Number(res?.orphaned_count || 0);
  state.favSongsData = tracks;

  if (orphanedCount > 0) {
    orphan.style.display = 'block';
    orphan.textContent = `${orphanedCount} favourited song${orphanedCount === 1 ? '' : 's'} are no longer in your library.`;
  } else {
    orphan.style.display = 'none';
  }

  if (!tracks.length) {
    table.style.display = 'none';
    empty.style.display = 'flex';
    tbody.innerHTML = '';
    return;
  }
  empty.style.display = 'none';
  table.style.display = 'table';

  const addedAt = _favAddedAtMap('songs');
  let rows = [...tracks];
  if (state.favSongsSort === 'my') {
    const order = _favOrderIds('songs');
    const idx = new Map(order.map((id, i) => [id, i]));
    rows.sort((a, b) => (idx.get(a.id) ?? 1e9) - (idx.get(b.id) ?? 1e9));
  } else if (state.favSongsSort === 'recent') {
    rows.sort((a, b) => (addedAt.get(b.id) || 0) - (addedAt.get(a.id) || 0));
  } else if (state.favSongsSort === 'az') {
    rows.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  } else if (state.favSongsSort === 'album') {
    rows.sort((a, b) => (a.album || '').localeCompare(b.album || ''));
  }

  Player.registerTracks(rows);
  Player.setPlaybackContext(rows, { sourceType: 'favourites', sourceId: 'songs', sourceLabel: 'Favourite Songs' });
  tbody.innerHTML = rows.map((t, i) => _favSongRow(t, i)).join('');
  _applyTableColumnVisibility();

  if (state.sortable) state.sortable.destroy();
  if (state.favSongsSort === 'my') {
    state.sortable = new Sortable(tbody, {
      animation: 150,
      handle: '.drag-handle',
      onEnd: async () => {
        const ids = Array.from(tbody.querySelectorAll('tr[data-id]')).map(r => r.dataset.id);
        await favSongsReorder(ids);
      },
    });
  } else {
    state.sortable = null;
  }
}

function _uniqueTracksById(tracks) {
  const byId = new Map();
  (tracks || []).forEach(t => {
    if (t && t.id && !byId.has(t.id)) byId.set(t.id, t);
  });
  return [...byId.values()];
}

async function playAllFavouriteArtists() {
  if (!state.artists.length) state.artists = await api('/library/artists').catch(() => []);
  const favArtists = _getFavArtistsRowsSorted();
  if (!favArtists.length) {
    toast('No favourite artists to play yet.');
    return;
  }
  const chunks = await Promise.all(
    favArtists.map(a => api(`/library/tracks?artist=${encodeURIComponent(a.name)}`).catch(() => []))
  );
  const tracks = _uniqueTracksById(chunks.flat());
  if (!tracks.length) {
    toast('No tracks found for favourite artists.');
    return;
  }
  Player.registerTracks(tracks);
  Player.setPlaybackContext(tracks, { sourceType: 'favourites', sourceId: 'artists', sourceLabel: 'Favourites · Artists' });
  Player.playAll(tracks, 0, 'Favourites · Artists');
}

async function playAllFavouriteAlbums() {
  if (!state.albums.length) state.albums = await api('/library/albums').catch(() => []);
  const favAlbums = _getFavAlbumsRowsSorted();
  if (!favAlbums.length) {
    toast('No favourite albums to play yet.');
    return;
  }
  const chunks = await Promise.all(
    favAlbums.map(al => api(`/library/tracks?artist=${encodeURIComponent(al.artist)}&album=${encodeURIComponent(al.name)}`).catch(() => []))
  );
  const tracks = _uniqueTracksById(chunks.flat());
  if (!tracks.length) {
    toast('No tracks found for favourite albums.');
    return;
  }
  Player.registerTracks(tracks);
  Player.setPlaybackContext(tracks, { sourceType: 'favourites', sourceId: 'albums', sourceLabel: 'Favourites · Albums' });
  Player.playAll(tracks, 0, 'Favourites · Albums');
}

async function playAllFavouriteSongs() {
  let tracks = Array.isArray(state.favSongsData) ? state.favSongsData : [];
  if (!tracks.length) {
    const res = await api('/favourites/songs/tracks').catch(() => ({ tracks: [] }));
    tracks = Array.isArray(res?.tracks) ? res.tracks : [];
  }
  tracks = _uniqueTracksById(tracks);
  if (!tracks.length) {
    toast('No favourite songs to play yet.');
    return;
  }
  Player.registerTracks(tracks);
  Player.setPlaybackContext(tracks, { sourceType: 'favourites', sourceId: 'songs', sourceLabel: 'Favourites · Songs' });
  Player.playAll(tracks, 0, 'Favourites · Songs');
}

function setFavSongsSort(mode) {
  state.favSongsSort = mode;
  document.querySelectorAll('[data-fav-song-sort]').forEach(b => b.classList.toggle('active', b.dataset.favSongSort === mode));
  loadFavSongs();
}

function exportFavSongs(fmt) {
  const a = document.createElement('a');
  a.href = `/api/favourites/songs/export/${fmt}`;
  a.click();
}

async function copyFavSongsToConnectedDap() {
  const daps = await api('/daps').catch(() => []);
  const connected = daps.find(d => d.mounted);
  if (!connected) {
    toast('No DAP connected');
    return;
  }
  await copyFavSongsToDap(connected.id);
}

async function copyFavSongsToDap(did) {
  if (_playlistDapExportBusyDid) return;
  _setPlaylistDapExportBusy(did, true);
  try {
    await api(`/daps/${did}/export/favourites`, { method: 'POST' });
    toast('Favourite songs copied to DAP');
    await loadFavourites();
    if (state.playlist?.is_favourites) {
      await renderDapExportPills(state.playlist.id);
    }
  } catch (e) {
    toast('Export failed. Check the device is connected.');
  } finally {
    _setPlaylistDapExportBusy(null, false);
  }
}

async function bulkFavouriteSelected() {
  const ids = [...state.selectedTrackIds];
  for (const id of ids) {
    if (!_isFavourite('songs', id)) {
      await toggleFavourite('songs', encodeURIComponent(id));
    }
  }
  toast(`Favourited ${ids.length} song${ids.length === 1 ? '' : 's'}.`);
}

async function bulkUnfavouriteSelected() {
  const ids = [...state.selectedTrackIds];
  for (const id of ids) {
    if (_isFavourite('songs', id)) {
      await toggleFavourite('songs', encodeURIComponent(id));
    }
  }
  toast(`Unfavourited ${ids.length} song${ids.length === 1 ? '' : 's'}.`);
}

/* ── Home ───────────────────────────────────────────────────────────── */
/* ── Home helpers ───────────────────────────────────────────────────── */

let _homeCurrentPeriod = 'month';
let _homeStatsLoading = false;
let _homeLastData = null;
let _homeLastStatsData = {}; // keyed by period

function _homeSectionVisible(id, visible) {
  const el = document.getElementById(id);
  if (el) el.style.display = visible ? '' : 'none';
}

function _homeArtEl(item) {
  const artistImageUrl = (item?.kind === 'artist' && item?.image_key)
    ? `/api/artists/${esc(item.image_key)}/image`
    : '';
  if (artistImageUrl) {
    return `<img src="${artistImageUrl}" loading="lazy" onerror="this.style.display='none'" />`;
  }
  const kind = String(item?.kind || '').toLowerCase();
  const playlistId = String(item?.playlist_id || '').trim();
  const artworkKey = item?.artwork_key || '';
  if (kind === 'playlist' && playlistId) {
    const playlistArt = `/api/playlists/${encodeURIComponent(playlistId)}/artwork?t=${Date.now()}`;
    const fallback = artworkKey ? `/api/artwork/${esc(artworkKey)}` : '';
    return fallback
      ? `<img src="${playlistArt}" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'" />`
      : `<img src="${playlistArt}" loading="lazy" onerror="this.style.display='none'" />`;
  }
  const fallbackKind = kind === 'artist' ? 'artist' : (kind === 'album' ? 'album' : 'song');
  return artworkKey
    ? `<img src="/api/artwork/${esc(artworkKey)}" loading="lazy" onerror="this.style.display='none'" />`
    : `<div class="home-card-art-placeholder">${coverPlaceholder(fallbackKind, 56, '14px')}</div>`;
}

function _homeOnClick(item) {
  const a = encodeURIComponent(item.artist || '');
  const al = encodeURIComponent(item.album || '');
  const pid = encodeURIComponent(item.playlist_id || '');
  return `App.homeOpenItem('${esc(item.kind || '')}','','${a}','${al}','${pid}')`;
}

function _homeOnPlay(item, e) {
  const a = encodeURIComponent(item.artist || '');
  const al = encodeURIComponent(item.album || '');
  const pid = encodeURIComponent(item.playlist_id || '');
  return `App.homePlayItem(event,'${esc(item.kind || '')}','${a}','${al}','${pid}')`;
}

const _HOME_PLAY_SVG = playSvg(16);

function _homeRailCardHtml(item) {
  const title = item.title || 'Unknown';
  const subtitle = item.subtitle || '';
  // Use div.home-card-play-btn (not button) to avoid nested-button invalid HTML
  return `
    <div class="home-card" onclick="${_homeOnClick(item)}" role="button" tabindex="0">
      <div class="home-card-art">
        ${_homeArtEl(item)}
        <div class="home-card-play-btn" onclick="${_homeOnPlay(item)}" role="button" tabindex="0" title="Play">
          ${_HOME_PLAY_SVG}
        </div>
      </div>
      <div class="home-card-title" title="${esc(title)}">${esc(title)}</div>
      ${subtitle ? `<div class="home-card-sub">${esc(subtitle)}</div>` : ''}
    </div>`;
}

function _homePickCardHtml(item) {
  const title = item.title || 'Unknown';
  const subtitle = item.subtitle || '';
  const reason = item.reason || '';
  return `
    <div class="home-pick-card" onclick="${_homeOnClick(item)}" role="button" tabindex="0">
      <div class="home-pick-art">
        ${_homeArtEl(item)}
        <div class="home-card-play-btn" onclick="${_homeOnPlay(item)}" role="button" tabindex="0" title="Play">
          ${_HOME_PLAY_SVG}
        </div>
      </div>
      <div class="home-pick-title" title="${esc(title)}">${esc(title)}</div>
      <div class="home-pick-sub">${esc(subtitle)}</div>
      ${reason ? `<div class="home-pick-reason">${esc(reason)}</div>` : ''}
    </div>`;
}

function _renderHomeRailSection(sectionId, railId, items, emptyMsg) {
  const rail = document.getElementById(railId);
  if (!rail) return false;
  if (!Array.isArray(items) || !items.length) {
    rail.innerHTML = `<div class="home-rail-empty">${esc(emptyMsg)}</div>`;
    _homeBindRailUX(railId);
    _homeSectionVisible(sectionId, true);
    return false;
  }
  rail.innerHTML = items.map(_homeRailCardHtml).join('');
  _homeBindRailUX(railId);
  _homeSectionVisible(sectionId, true);
  return true;
}

function _homeUpdateRailAffordance(railId) {
  const rail = document.getElementById(railId);
  const shell = rail?.closest('.home-rail-shell');
  if (!rail || !shell) return;
  const leftBtn = shell.querySelector('.home-rail-nav-left');
  const rightBtn = shell.querySelector('.home-rail-nav-right');

  const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
  const canScroll = maxScroll > 2;
  const atStart = rail.scrollLeft <= 2;
  const atEnd = rail.scrollLeft >= maxScroll - 2;

  shell.classList.toggle('can-scroll-left', canScroll && !atStart);
  shell.classList.toggle('can-scroll-right', canScroll && !atEnd);

  if (leftBtn) leftBtn.classList.toggle('is-visible', canScroll && !atStart);
  if (rightBtn) rightBtn.classList.toggle('is-visible', canScroll && !atEnd);
}

function _homeBindRailUX(railId) {
  const rail = document.getElementById(railId);
  if (!rail) return;
  if (!rail.dataset.uxBound) {
    rail.dataset.uxBound = '1';
    rail.addEventListener('scroll', () => _homeUpdateRailAffordance(railId), { passive: true });
  }
  _homeUpdateRailAffordance(railId);
}

function _homeRefreshRailAffordances() {
  ['home-continue', 'home-listen-next', 'home-recently-added', 'home-because'].forEach(_homeUpdateRailAffordance);
}

function homeRailStep(railId, direction = 1) {
  const rail = document.getElementById(railId);
  if (!rail) return;
  const dir = Number(direction) < 0 ? -1 : 1;
  const step = Math.max(Math.round(rail.clientWidth * 0.86), 240);
  rail.scrollBy({ left: dir * step, behavior: 'smooth' });
  setTimeout(() => _homeUpdateRailAffordance(railId), 220);
}

function _renderHomeTopPicks(items) {
  return _renderHomeRailSection(
    'home-because-section',
    'home-because',
    items || [],
    'Keep listening to unlock personalised recommendations.'
  );
}

function _renderHomeDataHealth(data) {
  const el = document.getElementById('home-data-health');
  if (!el) return;
  const trackingEnabled = data && data.tracking_enabled !== false;
  const health = data && data.data_health ? data.data_health : {};
  const latest = Number(health.latest_event_at || 0);
  const total = Number(health.total_events || 0);
  const valid = Number(health.valid_events || 0);
  const historyFresh = !!health.history_fresh;

  if (!trackingEnabled) {
    el.style.display = '';
    el.className = 'home-data-health warn';
    el.textContent = 'Listening tracking is turned off. Enable it in Settings to personalise Home.';
    return;
  }
  if (!total) {
    el.style.display = '';
    el.className = 'home-data-health info';
    el.textContent = 'Play a few songs to personalise Home.';
    return;
  }
  if (!historyFresh) {
    const ago = latest ? _homeRelativeTime(latest) : 'a while ago';
    el.style.display = '';
    el.className = 'home-data-health warn';
    el.textContent = `Listening history looks stale (last event ${ago}). Keep listening to refresh recommendations.`;
    return;
  }
  if (valid <= 0) {
    el.style.display = '';
    el.className = 'home-data-health info';
    el.textContent = 'Recent listens are mostly short skips. Full listens improve recommendations and stats.';
    return;
  }
  el.style.display = 'none';
}

function _renderHomeListeningStats(data) {
  const el = document.getElementById('home-stats-content');
  if (!el) return;
  const c = (data && data.current) || {};
  const comp = (data && data.comparison) || {};

  const fmtMins = m => {
    if (!m) return '0 min';
    if (m < 60) return `${Math.round(m)} min`;
    const h = Math.floor(m / 60);
    return h >= 100 ? `${h.toLocaleString()} hrs` : `${h} hr${h !== 1 ? 's' : ''}`;
  };

  const changePill = (pct) => {
    if (pct === null || pct === undefined) return '';
    const sign = pct >= 0 ? '+' : '';
    const cls = pct >= 0 ? 'home-stat-change-up' : 'home-stat-change-down';
    return `<span class="${cls}">${sign}${Math.round(pct)}%</span>`;
  };

  const metricCards = [
    { label: 'Valid plays', value: (c.track_count || 0).toLocaleString(), change: comp.tracks_change },
    { label: 'Albums played',  value: (c.album_count  || 0).toLocaleString() },
    { label: 'Unique artists', value: (c.artist_count || 0).toLocaleString() },
    { label: 'Active days',    value: (c.active_days  || 0).toLocaleString() },
  ].map(m => `
    <div class="home-stat-metric">
      <div class="home-stat-value">${m.value}${m.change !== undefined ? changePill(m.change) : ''}</div>
      <div class="home-stat-label">${m.label}</div>
    </div>`).join('');

  const topRow = [
    { label: 'Top artist', value: c.top_artist },
    { label: 'Top album',  value: c.top_album },
    { label: 'Top track',  value: c.top_track },
    { label: 'Top genre',  value: c.top_genre },
  ].filter(r => r.value).map(r => `
    <div class="home-stat-top-item">
      <span class="home-stat-top-label">${r.label}</span>
      <span class="home-stat-top-value">${esc(r.value)}</span>
    </div>`).join('');

  const minutes = fmtMins(c.total_minutes);
  el.innerHTML = `
    <div class="home-stats-shell">
      <div class="home-stats-hero">
        <div class="home-stats-hero-kicker">Personal retrospective</div>
        <div class="home-stats-hero-value">
          ${minutes}
          ${comp.minutes_change !== undefined ? changePill(comp.minutes_change) : ''}
        </div>
        <div class="home-stats-hero-label">Total listening time</div>
      </div>
      <div class="home-stats-right">
        <div class="home-stat-metrics">${metricCards}</div>
        ${topRow ? `<div class="home-stat-tops">${topRow}</div>` : ''}
        ${!c.track_count ? '<div class="home-stat-empty">Start listening to see your stats here.</div>' : ''}
      </div>
    </div>
  `;
  _homeSectionVisible('home-stats-section', true);
}

async function loadHome() {
  if (_homeLoading) return;
  _homeLoading = true;
  setActiveNav('home');
  showViewEl('home');
  const navRight = document.getElementById('main-nav-right');
  if (navRight) navRight.innerHTML = '';

  let data;
  try {
    data = await api('/home');
  } catch (err) {
    _homeLoading = false;
    document.getElementById('home-empty-title').textContent = 'Could not load Home';
    document.getElementById('home-empty-body').textContent = (err && err.message) || 'Check the server is running.';
    _homeSectionVisible('home-empty-state', true);
    return;
  }

  _homeApplyData(data, /* force */ true);
  _homeLoading = false;
}

// Silent background refresh — only updates DOM for sections whose data actually changed.
async function _homeBackgroundRefresh() {
  if (_homeLoading || state.view !== 'home' || document.hidden) return;
  let data;
  try {
    data = await api('/home');
  } catch (_) { return; }
  _homeApplyData(data, /* force */ false);
}

// Apply home data to DOM. force=true always re-renders all sections (initial load).
// force=false only updates sections whose serialised data has changed (background refresh).
function _homeApplyData(data, force) {
  const prev = _homeLastData;
  _homeLastData = data;

  // Header strip — always update (cheap text, no repaint flash)
  const summary = data.library_summary || {};
  const summaryEl = document.getElementById('home-library-summary');
  if (summaryEl) {
    const parts = [];
    if (summary.artists) parts.push(`${summary.artists.toLocaleString()} artists`);
    if (summary.albums)  parts.push(`${summary.albums.toLocaleString()} albums`);
    if (summary.tracks)  parts.push(`${summary.tracks.toLocaleString()} tracks`);
    summaryEl.textContent = parts.join(' · ');
  }
  const scanEl = document.getElementById('home-last-scan');
  if (scanEl && data.last_scan) {
    scanEl.textContent = `Scanned ${_homeRelativeTime(data.last_scan)}`;
  }

  // Empty library state
  const hasLibrary = (summary.tracks || 0) > 0;
  if (!hasLibrary) {
    _homeSectionVisible('home-empty-state', true);
    document.getElementById('home-empty-title').textContent = 'Your library is empty';
    document.getElementById('home-empty-body').textContent = 'Go to Settings to set your music folder, then scan.';
    _homeSectionVisible('home-continue-section', false);
    _homeSectionVisible('home-listen-next-section', false);
    _homeSectionVisible('home-recent-section', false);
    _homeSectionVisible('home-because-section', false);
    _homeSectionVisible('home-stats-section', false);
    _homeSectionVisible('home-data-health', false);
    return;
  }
  _homeSectionVisible('home-empty-state', false);

  const changed = (key) => !prev || JSON.stringify(prev[key]) !== JSON.stringify(data[key]);

  // Jump Back In
  if (force || changed('jump_back_in') || changed('continue_listening')) {
    _renderHomeRailSection(
      'home-continue-section',
      'home-continue',
      data.jump_back_in || data.continue_listening || [],
      'Start listening — your recent sessions will appear here.'
    );
  }

  // Listen Next (artists)
  if (force || changed('listen_next_artists')) {
    _renderHomeRailSection(
      'home-listen-next-section',
      'home-listen-next',
      data.listen_next_artists || [],
      'No listening pattern yet. Play more artists to unlock this rail.'
    );
  }

  // Recently Added
  if (force || changed('recently_added')) {
    _renderHomeRailSection('home-recent-section', 'home-recently-added', data.recently_added || [], 'No items added yet.');
  }

  // Because You Listened
  if (force || changed('because_you_listened') || changed('top_picks')) {
    _renderHomeTopPicks(data.because_you_listened || data.top_picks || []);
  }

  // Stats: on initial load fetch them; on background refresh skip (period chips handle updates)
  if (force) {
    _homeSectionVisible('home-stats-section', true);
    homeChangePeriod(_homeCurrentPeriod, /* skipChipUpdate */ true);
  }

  _renderHomeDataHealth(data);
}

async function homeChangePeriod(period, skipChipUpdate) {
  _homeCurrentPeriod = period;
  if (!skipChipUpdate) {
    document.querySelectorAll('.home-period-chip').forEach(el => {
      el.classList.toggle('active', el.dataset.period === period);
    });
  }
  if (_homeStatsLoading) return;
  _homeStatsLoading = true;

  // If we have cached stats for this period, render them immediately while we fetch fresh data
  if (_homeLastStatsData[period]) {
    _renderHomeListeningStats(_homeLastStatsData[period]);
  } else {
    const el = document.getElementById('home-stats-content');
    if (el) el.style.opacity = '0.4';
  }

  try {
    const stats = await api(`/home/stats?period=${encodeURIComponent(period)}`);
    _homeLastStatsData[period] = stats;
    const el = document.getElementById('home-stats-content');
    if (el) el.style.opacity = '';
    _renderHomeListeningStats(stats);
  } catch (_) {
    const el = document.getElementById('home-stats-content');
    if (el) { el.style.opacity = ''; el.innerHTML = '<div class="home-rail-empty">Could not load stats.</div>'; }
  }
  _homeStatsLoading = false;
}

function homeForceRefresh() {
  _homeLastData = null;
  _homeLastStatsData = {};
  loadHome();
}

async function homeShuffleLibrary() {
  const tracks = await api('/library/tracks');
  if (!tracks || !tracks.length) return;
  Player.registerTracks?.(tracks);
  Player.setPlaybackContext?.(tracks, { sourceType: 'songs', sourceId: '', sourceLabel: 'Songs' });
  Player.playCollectionShuffled(tracks, 'Songs');
}

function homeResumeListening() {
  const contEl = document.getElementById('home-continue');
  if (contEl) {
    const firstCard = contEl.querySelector('.home-card');
    if (firstCard) { firstCard.click(); return; }
  }
}

function _homeRelativeTime(ts) {
  if (!ts) return '';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60)         return 'just now';
  if (diff < 3600)       { const m = Math.floor(diff / 60);   return `${m} minute${m !== 1 ? 's' : ''} ago`; }
  if (diff < 86400)      { const h = Math.floor(diff / 3600); return `${h} hour${h !== 1 ? 's' : ''} ago`; }
  if (diff < 7 * 86400)  { const d = Math.floor(diff / 86400); return `${d} day${d !== 1 ? 's' : ''} ago`; }
  if (diff < 30 * 86400) { const w = Math.floor(diff / (7 * 86400)); return `${w} week${w !== 1 ? 's' : ''} ago`; }
  return 'a while ago';
}

function homeOpenItem(kind, trackIdEnc = '', artistEnc = '', albumEnc = '', playlistIdEnc = '') {
  const kindNorm = String(kind || '').toLowerCase();
  const artist = decodeURIComponent(artistEnc || '');
  const album  = decodeURIComponent(albumEnc  || '');
  const playlistId = decodeURIComponent(playlistIdEnc || '');
  if (kindNorm === 'album'    && artist && album)  { showAlbum(artist, album); return; }
  if (kindNorm === 'artist'   && artist)           { showArtist(artist); return; }
  if (kindNorm === 'playlist' && playlistId)       { openPlaylist(playlistId); return; }
}

function homePlayItem(event, kind, artistEnc = '', albumEnc = '', playlistIdEnc = '') {
  event && event.stopPropagation();
  const kindNorm = String(kind || '').toLowerCase();
  const artist = decodeURIComponent(artistEnc || '');
  const album  = decodeURIComponent(albumEnc  || '');
  const playlistId = decodeURIComponent(playlistIdEnc || '');
  if (kindNorm === 'album' && artist && album) {
    api(`/library/tracks?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`)
      .then(tracks => {
        if (!tracks || !tracks.length) return;
        Player.registerTracks?.(tracks);
        Player.setPlaybackContext?.(tracks, { sourceType: 'album', sourceId: `${artist}||${album}`, sourceLabel: `Album · ${album}` });
        Player.playAll(tracks, 0, `Album · ${album}`);
      });
    return;
  }
  if (kindNorm === 'artist' && artist) {
    api(`/library/tracks?artist=${encodeURIComponent(artist)}`)
      .then(tracks => {
        if (!tracks || !tracks.length) return;
        Player.registerTracks?.(tracks);
        Player.setPlaybackContext?.(tracks, { sourceType: 'artist', sourceId: artist, sourceLabel: `Artist · ${artist}` });
        // Respect the current player shuffle toggle state by using standard playAll.
        Player.playAll(tracks, 0, `Artist · ${artist}`);
      });
    return;
  }
  if (kindNorm === 'playlist' && playlistId) {
    api(`/playlists/${encodeURIComponent(playlistId)}`).then(pl => {
      if (!pl || !pl.tracks || !pl.tracks.length) return;
      Player.registerTracks?.(pl.tracks);
      Player.setPlaybackContext?.(pl.tracks, { sourceType: 'playlist', sourceId: pl.id, sourceLabel: `Playlist · ${pl.name}` });
      Player.playAll(pl.tracks, 0, `Playlist · ${pl.name}`);
    });
    return;
  }
}

/* ── View navigation ────────────────────────────────────────────────── */
function showView(viewName) {
  if (!_guardMlGeneratorNavigation()) return;
  if (!_guardPeqEditorNavigation()) return;
  if (!_guardModalNavigation()) return;
  _closeModalOverlaysForNavigation();
  _pushToNavHistory();
  if (viewName === 'fav-artists') {
    state.favPanel = 'artists';
    viewName = 'favourites';
  }
  if (viewName === 'fav-albums') {
    state.favPanel = 'albums';
    viewName = 'favourites';
  }
  state.view = viewName;
  if (viewName !== 'missing-tags') _insightsMissingTagsOpen = false;
  state.playlist = null;
  clearSelection();
  setActiveNav(viewName);
  renderSidebarPlaylists();

  showViewEl(viewName);

  if (viewName === 'home') loadHome();
  else if (viewName === 'artists') { state._artistsScrollTop = 0; loadArtists(); }
  else if (viewName === 'albums') { state.artist = null; loadAlbums(); }
  else if (viewName === 'songs') loadSongsView();
  else if (viewName === 'favourites') loadFavouritesSummary();
  else if (viewName === 'fav-songs') openFavouriteSongsPlaylist();
  else if (viewName === 'gear') loadGearView();
  else if (viewName === 'playlists') loadPlaylistsView();
  else if (viewName === 'settings') {
    setHealthSectionExpanded(false);
    loadSettings();
  }
  else if (viewName === 'insights') loadInsightsView();

  if (viewName === 'home') {
    if (_homeAutoRefreshTimer) clearInterval(_homeAutoRefreshTimer);
    _homeAutoRefreshTimer = setInterval(() => {
      _homeBackgroundRefresh();
    }, 30000);
  } else if (_homeAutoRefreshTimer) {
    clearInterval(_homeAutoRefreshTimer);
    _homeAutoRefreshTimer = null;
  }
}

function showViewEl(name) {
  const views = ['home', 'artists', 'albums', 'tracks', 'songs', 'favourites', 'fav-artists', 'fav-albums', 'fav-songs', 'playlist', 'gear', 'dap-detail', 'iem-detail', 'settings', 'playlists', 'insights', 'missing-tags'];
  views.forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.style.display = v === name ? (v === 'playlist' ? 'flex' : 'block') : 'none';
  });
  const main = document.getElementById('main');
  if (main) {
    main.classList.toggle('main-home-active', name === 'home');
    main.classList.toggle('main-library-active', name === 'artists' || name === 'albums');
  }
  // Clear right nav slot for non-home views (loadHome repopulates it)
  if (name !== 'home') {
    const navRight = document.getElementById('main-nav-right');
    if (navRight) navRight.innerHTML = '';
  }
}

function setActiveNav(view) {
  const NAV_MAP = {
    'tracks': 'artists',
    'dap-detail': 'gear',
    'iem-detail': 'gear',
    'playlist': 'playlists',
    'fav-artists': 'favourites',
    'fav-albums': 'favourites',
    'fav-songs': 'favourites',
    'missing-tags': 'insights',
  };
  const navView = NAV_MAP[view] || view;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === navView);
  });
}

function backToArtists() {
  if (!_guardMlGeneratorNavigation()) return;
  if (!_guardPeqEditorNavigation()) return;
  if (!_guardModalNavigation()) return;
  _closeModalOverlaysForNavigation();
  state.view = 'artists';
  clearSelection();
  setActiveNav('artists');
  renderSidebarPlaylists();
  showViewEl('artists');
  loadArtists(); // restores _artistsScrollTop if set
}

function backToGear() {
  if (!_guardMlGeneratorNavigation()) return;
  if (!_guardPeqEditorNavigation()) return;
  if (!_guardModalNavigation()) return;
  _closeModalOverlaysForNavigation();
  state.view = 'gear';
  clearSelection();
  setActiveNav('gear');
  showViewEl('gear');
  loadGearView();
}

/* ── Navigation history (back / forward) ───────────────────────────── */
function _captureNavSnapshot() {
  return {
    view: state.view,
    artist: state.artist || null,
    album: state.album || null,
    playlistId: state.playlist ? (state.playlist.id || null) : null,
    dapId: _currentDapId || null,
    iemId: _currentIemId || null,
    favPanel: state.favPanel || 'artists',
    scrollTop: document.getElementById('main')?.scrollTop || 0,
  };
}

function _pushToNavHistory() {
  if (_isNavigatingBack) return;
  const snap = _captureNavSnapshot();
  // Deduplicate: don't push if identical to last entry
  if (_navHistory.length > 0) {
    const last = _navHistory[_navHistory.length - 1];
    if (last.view === snap.view && last.artist === snap.artist &&
        last.album === snap.album && last.playlistId === snap.playlistId &&
        last.dapId === snap.dapId && last.iemId === snap.iemId) return;
  }
  if (_navHistory.length >= 50) _navHistory.shift();
  _navHistory.push(snap);
  _updateNavButtonStates();
}

function _updateNavButtonStates() {
  const hasBack = _navHistory.length > 0;
  const backBtn = document.getElementById('nav-back-btn');
  if (backBtn) backBtn.style.visibility = hasBack ? 'visible' : 'hidden';
}

async function _restoreNavSnapshot(snap) {
  const main = document.getElementById('main');
  switch (snap.view) {
    case 'home':
      state.view = 'home'; state.playlist = null; clearSelection();
      setActiveNav('home'); renderSidebarPlaylists(); showViewEl('home');
      await loadHome();
      break;
    case 'artists':
      state.view = 'artists'; state.playlist = null;
      state._artistsScrollTop = snap.scrollTop || 0;
      clearSelection(); setActiveNav('artists'); renderSidebarPlaylists(); showViewEl('artists');
      await loadArtists();
      return; // loadArtists restores scrollTop internally
    case 'albums':
      state.artist = snap.artist; state.view = 'albums'; state.playlist = null;
      clearSelection(); setActiveNav('albums'); renderSidebarPlaylists(); showViewEl('albums');
      await loadAlbums(snap.artist || undefined);
      break;
    case 'tracks':
      state.artist = snap.artist; state.album = snap.album; state.view = 'tracks';
      clearSelection(); setActiveNav(null); renderSidebarPlaylists(); showViewEl('tracks');
      await loadTracks(snap.artist, snap.album);
      break;
    case 'playlist':
      if (snap.playlistId === '__favourite_songs__') {
        await openFavouriteSongsPlaylist();
      } else if (snap.playlistId) {
        await openPlaylist(snap.playlistId);
      }
      return;
    case 'songs':
      state.view = 'songs'; state.playlist = null; clearSelection();
      setActiveNav('songs'); renderSidebarPlaylists(); showViewEl('songs');
      await loadSongsView();
      break;
    case 'favourites':
      state.view = 'favourites'; state.favPanel = snap.favPanel || 'artists';
      state.playlist = null; clearSelection();
      setActiveNav('favourites'); renderSidebarPlaylists(); showViewEl('favourites');
      await loadFavouritesSummary();
      break;
    case 'playlists':
      state.view = 'playlists'; state.playlist = null; clearSelection();
      setActiveNav('playlists'); renderSidebarPlaylists(); showViewEl('playlists');
      await loadPlaylistsView();
      break;
    case 'gear':
      state.view = 'gear'; state.playlist = null; clearSelection();
      setActiveNav('gear'); renderSidebarPlaylists(); showViewEl('gear');
      await loadGearView();
      break;
    case 'dap-detail':
      if (snap.dapId) await showDapDetail(snap.dapId);
      return;
    case 'iem-detail':
      if (snap.iemId) await showIemDetail(snap.iemId);
      return;
    case 'settings':
      state.view = 'settings'; state.playlist = null; clearSelection();
      setActiveNav('settings'); renderSidebarPlaylists(); showViewEl('settings');
      setHealthSectionExpanded(false); await loadSettings();
      break;
    case 'insights':
      state.view = 'insights'; state.playlist = null; clearSelection();
      setActiveNav('insights'); renderSidebarPlaylists(); showViewEl('insights');
      await loadInsightsView();
      break;
    case 'missing-tags':
      await openMissingTagsEditor();
      return;
  }
  if (main && snap.scrollTop !== undefined) {
    setTimeout(() => { main.scrollTop = snap.scrollTop; }, 60);
  }
}

async function navBack() {
  if (_navHistory.length === 0) return;
  if (!_guardMlGeneratorNavigation()) return;
  if (!_guardPeqEditorNavigation()) return;
  if (!_guardModalNavigation()) return;
  _closeModalOverlaysForNavigation();
  const prevSnap = _navHistory.pop();
  _isNavigatingBack = true;
  try { await _restoreNavSnapshot(prevSnap); } finally { _isNavigatingBack = false; }
  _updateNavButtonStates();
}


async function showArtist(artist) {
  if (!_guardMlGeneratorNavigation()) return;
  if (!_guardPeqEditorNavigation()) return;
  if (!_guardModalNavigation()) return;
  _closeModalOverlaysForNavigation();
  _pushToNavHistory();
  const main = document.getElementById('main');
  state._artistsScrollTop = main ? main.scrollTop : 0;
  state.artist = artist;
  state.view = 'albums';
  clearSelection();
  setActiveNav('albums');
  renderSidebarPlaylists();
  showViewEl('albums');
  try {
    // Keep artist metadata fresh so detail hero uses the latest curated artist image.
    state.artists = await api('/library/artists');
  } catch (_) {}
  await loadAlbums(artist);
}

async function showAlbum(artist, album) {
  if (!_guardMlGeneratorNavigation()) return;
  if (!_guardPeqEditorNavigation()) return;
  if (!_guardModalNavigation()) return;
  _closeModalOverlaysForNavigation();
  _pushToNavHistory();
  state.artist = artist;
  state.album = album;
  state.view = 'tracks';
  clearSelection();
  setActiveNav(null);
  renderSidebarPlaylists();
  showViewEl('tracks');
  await loadTracks(artist, album);
}

async function showArtistTracks(artist) {
  if (!_guardMlGeneratorNavigation()) return;
  if (!_guardPeqEditorNavigation()) return;
  _pushToNavHistory();
  state.artist = artist;
  state.album = null;
  state.view = 'tracks';
  clearSelection();
  setActiveNav(null);
  renderSidebarPlaylists();
  showViewEl('tracks');
  await loadTracks(artist, null);
}

async function rescan() {
  await api('/library/scan', { method: 'POST' }).catch(() => {});
  pollScanStatus();
}

async function rescanClean() {
  await api('/library/scan?clean=true', { method: 'POST' }).catch(() => {});
  pollScanStatus();
}

function toggleRescanMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('rescan-menu');
  const isOpen = menu.style.display === 'block';
  menu.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    setTimeout(() => document.addEventListener('click', closeRescanMenu, { once: true }), 0);
  }
}

function closeRescanMenu() {
  const menu = document.getElementById('rescan-menu');
  if (menu) menu.style.display = 'none';
}

/* ── Settings ───────────────────────────────────────────────────────── */
let _settings = {};

async function loadSettings() {
  _settings = await api('/settings').catch(() => ({}));
}

function showSettings() {
  document.getElementById('s-poweramp-mount').value  = _settings.poweramp_mount  || '';
  document.getElementById('s-poweramp-prefix').value = _settings.poweramp_prefix || '';
  document.getElementById('s-ap80-mount').value      = _settings.ap80_mount      || '';
  document.getElementById('settings-modal').style.display = 'flex';
}

function closeSettings() {
  document.getElementById('settings-modal').style.display = 'none';
}

async function saveSettings() {
  const updated = {
    poweramp_mount:   document.getElementById('s-poweramp-mount').value.trim(),
    poweramp_prefix:  document.getElementById('s-poweramp-prefix').value.trim(),
    ap80_mount:       document.getElementById('s-ap80-mount').value.trim(),
  };
  _settings = await api('/settings', { method: 'PUT', body: updated });
  closeSettings();
  toast('Settings saved');
}

/* ── Help modal ─────────────────────────────────────────────────────── */
async function renderHelpCenter() {
  const [settings, daps] = await Promise.all([
    api('/settings').catch(() => ({})),
    api('/daps').catch(() => []),
  ]);

  const libraryRoot = settings.library_path || '/Volumes/Storage/Music/FLAC';
  const dataDir = settings._data_dir || 'App data folder';
  const libraryRootEl = document.getElementById('help-library-root');
  const dataDirEl = document.getElementById('help-data-dir');
  if (libraryRootEl) libraryRootEl.textContent = libraryRoot;
  if (dataDirEl) dataDirEl.textContent = dataDir;

  const listEl = document.getElementById('help-device-list');
  if (!listEl) return;
  if (!daps.length) {
    listEl.innerHTML = `
      <div class="help-device-empty">
        No DAPs configured yet. Add one in <strong>Gear</strong> to see export path guidance here.
      </div>
    `;
    return;
  }

  listEl.innerHTML = daps.map(dap => {
    const mounted = !!dap.mounted;
    const mountPath = dap.mount_path || 'Not set';
    const exportFolder = dap.export_folder || 'Playlists';
    const pathPrefix = dap.path_prefix || '(none)';
    return `
      <div class="help-device-card">
        <div class="help-device-top">
          <div class="help-device-name">${esc(dap.name || 'Unnamed device')}</div>
          <span class="help-device-status ${mounted ? 'ok' : 'warn'}">${mounted ? 'Connected' : 'Not connected'}</span>
        </div>
        <p class="help-device-kv"><strong>Mount path:</strong> <code>${esc(mountPath)}</code></p>
        <p class="help-device-kv"><strong>Export folder:</strong> <code>${esc(exportFolder)}</code></p>
        <p class="help-device-kv"><strong>Track path prefix:</strong> <code>${esc(pathPrefix)}</code></p>
      </div>
    `;
  }).join('');
}

function showHelp() {
  document.getElementById('help-modal').style.display = 'flex';
  renderHelpCenter();
}
function closeHelp() {
  document.getElementById('help-modal').style.display = 'none';
}

/* ── Import ─────────────────────────────────────────────────────────── */
let _importData = null;
let _importMappings = {};          // idx → { trackId, title, artist }
const _mapSearchTimers = {};

function triggerImport() {
  const input = document.getElementById('import-file-input');
  input.value = '';
  input.click();
}

async function handleImportFile(input) {
  const file = input.files[0];
  if (!file) return;

  const content = await file.text();
  // Extract name: prefer #PLAYLIST: tag, fallback to filename
  const playlistTag = content.match(/^#PLAYLIST:(.+)/m);
  const name = playlistTag
    ? playlistTag[1].trim()
    : file.name.replace(/\.(m3u8?|M3U8?)$/, '').trim();

  toast('Analysing playlist…');

  let result;
  try {
    result = await api('/playlists/import', {
      method: 'POST',
      body: { content, name, create: false },
    });
  } catch (e) {
    toast('Import error: ' + e.message);
    return;
  }

  _importData = result;
  showImportModal(result);
}

function showImportModal(data) {
  document.getElementById('import-name-input').value = data.name;

  const summary = document.getElementById('import-summary');
  const total = data.matched + data.unmatched;
  if (data.matched === 0) {
    summary.innerHTML = `<span style="color:#f87171">No tracks matched in your library.</span> ${total} entr${total !== 1 ? 'ies' : 'y'} in the file.`;
    document.getElementById('import-confirm-btn').disabled = true;
  } else {
    const matchPct = Math.round((data.matched / total) * 100);
    summary.innerHTML =
      `<span style="color:#4ade80">✓ ${data.matched} track${data.matched !== 1 ? 's' : ''} matched</span>` +
      (data.unmatched ? `  ·  <span style="color:#f87171">${data.unmatched} unmatched</span>` : '') +
      `  ·  ${matchPct}% of ${total} entries`;
    document.getElementById('import-confirm-btn').disabled = false;
  }

  const unmatchedWrap = document.getElementById('import-unmatched-wrap');
  const unmatchedList = document.getElementById('import-unmatched-list');
  _importMappings = {};
  if (data.unmatched_entries?.length) {
    unmatchedWrap.style.display = 'block';
    unmatchedList.innerHTML = data.unmatched_entries.map((e, idx) => {
      // Parse path segments to extract artist / album folder names
      const parts = e.path.replace(/\\/g, '/').split('/').filter(p => p && p !== '..' && p !== '.');
      const filename = parts[parts.length - 1] || e.path;
      const albumFolder  = parts.length >= 2 ? parts[parts.length - 2] : '';
      const artistFolder = parts.length >= 3 ? parts[parts.length - 3] : '';

      // Prefer EXTINF tags; fall back to folder-derived values
      const displayTitle  = e.title  || filename.replace(/^\d+[\.\-\s]+/, '').replace(/\.flac$/i, '').trim() || filename;
      const displayArtist = e.artist || artistFolder;
      const displayAlbum  = albumFolder;

      // Pre-fill search with the most useful terms
      const preSearch = [displayTitle, displayArtist].filter(Boolean).join(' ');
      const checkIcon = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="3.5"><polyline points="20 6 9 17 4 12"/></svg>`;
      return `<div class="map-row">
        <div class="map-row-source" title="${esc(e.path)}">
          <div class="map-row-title">${esc(displayTitle)}</div>
          <div class="map-row-breadcrumb">${displayArtist ? `<span>${esc(displayArtist)}</span>` : ''}${displayArtist && displayAlbum ? '<span class="map-crumb-sep">›</span>' : ''}${displayAlbum ? `<span>${esc(displayAlbum)}</span>` : ''}</div>
        </div>
        <div class="map-row-target">
          <div id="map-mapped-${idx}" class="map-mapped" style="display:none">
            ${checkIcon}
            <span id="map-mapped-label-${idx}" class="map-mapped-label"></span>
            <button class="map-clear-btn" onclick="App.clearMapping(${idx})" title="Remove mapping">✕</button>
          </div>
          <div id="map-search-wrap-${idx}">
            <input type="text" id="map-input-${idx}" class="map-input"
                   placeholder="Search to map…" value="${esc(preSearch)}"
                   oninput="App.searchForMapping(${idx}, this.value)"
                   onfocus="App.searchForMapping(${idx}, this.value)" />
            <div id="map-results-${idx}" class="map-results" style="display:none"></div>
          </div>
        </div>
      </div>`;
    }).join('');
  } else {
    unmatchedWrap.style.display = 'none';
  }

  document.getElementById('import-modal').style.display = 'flex';
}

function closeImportModal() {
  document.getElementById('import-modal').style.display = 'none';
  _importData = null;
  _importMappings = {};
  Object.keys(_mapSearchTimers).forEach(k => { clearTimeout(_mapSearchTimers[k]); delete _mapSearchTimers[k]; });
}

async function confirmImport() {
  if (!_importData) return;
  const name = document.getElementById('import-name-input').value.trim() || _importData.name;

  // Combine originally matched tracks + user-mapped tracks
  const mappedIds = Object.values(_importMappings).map(m => m.trackId);
  const allIds = [..._importData.matched_track_ids, ...mappedIds];

  if (!allIds.length) { toast('No tracks to import'); return; }

  const pl = await api('/playlists', { method: 'POST', body: { name } });
  await api(`/playlists/${pl.id}/tracks`, {
    method: 'POST',
    body: { track_ids: allIds, force: true },
  });

  const totalAdded = allIds.length;
  closeImportModal();
  await loadPlaylists();
  await openPlaylist(pl.id);
  toast(`Imported "${name}" — ${totalAdded} track${totalAdded !== 1 ? 's' : ''}`);
}

/* ── Import mapping helpers ──────────────────────────────────────────── */
async function searchForMapping(idx, query) {
  clearTimeout(_mapSearchTimers[idx]);
  const resultsEl = document.getElementById(`map-results-${idx}`);
  if (!resultsEl) return;
  if (!query.trim()) { resultsEl.style.display = 'none'; return; }

  _mapSearchTimers[idx] = setTimeout(async () => {
    const tracks = await api(`/library/tracks?q=${encodeURIComponent(query)}`).catch(() => []);
    const top = tracks.slice(0, 6);
    if (!top.length) {
      resultsEl.innerHTML = `<div class="map-result-none">No results found</div>`;
    } else {
      resultsEl.innerHTML = top.map(t => `
        <div class="map-result-item"
             data-id="${esc(t.id)}"
             data-title="${esc(t.title)}"
             data-artist="${esc(t.artist)}"
             onclick="App.selectMapping(${idx}, this.dataset.id, this.dataset.title, this.dataset.artist)">
          <span class="map-result-title">${esc(t.title)}</span>
          <span class="map-result-meta">${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</span>
        </div>`).join('');
    }
    resultsEl.style.display = 'block';
  }, 250);
}

function selectMapping(idx, trackId, title, artist) {
  _importMappings[idx] = { trackId, title, artist };

  // Swap: hide search, show mapped chip
  const searchWrap = document.getElementById(`map-search-wrap-${idx}`);
  const mappedEl   = document.getElementById(`map-mapped-${idx}`);
  const labelEl    = document.getElementById(`map-mapped-label-${idx}`);
  if (searchWrap) searchWrap.style.display = 'none';
  if (labelEl) labelEl.textContent = `${title} — ${artist}`;
  if (mappedEl) mappedEl.style.display = 'flex';

  // Close results dropdown
  const resultsEl = document.getElementById(`map-results-${idx}`);
  if (resultsEl) resultsEl.style.display = 'none';

  _updateMappingCount();
}

function clearMapping(idx) {
  delete _importMappings[idx];

  const searchWrap = document.getElementById(`map-search-wrap-${idx}`);
  const mappedEl   = document.getElementById(`map-mapped-${idx}`);
  if (mappedEl)   mappedEl.style.display = 'none';
  if (searchWrap) searchWrap.style.display = 'block';

  _updateMappingCount();
}

function _updateMappingCount() {
  if (!_importData) return;
  const mappedCount = Object.keys(_importMappings).length;
  const total = _importData.matched + mappedCount;
  const btn = document.getElementById('import-confirm-btn');
  if (btn) {
    btn.disabled = total === 0;
    btn.textContent = mappedCount > 0
      ? `Import Playlist (${total} tracks)`
      : 'Import Playlist';
  }
}

/* ── Sync ────────────────────────────────────────────────────────────── */
let _syncPollTimer = null;
let _syncLastStatus = null;
let _syncSelectedDapId = '';
let _syncSelectedDapName = 'Selected device';
let _syncScanRunId = 0;
let _syncScanInFlight = false;
let _syncPreviewWarningCount = 0;
const _syncSectionCollapsed = { local: true, device: true };

function _fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const decimals = v >= 100 || i === 0 ? 0 : (v >= 10 ? 1 : 2);
  return `${v.toFixed(decimals)} ${units[i]}`;
}

function _formatSyncPhaseMessage(raw, phase) {
  const msg = String(raw || '').trim();
  if (!msg) {
    if (phase === 'scan') return 'Scanning your library files…';
    if (phase === 'copy') return 'Copying selected files…';
    if (phase === 'done') return 'Sync complete.';
    return '';
  }
  const progressMatch = msg.match(/(\d+)\s*\/\s*(\d+)/);
  if (phase === 'scan') {
    if (progressMatch) return `Scanning files (${progressMatch[1]} / ${progressMatch[2]})…`;
    return msg;
  }
  if (phase === 'copy') {
    if (progressMatch) return `Copying files (${progressMatch[1]} / ${progressMatch[2]})…`;
    return msg;
  }
  if (phase === 'done') {
    return msg;
  }
  return msg;
}

function _syncDeviceStatusPills(dap) {
  const summary = dap?.sync_summary || {};
  const add = Number(summary.music_to_add_count || 0);
  const remove = Number(summary.music_to_remove_count || 0);
  const musicOut = Number(summary.music_out_of_sync_count || (add + remove));
  const playlistOut = Number(summary.playlist_out_of_sync_count || (Number(dap?.stale_count || 0) + Number(dap?.never_exported || 0)));

  const musicLabel = musicOut <= 0
    ? 'Music synced'
    : `Music ${add} add · ${remove} remove`;
  const playlistLabel = playlistOut <= 0
    ? 'Playlists synced'
    : `Playlists ${playlistOut} out of sync`;

  return `
    <div class="sync-device-card-statuses">
      ${_gearStatusPillHtml(_GEAR_ICON_MUSIC, musicOut <= 0 ? 'gear-sync-ok' : 'gear-sync-stale', musicLabel)}
      ${_gearStatusPillHtml(_GEAR_ICON_PLAYLIST, playlistOut <= 0 ? 'gear-sync-ok' : 'gear-sync-stale', playlistLabel)}
    </div>
  `;
}

function _syncPhase(name) {
  const phaseMeta = {
    pick: {
      step: 'Step 1 of 5',
      title: 'Sync Music',
      subtitle: 'Choose a connected device to start syncing.',
    },
    scanning: {
      step: 'Step 2 of 5',
      title: 'Scanning Library',
      subtitle: 'Comparing your local library and selected device.',
    },
    preview: {
      step: 'Step 3 of 5',
      title: 'Review Changes',
      subtitle: 'Select what to copy before starting sync.',
    },
    copying: {
      step: 'Step 4 of 5',
      title: 'Sync in Progress',
      subtitle: 'Copying selected files. Keep this modal open.',
    },
    done: {
      step: 'Step 5 of 5',
      title: 'Sync Complete',
      subtitle: 'Review the summary and run another scan if needed.',
    },
  };

  const meta = phaseMeta[name];
  if (meta) {
    const stepEl = document.getElementById('sync-modal-step-label');
    const titleEl = document.getElementById('sync-modal-title');
    const subtitleEl = document.getElementById('sync-modal-subtitle');
    if (stepEl) stepEl.textContent = meta.step;
    if (titleEl) titleEl.textContent = meta.title;
    if (subtitleEl) subtitleEl.textContent = meta.subtitle;
  }

  const progressBanner = document.getElementById('sync-progress-banner');
  const progressBannerText = document.getElementById('sync-progress-banner-text');
  const showBusyBanner = name === 'scanning' || name === 'copying';
  const showWarningBanner = name === 'preview' && _syncPreviewWarningCount > 0;
  if (progressBanner) {
    progressBanner.style.display = (showBusyBanner || showWarningBanner) ? '' : 'none';
    progressBanner.classList.toggle('is-warning', showWarningBanner && !showBusyBanner);
  }
  if (progressBannerText) {
    if (showBusyBanner) {
      progressBannerText.textContent = name === 'copying'
        ? 'Sync in progress. Copying files now.'
        : 'Sync in progress - do not dismiss.';
    } else if (showWarningBanner) {
      progressBannerText.textContent = `Warnings detected: ${_syncPreviewWarningCount} item${_syncPreviewWarningCount === 1 ? '' : 's'}. Review before syncing.`;
    }
  }

  const modal = document.getElementById('sync-modal');
  if (modal) modal.setAttribute('data-phase', name);
  document.querySelectorAll('#sync-modal .sync-phase-step').forEach(el => {
    el.classList.toggle('active', el.dataset.step === name);
  });
  ['pick', 'scanning', 'preview', 'copying', 'done'].forEach(p => {
    const el = document.getElementById(`sync-phase-${p}`);
    if (el) el.style.display = p === name ? '' : 'none';
  });
}

async function showSync() {
  const modal = document.getElementById('sync-modal');
  if (modal) modal.style.display = 'flex';

  const container = document.getElementById('sync-device-list');
  if (container) {
    container.innerHTML = `
      <div class="sync-device-loading">
        <div class="sync-device-loading-spinner" aria-hidden="true"></div>
        <span>Loading your DAPs and sync status…</span>
      </div>
    `;
  }

  await api('/sync/reset', { method: 'POST' }).catch(() => {});
  _syncLastStatus = null;
  _syncSelectedDapId = '';
  _syncSelectedDapName = 'Selected device';
  _syncScanInFlight = false;
  _syncPreviewWarningCount = 0;
  _syncPhase('pick');
  const errWrap = document.getElementById('sync-errors-wrap');
  if (errWrap) errWrap.style.display = 'none';
  const doneTitle = document.getElementById('sync-done-title');
  const doneCopy = document.getElementById('sync-done-copy');
  const doneDetail = document.getElementById('sync-done-detail');
  if (doneTitle) doneTitle.textContent = 'Sync Complete';
  if (doneCopy) doneCopy.textContent = 'Your library and DAP are now in harmony.';
  if (doneDetail) doneDetail.textContent = '';

  const daps = await api('/daps').catch(() => []);
  if (!container) { document.getElementById('sync-modal').style.display = 'flex'; return; }

  const svgDevice = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18" stroke-width="3"/></svg>`;

  const _deviceMeta = (dap) => {
    const summary = dap?.sync_summary || {};
    const total = Number(summary.space_total_bytes || 0);
    const free = Number(summary.space_available_bytes || 0);
    if (dap?.mounted && Number.isFinite(total) && total > 0 && Number.isFinite(free) && free >= 0) {
      return `${_fmtBytes(free)} free of ${_fmtBytes(total)}`;
    }
    if (dap?.mount_path) {
      return dap.mount_path;
    }
    return dap?.mounted ? 'Connected' : 'Not connected';
  };

  if (!daps.length) {
    container.innerHTML = `<p style="color:var(--text-muted);font-size:13px">No DAPs configured — add one in <strong>Gear → DAPs</strong> first.</p>`;
  } else {
    const firstMounted = daps.find(d => d?.mounted);
    _syncSelectedDapId = String((firstMounted || {}).id || '');
    _syncSelectedDapName = String((firstMounted || {}).name || 'Selected device');
    container.innerHTML = daps.map(dap => {
      const selectable = !!dap?.mounted;
      const selected = selectable && String(dap.id) === String(_syncSelectedDapId);
      return `
        <button
          class="sync-device-card${selected ? ' is-selected' : ''}${selectable ? '' : ' is-disabled'}"
          data-dap-id="${esc(dap.id)}"
          data-selectable="${selectable ? '1' : '0'}"
          onclick="App.selectSyncDevice('${dap.id}')"
          ${selectable ? '' : 'disabled aria-disabled="true"'}
        >
          <div class="sync-device-card-icon">${svgDevice}</div>
          <div class="sync-device-card-info">
            <span class="sync-device-card-name">${esc(dap.name)}</span>
            <span class="sync-device-meta">
              ${esc(_deviceMeta(dap))}
            </span>
          </div>
          <div class="sync-device-radio${selected ? ' is-selected' : ''}" aria-hidden="true">
            <span></span>
          </div>
        </button>`;
    }).join('');
  }

  syncUpdatePickNextCta();
  document.getElementById('sync-modal').style.display = 'flex';
}

function closeSyncModal() {
  clearInterval(_syncPollTimer);
  _syncPollTimer = null;
  _syncScanRunId += 1;
  _syncScanInFlight = false;
  _syncSelectedDapId = '';
  _syncSelectedDapName = 'Selected device';
  _syncPreviewWarningCount = 0;
  document.getElementById('sync-modal').style.display = 'none';
}

function selectSyncDevice(dapId) {
  const container = document.getElementById('sync-device-list');
  const targetId = String(dapId || '');
  const target = container
    ? [...container.querySelectorAll('.sync-device-card')].find((el) => String(el.getAttribute('data-dap-id') || '') === targetId)
    : null;
  if (target?.dataset?.selectable !== '1') {
    return;
  }
  _syncSelectedDapId = targetId;
  _syncSelectedDapName = String(target.querySelector('.sync-device-card-name')?.textContent || '').trim() || 'Selected device';
  if (container) {
    [...container.querySelectorAll('.sync-device-card')].forEach((el) => {
      const cardId = String(el.getAttribute('data-dap-id') || '');
      const selectable = el.dataset.selectable === '1';
      el.classList.toggle('is-selected', selectable && cardId === _syncSelectedDapId);
      const radio = el.querySelector('.sync-device-radio');
      if (radio) radio.classList.toggle('is-selected', selectable && cardId === _syncSelectedDapId);
    });
  }
  syncUpdatePickNextCta();
}

function syncUpdatePickNextCta() {
  const nextBtn = document.getElementById('sync-pick-next-btn');
  if (!nextBtn) return;
  const container = document.getElementById('sync-device-list');
  const selectedId = String(_syncSelectedDapId || '');
  const selected = container
    ? [...container.querySelectorAll('.sync-device-card')].find((el) => String(el.getAttribute('data-dap-id') || '') === selectedId)
    : null;
  const canContinue = !!_syncSelectedDapId && selected?.dataset?.selectable === '1';
  nextBtn.disabled = !canContinue;
}

async function startSyncFromSelection() {
  if (!_syncSelectedDapId) {
    toast('Select a device to continue.');
    return;
  }
  await startSyncScan(_syncSelectedDapId);
}

function _syncSetScanningVisualProgress(percent) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const ring = document.getElementById('sync-scan-ring');
  const label = document.getElementById('sync-scan-percent');
  if (ring) ring.style.setProperty('--scan-pct', String(pct));
  if (label) label.textContent = `${Math.round(pct)}%`;
}

function _syncSetCopyVisualProgress(percent) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const ring = document.getElementById('sync-copy-ring');
  const label = document.getElementById('sync-copy-percent');
  if (ring) ring.style.setProperty('--scan-pct', String(pct));
  if (label) label.textContent = `${Math.round(pct)}%`;
}

function _syncDeviceNameLabel() {
  const name = String(_syncSelectedDapName || '').trim();
  return name || 'Selected device';
}

function _syncUpdatePreviewDirectionLabels() {
  const deviceLabel = _syncDeviceNameLabel();
  const localTitle = document.getElementById('sync-local-title');
  const deviceTitle = document.getElementById('sync-device-title');
  const playlistTitle = document.getElementById('sync-playlist-title');
  if (localTitle) localTitle.textContent = `Tracks to Add to ${deviceLabel}`;
  if (deviceTitle) deviceTitle.textContent = 'Tracks to Add to Local Library';
  if (playlistTitle) playlistTitle.textContent = `Playlists to Sync to ${deviceLabel}`;
}

async function startSyncScan(dapId) {
  if (_syncScanInFlight) return;
  _syncScanInFlight = true;
  const runId = ++_syncScanRunId;
  _syncPhase('scanning');
  const scanMode = document.getElementById('sync-scan-mode');
  if (scanMode) scanMode.textContent = 'Scanning';
  _syncSetScanningVisualProgress(0);
  document.getElementById('sync-scanning-msg').textContent = 'Scanning device…';
  const scanStartedAt = Date.now();
  let visualPct = 0;
  const setVisualPct = (nextPct, force = false) => {
    const normalized = Math.max(0, Math.min(100, Number(nextPct) || 0));
    if (!force && normalized < visualPct) return;
    visualPct = normalized;
    _syncSetScanningVisualProgress(visualPct);
  };
  const preflightAnimTimer = setInterval(() => {
    if (runId !== _syncScanRunId) return;
    const elapsedSec = (Date.now() - scanStartedAt) / 1000;
    const easedPct = 8 + (1 - Math.exp(-elapsedSec / 6.8)) * 72;
    setVisualPct(easedPct);
  }, 260);

  const res = await api('/sync/scan', { method: 'POST', body: { dap_id: dapId } });
  clearInterval(preflightAnimTimer);
  if (runId !== _syncScanRunId) {
    _syncScanInFlight = false;
    return;
  }
  if (res.error) {
    _syncScanInFlight = false;
    toast(res.error);
    _syncPhase('pick');
    return;
  }

  // Poll status while scanning/copy-prep progresses
  clearInterval(_syncPollTimer);
  let polling = false;
  let finished = false;
  _syncPollTimer = setInterval(async () => {
    if (finished || polling || runId !== _syncScanRunId) return;
    polling = true;
    const elapsedSec = (Date.now() - scanStartedAt) / 1000;
    const easedPct = 10 + (1 - Math.exp(-elapsedSec / 6.8)) * 76;
    setVisualPct(easedPct);

    const status = await api('/sync/status').catch(() => null);
    if (!status || runId !== _syncScanRunId) {
      polling = false;
      return;
    }

    const explicitPct = Number(status.progress_pct ?? status.progress ?? status.percent);
    if (Number.isFinite(explicitPct)) {
      setVisualPct(explicitPct);
    }

    document.getElementById('sync-scanning-msg').textContent =
      _formatSyncPhaseMessage(status.current || status.message, 'scan');

    if (status.status === 'ready') {
      finished = true;
      setVisualPct(100, true);
      clearInterval(_syncPollTimer);
      _syncPollTimer = null;
      _syncScanInFlight = false;
      renderSyncPreview(status);
    } else if (status.status === 'error') {
      finished = true;
      clearInterval(_syncPollTimer);
      _syncPollTimer = null;
      _syncScanInFlight = false;
      toast('Could not complete scan: ' + status.message);
      _syncPhase('pick');
    }
    polling = false;
  }, 600);
}

function _syncFileRows(paths, side, reasons = {}) {
  if (!paths.length) {
    return `<div class="sync-empty">No files to sync in this direction.</div>`;
  }
  const deviceLabel = _syncDeviceNameLabel();
  const originLabel = side === 'local'
    ? `Local Library → ${deviceLabel}`
    : `${deviceLabel} → Local Library`;
  return paths.map((p) => {
    const parts = p.replace(/\\/g, '/').split('/');
    const filename = parts[parts.length - 1];
    const folder = parts.slice(0, -1).join('/');
    const reason = String(reasons[p] || '').trim();
    return `<label class="sync-file-row sync-file-row--preview">
      <input type="checkbox" class="sync-chk sync-chk-${side}" data-path="${esc(p)}" checked onchange="App.syncSelectionChanged()" />
      <div class="sync-file-main">
        <span class="sync-file-name">${esc(filename)}</span>
        <span class="sync-file-folder">${esc(folder)}/</span>
        ${reason ? `<span class="sync-file-reason">${esc(reason)}</span>` : ''}
      </div>
      <div class="sync-file-origin">${originLabel}</div>
    </label>`;
  }).join('');
}

function _syncPlaylistRows(items = []) {
  if (!items.length) {
    return `<div class="sync-empty">No playlists need syncing.</div>`;
  }
  const deviceLabel = _syncDeviceNameLabel();
  return items.map((pl) => {
    const pid = String(pl.id || '');
    const name = String(pl.name || 'Playlist');
    const trackCount = Number(pl.track_count || 0);
    const reason = String(pl.reason || '').trim();
    return `<label class="sync-file-row sync-file-row--preview">
      <input type="checkbox" class="sync-chk sync-chk-playlists" data-plid="${esc(pid)}" checked onchange="App.syncSelectionChanged()" />
      <div class="sync-file-main">
        <span class="sync-file-name">${esc(name)}</span>
        <span class="sync-file-folder">${trackCount} track${trackCount === 1 ? '' : 's'}</span>
        ${reason ? `<span class="sync-file-reason">${esc(reason)}</span>` : ''}
      </div>
      <div class="sync-file-origin">Local Playlists → ${esc(deviceLabel)}</div>
    </label>`;
  }).join('');
}

function _syncWarningRows(items) {
  if (!items || !items.length) return `<div class="sync-empty">No issues detected.</div>`;
  return items.map(msg => `<div class="sync-warning-row">${esc(msg)}</div>`).join('');
}

function _syncApplySectionCollapse(section) {
  const key = section === 'device' ? 'device' : 'local';
  const wrapperId = key === 'local' ? 'sync-section-local' : 'sync-section-device';
  const toggleId = key === 'local' ? 'sync-toggle-local' : 'sync-toggle-device';
  const wrapper = document.getElementById(wrapperId);
  const toggle = document.getElementById(toggleId);
  if (!wrapper || !toggle) return;
  const collapsed = !!_syncSectionCollapsed[key];
  wrapper.classList.toggle('is-collapsed', collapsed);
  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  toggle.title = collapsed ? 'Expand section' : 'Collapse section';
}

function toggleSyncSection(section) {
  const key = section === 'device' ? 'device' : 'local';
  _syncSectionCollapsed[key] = !_syncSectionCollapsed[key];
  _syncApplySectionCollapse(key);
}

function renderSyncPreview(status) {
  _syncLastStatus = status || null;
  _syncUpdatePreviewDirectionLabels();
  document.getElementById('sync-local-count').textContent = status.local_only.length;
  document.getElementById('sync-device-count').textContent = status.device_only.length;
  const playlistsOut = Array.isArray(status.playlists_out_of_sync) ? status.playlists_out_of_sync : [];
  document.getElementById('sync-playlist-count').textContent = playlistsOut.length;
  document.getElementById('sync-list-local').innerHTML = _syncFileRows(
    status.local_only,
    'local',
    status.local_only_reasons || {}
  );
  document.getElementById('sync-list-device').innerHTML = _syncFileRows(
    status.device_only,
    'device',
    status.device_only_reasons || {}
  );
  document.getElementById('sync-list-playlists').innerHTML = _syncPlaylistRows(playlistsOut);
  const warnings = Array.isArray(status.warnings) ? status.warnings : [];
  _syncPreviewWarningCount = warnings.length;
  document.getElementById('sync-warning-count').textContent = warnings.length;
  document.getElementById('sync-list-warnings').innerHTML = _syncWarningRows(warnings);
  document.getElementById('sync-warnings-wrap').style.display = 'none';

  // Hide "copy to device" section if nothing to copy
  document.getElementById('sync-section-local').style.display =
    status.local_only.length ? 'block' : 'none';
  document.getElementById('sync-section-device').style.display =
    status.device_only.length ? 'block' : 'none';
  document.getElementById('sync-section-playlists').style.display =
    playlistsOut.length ? 'block' : 'none';
  _syncSectionCollapsed.local = true;
  _syncSectionCollapsed.device = true;
  _syncApplySectionCollapse('local');
  _syncApplySectionCollapse('device');

  const executeBtn = document.getElementById('sync-execute-btn');
  if (executeBtn) executeBtn.disabled = status.local_only.length === 0 && status.device_only.length === 0;

  // Reset select-all checkboxes
  const allLocal = document.getElementById('chk-all-local');
  const allDevice = document.getElementById('chk-all-device');
  const allPlaylists = document.getElementById('chk-all-playlists');
  if (allLocal) allLocal.checked = true;
  if (allDevice) allDevice.checked = true;
  if (allPlaylists) allPlaylists.checked = true;
  syncSelectionChanged();

  _syncPhase('preview');
}

function syncToggleAll(side, checked) {
  document.querySelectorAll(`.sync-chk-${side}`).forEach(cb => cb.checked = checked);
  syncSelectionChanged();
}

function syncSelectionChanged() {
  const panel = document.getElementById('sync-space-summary');
  const estTime = document.getElementById('sync-est-time');
  const status = _syncLastStatus;
  if (!panel || !status) return;
  const selectedLocal = [...document.querySelectorAll('.sync-chk-local:checked')].map(cb => cb.dataset.path);
  const selectedPlaylists = [...document.querySelectorAll('.sync-chk-playlists:checked')].map(cb => cb.dataset.plid);
  const localSizes = status.local_only_sizes || {};
  const required = selectedLocal.reduce((sum, rel) => sum + Number(localSizes[rel] || 0), 0);
  const available = (status.space_available_bytes === null || status.space_available_bytes === undefined)
    ? null
    : Number(status.space_available_bytes);
  const shortfall = (available !== null && required > available) ? (required - available) : 0;
  const executeBtn = document.getElementById('sync-execute-btn');

  const addCount = selectedLocal.length;
  const removeCount = [...document.querySelectorAll('.sync-chk-device:checked')].length;
  const playlistCount = selectedPlaylists.length;
  const noSelection = addCount === 0 && removeCount === 0 && playlistCount === 0;
  const tracksLine = noSelection
    ? 'All synced and sounding great. Nothing to copy right now.'
    : `Selected: ${addCount} track${addCount === 1 ? '' : 's'} to device • ${removeCount} track${removeCount === 1 ? '' : 's'} to local • ${playlistCount} playlist${playlistCount === 1 ? '' : 's'} to sync`;
  let spaceLine = '';
  let className = 'sync-space-summary';

  if (available === null) {
    spaceLine = `Space check unavailable • Required for add: ${_fmtBytes(required)}`;
  } else if (shortfall > 0) {
    spaceLine = `Not enough space • Need ${_fmtBytes(required)}, available ${_fmtBytes(available)} (short by ${_fmtBytes(shortfall)})`;
    className += ' sync-space-summary--danger';
  } else if (noSelection) {
    const remaining = Math.max(0, available - required);
    spaceLine = `Available ${_fmtBytes(available)} • Required ${_fmtBytes(required)} • After sync ${_fmtBytes(remaining)} free`;
    className += ' sync-space-summary--ok';
  } else {
    const remaining = Math.max(0, available - required);
    spaceLine = `Available ${_fmtBytes(available)} • Required ${_fmtBytes(required)} • After sync ${_fmtBytes(remaining)} free`;
    if (remaining < (0.1 * (Number(status.space_total_bytes || 0)))) className += ' sync-space-summary--warn';
    else className += ' sync-space-summary--ok';
  }

  panel.className = className;
  panel.innerHTML = `<div>${esc(tracksLine)}</div><div>${esc(spaceLine)}</div>`;
  if (estTime) {
    if (noSelection) {
      estTime.textContent = '';
    } else {
      const throughputBytesPerSec = 12 * 1024 * 1024;
      const estSeconds = Math.max(10, Math.round(required / throughputBytesPerSec));
      const mins = Math.floor(estSeconds / 60);
      const secs = estSeconds % 60;
      estTime.textContent = `Est. time ~${mins}m ${secs}s`;
    }
  }
  if (executeBtn) {
    if (noSelection) {
      executeBtn.disabled = false;
      executeBtn.textContent = 'Done';
      executeBtn.title = '';
      executeBtn.onclick = () => App.closeSyncModal();
    } else {
      executeBtn.disabled = false;
      if (shortfall > 0) {
        executeBtn.textContent = `Need ${_fmtBytes(shortfall)} More Space`;
        executeBtn.title = `Not enough space: short by ${_fmtBytes(shortfall)}`;
        executeBtn.onclick = () => {
          toast(`Not enough device space. Short by ${_fmtBytes(shortfall)}.`);
        };
      } else {
        executeBtn.textContent = 'Start Sync';
        executeBtn.title = '';
        executeBtn.onclick = () => App.executeSync();
      }
    }
  }
}

async function executeSync() {
  const local_paths = [...document.querySelectorAll('.sync-chk-local:checked')].map(cb => cb.dataset.path);
  const device_paths = [...document.querySelectorAll('.sync-chk-device:checked')].map(cb => cb.dataset.path);
  const playlist_ids = [...document.querySelectorAll('.sync-chk-playlists:checked')].map(cb => cb.dataset.plid);

  if (!local_paths.length && !device_paths.length && !playlist_ids.length) {
    toast('Select at least one file or playlist to sync.');
    return;
  }

  _syncPhase('copying');
  const copyMode = document.getElementById('sync-copying-mode');
  if (copyMode) {
    if (playlist_ids.length > 0 && local_paths.length === 0 && device_paths.length === 0) copyMode.textContent = 'Syncing Playlists';
    else if (local_paths.length > 0 && device_paths.length > 0) copyMode.textContent = 'Syncing';
    else if (device_paths.length > 0) copyMode.textContent = 'Removing';
    else copyMode.textContent = 'Copying';
  }
  document.getElementById('sync-copying-msg').textContent = `Preparing to sync 0 / ${local_paths.length + device_paths.length + playlist_ids.length} items…`;
  _syncSetCopyVisualProgress(0);
  const copyPctEl = document.getElementById('sync-copy-percent');
  if (copyPctEl) copyPctEl.textContent = '0%';
  document.getElementById('sync-copying-current').textContent = '';

  const execRes = await fetch('/api/sync/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ local_paths, device_paths, playlist_ids }),
  });
  if (!execRes.ok) {
    const err = await execRes.json().catch(() => ({}));
    if (err.space_required_bytes !== undefined) {
      toast(`Not enough device space: need ${_fmtBytes(err.space_required_bytes)}, available ${_fmtBytes(err.space_available_bytes)}.`);
    } else {
      toast(err.error || 'Sync failed to start.');
    }
    _syncPhase('preview');
    return;
  }

  clearInterval(_syncPollTimer);
  _syncPollTimer = setInterval(async () => {
    const status = await api('/sync/status').catch(() => null);
    if (!status) return;

    const pct = status.total > 0 ? Math.round((status.progress / status.total) * 100) : 0;
    _syncSetCopyVisualProgress(pct);
    if (copyPctEl) copyPctEl.textContent = pct + '%';
    document.getElementById('sync-copying-msg').textContent =
      _formatSyncPhaseMessage(status.message, 'copy');
    document.getElementById('sync-copying-current').textContent = status.current || '';
    if (copyMode) {
      const modeText = `${status.message || ''} ${status.current || ''}`.toLowerCase();
      if (modeText.includes('remove') || modeText.includes('delet')) copyMode.textContent = 'Removing';
      else if (modeText.includes('copy') || modeText.includes('write')) copyMode.textContent = 'Copying';
      else copyMode.textContent = 'Syncing';
    }

    if (status.status === 'done') {
      clearInterval(_syncPollTimer);
      _showSyncDone(status);
    } else if (status.status === 'error') {
      clearInterval(_syncPollTimer);
      toast('Sync failed: ' + status.message);
    }
  }, 600);
}

function _showSyncDone(status) {
  const issueCount = Array.isArray(status.errors) ? status.errors.length : 0;
  const baseDone = _formatSyncPhaseMessage(status.message, 'done') || 'Sync complete.';
  const titleEl = document.getElementById('sync-done-title');
  const copyEl = document.getElementById('sync-done-copy');
  const detailEl = document.getElementById('sync-done-detail');
  if (titleEl) {
    titleEl.textContent = issueCount ? 'Sync Completed with Issues' : 'Sync Complete';
  }
  if (copyEl) {
    copyEl.textContent = issueCount
      ? `Finished syncing with ${issueCount} issue${issueCount === 1 ? '' : 's'}.`
      : 'Your library and DAP are now in harmony.';
  }
  if (detailEl) {
    detailEl.textContent = baseDone;
  }
  const errWrap = document.getElementById('sync-errors-wrap');
  if (status.errors?.length) {
    errWrap.style.display = 'block';
    document.getElementById('sync-errors-list').innerHTML = status.errors.map(e =>
      `<div class="sync-file-row" style="color:var(--text-muted)">${esc(e)}</div>`
    ).join('');
  } else {
    errWrap.style.display = 'none';
  }
  _syncPhase('done');
  // Refresh DAP sync badges/details so Gear reflects post-sync state immediately.
  loadDapsView().catch(() => {});
  if (state.view === 'dap-detail' && _currentDapId) {
    showDapDetail(_currentDapId).catch(() => {});
  }
}

async function syncScanAgain() {
  await api('/sync/reset', { method: 'POST' }).catch(() => {});
  _syncScanInFlight = false;
  _syncPreviewWarningCount = 0;
  _syncPhase('pick');
}

/* ── DAP management ─────────────────────────────────────────────────── */

// SVG icon used for all DAP cards/headers
const _DAP_SVG = `<span class="gear-mask-icon gear-mask-icon-player-fill" aria-hidden="true"></span>`;
const _IEM_ICON_HTML = `<img src="icons/earphone-1-svgrepo-com.svg" alt="" class="gear-iem-icon-image" loading="lazy" decoding="async" />`;
const _HEADPHONE_SVG  = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`;
const _GEAR_DOTS = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`;
const _GEAR_ICON_MUSIC = `<span class="gear-mask-icon gear-mask-icon-player" aria-hidden="true"></span>`;
const _GEAR_ICON_PLAYLIST = `<span class="gear-mask-icon gear-mask-icon-playlist" aria-hidden="true"></span>`;

function _prettyModelLabel(model) {
  const raw = String(model || 'generic').trim();
  if (!raw) return 'Generic';
  return raw
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function _dapIdentityLine(dap) {
  const model = _prettyModelLabel(dap.model);
  const rawMount = (dap.active_mount_label || dap.active_mount_path || dap.mount_path || '').trim();
  const mountLabel = rawMount.replace(/\s*\(External Drive\)\s*$/i, '');
  if (!mountLabel) return model;
  let shortMount = mountLabel;
  const volMatch = mountLabel.match(/\/Volumes\/([^/]+)/i);
  if (volMatch && volMatch[1]) {
    shortMount = volMatch[1];
  } else if (mountLabel.includes('/') || mountLabel.includes('\\')) {
    shortMount = mountLabel.split(/[\\/]/).filter(Boolean).pop() || mountLabel;
  }
  return `${model} • ${shortMount}`;
}

function _dapMusicStatus(summary = {}, isMounted = false) {
  const add = Number(summary.music_to_add_count || 0);
  const remove = Number(summary.music_to_remove_count || 0);
  const out = Number(summary.music_out_of_sync_count || (add + remove));
  const syncState = String(summary.sync_status_state || 'estimated');
  const verifiedAt = Number(summary.last_verified_at || 0);
  const hasVerified = verifiedAt > 0;
  const ageSec = hasVerified ? Math.max(0, Math.floor(Date.now() / 1000) - verifiedAt) : Number.POSITIVE_INFINITY;
  const staleWindowSec = 24 * 60 * 60;
  const canTrust = isMounted && syncState === 'verified' && hasVerified && ageSec <= staleWindowSec;

  if (!canTrust) {
    return { className: 'gear-sync-neutral', text: 'Check status', detail: '' };
  }
  if (out <= 0) {
    return { className: 'gear-sync-ok', text: 'Library in sync', detail: '' };
  }
  const parts = [];
  if (add > 0) parts.push(`+${add} to copy`);
  if (remove > 0) parts.push(`${remove} extra on device`);
  return {
    className: 'gear-sync-stale',
    text: 'Library update needed',
    detail: parts.join(' · '),
  };
}

function _dapPlaylistStatus(dap, summary = {}) {
  const stale = Number(dap.stale_count || 0);
  const never = Number(dap.never_exported || 0);
  const out = Number(summary.playlist_out_of_sync_count || (stale + never));
  if (out <= 0) {
    return { className: 'gear-sync-ok', text: 'Playlists up to date', detail: '' };
  }
  const detailParts = [];
  if (never > 0) detailParts.push(`${never} new`);
  if (stale > 0) detailParts.push(`${stale} changed`);
  return {
    className: 'gear-sync-stale',
    text: 'Playlists need sync',
    detail: detailParts.join(' · '),
  };
}

function _formatSyncCheckedAt(ts) {
  const n = Number(ts || 0);
  if (!n) return 'Not checked yet';
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - n);
  if (secs < 60) return 'Checked just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `Checked ${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Checked ${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return `Checked ${days} day${days === 1 ? '' : 's'} ago`;
}

function _gearStatusPillHtml(iconSvg, className, text) {
  return `<span class="gear-sync-badge ${className}"><span class="gear-pill-icon">${iconSvg}</span><span>${esc(text)}</span></span>`;
}

async function loadDapsView() {
  document.getElementById('daps-grid').innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  const daps = await api('/daps').catch(() => []);
  const grid  = document.getElementById('daps-grid');
  const empty = document.getElementById('daps-empty');
  if (!daps.length) { grid.innerHTML = ''; empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  grid.innerHTML = daps.map(d => {
    const summary = d.sync_summary || {};
    const musicStatus = _dapMusicStatus(summary, !!d.mounted);
    const playlistStatus = _dapPlaylistStatus(d, summary);
    const statusClass = d.mounted ? 'gear-dap-conn--on' : 'gear-dap-conn--off';
    const statusText = d.mounted ? 'Connected' : 'Not connected';
    const musicTone = musicStatus.className === 'gear-sync-ok'
      ? 'gear-dap-value--ok'
      : (musicStatus.className === 'gear-sync-neutral' ? 'gear-dap-value--neutral' : 'gear-dap-value--warn');
    const playlistTone = playlistStatus.className === 'gear-sync-ok' ? 'gear-dap-value--ok' : 'gear-dap-value--warn';
    const musicValue = musicStatus.className === 'gear-sync-ok'
      ? 'Synced'
      : (musicStatus.className === 'gear-sync-neutral' ? 'Check status' : 'Out of sync');
    const playlistValue = playlistStatus.className === 'gear-sync-ok' ? 'Synced' : 'Out of sync';
    const musicTitle = musicStatus.detail ? ` title="${esc(musicStatus.detail)}"` : '';
    const playlistTitle = playlistStatus.detail ? ` title="${esc(playlistStatus.detail)}"` : '';
    return `
    <div class="gear-card gear-card-dap" onclick="App.showDapDetail('${d.id}')">
      <div class="gear-card-body gear-card-dap-body">
        <div class="gear-card-dap-head">
          <div class="gear-card-name">${esc(d.name)}</div>
          <div class="gear-card-dap-miniicon">${_DAP_SVG}</div>
        </div>
        <div class="gear-card-subline gear-card-dap-connection ${statusClass}">${statusText.toUpperCase()}</div>
        <div class="gear-card-dap-rule"></div>
        <div class="gear-card-dap-status">
          <span class="gear-dap-label">Music</span>
          <span class="gear-dap-value ${musicTone}"${musicTitle}>${musicValue}</span>
          <span class="gear-dap-label">Playlists</span>
          <span class="gear-dap-value ${playlistTone}"${playlistTitle}>${playlistValue}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

/* ── IEM compare state ───────────────────────────────────────────────── */
let _iemCompareMode     = false;
let _iemCompareSelected = new Set();
let _iemCompareChart    = null;

async function loadIemsView() {
  document.getElementById('iems-grid').innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  const iems  = await api('/iems').catch(() => []);
  const grid  = document.getElementById('iems-grid');
  const empty = document.getElementById('iems-empty');
  const cmpBtn = document.getElementById('iems-compare-btn');
  if (!iems.length) {
    grid.innerHTML = '';
    empty.style.display = 'flex';
    if (cmpBtn) cmpBtn.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  // Show compare button only when 2+ IEMs exist
  if (cmpBtn) cmpBtn.style.display = iems.length >= 2 ? '' : 'none';
  _renderIemCards(iems);
}

function _renderIemCards(iems) {
  const grid = document.getElementById('iems-grid');
  if (!grid) return;
  grid.innerHTML = iems.map(i => {
    const typeLabel = String(i.type || 'IEM');
    const isHeadphone = /headphone|over-?ear|on-?ear/i.test(typeLabel);
    const badgeClass  = isHeadphone ? 'gear-badge-hp' : 'gear-badge-iem';
    const peqCount    = i.peq_profiles?.length || 0;
    const peqStr      = peqCount > 0 ? `PEQ ${peqCount}` : '';
    const isSelected  = _iemCompareSelected.has(i.id);
    const clickAction = _iemCompareMode
      ? `App.toggleIemCompareSelect('${i.id}', event)`
      : `App.showIemDetail('${i.id}')`;
    return `
    <div class="gear-card gear-card-iem${isSelected ? ' gear-card--selected' : ''}" id="gear-iem-card-${i.id}" onclick="${clickAction}">
      <div class="gear-card-icon">${isHeadphone ? _HEADPHONE_SVG : _IEM_ICON_HTML}</div>
      <div class="gear-card-body gear-card-iem-body">
        <div class="gear-card-name">${esc(i.name)}</div>
        <div class="gear-card-row">
          <span class="gear-badge ${badgeClass}">${esc(i.type || 'IEM')}</span>
          ${peqStr ? `<span class="gear-sync-badge gear-sync-neutral">${peqStr}</span>` : ''}
        </div>
      </div>
      ${_iemCompareMode
        ? `<div class="gear-compare-check${isSelected ? ' checked' : ''}"></div>`
        : `<div class="gear-card-kebab">${_GEAR_DOTS}</div>`}
    </div>`;
  }).join('');
}

function toggleIemCompareMode() {
  _iemCompareMode = !_iemCompareMode;
  _iemCompareSelected.clear();
  const btn = document.getElementById('iems-compare-btn');
  if (btn) {
    btn.textContent = _iemCompareMode ? 'Cancel' : 'Compare';
    btn.classList.toggle('active', _iemCompareMode);
  }
  _updateIemCompareBar();
  // Re-render cards to show/hide checkboxes
  api('/iems').then(iems => _renderIemCards(iems)).catch(() => {});
}

function toggleIemCompareSelect(iemId, event) {
  if (event) event.stopPropagation();
  if (_iemCompareSelected.has(iemId)) {
    _iemCompareSelected.delete(iemId);
  } else {
    _iemCompareSelected.add(iemId);
  }
  const card = document.getElementById(`gear-iem-card-${iemId}`);
  if (card) {
    card.classList.toggle('gear-card--selected', _iemCompareSelected.has(iemId));
    const chk = card.querySelector('.gear-compare-check');
    if (chk) chk.classList.toggle('checked', _iemCompareSelected.has(iemId));
  }
  _updateIemCompareBar();
}

function _updateIemCompareBar() {
  const bar   = document.getElementById('iem-compare-bar');
  const label = document.getElementById('iem-compare-bar-label');
  const btn   = document.getElementById('iem-compare-submit-btn');
  if (!bar) return;
  const n = _iemCompareSelected.size;
  if (_iemCompareMode) {
    bar.style.display = 'flex';
    if (label) label.textContent = n < 2 ? 'Select 2 or more IEMs to compare' : `${n} IEMs selected`;
    if (btn) { btn.textContent = `Compare ${n > 0 ? n : ''}`; btn.disabled = n < 2; }
  } else {
    bar.style.display = 'none';
  }
}

async function showIemCompare() {
  const ids = [..._iemCompareSelected];
  if (ids.length < 2) return;
  const [primary, ...rest] = ids;
  const params = rest.map(id => `compare=${encodeURIComponent(id)}`).join('&');
  const res = await fetch(`/api/iems/${encodeURIComponent(primary)}/graph?${params}`).catch(() => null);
  if (!res || !res.ok) { showToast('Could not load comparison data.'); return; }
  const data = await res.json();
  _iemCompareLastData = data;
  document.getElementById('iem-compare-modal').style.display = 'flex';
  _buildIemCompareChart(data);
}

function closeIemCompare(event) {
  if (event && event.target !== document.getElementById('iem-compare-modal')) return;
  document.getElementById('iem-compare-modal').style.display = 'none';
  if (_iemCompareChart) { _iemCompareChart.destroy(); _iemCompareChart = null; }
}

function _buildIemCompareChart(data) {
  const canvas = document.getElementById('iem-compare-canvas');
  const legendEl = document.getElementById('iem-compare-legend');
  const hdr = document.querySelector('#iem-compare-modal .iem-compare-hdr');
  if (!canvas) return;
  if (_iemCompareChart) { _iemCompareChart.destroy(); _iemCompareChart = null; }
  if (hdr) {
    let host = document.getElementById('iem-compare-overlay-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'iem-compare-overlay-host';
      host.className = 'fr-overlay-host fr-overlay-host--compare';
      host.setAttribute('data-fr-overlay-host', '1');
      host.setAttribute('data-fr-overlay-context', 'iem-compare');
      const closeBtn = hdr.querySelector('.modal-x-btn');
      if (closeBtn) hdr.insertBefore(host, closeBtn);
      else hdr.appendChild(host);
    }
  }
  _refreshFrOverlayControls();

  // Use backend-assigned colors directly — each IEM has its own palette color
  const datasets = data.curves.map(c => ({
    label:       c.label,
    data:        c.data.map(([f, spl]) => ({ x: f, y: spl })),
    borderColor: c.color,
    borderWidth: c.id.startsWith('baseline-') ? 1.5 : 2.1,
    borderDash:  c.dash ? [6, 4] : undefined,
    pointRadius: 0,
    tension:     0.3,
    hidden:      c.id.startsWith('baseline-'),
  }));

  const regionPlugin = _createFrOverlayPlugin('compareRegions');

  _iemCompareChart = new Chart(canvas, {
    type: 'line',
    plugins: [regionPlugin],
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 200 },
      scales: {
        x: {
          type: 'logarithmic', min: 20, max: 20000,
          title: { display: true, text: 'Frequency (Hz)', color: '#6b6b7b', font: { size: 10, family: 'Inter, sans-serif' } },
          ticks: {
            color: '#6b6b7b', font: { size: 9, family: 'Inter, sans-serif' }, autoSkip: false, maxRotation: 0,
            callback: v => [20,50,100,200,500,1000,2000,5000,10000,20000].includes(v)
              ? (v >= 1000 ? v/1000+'k' : v) : '',
          },
          grid: { color: ctx => [100,1000,10000].includes(ctx.tick?.value)
            ? 'rgba(173,198,255,.12)' : 'rgba(173,198,255,.04)' },
          afterBuildTicks: axis => {
            axis.ticks = [20,30,40,50,60,80,100,150,200,300,400,500,600,800,1000,1500,2000,
              3000,4000,5000,6000,8000,10000,15000,20000].map(v => ({ value: v }));
          },
        },
        y: {
          min: 50, max: 110,
          title: { display: true, text: 'dB', color: '#6b6b7b', font: { size: 10, family: 'Inter, sans-serif' } },
          ticks: { color: '#6b6b7b', font: { size: 9, family: 'Inter, sans-serif' }, stepSize: 10 },
          grid: { color: 'rgba(173,198,255,.06)' },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(30,30,42,0.95)', titleColor: '#adc6ff',
          bodyColor: '#c1c6d7', borderColor: 'rgba(65,71,85,0.3)', borderWidth: 1,
          callbacks: {
            title: items => { const f = items[0].parsed.x; return f >= 1000 ? (f/1000).toFixed(1)+' kHz' : Math.round(f)+' Hz'; },
            label: item => ` ${item.dataset.label}: ${item.parsed.y.toFixed(1)} dB`,
          },
        },
      },
    },
  });

  // Render compact legend
  if (legendEl) {
    legendEl.innerHTML = datasets.map((ds, i) => {
      const dash = ds.borderDash ? 'stroke-dasharray="5 4"' : '';
      return `<div class="compare-legend-item${ds.hidden ? ' compare-legend-item--off' : ''}" onclick="App._toggleCompareDataset(${i})" id="cmp-legend-${i}">
        <svg width="24" height="8" viewBox="0 0 24 8">
          <line x1="0" y1="4" x2="24" y2="4" stroke="${ds.borderColor}" stroke-width="${ds.borderWidth||1.5}" ${dash}/>
        </svg>
        <span class="compare-legend-label">${esc(ds.label)}</span>
      </div>`;
    }).join('');
  }
}

function _toggleCompareDataset(idx) {
  if (!_iemCompareChart) return;
  const visible = !_iemCompareChart.isDatasetVisible(idx);
  _iemCompareChart.setDatasetVisibility(idx, visible);
  _iemCompareChart.update();
  const item = document.getElementById(`cmp-legend-${idx}`);
  if (item) item.classList.toggle('compare-legend-item--off', !visible);
}

async function loadGearView() {
  await Promise.all([loadDapsView(), loadIemsView()]);
}

let _gearPlaylistsCache = { ts: 0, data: null };
async function _getPlaylistsForGear(force = false) {
  const ttlMs = 15000;
  const now = Date.now();
  if (!force && _gearPlaylistsCache.data && (now - _gearPlaylistsCache.ts) < ttlMs) {
    return _gearPlaylistsCache.data;
  }
  const data = await api('/playlists');
  _gearPlaylistsCache = { ts: now, data };
  return data;
}

async function _pollSyncCheckCompletion(targetIds, onDone) {
  const watchIds = new Set((targetIds || []).filter(Boolean));
  return new Promise((resolve) => {
    if (!watchIds.size) {
      Promise.resolve(typeof onDone === 'function' ? onDone() : null).finally(resolve);
      return;
    }
    const startedAt = Date.now();
    const timeoutMs = 120000;
    const tick = async () => {
      if (Date.now() - startedAt > timeoutMs) {
        toast('Sync status check timed out. Try again.');
        await Promise.resolve(typeof onDone === 'function' ? onDone() : null);
        resolve();
        return;
      }
      const daps = await api('/daps').catch(() => []);
      let pending = 0;
      daps.forEach(d => {
        if (!watchIds.has(d.id)) return;
        const state = String((d.sync_summary || {}).sync_status_state || 'estimated');
        if (state === 'checking') pending += 1;
      });
      if (pending === 0) {
        await Promise.resolve(typeof onDone === 'function' ? onDone() : null);
        resolve();
        return;
      }
      setTimeout(tick, 900);
    };
    tick();
  });
}

async function checkAllDapSyncStatus() {
  const btn = document.getElementById('gear-check-sync-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Checking…';
  }
  try {
    const res = await api('/daps/sync-status/check', { method: 'POST' });
    const started = Array.isArray(res.started) ? res.started : [];
    if (!started.length) {
      toast('No mounted DAPs available for live sync check.');
      await loadDapsView();
      return;
    }
    toast(`Checking sync status for ${started.length} device${started.length === 1 ? '' : 's'}…`);
    await _pollSyncCheckCompletion(started, async () => {
      await loadDapsView();
      toast('Sync status check complete.');
    });
  } catch (e) {
    toast('Sync status check failed: ' + e.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Check Sync Status';
    }
  }
}

async function checkDapSyncStatus(did) {
  const btn = document.getElementById('dap-check-sync-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Checking…';
  }
  try {
    await api(`/daps/${did}/sync-status/check`, { method: 'POST' });
    toast('Checking sync status…');
    await _pollSyncCheckCompletion([did], async () => {
      await showDapDetail(did);
      await loadDapsView();
      toast('Sync status updated.');
    });
  } catch (e) {
    toast('Sync status check failed: ' + e.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Check Sync Status';
    }
  }
}

async function showDapDetail(id) {
  _pushToNavHistory();
  _currentDapId = id;
  state.view = 'dap-detail';
  clearSelection();
  setActiveNav('gear');
  showViewEl('dap-detail');

  document.getElementById('dap-detail-content').innerHTML = `
    <div class="spinner-wrap" style="padding:24px 0">
      <div class="spinner"></div>
    </div>
  `;

  const [dap, playlists] = await Promise.all([
    api(`/daps/${id}`),
    _getPlaylistsForGear(),
  ]);

  const exports = dap.playlist_exports || {};
  const summary = dap.sync_summary || {};
  const syncState = String(summary.sync_status_state || 'estimated');
  const syncStateText = syncState === 'checking'
    ? 'Checking live sync status…'
    : syncState === 'verified'
      ? _formatSyncCheckedAt(summary.last_verified_at)
      : syncState === 'error'
        ? (summary.sync_status_message || 'Sync check unavailable')
        : `Estimated • ${_formatSyncCheckedAt(summary.last_scan_at)}`;
  const musicStatus = _dapMusicStatus(summary, !!dap.mounted);
  const playlistStatus = _dapPlaylistStatus(dap, summary);
  const sortedPl = [...playlists].sort((a, b) => a.name.localeCompare(b.name));

  const plRows = sortedPl.map(pl => {
    const ts = exports[pl.id];
    let statusHtml;
    if (!ts) {
      statusHtml = `<span class="gear-sync-badge gear-sync-never">Never exported</span>`;
    } else if (ts < (pl.updated_at || 0)) {
      statusHtml = `<span class="gear-sync-badge gear-sync-stale">⚠ Outdated</span>`;
    } else {
      statusHtml = `<span class="gear-sync-badge gear-sync-ok">✓ Up to date</span>`;
    }
    const canExport = dap.mounted;
    return `
      <tr>
        <td class="dap-pl-name" onclick="App.openPlaylist('${pl.id}')" title="Open playlist">${esc(pl.name)}</td>
        <td>${pl.tracks?.length ?? 0} tracks</td>
        <td>${statusHtml}</td>
        <td class="dap-pl-export-cell">
          <button class="dap-pl-export-btn" ${canExport ? '' : 'disabled title="Device not mounted"'}
            onclick="App.dapExportPlaylist('${dap.id}','${pl.id}',this)">
            ${dap.mounted ? 'Sync' : 'Not mounted'}
          </button>
        </td>
      </tr>
    `;
  }).join('');

  document.getElementById('dap-detail-content').innerHTML = `
    <div class="dap-detail-header">
      <div class="dap-detail-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="14" r="3"/><line x1="9" y1="6" x2="15" y2="6"/></svg></div>
      <div>
        <div class="dap-detail-title">${esc(dap.name)}</div>
        <div class="dap-detail-sub">
          <span class="gear-badge ${dap.mounted ? 'gear-badge-connected' : 'gear-badge-disconnected'}">
            ${dap.mounted ? '● Connected' : '○ Not connected'}
          </span>
          ${_gearStatusPillHtml(_GEAR_ICON_MUSIC, musicStatus.className, musicStatus.text)}
          ${_gearStatusPillHtml(_GEAR_ICON_PLAYLIST, playlistStatus.className, playlistStatus.text)}
        </div>
        ${(musicStatus.detail || playlistStatus.detail)
          ? `<div class="gear-card-meta-text" style="margin-top:6px">${esc([musicStatus.detail, playlistStatus.detail].filter(Boolean).join(' · '))}</div>`
          : ''}
        <div class="gear-card-meta-text" style="margin-top:4px">${esc(syncStateText)}</div>
        <div class="gear-edit-actions">
          <button id="dap-check-sync-btn" class="btn-secondary" onclick="App.checkDapSyncStatus('${dap.id}')" ${syncState === 'checking' ? 'disabled' : ''}>
            ${syncState === 'checking' ? 'Checking…' : 'Check Sync Status'}
          </button>
          <button class="btn-secondary" onclick="App.dapExportAllPlaylists('${dap.id}', this)" ${dap.mounted ? '' : 'disabled title="Device not mounted"'}>
            ${dap.mounted ? 'Sync All Playlists' : 'Not mounted'}
          </button>
          <button class="btn-secondary" onclick="App.showEditDapModal('${dap.id}')">Edit</button>
          <button class="btn-danger-sm" onclick="App.deleteDap('${dap.id}')">Delete</button>
        </div>
      </div>
    </div>
    <div class="dap-config-block">
      <div class="dap-config-field"><label>Mount path</label><span>${esc(dap.mount_path || '—')}</span></div>
      <div class="dap-config-field"><label>Storage</label><span>${esc(dap.storage_type === 'internal' ? 'Internal' : 'SD card')}</span></div>
      <div class="dap-config-field"><label>Music folder</label><span>${esc(dap.music_root || 'Music')}</span></div>
      <div class="dap-config-field"><label>Export folder</label><span>${esc(dap.export_folder || 'Playlists')}</span></div>
      <div class="dap-config-field"><label>PEQ folder</label><span>${esc(dap.peq_folder || '~/PEQ')}</span></div>
      <div class="dap-config-field"><label>Sync template</label><span><code>${esc(dap.path_template || DAP_TEMPLATE_PRESETS.artist_album_track)}</code></span></div>
      <div class="dap-config-field"><label>Path prefix</label><span>${esc(dap.path_prefix || '(none)')}</span></div>
      <div class="dap-config-field"><label>Model</label><span>${esc(dap.model || 'generic')}</span></div>
      <div class="dap-config-field"><label>Playlists out of sync</label><span>${Number(summary.playlist_out_of_sync_count || (dap.stale_count || 0) + (dap.never_exported || 0))}</span></div>
      <div class="dap-config-field"><label>Music files out of sync</label><span>${Number(summary.music_out_of_sync_count || 0)} <span class="gear-card-meta-text">(${Number(summary.music_to_add_count || 0)} add • ${Number(summary.music_to_remove_count || 0)} remove)</span></span></div>
      <div class="dap-config-field"><label>Device space</label><span>${summary.space_available_bytes === null || summary.space_available_bytes === undefined ? 'Unavailable' : _fmtBytes(summary.space_available_bytes)}</span></div>
      <div class="dap-config-field"><label>Required for add</label><span>${_fmtBytes(Number(summary.space_required_bytes || 0))}${Number(summary.space_shortfall_bytes || 0) > 0 ? ` <span class="gear-sync-badge gear-sync-stale">Short ${_fmtBytes(Number(summary.space_shortfall_bytes || 0))}</span>` : ''}</span></div>
    </div>
    <div class="dap-section-title">Playlist Sync Status</div>
    <div class="dap-table-shell">
      <table class="dap-pl-table">
        <thead><tr>
          <th>Playlist</th><th>Tracks</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${plRows || '<tr><td colspan="4" class="dap-pl-empty-row">No playlists yet</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

async function dapExportPlaylist(dapId, plId, btn) {
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    await api(`/daps/${dapId}/export/${plId}`, { method: 'POST' });
    btn.textContent = '✓ Synced';
    btn.style.background = '#4caf8f';
    // Refresh stale badge
    const row = btn.closest('tr');
    if (row) {
      const statusCell = row.cells[2];
      if (statusCell) statusCell.innerHTML = `<span class="gear-sync-badge gear-sync-ok">✓ Up to date</span>`;
    }
  } catch (e) {
    toast('Export failed. Check the device is connected.');
    btn.disabled = false;
    btn.textContent = 'Sync';
  }
}

async function dapExportAllPlaylists(dapId, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Syncing…';
  }
  try {
    const res = await api(`/daps/${dapId}/export-all-playlists`, {
      method: 'POST',
      body: { only_out_of_sync: true },
    });
    const exported = Number(res?.exported_count || 0);
    const failed = Number(res?.failed_count || 0);
    toast(`Playlists synced: ${exported}${failed ? `, failed: ${failed}` : ''}`);
    await showDapDetail(dapId);
    await loadDapsView();
  } catch (e) {
    toast('Playlist sync failed: ' + e.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Sync All Playlists';
    }
  }
}

async function showAddDapModal() {
  _ensureGearProfileSelects();
  const firstModel = Object.keys(DAP_MODEL_PRESETS)[0] || 'other';
  const firstPreset = DAP_MODEL_PRESETS[firstModel] || { folder: 'Playlists', prefix: '' };
  document.getElementById('dap-modal-title').textContent = 'Add Device';
  document.getElementById('dap-modal-id').value = '';
  document.getElementById('dap-mount-volume-uuid').value = '';
  document.getElementById('dap-mount-disk-uuid').value = '';
  document.getElementById('dap-mount-device-identifier').value = '';
  document.getElementById('dap-name').value = '';
  document.getElementById('dap-model').value = firstModel;
  document.getElementById('dap-mount').value = '';
  document.getElementById('dap-mount').dataset.prevMountForPeq = '';
  document.getElementById('dap-mount-manual-toggle').checked = false;
  document.getElementById('dap-mount-manual-wrap').style.display = 'none';
  document.getElementById('dap-music-root').value = 'Music';
  document.getElementById('dap-template-preset').value = 'artist_album_track';
  document.getElementById('dap-path-template').value = DAP_TEMPLATE_PRESETS.artist_album_track;
  document.getElementById('dap-export-folder').value = firstPreset.folder || 'Playlists';
  document.getElementById('dap-peq-folder').value = '';
  document.getElementById('dap-prefix').value = firstPreset.prefix || '';
  dapModelPreset(firstModel);
  dapTemplateChanged();
  _closeDapHelpPanels();
  document.getElementById('dap-modal').style.display = 'flex';
  await refreshDapMounts('', true, null, true);
  validateDapForm(false);
  _commitDapModalBaseline();
}

async function showEditDapModal(id) {
  _ensureGearProfileSelects();
  const dap = await api(`/daps/${id}`);
  document.getElementById('dap-modal-title').textContent = 'Edit Device';
  document.getElementById('dap-modal-id').value = id;
  document.getElementById('dap-name').value = dap.name || '';
  const modelSel = document.getElementById('dap-model');
  if (modelSel && dap.model && !Array.from(modelSel.options).some(o => o.value === dap.model)) {
    const opt = document.createElement('option');
    opt.value = dap.model;
    opt.textContent = dap.model;
    modelSel.appendChild(opt);
  }
  document.getElementById('dap-model').value = dap.model || (Object.keys(DAP_MODEL_PRESETS)[0] || 'other');
  document.getElementById('dap-mount').value = dap.mount_path || '';
  document.getElementById('dap-mount').dataset.prevMountForPeq = dap.mount_path || '';
  document.getElementById('dap-mount-volume-uuid').value = dap.mount_volume_uuid || '';
  document.getElementById('dap-mount-disk-uuid').value = dap.mount_disk_uuid || '';
  document.getElementById('dap-mount-device-identifier').value = dap.mount_device_identifier || '';
  document.getElementById('dap-music-root').value = dap.music_root || 'Music';
  document.getElementById('dap-path-template').value = dap.path_template || DAP_TEMPLATE_PRESETS.artist_album_track;
  document.getElementById('dap-template-preset').value = _suggestTemplatePreset(document.getElementById('dap-path-template').value);
  document.getElementById('dap-export-folder').value = dap.export_folder || 'Playlists';
  document.getElementById('dap-peq-folder').value = dap.peq_folder || _defaultPeqFolderForMount(dap.mount_path || '');
  document.getElementById('dap-prefix').value = dap.path_prefix || '';
  _updateDapFolderHint(dap.model || (Object.keys(DAP_MODEL_PRESETS)[0] || 'other'));
  dapTemplateChanged();
  _closeDapHelpPanels();
  document.getElementById('dap-modal').style.display = 'flex';
  await refreshDapMounts(dap.mount_path || '', false, {
    volume_uuid: dap.mount_volume_uuid || '',
    disk_uuid: dap.mount_disk_uuid || '',
    device_identifier: dap.mount_device_identifier || '',
  }, true);
  validateDapForm(false);
  _commitDapModalBaseline();
}

function closeDapModal() {
  _closeDapHelpPanels();
  document.getElementById('dap-modal').style.display = 'none';
  const banner = document.getElementById('dap-unsaved-banner');
  if (banner) banner.style.display = 'none';
  _dapModalInitialJson = '';
}

const _mountPrefix = (() => {
  const os = _getOsPlatform();
  if (os === 'windows') return { base: 'E:\\', sep: '\\' };
  if (os === 'linux') return { base: '/media/', sep: '/' };
  return { base: '/Volumes/', sep: '/' };
})();

let DAP_MODEL_PRESETS = {};
let _gearIemTypes = ['IEM', 'Headphone'];
let _gearProfilesLoaded = false;
let _detectedDapMounts = [];
const DAP_TEMPLATE_PRESETS = {
  artist_album_track: '%artist%/%album%/%track% - %title%',
  artist_track: '%artist%/%track% - %title%',
  albumartist_album_track: '%artist%/%year%/%track% - %title%',
  flat_track: '%genre%/%track% - %title%',
  custom: '%track% - %title%',
};
const DAP_FOLDER_TOKENS = ['%artist%', '%album%', '%year%', '%genre%'];

function _normalizeDapPreset(profile) {
  const mountName = (profile.mount_name || 'MyDAP').replace(/[\\/]/g, '').trim() || 'MyDAP';
  return {
    label: profile.name || profile.model || 'Other',
    mount: _mountPrefix.base + mountName,
    folder: (profile.export_folder || 'Playlists').replace(/^[/\\]+|[/\\]+$/g, ''),
    prefix: profile.path_prefix || '',
    hint: profile.hint || '',
  };
}

function _populateDapModelSelect() {
  const sel = document.getElementById('dap-model');
  if (!sel) return;
  const models = Object.keys(DAP_MODEL_PRESETS);
  sel.innerHTML = models.map(m => `<option value="${esc(m)}">${esc(DAP_MODEL_PRESETS[m].label || m)}</option>`).join('');
  if (!models.length) {
    sel.innerHTML = '<option value="other">Other</option>';
    DAP_MODEL_PRESETS = { other: { label: 'Other', mount: _mountPrefix.base + 'MyDAP', folder: 'Playlists', prefix: '', hint: '' } };
  }
}

function _suggestTemplatePreset(template) {
  const t = (template || '').trim();
  for (const [k, v] of Object.entries(DAP_TEMPLATE_PRESETS)) {
    if (k === 'custom') continue;
    if (v === t) return k;
  }
  return 'custom';
}

function _buildTemplateFromSelectedTokens(tokens) {
  const folders = (tokens || []).filter(t => DAP_FOLDER_TOKENS.includes(t));
  const folderPath = folders.join('/');
  return folderPath ? `${folderPath}/%track% - %title%` : '%track% - %title%';
}

function _setTemplateChipStateFromTemplate(template) {
  const tpl = (template || '').trim();
  const active = DAP_FOLDER_TOKENS.filter(t => tpl.includes(t));
  document.querySelectorAll('.token-chip-row .token-chip').forEach(btn => {
    const tok = btn.dataset.token;
    const isActive = !!tok && active.includes(tok);
    btn.classList.toggle('is-active', isActive);
  });
}

function _renderDapTemplatePreview() {
  const preview = document.getElementById('dap-template-preview');
  const input = document.getElementById('dap-path-template');
  if (!preview || !input) return;
  const tpl = (input.value || '').trim() || '%track% - %title%';
  const sample = {
    artist: 'Linkin Park',
    albumartist: 'Linkin Park',
    album: 'Meteora',
    track: '03',
    title: 'Numb',
    year: '2003',
    genre: 'Alternative Rock',
  };
  let rendered = tpl;
  Object.entries(sample).forEach(([k, v]) => {
    rendered = rendered.split(`%${k}%`).join(v);
  });
  if (!/\.[a-z0-9]{2,5}$/i.test(rendered)) rendered += '.flac';
  const root = ((document.getElementById('dap-music-root')?.value || 'Music').trim().replace(/\\/g, '/')).replace(/^\/+|\/+$/g, '');
  const full = [root, rendered].filter(Boolean).join('/');
  const breadcrumb = full.split('/').filter(Boolean).join(' › ');
  preview.innerHTML = `<span class="dap-template-preview-label">Preview file path</span><code class="dap-template-preview-path">${esc(breadcrumb)}</code>`;
}

function _validateDapTemplate(showToast = false) {
  const input = document.getElementById('dap-path-template');
  const msgEl = document.getElementById('dap-template-validation');
  if (!input || !msgEl) return true;
  const tpl = (input.value || '').trim();
  let error = '';

  if (!tpl) {
    error = 'Path template is required.';
  } else if (tpl.includes('\\')) {
    error = 'Use "/" for path separators.';
  } else if (tpl.includes('//')) {
    error = 'Template cannot include empty path segments ("//").';
  } else if (/[<>:"|?*\x00-\x1f]/.test(tpl)) {
    error = 'Template contains filesystem-invalid characters.';
  } else if (!/%track%\s*-\s*%title%/.test(tpl)) {
    error = 'Template must end with the auto filename pattern: %track% - %title%.';
  }

  if (error) {
    msgEl.textContent = error;
    msgEl.style.display = 'block';
    if (showToast) toast(error);
    return false;
  }
  msgEl.textContent = '';
  msgEl.style.display = 'none';
  return true;
}

function dapTemplatePreset(preset) {
  const input = document.getElementById('dap-path-template');
  if (!input) return;
  if (preset === 'custom') {
    input.value = '';
    input.placeholder = '';
  } else {
    input.placeholder = '%artist%/%album%/%track% - %title%';
  }
  if (preset && preset !== 'custom' && DAP_TEMPLATE_PRESETS[preset]) {
    input.value = DAP_TEMPLATE_PRESETS[preset];
  }
  if (preset === 'custom') {
    _setTemplateChipStateFromTemplate('');
  } else {
    _setTemplateChipStateFromTemplate(input.value);
  }
  _validateDapTemplate(false);
  _renderDapTemplatePreview();
}

function dapTemplateChanged() {
  const sel = document.getElementById('dap-template-preset');
  const input = document.getElementById('dap-path-template');
  if (sel && input) sel.value = _suggestTemplatePreset(input.value);
  if (input) input.placeholder = sel?.value === 'custom' ? '' : '%artist%/%album%/%track% - %title%';
  _setTemplateChipStateFromTemplate(input?.value || '');
  _validateDapTemplate(false);
  _renderDapTemplatePreview();
  validateDapForm(false);
}

function insertDapToken(token) {
  const input = document.getElementById('dap-path-template');
  if (!input) return;
  if (!DAP_FOLDER_TOKENS.includes(token)) return;
  const btn = document.querySelector(`.token-chip-row .token-chip[data-token="${token}"]`);
  if (btn) btn.classList.toggle('is-active');
  const selected = DAP_FOLDER_TOKENS.filter(tok => {
    const b = document.querySelector(`.token-chip-row .token-chip[data-token="${tok}"]`);
    return !!b && b.classList.contains('is-active');
  });
  input.value = _buildTemplateFromSelectedTokens(selected);
  dapTemplateChanged();
}

function _renderDapMountSelect(preferredPath = '') {
  const sel = document.getElementById('dap-device-select');
  if (!sel) return;
  const mounts = Array.isArray(_detectedDapMounts) ? _detectedDapMounts : [];
  if (!mounts.length) {
    sel.innerHTML = '<option value="">No external devices detected</option>';
    sel.value = '';
    return;
  }
  sel.innerHTML = mounts.map(m => `<option value="${esc(m.path)}">${esc(m.label || m.path)}</option>`).join('');
  const prefVolume = (document.getElementById('dap-mount-volume-uuid')?.value || '').trim().toLowerCase();
  const prefDisk = (document.getElementById('dap-mount-disk-uuid')?.value || '').trim().toLowerCase();
  const prefDevice = (document.getElementById('dap-mount-device-identifier')?.value || '').trim().toLowerCase();
  const byIdentity = mounts.find(m =>
    (prefVolume && String(m.volume_uuid || '').trim().toLowerCase() === prefVolume) ||
    (prefDisk && String(m.disk_uuid || '').trim().toLowerCase() === prefDisk) ||
    (prefDevice && String(m.device_identifier || '').trim().toLowerCase() === prefDevice)
  );
  const chosen = (byIdentity && byIdentity.path) || mounts.find(m => m.path === preferredPath)?.path || mounts[0].path;
  sel.value = chosen;
}

function _setDapMountIdentityFields(mountObj) {
  const vol = document.getElementById('dap-mount-volume-uuid');
  const disk = document.getElementById('dap-mount-disk-uuid');
  const dev = document.getElementById('dap-mount-device-identifier');
  if (vol) vol.value = (mountObj && mountObj.volume_uuid) ? String(mountObj.volume_uuid).trim() : '';
  if (disk) disk.value = (mountObj && mountObj.disk_uuid) ? String(mountObj.disk_uuid).trim() : '';
  if (dev) dev.value = (mountObj && mountObj.device_identifier) ? String(mountObj.device_identifier).trim() : '';
}

function _matchMountByIdentity(mounts, identity) {
  if (!identity || !Array.isArray(mounts)) return null;
  const prefVolume = String(identity.volume_uuid || '').trim().toLowerCase();
  const prefDisk = String(identity.disk_uuid || '').trim().toLowerCase();
  const prefDevice = String(identity.device_identifier || '').trim().toLowerCase();
  return mounts.find(m =>
    (prefVolume && String(m.volume_uuid || '').trim().toLowerCase() === prefVolume) ||
    (prefDisk && String(m.disk_uuid || '').trim().toLowerCase() === prefDisk) ||
    (prefDevice && String(m.device_identifier || '').trim().toLowerCase() === prefDevice)
  ) || null;
}

async function refreshDapMounts(preferredPath = '', forceManualOff = false, preferredIdentity = null, commitBaseline = false) {
  const currentPath = (preferredPath || document.getElementById('dap-mount')?.value || '').trim();
  const beforeMount = document.getElementById('dap-mount')?.value || '';
  const currentIdentity = preferredIdentity || {
    volume_uuid: document.getElementById('dap-mount-volume-uuid')?.value || '',
    disk_uuid: document.getElementById('dap-mount-disk-uuid')?.value || '',
    device_identifier: document.getElementById('dap-mount-device-identifier')?.value || '',
  };
  try {
    const data = await api('/system/mounts');
    _detectedDapMounts = Array.isArray(data.mounts) ? data.mounts : [];
  } catch (_) {
    _detectedDapMounts = [];
  }
  const matchedByIdentity = _matchMountByIdentity(_detectedDapMounts, currentIdentity);
  const hasCurrent = !!matchedByIdentity || _detectedDapMounts.some(m => m.path === currentPath);
  const manualToggle = document.getElementById('dap-mount-manual-toggle');
  const shouldManual = forceManualOff ? false : (!!manualToggle?.checked || (!!currentPath && !hasCurrent));
  _renderDapMountSelect(currentPath);
  if (manualToggle) manualToggle.checked = shouldManual;
  toggleDapManualMount(shouldManual);
  if (!shouldManual) {
    const selPath = (matchedByIdentity && matchedByIdentity.path) || document.getElementById('dap-device-select')?.value || '';
    if (document.getElementById('dap-device-select') && selPath) {
      document.getElementById('dap-device-select').value = selPath;
    }
    document.getElementById('dap-mount').value = selPath;
    const selectedMount = _detectedDapMounts.find(m => m.path === selPath) || matchedByIdentity || null;
    _setDapMountIdentityFields(selectedMount);
    _maybeSyncPeqFolderWithMount(selPath, beforeMount, false);
    const mountInput = document.getElementById('dap-mount');
    if (mountInput) mountInput.dataset.prevMountForPeq = selPath || '';
  }
  validateDapForm(false);
  if (commitBaseline && _isOverlayOpen('dap-modal')) {
    _commitDapModalBaseline();
  }
}

function selectDapMount(path) {
  if (document.getElementById('dap-mount-manual-toggle')?.checked) return;
  const beforeMount = document.getElementById('dap-mount')?.value || '';
  const selectedPath = (path || '').trim();
  document.getElementById('dap-mount').value = selectedPath;
  const selectedMount = _detectedDapMounts.find(m => m.path === selectedPath) || null;
  _setDapMountIdentityFields(selectedMount);
  _maybeSyncPeqFolderWithMount(selectedPath, beforeMount, true);
  const mountInput = document.getElementById('dap-mount');
  if (mountInput) mountInput.dataset.prevMountForPeq = selectedPath || '';
  validateDapForm(false);
}

function toggleDapManualMount(enabled) {
  const wrap = document.getElementById('dap-mount-manual-wrap');
  if (wrap) wrap.style.display = enabled ? 'flex' : 'none';
  if (enabled) _setDapMountIdentityFields(null);
  if (!enabled) {
    const beforeMount = document.getElementById('dap-mount')?.value || '';
    const selPath = document.getElementById('dap-device-select')?.value || '';
    document.getElementById('dap-mount').value = selPath;
    const selectedMount = _detectedDapMounts.find(m => m.path === selPath) || null;
    _setDapMountIdentityFields(selectedMount);
    _maybeSyncPeqFolderWithMount(selPath, beforeMount, true);
    const mountInput = document.getElementById('dap-mount');
    if (mountInput) mountInput.dataset.prevMountForPeq = selPath || '';
  }
  validateDapForm(false);
}

function validateDapForm(showToast = false) {
  const name = (document.getElementById('dap-name')?.value || '').trim();
  const mountPath = (document.getElementById('dap-mount')?.value || '').trim();
  const manual = !!document.getElementById('dap-mount-manual-toggle')?.checked;
  const mountMsg = document.getElementById('dap-mount-validation');
  const saveBtn = document.getElementById('dap-save-btn');
  let mountError = '';

  if (!mountPath) {
    mountError = manual ? 'Device location path is required.' : 'Select a connected device location.';
  } else if (!manual && _detectedDapMounts.length && !_detectedDapMounts.some(m => m.path === mountPath)) {
    mountError = 'Selected device is no longer connected. Refresh or switch to manual mode.';
  }

  if (mountMsg) {
    mountMsg.textContent = mountError;
    mountMsg.style.display = mountError ? 'block' : 'none';
  }

  const templateOk = _validateDapTemplate(false);
  const ok = !!name && !mountError && templateOk;
  if (saveBtn) saveBtn.disabled = !ok;

  if (!ok && showToast) {
    if (!name) toast('Device name is required');
    else if (mountError) toast(mountError);
  }
  _updateDapModalUnsavedBanner();
  return ok;
}

function toggleDapTemplateHelp() {
  toggleDapHelp('dap-template-help');
}

function toggleDapHelp(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function _closeDapHelpPanels() {
  document.querySelectorAll('#dap-modal .dap-inline-help, #dap-modal .dap-template-help').forEach(el => {
    el.style.display = 'none';
  });
}

function _restoreDapDraftFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const modelSel = document.getElementById('dap-model');
  if (modelSel && snapshot.model && !Array.from(modelSel.options).some(o => o.value === snapshot.model)) {
    const opt = document.createElement('option');
    opt.value = snapshot.model;
    opt.textContent = snapshot.model;
    modelSel.appendChild(opt);
  }
  document.getElementById('dap-modal-id').value = snapshot.id || '';
  document.getElementById('dap-name').value = snapshot.name || '';
  document.getElementById('dap-model').value = snapshot.model || '';
  document.getElementById('dap-mount').value = snapshot.mount || '';
  document.getElementById('dap-mount').dataset.prevMountForPeq = snapshot.mount || '';
  document.getElementById('dap-music-root').value = snapshot.music_root || '';
  document.getElementById('dap-path-template').value = snapshot.template || DAP_TEMPLATE_PRESETS.artist_album_track;
  document.getElementById('dap-export-folder').value = snapshot.export_folder || '';
  document.getElementById('dap-peq-folder').value = snapshot.peq_folder || _defaultPeqFolderForMount(snapshot.mount || '');
  document.getElementById('dap-prefix').value = snapshot.prefix || '';
  const preset = _suggestTemplatePreset(document.getElementById('dap-path-template').value);
  document.getElementById('dap-template-preset').value = preset;
  dapTemplateChanged();
  validateDapForm(false);
}

function revertDapModalChanges() {
  if (!_dapModalInitialJson) return;
  try {
    const snapshot = JSON.parse(_dapModalInitialJson);
    _restoreDapDraftFromSnapshot(snapshot);
    _updateDapModalUnsavedBanner();
  } catch (_) {
    // no-op
  }
}

function _populateIemTypeSelect() {
  const sel = document.getElementById('iem-type');
  if (!sel) return;
  const types = (_gearIemTypes && _gearIemTypes.length) ? _gearIemTypes : ['IEM', 'Headphone'];
  sel.innerHTML = types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
}

function _ensureGearProfileSelects() {
  if (!_gearProfilesLoaded) return;
  _populateDapModelSelect();
  _populateIemTypeSelect();
}

async function loadGearProfiles() {
  try {
    const data = await api('/gear/profiles');
    const profiles = Array.isArray(data.dap_profiles) ? data.dap_profiles : [];
    DAP_MODEL_PRESETS = {};
    profiles.forEach(p => {
      if (!p.model) return;
      DAP_MODEL_PRESETS[p.model] = _normalizeDapPreset(p);
    });
    if (!Object.keys(DAP_MODEL_PRESETS).length) {
      DAP_MODEL_PRESETS.other = { label: 'Other', mount: _mountPrefix.base + 'MyDAP', folder: 'Playlists', prefix: '', hint: '' };
    }
    _gearIemTypes = Array.isArray(data.iem_types) && data.iem_types.length ? data.iem_types : ['IEM', 'Headphone'];
  } catch (_) {
    DAP_MODEL_PRESETS = {
      other: { label: 'Other', mount: _mountPrefix.base + 'MyDAP', folder: 'Playlists', prefix: '', hint: '' },
    };
    _gearIemTypes = ['IEM', 'Headphone'];
  } finally {
    _gearProfilesLoaded = true;
    _populateDapModelSelect();
    _populateIemTypeSelect();
    if (_isOverlayOpen('dap-modal') && !_isDapModalDirty()) {
      _commitDapModalBaseline();
    }
  }
}

function dapModelPreset(model) {
  const fallback = DAP_MODEL_PRESETS.other || Object.values(DAP_MODEL_PRESETS)[0] || { mount: _mountPrefix.base + 'MyDAP', folder: 'Playlists', prefix: '', hint: '' };
  const preset = DAP_MODEL_PRESETS[model] || fallback;
  const mountInput = document.getElementById('dap-mount');
  // Only update mount if field is empty or user hasn't customized it
  if (!mountInput.value || Object.values(DAP_MODEL_PRESETS).some(p => mountInput.value === p.mount)) {
    mountInput.value = preset.mount;
  }
  if (!document.getElementById('dap-mount-manual-toggle')?.checked) {
    _renderDapMountSelect(mountInput.value);
    const selected = document.getElementById('dap-device-select')?.value || mountInput.value;
    mountInput.value = selected;
    const selectedMount = _detectedDapMounts.find(m => m.path === selected) || null;
    _setDapMountIdentityFields(selectedMount);
  }
  document.getElementById('dap-export-folder').value = preset.folder;
  document.getElementById('dap-prefix').value = preset.prefix;
  _updateDapFolderHint(model);
  validateDapForm(false);
}

function _normalizePathForCompare(path) {
  return String(path || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function _defaultPeqFolderForMount(mountPath) {
  const mount = _normalizePathForCompare(mountPath);
  return mount ? `${mount}/PEQ` : '~/PEQ';
}

function _maybeSyncPeqFolderWithMount(nextMountPath, prevMountPath = '', userDriven = false) {
  const peqEl = document.getElementById('dap-peq-folder');
  if (!peqEl) return;
  const current = String(peqEl.value || '').trim();
  const prevDefault = _defaultPeqFolderForMount(prevMountPath);
  const nextDefault = _defaultPeqFolderForMount(nextMountPath);
  const currentNorm = _normalizePathForCompare(current);
  const prevNorm = _normalizePathForCompare(prevDefault);
  // On first modal load, keep PEQ folder empty until user intentionally sets mount path.
  if (!current && !userDriven) return;
  if (!current || current === '~/PEQ' || currentNorm === prevNorm) {
    peqEl.value = nextDefault;
  }
}

function onDapMountInput(value) {
  const mountInput = document.getElementById('dap-mount');
  const prevMount = mountInput?.dataset.prevMountForPeq || '';
  _maybeSyncPeqFolderWithMount(value || '', prevMount, true);
  if (mountInput) mountInput.dataset.prevMountForPeq = value || '';
  validateDapForm(false);
}

async function browseDapMount() {
  const before = document.getElementById('dap-mount')?.value || '';
  await browseFolder('dap-mount');
  const after = document.getElementById('dap-mount')?.value || '';
  if (_normalizePathForCompare(before) !== _normalizePathForCompare(after)) {
    _setDapMountIdentityFields(null);
    _maybeSyncPeqFolderWithMount(after, before, true);
    const mountInput = document.getElementById('dap-mount');
    if (mountInput) mountInput.dataset.prevMountForPeq = after || '';
  }
  validateDapForm(false);
}

function _updateDapFolderHint(model) {
  const el = document.getElementById('dap-folder-hint');
  if (!el) return;
  const preset = DAP_MODEL_PRESETS[model] || DAP_MODEL_PRESETS.other || Object.values(DAP_MODEL_PRESETS)[0] || { hint: '' };
  const base = 'Playlist files are exported into this folder (relative to mount path).';
  const note = (preset.hint || '').trim();
  el.textContent = note ? `${base} ${note}` : base;
}

async function saveDap() {
  if (!validateDapForm(true)) return;
  const id = document.getElementById('dap-modal-id').value;
  const body = {
    name: document.getElementById('dap-name').value.trim() || 'My DAP',
    model: document.getElementById('dap-model').value,
    mount_path: document.getElementById('dap-mount').value.trim(),
    mount_volume_uuid: document.getElementById('dap-mount-volume-uuid').value.trim(),
    mount_disk_uuid: document.getElementById('dap-mount-disk-uuid').value.trim(),
    mount_device_identifier: document.getElementById('dap-mount-device-identifier').value.trim(),
    music_root: document.getElementById('dap-music-root').value.trim() || 'Music',
    path_template: document.getElementById('dap-path-template').value.trim() || DAP_TEMPLATE_PRESETS.artist_album_track,
    export_folder: document.getElementById('dap-export-folder').value.trim() || 'Playlists',
    peq_folder: document.getElementById('dap-peq-folder').value.trim() || _defaultPeqFolderForMount(document.getElementById('dap-mount').value.trim()),
    path_prefix: document.getElementById('dap-prefix').value.trim(),
  };
  try {
    if (id) {
      await api(`/daps/${id}`, { method: 'PUT', body });
    } else {
      await api('/daps', { method: 'POST', body });
    }
    closeDapModal();
    if (state.view === 'dap-detail' && id) {
      showDapDetail(id);
    } else {
      showView('gear');
    }
  } catch (e) {
    toast('Could not save. Check the details and try again.');
  }
}

async function deleteDap(id) {
  const ok = await _showConfirm({
    title:   'Delete DAP',
    message: 'This DAP and all its export history will be removed.',
    okText:  'Delete',
  });
  if (!ok) return;
  await api(`/daps/${id}`, { method: 'DELETE' });
  showView('gear');
}

/* ── IEM management ─────────────────────────────────────────────────── */
let _iemChart = null;
let _currentIemId = null;
let _activePeqId = null;
let _activeIemSourceId = null;

function _collectIemModalSources() {
  const sources = [];
  for (let i = 1; i <= 3; i++) {
    const label = (document.getElementById(`iem-source-label-${i}`)?.value || '').trim();
    const url = (document.getElementById(`iem-source-url-${i}`)?.value || '').trim();
    if (!url) continue;
    sources.push({
      label: label || `Source ${i}`,
      url,
    });
  }
  return sources.slice(0, 3);
}

function _setIemModalSources(sources = []) {
  for (let i = 1; i <= 3; i++) {
    const src = sources[i - 1] || {};
    const labelEl = document.getElementById(`iem-source-label-${i}`);
    const urlEl = document.getElementById(`iem-source-url-${i}`);
    if (labelEl) labelEl.value = src.label || '';
    if (urlEl) urlEl.value = src.url || '';
  }
}

async function showIemDetail(id) {
  _pushToNavHistory();
  const iem = await api(`/iems/${id}`);
  _currentIemId = id;
  _activePeqId = null;
  _activeIemSourceId = iem.primary_source_id || ((iem.squig_sources || [])[0] || {}).id || null;
  state.view = 'iem-detail';
  clearSelection();
  setActiveNav('gear');
  showViewEl('iem-detail');


  const isHeadphone = iem.type === 'Headphone';
  const typeBadge = isHeadphone ? 'gear-badge-hp' : 'gear-badge-iem';
  const detailIcon = isHeadphone ? _HEADPHONE_SVG : _IEM_ICON_HTML;
  const hasMeasurement = !!iem.has_measurement;
  const sourceOptions = (iem.squig_sources || []).map(s =>
    `<option value="${esc(s.id || '')}" ${s.id === _activeIemSourceId ? 'selected' : ''}>${esc(s.label || 'Source')}</option>`
  ).join('');
  const sourceLink = (iem.squig_sources || []).find(s => s.id === _activeIemSourceId) || (iem.squig_sources || [])[0];
  const peqOptions = (iem.peq_profiles || []).map(p =>
    `<option value="${p.id}">${esc(p.name)}</option>`
  ).join('');

  document.getElementById('iem-detail-content').innerHTML = `
    <div class="iem-detail-header">
      <div class="iem-detail-icon">
        ${detailIcon}
      </div>
      <div>
        <div class="iem-detail-title">${esc(iem.name)}</div>
        <div class="iem-detail-sub">
          <span class="gear-badge ${typeBadge}">${esc(iem.type || 'IEM')}</span>
          ${sourceLink && sourceLink.url ? `<a href="${esc(sourceLink.url)}" target="_blank" style="font-size:var(--text-xs);color:var(--accent);text-decoration:none">squig.link ↗</a>` : ''}
        </div>
        <div class="gear-edit-actions">
          <button class="btn-secondary" onclick="App.showEditIemModal('${iem.id}')">Edit</button>
          <button class="btn-danger-sm" onclick="App.deleteIem('${iem.id}')">Delete</button>
        </div>
      </div>
    </div>

    <div class="freq-graph-wrap">
      <div class="freq-graph-toolbar">
        ${sourceOptions ? `<label>Source:</label>
        <select id="iem-source-select" onchange="App.applyIemSourceToGraph(this.value)">
          ${sourceOptions}
        </select>` : ''}
        <label>PEQ:</label>
        <select id="peq-select" onchange="App.applyPeqToGraph(this.value)">
          <option value="">None (raw measurement)</option>
          ${peqOptions}
        </select>
        <div id="freq-overlay-host" class="fr-overlay-host fr-overlay-host--toolbar" data-fr-overlay-host="1" data-fr-overlay-context="iem-detail"></div>
      </div>
      <div id="freq-canvas-wrap">
        ${hasMeasurement
          ? `<canvas id="freq-canvas"></canvas>`
          : `<div class="freq-no-data">
               <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3v18h18"/><path d="M7 16l4-4 4 4 4-4" stroke-width="2"/></svg>
               <span>No measurement data — add a squig.link URL to import frequency response.</span>
             </div>`
        }
      </div>
      ${hasMeasurement ? `<div id="iem-curve-legend" class="curve-legend"></div>` : ''}
    </div>

    <div class="peq-section-hdr">
      <div class="peq-section-title">PEQ Profiles</div>
      <button class="btn-secondary" onclick="App.showPeqModal()">+ Upload PEQ</button>
    </div>
    <div class="peq-list" id="peq-list">
      ${_renderPeqList(iem.peq_profiles || [])}
    </div>
  `;
  _refreshFrOverlayControls();

  if (hasMeasurement) {
    await _loadIemGraph(id, null, _activeIemSourceId);
  }
}

function _renderPeqList(profiles) {
  if (!profiles.length) {
    return `<div style="color:var(--text-muted);font-size:var(--text-sm);padding:10px 0">No PEQ profiles yet. Upload an APO/AutoEQ .txt file.</div>`;
  }
  return profiles.map(p => {
    const filterCount = p.filters?.length || 0;
    const preampStr = p.preamp_db != null
      ? `${p.preamp_db >= 0 ? '+' : ''}${p.preamp_db.toFixed(1)} dB preamp`
      : '';
    const meta = [filterCount + ' filter' + (filterCount !== 1 ? 's' : ''), preampStr].filter(Boolean).join(' · ');

    const preampHtml = p.preamp_db != null
      ? `<div class="peq-preamp">Preamp: <strong>${p.preamp_db >= 0 ? '+' : ''}${p.preamp_db.toFixed(1)} dB</strong></div>`
      : '';

    const filterRows = (p.filters || []).map(f => {
      const freq = f.fc >= 1000 ? (f.fc / 1000).toFixed(f.fc % 1000 === 0 ? 0 : 1) + ' kHz' : f.fc + ' Hz';
      const gainStr = f.gain != null ? (f.gain > 0 ? '+' : '') + Number(f.gain).toFixed(1) + ' dB' : '—';
      const gainClass = f.gain > 0 ? 'peq-gain-pos' : f.gain < 0 ? 'peq-gain-neg' : '';
      const qStr = f.q != null ? Number(f.q).toFixed(2) : '—';
      return `<tr>
        <td>${esc(f.type || '')}</td>
        <td>${freq}</td>
        <td class="${gainClass}">${gainStr}</td>
        <td>${qStr}</td>
      </tr>`;
    }).join('');

    const tableHtml = filterRows
      ? `<table class="peq-filter-table">
           <thead><tr><th>Type</th><th>Freq</th><th>Gain</th><th>Q</th></tr></thead>
           <tbody>${filterRows}</tbody>
         </table>`
      : `<div style="color:var(--text-muted);font-size:var(--text-xs);padding:8px 0 12px">No filters found.</div>`;

    return `
    <div class="peq-card${_activePeqId === p.id ? ' active' : ''}" id="peq-row-${p.id}">
      <div class="peq-card-header" onclick="App.togglePeqAccordion('${p.id}')">
        <svg class="peq-chevron" id="peq-chevron-${p.id}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        <span class="peq-row-name">${esc(p.name)}</span>
        <span class="peq-row-meta">${esc(meta)}</span>
        <div class="peq-row-actions" onclick="event.stopPropagation()">
          <button class="btn-secondary" style="font-size:var(--text-xs);padding:3px 9px"
            onclick="App.applyPeqToGraph('${p.id}')">
            ${_activePeqId === p.id ? 'Showing' : 'View on graph'}
          </button>
          <button class="btn-danger-sm" onclick="App.deletePeq('${p.id}')">✕</button>
        </div>
      </div>
      <div class="peq-accordion" id="peq-accordion-${p.id}" style="display:none">
        ${preampHtml}
        ${tableHtml}
        <button class="btn-secondary peq-download-btn"
          onclick="App.downloadPeq('${p.id}', ${JSON.stringify(p.name)})">↓ Download .txt</button>
      </div>
    </div>`;
  }).join('');
}

function togglePeqAccordion(peqId) {
  const accordion = document.getElementById(`peq-accordion-${peqId}`);
  const chevron = document.getElementById(`peq-chevron-${peqId}`);
  if (!accordion) return;
  const isOpen = accordion.style.display !== 'none';
  accordion.style.display = isOpen ? 'none' : 'block';
  if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(90deg)';
}

async function downloadPeq(peqId, name) {
  try {
    const res = await fetch(`/api/iems/${_currentIemId}/peq/${peqId}/download`);
    if (!res.ok) throw new Error('Server error');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name.replace(/[/\\]/g, '-') + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    toast('Failed to download PEQ: ' + e.message);
  }
}

async function _loadIemGraph(iemId, peqId, sourceId = null) {
  const qp = [];
  if (peqId) qp.push(`peq=${encodeURIComponent(peqId)}`);
  if (sourceId) qp.push(`source=${encodeURIComponent(sourceId)}`);
  const params = qp.length ? `?${qp.join('&')}` : '';
  let data;
  try {
    data = await api(`/iems/${iemId}/graph${params}`);
  } catch (e) {
    toast('Failed to load graph data: ' + e.message);
    return;
  }
  if (!data || !data.curves || !data.curves.length) return;
  _activeIemSourceId = data.selected_source_id || sourceId || _activeIemSourceId;

  const canvas = document.getElementById('freq-canvas');
  if (!canvas) return;

  if (_iemChart) { _iemChart.destroy(); _iemChart = null; }

  const regionPlugin = _createFrOverlayPlugin('freqRegions');

  // L = blue, R = red, PEQ = green — consistent regardless of comparison palette
  function _iemCurveColor(id, backendColor) {
    if (id.startsWith('baseline-')) return backendColor || '#f0b429';
    if (id.includes('-peq-')) return '#53e16f';  // accent-success green
    if (id.endsWith('-R'))    return '#e05c5c';  // red for R channel
    return '#5b8dee';                             // blue for L channel
  }

  const datasets = data.curves.map(c => ({
    label: c.label,
    data: c.data.map(([f, spl]) => ({ x: f, y: spl })),
    borderColor: _iemCurveColor(c.id, c.color),
    borderWidth: c.id.startsWith('baseline-') ? 1.4 : c.dash ? 1.3 : 1.9,
    borderDash: c.dash ? [6, 4] : undefined,
    pointRadius: 0,
    tension: 0.3,
    // Baselines are hidden on first load — user toggles them via the legend
    hidden: c.id.startsWith('baseline-'),
  }));

  _iemChart = new Chart(canvas, {
    type: 'line',
    plugins: [regionPlugin],
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      scales: {
        x: {
          type: 'logarithmic',
          min: 20,
          max: 20000,
          title: { display: true, text: 'Frequency (Hz)', color: '#6b6b7b', font: { size: 11, family: 'Inter, sans-serif' } },
          ticks: {
            color: '#6b6b7b',
            font: { size: 10, family: 'Inter, sans-serif' },
            callback: function(v) {
              const labeled = [20,50,100,200,500,1000,2000,5000,10000,20000];
              if (!labeled.includes(v)) return '';
              if (v >= 1000) return (v / 1000) + 'k';
              return v;
            },
            autoSkip: false,
            maxRotation: 0,
            font: { size: 9, family: 'Inter, sans-serif' },
          },
          grid: {
            color: function(ctx) {
              const v = ctx.tick && ctx.tick.value;
              const major = [100, 1000, 10000];
              return major.includes(v) ? 'rgba(173,198,255,.12)' : 'rgba(173,198,255,.04)';
            },
          },
          afterBuildTicks(axis) {
            axis.ticks = [20,30,40,50,60,80,100,150,200,300,400,500,600,800,1000,1500,2000,3000,4000,5000,6000,8000,10000,15000,20000].map(v => ({ value: v }));
          },
        },
        y: {
          min: 50,
          max: 110,
          title: { display: true, text: 'dB', color: '#6b6b7b', font: { size: 11, family: 'Inter, sans-serif' } },
          ticks: {
            color: '#6b6b7b',
            font: { size: 10, family: 'Inter, sans-serif' },
            stepSize: 10,
          },
          grid: { color: 'rgba(173,198,255,.06)' },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(53,53,52,0.95)',
          titleColor: '#e5e2e1',
          bodyColor: '#c1c6d7',
          borderColor: 'rgba(65,71,85,0.3)',
          borderWidth: 1,
          callbacks: {
            title: items => {
              const f = items[0].parsed.x;
              return f >= 1000 ? (f / 1000).toFixed(1) + ' kHz' : Math.round(f) + ' Hz';
            },
            label: item => ` ${item.dataset.label}: ${item.parsed.y.toFixed(1)} dB`,
          },
        },
      },
    },
  });

  _renderIemLegend(datasets);
}

function _renderIemLegend(datasets) {
  const el = document.getElementById('iem-curve-legend');
  if (!el) return;
  el.innerHTML = datasets.map((ds, i) => {
    const dash = (ds.borderDash && ds.borderDash.length) ? 'stroke-dasharray="5 4"' : '';
    const isHidden = ds.hidden === true;
    return `
      <div class="curve-legend-item" id="legend-item-${i}">
        <button class="eye-toggle${isHidden ? ' hidden' : ''}" onclick="App.toggleIemCurve(${i})" title="${isHidden ? 'Show curve' : 'Hide curve'}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        <svg width="28" height="10" viewBox="0 0 28 10" style="flex-shrink:0;opacity:${isHidden ? '0.35' : '1'}">
          <line x1="0" y1="5" x2="28" y2="5" stroke="${ds.borderColor}"
            stroke-width="${ds.borderWidth || 1.5}" ${dash}/>
        </svg>
        <span style="opacity:${isHidden ? '0.45' : '1'}">${esc(ds.label)}</span>
      </div>`;
  }).join('');
}

function toggleIemCurve(idx) {
  if (!_iemChart) return;
  const nowVisible = !_iemChart.isDatasetVisible(idx);
  _iemChart.setDatasetVisibility(idx, nowVisible);
  _iemChart.update();
  const item = document.getElementById(`legend-item-${idx}`);
  if (!item) return;
  const btn = item.querySelector('.eye-toggle');
  if (btn) {
    btn.classList.toggle('hidden', !nowVisible);
    btn.title = nowVisible ? 'Hide curve' : 'Show curve';
  }
  const svg = item.querySelector('svg:not(.eye-toggle svg)');
  if (svg) svg.style.opacity = nowVisible ? '1' : '0.35';
  const label = item.querySelector('span');
  if (label) label.style.opacity = nowVisible ? '1' : '0.45';
}

async function applyPeqToGraph(peqId) {
  _activePeqId = peqId || null;
  // Update select
  const sel = document.getElementById('peq-select');
  if (sel) sel.value = peqId || '';
  // Update row highlights
  document.querySelectorAll('.peq-row').forEach(row => row.classList.remove('active'));
  if (peqId) {
    const activeRow = document.getElementById(`peq-row-${peqId}`);
    if (activeRow) activeRow.classList.add('active');
  }
  if (_currentIemId) await _loadIemGraph(_currentIemId, _activePeqId, _activeIemSourceId);
}

async function applyIemSourceToGraph(sourceId) {
  _activeIemSourceId = sourceId || null;
  const sel = document.getElementById('iem-source-select');
  if (sel) sel.value = sourceId || '';
  if (_currentIemId) await _loadIemGraph(_currentIemId, _activePeqId, _activeIemSourceId);
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
    const src = bands[i] || {};
    const type = String(src.type || 'PK').toUpperCase();
    base.bands[i] = {
      enabled: !!src.enabled,
      type: ['PK', 'LSC', 'HSC', 'LPQ', 'HPQ', 'NO', 'AP'].includes(type) ? type : 'PK',
      fc: Math.max(20, Math.min(20000, Number(src.fc) || 1000)),
      gain: Math.max(-30, Math.min(30, Number(src.gain) || 0)),
      q: Math.max(0.1, Math.min(10, Number(src.q) || 1.0)),
    };
  }
  return base;
}

function _loadCustomPeqState() {
  if (_customPeqEditorState) return _customPeqEditorState;
  try {
    const raw = localStorage.getItem(_CUSTOM_PEQ_KEY);
    _customPeqEditorState = _sanitizeCustomPeqState(raw ? JSON.parse(raw) : null);
  } catch (_) {
    _customPeqEditorState = _defaultCustomPeqState();
  }
  return _customPeqEditorState;
}

function _saveCustomPeqState() {
  if (!_customPeqEditorState) _customPeqEditorState = _defaultCustomPeqState();
  const safe = _sanitizeCustomPeqState(_customPeqEditorState);
  _customPeqEditorState = safe;
  try { localStorage.setItem(_CUSTOM_PEQ_KEY, JSON.stringify(safe)); } catch (_) {}
  return safe;
}

function _enabledBandIndex(bandIndex) {
  if (!_customPeqEditorState?.bands?.[bandIndex]?.enabled) return -1;
  let enabled = 0;
  for (let i = 0; i < bandIndex; i++) if (_customPeqEditorState.bands[i].enabled) enabled++;
  return enabled;
}

function _parseNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _renderCustomPeqSavePanel(open) {
  const panel = document.getElementById('peq-save-profile-panel');
  if (!panel) return;
  panel.style.display = open ? 'block' : 'none';
  if (!open) {
    const err = document.getElementById('peq-save-profile-error');
    if (err) err.style.display = 'none';
  }
}

function _setPeqWorkspaceDirty(isDirty) {
  _peqWorkspaceDirty = !!isDirty;
  const chip = document.getElementById('peq-workspace-dirty');
  if (chip) chip.style.display = _peqWorkspaceDirty ? '' : 'none';
}

function _refreshPeqWorkspaceDirty() {
  if (!_peqWorkspaceOpen) return;
  const current = JSON.stringify(_sanitizeCustomPeqState(_customPeqEditorState));
  _setPeqWorkspaceDirty(current !== _peqWorkspaceInitialJson);
}

function _snapshotPeqWorkspace() {
  _peqWorkspaceInitialJson = JSON.stringify(_sanitizeCustomPeqState(_customPeqEditorState));
  _setPeqWorkspaceDirty(false);
}

function _destroyPeqWorkspaceChart() {
  if (_peqWorkspaceChart) {
    _peqWorkspaceChart.destroy();
    _peqWorkspaceChart = null;
  }
  const el = document.getElementById('peq-editor-curve-legend');
  if (el) el.innerHTML = '';
}

function _renderPeqWorkspaceLegend(datasets) {
  const el = document.getElementById('peq-editor-curve-legend');
  if (!el) return;
  el.innerHTML = datasets.map((ds, i) => {
    const dash = (ds.borderDash && ds.borderDash.length) ? 'stroke-dasharray="5 4"' : '';
    const isHidden = ds.hidden === true;
    return `
      <div class="curve-legend-item" id="peq-legend-item-${i}">
        <button class="eye-toggle${isHidden ? ' hidden' : ''}" onclick="App.togglePeqWorkspaceCurve(${i})" title="${isHidden ? 'Show curve' : 'Hide curve'}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        <svg width="28" height="10" viewBox="0 0 28 10" style="flex-shrink:0;opacity:${isHidden ? '0.35' : '1'}">
          <line x1="0" y1="5" x2="28" y2="5" stroke="${ds.borderColor}"
            stroke-width="${ds.borderWidth || 1.5}" ${dash}/>
        </svg>
        <span style="opacity:${isHidden ? '0.45' : '1'}">${esc(ds.label)}</span>
      </div>`;
  }).join('');
}

function togglePeqWorkspaceCurve(idx) {
  if (!_peqWorkspaceChart) return;
  const nowVisible = !_peqWorkspaceChart.isDatasetVisible(idx);
  _peqWorkspaceChart.setDatasetVisibility(idx, nowVisible);
  const ds = _peqWorkspaceChart.data.datasets[idx];
  if (ds && ds._curveId) _peqWorkspaceCurveVisibility[ds._curveId] = nowVisible;
  _peqWorkspaceChart.update();
  const item = document.getElementById(`peq-legend-item-${idx}`);
  if (!item) return;
  const btn = item.querySelector('.eye-toggle');
  if (btn) {
    btn.classList.toggle('hidden', !nowVisible);
    btn.title = nowVisible ? 'Hide curve' : 'Show curve';
  }
  const svg = item.querySelector('svg:not(.eye-toggle svg)');
  if (svg) svg.style.opacity = nowVisible ? '1' : '0.35';
  const label = item.querySelector('span');
  if (label) label.style.opacity = nowVisible ? '1' : '0.45';
}

function _schedulePeqWorkspaceGraphRefresh() {
  if (!_peqWorkspaceOpen) return;
  if (_peqWorkspaceGraphTimer) clearTimeout(_peqWorkspaceGraphTimer);
  _peqWorkspaceGraphTimer = setTimeout(() => {
    _peqWorkspaceGraphTimer = null;
    _refreshPeqWorkspaceGraph();
  }, 70);
}

async function _refreshPeqWorkspaceGraph() {
  if (!_peqWorkspaceOpen) return;
  const canvas = document.getElementById('peq-editor-canvas');
  if (!canvas) return;
  const iemId = _peqWorkspaceSelectedIemId || document.getElementById('peq-workspace-iem-select')?.value || '';
  const reqId = ++_peqWorkspaceGraphReqId;
  const body = {
    custom_peq: _sanitizeCustomPeqState(_customPeqEditorState || _defaultCustomPeqState()),
  };
  const targetId = _peqWorkspaceSelectedTargetId || document.getElementById('peq-workspace-target-select')?.value || '';
  if (targetId) body.baseline_ids = [targetId];
  let data;
  try {
    data = iemId
      ? await api(`/iems/${encodeURIComponent(iemId)}/graph/custom`, { method: 'POST', body })
      : await api('/peq/graph/custom', { method: 'POST', body });
  } catch (e) {
    if (reqId === _peqWorkspaceGraphReqId) toast('Failed to load Custom PEQ graph: ' + e.message);
    return;
  }
  if (reqId !== _peqWorkspaceGraphReqId) return;
  const curves = Array.isArray(data?.curves) ? data.curves : [];
  if (!curves.length) {
    _destroyPeqWorkspaceChart();
    return;
  }
  if (_peqWorkspaceChart) _destroyPeqWorkspaceChart();
  const regionPlugin = _createFrOverlayPlugin('peqWorkspaceFreqRegions');
  function _workspaceCurveColor(id, backendColor) {
    if (id.startsWith('baseline-')) return backendColor || '#f0b429';
    if (id.includes('-custom-')) return '#53e16f';
    if (id.endsWith('-R')) return '#e05c5c';
    return '#5b8dee';
  }
  const datasets = curves.map(c => ({
    label: c.label,
    _curveId: c.id,
    data: c.data.map(([f, spl]) => ({ x: f, y: spl })),
    borderColor: _workspaceCurveColor(c.id, c.color),
    borderWidth: c.id.startsWith('baseline-') ? 1.35 : c.dash ? 1.25 : 1.85,
    borderDash: c.dash ? [6, 4] : undefined,
    pointRadius: 0,
    tension: 0.28,
    hidden: _peqWorkspaceCurveVisibility[c.id] === false,
  }));
  _peqWorkspaceChart = new Chart(canvas, {
    type: 'line',
    plugins: [regionPlugin],
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 120 },
      scales: {
        x: {
          type: 'logarithmic',
          min: 20,
          max: 20000,
          title: { display: true, text: 'Frequency (Hz)', color: '#6b6b7b', font: { size: 11, family: 'Inter, sans-serif' } },
          ticks: {
            color: '#6b6b7b',
            font: { size: 10, family: 'Inter, sans-serif' },
            callback: function(v) {
              const labeled = [20,50,100,200,500,1000,2000,5000,10000,20000];
              if (!labeled.includes(v)) return '';
              return v >= 1000 ? `${v / 1000}k` : v;
            },
            autoSkip: false,
            maxRotation: 0,
          },
          grid: {
            color: function(ctx) {
              const v = ctx.tick && ctx.tick.value;
              const major = [100, 1000, 10000];
              return major.includes(v) ? 'rgba(173,198,255,.12)' : 'rgba(173,198,255,.04)';
            },
          },
          afterBuildTicks(axis) {
            axis.ticks = [20,30,40,50,60,80,100,150,200,300,400,500,600,800,1000,1500,2000,3000,4000,5000,6000,8000,10000,15000,20000].map(v => ({ value: v }));
          },
        },
        y: {
          min: 50,
          max: 110,
          title: { display: true, text: 'dB', color: '#6b6b7b', font: { size: 11, family: 'Inter, sans-serif' } },
          ticks: { color: '#6b6b7b', font: { size: 10, family: 'Inter, sans-serif' }, stepSize: 10 },
          grid: { color: 'rgba(173,198,255,.06)' },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(53,53,52,0.95)',
          titleColor: '#e5e2e1',
          bodyColor: '#c1c6d7',
          borderColor: 'rgba(65,71,85,0.3)',
          borderWidth: 1,
          callbacks: {
            title: items => {
              const f = items[0].parsed.x;
              return f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`;
            },
            label: item => ` ${item.dataset.label}: ${item.parsed.y.toFixed(1)} dB`,
          },
        },
      },
    },
  });
  _renderPeqWorkspaceLegend(datasets);
}

async function _loadPeqWorkspaceContext() {
  const iemSel = document.getElementById('peq-workspace-iem-select');
  const peqSel = document.getElementById('peq-workspace-peq-select');
  const targetSel = document.getElementById('peq-workspace-target-select');
  const ctx = document.querySelector('#peq-workspace .peq-workspace-context');
  if (ctx && !document.getElementById('peq-workspace-overlay-field')) {
    const field = document.createElement('div');
    field.id = 'peq-workspace-overlay-field';
    field.className = 'peq-workspace-field';
    field.innerHTML = `
      <label class="peq-editor-col-label">Overlays</label>
      <div id="peq-workspace-overlay-host" class="fr-overlay-host" data-fr-overlay-host="1" data-fr-overlay-context="peq-workspace"></div>
    `;
    ctx.appendChild(field);
  }
  _refreshFrOverlayControls();
  if (iemSel) {
    iemSel.innerHTML = '<option value="">No IEM / Headphone selected</option>';
  }
  if (peqSel) {
    peqSel.innerHTML = `<option value="${_WORKSPACE_NEW_PEQ_ID}">New PEQ</option>`;
  }
  if (targetSel) {
    targetSel.innerHTML = '<option value="">No target selected</option>';
  }
  try {
    const [iems, baselines, daps] = await Promise.all([
      api('/iems').catch(() => []),
      api('/baselines').catch(() => []),
      api('/daps').catch(() => []),
    ]);
    if (iemSel) {
      _peqWorkspaceIemCache = (iems || []).slice();
      const measured = _peqWorkspaceIemCache.filter(i => i.has_measurement);
      iemSel.innerHTML += measured.map(i => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('');
      const saveSel = document.getElementById('peq-save-iem-select');
      const candidate = _peqWorkspaceSelectedIemId || (saveSel && saveSel.value) || '';
      const hasCandidate = candidate && measured.some(i => i.id === candidate);
      if (hasCandidate) iemSel.value = candidate;
      else iemSel.value = '';
      _peqWorkspaceSelectedIemId = iemSel.value || '';
    }
    _refreshPeqWorkspacePeqOptions();
    if (targetSel) {
      targetSel.innerHTML += (baselines || []).map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
      if (_peqWorkspaceSelectedTargetId && (baselines || []).some(b => b.id === _peqWorkspaceSelectedTargetId)) {
        targetSel.value = _peqWorkspaceSelectedTargetId;
      }
      _peqWorkspaceSelectedTargetId = targetSel.value || '';
    }
    _refreshPeqWorkspaceCopyTargets(daps || []);
  } catch (_) {}
}

function _refreshPeqWorkspacePeqOptions() {
  const peqSel = document.getElementById('peq-workspace-peq-select');
  if (!peqSel) return;
  const iemId = _peqWorkspaceSelectedIemId || document.getElementById('peq-workspace-iem-select')?.value || '';
  const iem = (_peqWorkspaceIemCache || []).find(i => i.id === iemId);
  const profiles = Array.isArray(iem?.peq_profiles) ? iem.peq_profiles : [];
  peqSel.innerHTML = `<option value="${_WORKSPACE_NEW_PEQ_ID}">New PEQ</option>` +
    profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if (_peqWorkspaceSelectedPeqId && profiles.some(p => p.id === _peqWorkspaceSelectedPeqId)) {
    peqSel.value = _peqWorkspaceSelectedPeqId;
  } else {
    _peqWorkspaceSelectedPeqId = _WORKSPACE_NEW_PEQ_ID;
    peqSel.value = _WORKSPACE_NEW_PEQ_ID;
  }
}

function _refreshPeqWorkspaceCopyTargets(allDaps) {
  const wrap = document.getElementById('peq-copy-wrap');
  const sel = document.getElementById('peq-copy-dap-select');
  const btn = document.getElementById('peq-copy-btn');
  if (!wrap || !sel || !btn) return;
  const connected = (allDaps || []).filter(d => d.mounted);
  _peqWorkspaceConnectedDaps = connected;
  if (!connected.length) {
    wrap.style.display = 'none';
    _peqWorkspaceCopyDapId = '';
    return;
  }
  wrap.style.display = '';
  if (connected.length === 1) {
    _peqWorkspaceCopyDapId = connected[0].id;
    sel.style.display = 'none';
    btn.textContent = `Copy to ${connected[0].name}`;
    return;
  }
  btn.textContent = 'Copy to Selected DAP';
  sel.style.display = '';
  sel.innerHTML = connected.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
  if (_peqWorkspaceCopyDapId && connected.some(d => d.id === _peqWorkspaceCopyDapId)) {
    sel.value = _peqWorkspaceCopyDapId;
  } else {
    _peqWorkspaceCopyDapId = connected[0].id;
    sel.value = _peqWorkspaceCopyDapId;
  }
}

function _hidePeqWorkspace(opts = {}) {
  const panel = document.getElementById('peq-workspace');
  if (panel) panel.style.display = 'none';
  _renderCustomPeqSavePanel(false);
  _destroyPeqWorkspaceChart();
  if (_peqWorkspaceGraphTimer) {
    clearTimeout(_peqWorkspaceGraphTimer);
    _peqWorkspaceGraphTimer = null;
  }
  _peqWorkspaceOpen = false;
  _peqWorkspaceEditContext = null;
}

function isPeqWorkspaceOpen() {
  return !!_peqWorkspaceOpen;
}

function _guardPeqEditorNavigation() {
  if (!_peqWorkspaceOpen) return true;
  if (_peqWorkspaceDirty) {
    const shouldSave = window.confirm('Save Custom PEQ changes before leaving? Click OK to save, or Cancel to discard.');
    if (shouldSave) {
      const st = _saveCustomPeqState();
      st.enabled = true;
      _saveCustomPeqState();
      Player?.applyCustomPeq?.(st);
      _snapshotPeqWorkspace();
    } else {
      try {
        _customPeqEditorState = _sanitizeCustomPeqState(JSON.parse(_peqWorkspaceInitialJson || '{}'));
      } catch (_) {
        _customPeqEditorState = _defaultCustomPeqState();
      }
      _customPeqEditorState.enabled = true;
      const restored = _saveCustomPeqState();
      Player?.applyCustomPeq?.(restored);
      _setPeqWorkspaceDirty(false);
    }
  }
  _hidePeqWorkspace();
  return true;
}

async function _loadPeqSaveIems() {
  const sel = document.getElementById('peq-save-iem-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select IEM</option>';
  try {
    const iems = await api('/iems');
    sel.innerHTML += (iems || []).map(iem => `<option value="${esc(iem.id)}">${esc(iem.name)}</option>`).join('');
  } catch (_) {}
}

function _apoFromCustomState(state) {
  const st = _sanitizeCustomPeqState(state);
  const lines = [`Preamp: ${st.preamp_db.toFixed(1)} dB`];
  let idx = 1;
  st.bands.forEach(b => {
    if (!b.enabled) return;
    const noGain = _CUSTOM_NO_GAIN_TYPES.has(String(b.type || '').toUpperCase());
    const parts = [`Filter ${idx}: ON ${b.type} Fc ${Math.round(b.fc)} Hz`];
    if (!noGain) parts.push(`Gain ${b.gain.toFixed(1)} dB`);
    parts.push(`Q ${b.q.toFixed(3)}`);
    lines.push(parts.join(' '));
    idx++;
  });
  return lines.join('\n') + '\n';
}

function _customStateFromProfile(profile) {
  const st = _defaultCustomPeqState();
  if (!profile || typeof profile !== 'object') return st;
  st.enabled = true;
  st.preamp_db = Math.max(-30, Math.min(30, Number(profile.preamp_db) || 0));
  const filters = Array.isArray(profile.filters) ? profile.filters : [];
  for (let i = 0; i < Math.min(10, filters.length); i++) {
    const f = filters[i] || {};
    const t = String(f.type || 'PK').toUpperCase();
    st.bands[i] = {
      enabled: f.enabled !== false,
      type: ['PK', 'LSC', 'HSC', 'LPQ', 'HPQ', 'NO', 'AP'].includes(t) ? t : 'PK',
      fc: Math.max(20, Math.min(20000, Number(f.fc) || 1000)),
      gain: Math.max(-30, Math.min(30, Number(f.gain) || 0)),
      q: Math.max(0.1, Math.min(10, Number(f.q) || 1.0)),
    };
  }
  return st;
}

async function _saveCustomProfileToIem(iemId, name, overwritePeqId = '') {
  const st = _loadCustomPeqState();
  const content = _apoFromCustomState(st);
  const fileName = `${name.replace(/[^\w\- ]+/g, '').trim() || 'Custom EQ'}.txt`;
  const formData = new FormData();
  formData.append('file', new Blob([content], { type: 'text/plain' }), fileName);
  formData.append('name', name);
  const url = overwritePeqId
    ? `/api/iems/${encodeURIComponent(iemId)}/peq/${encodeURIComponent(overwritePeqId)}`
    : `/api/iems/${encodeURIComponent(iemId)}/peq`;
  const method = overwritePeqId ? 'PUT' : 'POST';
  const res = await fetch(url, { method, body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Could not save profile' }));
    throw new Error(err.error || 'Could not save profile');
  }
  return res.json();
}

function renderPeqEditorBands() {
  const wrap = document.getElementById('peq-editor-bands');
  if (!wrap) return;
  const st = _loadCustomPeqState();
  wrap.innerHTML = st.bands.map((band, i) => {
    const gainHidden = _CUSTOM_NO_GAIN_TYPES.has(String(band.type || '').toUpperCase());
    return `
      <div class="peq-editor-band-row" data-band="${i}">
        <span class="peq-editor-band-num">${i + 1}</span>
        <button class="peq-band-toggle ${band.enabled ? 'active' : ''}" onclick="App.togglePeqBand(${i})">
          ${band.enabled ? 'ON' : 'OFF'}
        </button>
        <select class="peq-band-type" onchange="App.onPeqBandTypeChange(${i}, this.value)">
          <option value="PK" ${band.type === 'PK' ? 'selected' : ''}>PK</option>
          <option value="LSC" ${band.type === 'LSC' ? 'selected' : ''}>LSC</option>
          <option value="HSC" ${band.type === 'HSC' ? 'selected' : ''}>HSC</option>
          <option value="LPQ" ${band.type === 'LPQ' ? 'selected' : ''}>LPQ</option>
          <option value="HPQ" ${band.type === 'HPQ' ? 'selected' : ''}>HPQ</option>
          <option value="NO" ${band.type === 'NO' ? 'selected' : ''}>NO</option>
          <option value="AP" ${band.type === 'AP' ? 'selected' : ''}>AP</option>
        </select>
        <input type="number" class="peq-editor-num-input" value="${Math.round(band.fc)}"
               min="20" max="20000" step="1"
               oninput="App.onPeqBandFcChange(${i}, this.value)" />
        <input type="number" class="peq-editor-num-input ${gainHidden ? 'peq-input-hidden' : ''}"
               value="${band.gain.toFixed(1)}" min="-30" max="30" step="0.1"
               oninput="App.onPeqBandGainChange(${i}, this.value)" />
        <input type="number" class="peq-editor-num-input" value="${band.q.toFixed(3)}"
               min="0.1" max="10" step="0.001"
               oninput="App.onPeqBandQChange(${i}, this.value)" />
      </div>`;
  }).join('');
}

function _syncPeqPreampInputs(value, source = '') {
  const val = Math.max(-30, Math.min(30, Number(value) || 0));
  const numInput = document.getElementById('peq-preamp');
  const slider = document.getElementById('peq-preamp-slider');
  if (numInput && source !== 'input') numInput.value = val.toFixed(1);
  if (slider) slider.value = String(val);
}

function _updatePeqWorkspaceActionLabels() {
  const primary = document.getElementById('peq-primary-action-btn');
  const secondary = document.getElementById('peq-secondary-action-btn');
  if (!primary || !secondary) return;
  const isEditingExisting = !!(_peqWorkspaceEditContext?.iemId && _peqWorkspaceEditContext?.peqId);
  primary.textContent = isEditingExisting ? 'Save As' : 'Save';
  secondary.textContent = isEditingExisting ? 'Override Existing' : 'Save Profile';
}

async function openPeqEditor(opts = {}) {
  if (_peqWorkspaceOpen) return;
  const panel = document.getElementById('peq-workspace');
  if (!panel) return;
  _peqWorkspaceEditContext = null;
  if (opts.mode === 'edit_profile' && opts.iemId && opts.peqId) {
    try {
      const iem = await api(`/iems/${encodeURIComponent(opts.iemId)}`);
      const profile = (iem.peq_profiles || []).find(p => p.id === opts.peqId);
      if (profile) {
        _customPeqEditorState = _customStateFromProfile(profile);
        _saveCustomPeqState();
        _peqWorkspaceEditContext = { iemId: opts.iemId, peqId: opts.peqId, peqName: profile.name || 'PEQ Profile' };
        _peqWorkspaceSelectedIemId = opts.iemId;
        _peqWorkspaceSelectedPeqId = opts.peqId;
        if ((profile.filters || []).length > 10) {
          toast('Only the first 10 filters are editable in Custom PEQ workspace.');
        }
      } else {
        _customPeqEditorState = _loadCustomPeqState();
      }
    } catch (_) {
      _customPeqEditorState = _loadCustomPeqState();
      toast('Could not load selected PEQ. Opening Custom PEQ workspace with current state.');
    }
  } else if (opts.mode === 'create') {
    _customPeqEditorState = _defaultCustomPeqState();
    _customPeqEditorState.enabled = true;
    _saveCustomPeqState();
    _peqWorkspaceSelectedIemId = opts.iemId || '';
    _peqWorkspaceSelectedPeqId = _WORKSPACE_NEW_PEQ_ID;
  } else {
    _customPeqEditorState = _loadCustomPeqState();
    _customPeqEditorState.enabled = true;
    _saveCustomPeqState();
  }
  if (Player?.setCustomPeqEnabled) Player.setCustomPeqEnabled(true);
  await _loadPeqWorkspaceContext();
  _refreshPeqWorkspacePeqOptions();
  const peqSel = document.getElementById('peq-workspace-peq-select');
  if (peqSel) {
    if (_peqWorkspaceSelectedPeqId && Array.from(peqSel.options).some(o => o.value === _peqWorkspaceSelectedPeqId)) {
      peqSel.value = _peqWorkspaceSelectedPeqId;
    } else {
      _peqWorkspaceSelectedPeqId = _WORKSPACE_NEW_PEQ_ID;
      peqSel.value = _WORKSPACE_NEW_PEQ_ID;
    }
  }
  _syncPeqPreampInputs(_customPeqEditorState.preamp_db);
  _updatePeqWorkspaceActionLabels();
  renderPeqEditorBands();
  _renderCustomPeqSavePanel(false);
  panel.style.display = 'block';
  _peqWorkspaceOpen = true;
  _snapshotPeqWorkspace();
  _schedulePeqWorkspaceGraphRefresh();
}

async function onPeqPrimaryAction() {
  if (_peqWorkspaceEditContext?.iemId && _peqWorkspaceEditContext?.peqId) {
    await saveCustomPeqAsProfile({
      iemId: _peqWorkspaceEditContext.iemId,
      name: `${_peqWorkspaceEditContext.peqName} Copy`,
    });
    return;
  }
  await applyAndClosePeqEditor();
}

async function overwriteCurrentPeqProfile() {
  if (!_peqWorkspaceEditContext?.iemId || !_peqWorkspaceEditContext?.peqId) return;
  const confirmOverwrite = await _showConfirm({
    title: 'Overwrite Existing PEQ?',
    message: `This will replace "${_peqWorkspaceEditContext.peqName}" with current values. This cannot be undone.`,
    okText: 'Overwrite',
    cancelText: 'Cancel',
    danger: true,
    icon: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent-secondary)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>`,
  });
  if (!confirmOverwrite) return;
  try {
    await _saveCustomProfileToIem(
      _peqWorkspaceEditContext.iemId,
      _peqWorkspaceEditContext.peqName,
      _peqWorkspaceEditContext.peqId
    );
    if (Player?.onPeqIemChange && Player?.onPeqProfileChange) {
      await Player.onPeqIemChange(_peqWorkspaceEditContext.iemId);
      await Player.onPeqProfileChange(_peqWorkspaceEditContext.peqId);
    }
    toast(`Overwrote "${_peqWorkspaceEditContext.peqName}".`);
    _snapshotPeqWorkspace();
    _hidePeqWorkspace({ toast: false });
  } catch (e) {
    toast('Could not overwrite profile: ' + e.message);
  }
}

async function onPeqSecondaryAction() {
  if (_peqWorkspaceEditContext?.iemId && _peqWorkspaceEditContext?.peqId) {
    await overwriteCurrentPeqProfile();
    return;
  }
  await saveCustomPeqAsProfile();
}

function closePeqEditor() {
  if (!_peqWorkspaceOpen) return;
  if (!_peqWorkspaceDirty) {
    _hidePeqWorkspace();
    return;
  }
  _showConfirm({
    title: 'Discard unsaved PEQ edits?',
    message: 'You have unsaved changes in Custom PEQ. Choose "Discard & Close" to exit without saving, or "Keep Editing" to continue.',
    okText: 'Discard & Close',
    cancelText: 'Keep Editing',
    danger: true,
    icon: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent-secondary)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>`,
  }).then(discard => {
    if (!discard) return;
    try {
      _customPeqEditorState = _sanitizeCustomPeqState(JSON.parse(_peqWorkspaceInitialJson || '{}'));
    } catch (_) {
      _customPeqEditorState = _defaultCustomPeqState();
    }
    _customPeqEditorState.enabled = true;
    const restored = _saveCustomPeqState();
    Player?.applyCustomPeq?.(restored);
    _setPeqWorkspaceDirty(false);
    _hidePeqWorkspace();
  });
}

async function applyAndClosePeqEditor() {
  if (_peqWorkspaceEditContext?.iemId && _peqWorkspaceEditContext?.peqId) {
    const overwrite = await _showConfirm({
      title: 'Save PEQ Changes',
      message: `Overwrite "${_peqWorkspaceEditContext.peqName}"? Choose Overwrite to replace it, or Cancel to save as a new profile.`,
      okText: 'Overwrite',
      danger: false,
    });
    if (overwrite) {
      try {
        await _saveCustomProfileToIem(
          _peqWorkspaceEditContext.iemId,
          _peqWorkspaceEditContext.peqName,
          _peqWorkspaceEditContext.peqId
        );
        if (Player?.onPeqIemChange && Player?.onPeqProfileChange) {
          await Player.onPeqIemChange(_peqWorkspaceEditContext.iemId);
          await Player.onPeqProfileChange(_peqWorkspaceEditContext.peqId);
        }
        toast(`Updated "${_peqWorkspaceEditContext.peqName}".`);
        _snapshotPeqWorkspace();
        _hidePeqWorkspace({ toast: false });
        return;
      } catch (e) {
        toast('Could not overwrite profile: ' + e.message);
        return;
      }
    } else {
      await saveCustomPeqAsProfile({
        iemId: _peqWorkspaceEditContext.iemId,
        name: `${_peqWorkspaceEditContext.peqName} Copy`,
      });
      return;
    }
  }
  const st = _saveCustomPeqState();
  st.enabled = true;
  _saveCustomPeqState();
  Player?.applyCustomPeq?.(st);
  _snapshotPeqWorkspace();
  toast('Custom PEQ saved.');
  _hidePeqWorkspace({ toast: false });
}

async function resetCustomPeq() {
  const ok = await _showConfirm({
    title: 'Reset Custom PEQ',
    message: 'Reset all 10 bands and preamp to defaults?',
    okText: 'Reset',
    danger: false,
  });
  if (!ok) return;
  _customPeqEditorState = _defaultCustomPeqState();
  _customPeqEditorState.enabled = true;
  const st = _saveCustomPeqState();
  _syncPeqPreampInputs(st.preamp_db);
  renderPeqEditorBands();
  Player?.applyCustomPeq?.(st);
  _schedulePeqWorkspaceGraphRefresh();
  _refreshPeqWorkspaceDirty();
}

function togglePeqBand(i) {
  const st = _loadCustomPeqState();
  if (!st.bands[i]) return;
  st.bands[i].enabled = !st.bands[i].enabled;
  st.enabled = true;
  _saveCustomPeqState();
  renderPeqEditorBands();
  Player?.applyCustomPeq?.(st);
  _schedulePeqWorkspaceGraphRefresh();
  _refreshPeqWorkspaceDirty();
}

function onPeqBandTypeChange(i, val) {
  const st = _loadCustomPeqState();
  const band = st.bands[i];
  if (!band) return;
  band.type = String(val || 'PK').toUpperCase();
  st.enabled = true;
  _saveCustomPeqState();
  renderPeqEditorBands();
  Player?.applyCustomPeq?.(st);
  _schedulePeqWorkspaceGraphRefresh();
  _refreshPeqWorkspaceDirty();
}

function onPeqBandFcChange(i, val) {
  const st = _loadCustomPeqState();
  const band = st.bands[i];
  if (!band) return;
  band.fc = Math.max(20, Math.min(20000, Math.round(_parseNum(val, band.fc))));
  st.enabled = true;
  _saveCustomPeqState();
  const enabledIdx = _enabledBandIndex(i);
  if (enabledIdx >= 0) Player?.updateBandParam?.(enabledIdx, band.fc, band.gain, band.q);
  _schedulePeqWorkspaceGraphRefresh();
  _refreshPeqWorkspaceDirty();
}

function onPeqBandGainChange(i, val) {
  const st = _loadCustomPeqState();
  const band = st.bands[i];
  if (!band) return;
  band.gain = Math.max(-30, Math.min(30, _parseNum(val, band.gain)));
  st.enabled = true;
  _saveCustomPeqState();
  const enabledIdx = _enabledBandIndex(i);
  if (enabledIdx >= 0 && !_CUSTOM_NO_GAIN_TYPES.has(String(band.type || '').toUpperCase())) {
    Player?.updateBandParam?.(enabledIdx, band.fc, band.gain, band.q);
  }
  _schedulePeqWorkspaceGraphRefresh();
  _refreshPeqWorkspaceDirty();
}

function onPeqBandQChange(i, val) {
  const st = _loadCustomPeqState();
  const band = st.bands[i];
  if (!band) return;
  band.q = Math.max(0.1, Math.min(10, _parseNum(val, band.q)));
  st.enabled = true;
  _saveCustomPeqState();
  const enabledIdx = _enabledBandIndex(i);
  if (enabledIdx >= 0) Player?.updateBandParam?.(enabledIdx, band.fc, band.gain, band.q);
  _schedulePeqWorkspaceGraphRefresh();
  _refreshPeqWorkspaceDirty();
}

function onPeqPreampChange(val, source = '') {
  const st = _loadCustomPeqState();
  st.preamp_db = Math.max(-30, Math.min(30, _parseNum(val, st.preamp_db)));
  st.enabled = true;
  _saveCustomPeqState();
  _syncPeqPreampInputs(st.preamp_db, source);
  Player?.updatePreamp?.(st.preamp_db);
  _schedulePeqWorkspaceGraphRefresh();
  _refreshPeqWorkspaceDirty();
}

function onPeqWorkspaceIemChange(iemId) {
  _peqWorkspaceSelectedIemId = iemId || '';
  const saveSel = document.getElementById('peq-save-iem-select');
  if (saveSel && _peqWorkspaceSelectedIemId) saveSel.value = _peqWorkspaceSelectedIemId;
  _peqWorkspaceSelectedPeqId = _WORKSPACE_NEW_PEQ_ID;
  _refreshPeqWorkspacePeqOptions();
  onPeqWorkspacePeqChange(_peqWorkspaceSelectedPeqId);
  _schedulePeqWorkspaceGraphRefresh();
}

function onPeqWorkspacePeqChange(peqId) {
  _peqWorkspaceSelectedPeqId = peqId || _WORKSPACE_NEW_PEQ_ID;
  if (_peqWorkspaceSelectedPeqId === _WORKSPACE_NEW_PEQ_ID) {
    _peqWorkspaceEditContext = null;
    _customPeqEditorState = _defaultCustomPeqState();
    _customPeqEditorState.enabled = true;
    _saveCustomPeqState();
    _syncPeqPreampInputs(_customPeqEditorState.preamp_db);
    renderPeqEditorBands();
    Player?.applyCustomPeq?.(_customPeqEditorState);
    _snapshotPeqWorkspace();
    _updatePeqWorkspaceActionLabels();
    _schedulePeqWorkspaceGraphRefresh();
    return;
  }
  const iemId = _peqWorkspaceSelectedIemId || document.getElementById('peq-workspace-iem-select')?.value || '';
  const iem = (_peqWorkspaceIemCache || []).find(i => i.id === iemId);
  const profile = (iem?.peq_profiles || []).find(p => p.id === _peqWorkspaceSelectedPeqId);
  if (!profile) return;
  _customPeqEditorState = _customStateFromProfile(profile);
  _saveCustomPeqState();
  _peqWorkspaceEditContext = { iemId, peqId: profile.id, peqName: profile.name || 'PEQ Profile' };
  _syncPeqPreampInputs(_customPeqEditorState.preamp_db);
  renderPeqEditorBands();
  Player?.applyCustomPeq?.(_customPeqEditorState);
  _snapshotPeqWorkspace();
  _updatePeqWorkspaceActionLabels();
  _schedulePeqWorkspaceGraphRefresh();
}

function onPeqWorkspaceTargetChange(targetId) {
  _peqWorkspaceSelectedTargetId = targetId || '';
  _schedulePeqWorkspaceGraphRefresh();
}

async function saveCustomPeqAsProfile(prefill = {}) {
  const panel = document.getElementById('peq-save-profile-panel');
  if (!panel) return;
  const isOpen = panel.style.display === 'block';
  if (isOpen) {
    _renderCustomPeqSavePanel(false);
    return;
  }
  _renderCustomPeqSavePanel(true);
  await _loadPeqSaveIems();
  const iemSel = document.getElementById('peq-save-iem-select');
  const nameEl = document.getElementById('peq-save-name');
  if (iemSel && prefill.iemId) iemSel.value = prefill.iemId;
  if (nameEl && prefill.name) nameEl.value = prefill.name;
}

function cancelCustomPeqSaveProfile() {
  _renderCustomPeqSavePanel(false);
}

async function confirmCustomPeqSaveProfile() {
  const iemSel = document.getElementById('peq-save-iem-select');
  const nameEl = document.getElementById('peq-save-name');
  const errEl = document.getElementById('peq-save-profile-error');
  if (!iemSel || !nameEl || !errEl) return;
  errEl.style.display = 'none';
  const iemId = iemSel.value;
  const name = nameEl.value.trim();
  if (!iemId || !name) {
    errEl.textContent = 'Pick an IEM and profile name.';
    errEl.style.display = 'block';
    return;
  }
  const st = _loadCustomPeqState();
  const enabledBands = st.bands.filter(b => b.enabled);
  if (!enabledBands.length) {
    errEl.textContent = 'Enable at least one band before saving.';
    errEl.style.display = 'block';
    return;
  }
  try {
    const created = await _saveCustomProfileToIem(iemId, name);
    _peqWorkspaceSelectedIemId = iemId;
    _peqWorkspaceSelectedPeqId = created?.id || _WORKSPACE_NEW_PEQ_ID;
    await _loadPeqWorkspaceContext();
    _refreshPeqWorkspacePeqOptions();
    toast(`Saved "${name}" to selected IEM.`);
    nameEl.value = '';
    _snapshotPeqWorkspace();
    _renderCustomPeqSavePanel(false);
  } catch (e) {
    errEl.textContent = e.message || 'Could not save profile';
    errEl.style.display = 'block';
  }
}

function downloadCustomPeqTxt() {
  const st = _loadCustomPeqState();
  const txt = _apoFromCustomState(st);
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Custom PEQ.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Custom PEQ .txt downloaded.');
}

async function copyCustomPeqToConnectedDap() {
  const iemSel = document.getElementById('peq-workspace-iem-select');
  const dapSel = document.getElementById('peq-copy-dap-select');
  const iemId = iemSel ? iemSel.value : '';
  if (!iemId) {
    toast('Select an IEM first.');
    return;
  }
  if (!_peqWorkspaceConnectedDaps.length) {
    toast('No connected DAP found.');
    return;
  }
  let connected = _peqWorkspaceConnectedDaps[0];
  if (_peqWorkspaceConnectedDaps.length > 1) {
    const selectedId = (dapSel && dapSel.value) || _peqWorkspaceCopyDapId || '';
    const picked = _peqWorkspaceConnectedDaps.find(d => d.id === selectedId);
    if (picked) connected = picked;
    _peqWorkspaceCopyDapId = connected.id;
  }
  const profileName = `Custom PEQ ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
  try {
    const created = await _saveCustomProfileToIem(iemId, profileName);
    await api(`/iems/${iemId}/peq/${created.id}/copy`, { method: 'POST', body: { dap_id: connected.id } });
    _snapshotPeqWorkspace();
    toast(`Copied "${profileName}" to ${connected.name}.`);
  } catch (e) {
    toast('Copy failed: ' + e.message);
  }
}

function showAddIemModal() {
  _ensureGearProfileSelects();
  document.getElementById('iem-modal-title').textContent = 'IEM / Headphone Profile';
  document.getElementById('iem-modal-id').value = '';
  document.getElementById('iem-name').value = '';
  const typeSel = document.getElementById('iem-type');
  if (typeSel && typeSel.options.length > 0) typeSel.value = typeSel.options[0].value;
  _setIemModalSources([]);
  _closeIemHelpPanels();
  document.getElementById('iem-modal-error').style.display = 'none';
  document.getElementById('iem-save-btn').disabled = false;
  document.getElementById('iem-save-btn').textContent = 'Save';
  document.getElementById('iem-modal').style.display = 'flex';
  _commitIemModalBaseline();
}

async function showEditIemModal(id) {
  _ensureGearProfileSelects();
  const iem = await api(`/iems/${id}`);
  document.getElementById('iem-modal-title').textContent = 'IEM / Headphone Profile';
  document.getElementById('iem-modal-id').value = id;
  document.getElementById('iem-name').value = iem.name || '';
  const typeSel = document.getElementById('iem-type');
  if (typeSel && iem.type && !Array.from(typeSel.options).some(o => o.value === iem.type)) {
    const opt = document.createElement('option');
    opt.value = iem.type;
    opt.textContent = iem.type;
    typeSel.appendChild(opt);
  }
  document.getElementById('iem-type').value = iem.type || (typeSel && typeSel.options.length ? typeSel.options[0].value : 'IEM');
  const srcs = (iem.squig_sources || []).slice(0, 3).map(s => ({ label: s.label || '', url: s.url || '' }));
  if (!srcs.length && iem.squig_url) srcs.push({ label: 'Primary', url: iem.squig_url });
  _setIemModalSources(srcs);
  _closeIemHelpPanels();
  document.getElementById('iem-modal-error').style.display = 'none';
  document.getElementById('iem-save-btn').disabled = false;
  document.getElementById('iem-save-btn').textContent = 'Save';
  document.getElementById('iem-modal').style.display = 'flex';
  _commitIemModalBaseline();
}

function closeIemModal() {
  _closeIemHelpPanels();
  document.getElementById('iem-modal').style.display = 'none';
  const banner = document.getElementById('iem-unsaved-banner');
  if (banner) banner.style.display = 'none';
  _iemModalInitialJson = '';
}

function toggleIemHelp(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function _closeIemHelpPanels() {
  document.querySelectorAll('#iem-modal .dap-inline-help').forEach(el => {
    el.style.display = 'none';
  });
}

function _restoreIemDraftFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const typeSel = document.getElementById('iem-type');
  if (typeSel && snapshot.type && !Array.from(typeSel.options).some(o => o.value === snapshot.type)) {
    const opt = document.createElement('option');
    opt.value = snapshot.type;
    opt.textContent = snapshot.type;
    typeSel.appendChild(opt);
  }
  document.getElementById('iem-modal-id').value = snapshot.id || '';
  document.getElementById('iem-name').value = snapshot.name || '';
  if (typeSel) typeSel.value = snapshot.type || (typeSel.options.length ? typeSel.options[0].value : 'IEM');
  document.getElementById('iem-source-label-1').value = snapshot.s1l || '';
  document.getElementById('iem-source-url-1').value = snapshot.s1u || '';
  document.getElementById('iem-source-label-2').value = snapshot.s2l || '';
  document.getElementById('iem-source-url-2').value = snapshot.s2u || '';
  document.getElementById('iem-source-label-3').value = snapshot.s3l || '';
  document.getElementById('iem-source-url-3').value = snapshot.s3u || '';
  _updateIemModalUnsavedBanner();
}

function revertIemModalChanges() {
  if (!_iemModalInitialJson) return;
  try {
    const snapshot = JSON.parse(_iemModalInitialJson);
    _restoreIemDraftFromSnapshot(snapshot);
  } catch (_) {
    // no-op
  }
}

function iemModalChanged() {
  _updateIemModalUnsavedBanner();
}

async function saveIem() {
  const id = document.getElementById('iem-modal-id').value;
  const squigSources = _collectIemModalSources();
  const body = {
    name: document.getElementById('iem-name').value.trim() || 'New IEM',
    type: document.getElementById('iem-type').value,
    squig_sources: squigSources,
  };
  const errEl = document.getElementById('iem-modal-error');
  const btn = document.getElementById('iem-save-btn');
  btn.disabled = true;
  btn.textContent = squigSources.length ? 'Fetching measurement…' : 'Saving…';
  errEl.style.display = 'none';
  try {
    let saved;
    if (id) {
      saved = await api(`/iems/${id}`, { method: 'PUT', body });
    } else {
      saved = await api('/iems', { method: 'POST', body });
    }
    closeIemModal();
    if (id) {
      showIemDetail(id);
    } else {
      showIemDetail(saved.id);
    }
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function deleteIem(id) {
  const ok = await _showConfirm({
    title:   'Delete IEM / Headphone',
    message: 'All measurements and EQ profiles for this IEM will be removed.',
    okText:  'Delete',
  });
  if (!ok) return;
  if (_iemChart) { _iemChart.destroy(); _iemChart = null; }
  await api(`/iems/${id}`, { method: 'DELETE' });
  showView('gear');
}

function showPeqModal() {
  document.getElementById('peq-name').value = '';
  document.getElementById('peq-file-input').value = '';
  document.getElementById('peq-modal-error').style.display = 'none';
  document.getElementById('peq-modal').style.display = 'flex';
}

function closePeqModal() {
  document.getElementById('peq-modal').style.display = 'none';
}

async function savePeq() {
  if (!_currentIemId) return;
  const nameVal = document.getElementById('peq-name').value.trim();
  const fileInput = document.getElementById('peq-file-input');
  const errEl = document.getElementById('peq-modal-error');
  errEl.style.display = 'none';

  if (!fileInput.files.length) {
    errEl.textContent = 'Please select a PEQ file.';
    errEl.style.display = 'block';
    return;
  }

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  if (nameVal) formData.append('name', nameVal);

  try {
    const res = await fetch(`/api/iems/${_currentIemId}/peq`, { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(err.error || 'Upload failed');
    }
    closePeqModal();
    await showIemDetail(_currentIemId);
  } catch (e) {
    errEl.textContent = e.message || 'Failed to upload PEQ file. Check the file format.';
    errEl.style.display = 'block';
  }
}

async function deletePeq(peqId) {
  if (!_currentIemId) return;
  const ok = await _showConfirm({
    title:   'Delete EQ Profile',
    message: 'This EQ profile will be permanently removed.',
    okText:  'Delete',
  });
  if (!ok) return;
  await api(`/iems/${_currentIemId}/peq/${peqId}`, { method: 'DELETE' });
  if (_activePeqId === peqId) _activePeqId = null;
  await showIemDetail(_currentIemId);
}

/* ── Songs view ─────────────────────────────────────────────────────── */
let _songsData = [];
let _songsSort = { col: 'title', order: 'asc' };
let _songsFilter = '';
let _songsPage = 0;
const SONGS_PER_PAGE = 100;
const _TABLE_COLUMNS_STORAGE_KEY = 'tb.table_columns.v1';
const _TABLE_COLUMNS = [
  { key: 'track_number', label: 'Track #' },
  { key: 'title', label: 'Title' },
  { key: 'duration', label: 'Time' },
  { key: 'artist', label: 'Artist' },
  { key: 'album', label: 'Album' },
  { key: 'album_artist', label: 'Album Artist' },
  { key: 'genre', label: 'Genre' },
  { key: 'year', label: 'Year' },
  { key: 'disc_number', label: 'Disc #' },
  { key: 'format', label: 'Format' },
  { key: 'bitrate', label: 'Bitrate' },
  { key: 'sample_rate', label: 'Sample Rate' },
  { key: 'bit_depth', label: 'Bit Depth' },
  { key: 'date_added', label: 'Date Added' },
  { key: 'filename', label: 'Filename' },
  { key: 'favourite', label: 'Favourite' },
  { key: 'actions', label: 'Actions' },
];
const _TABLE_COL_DEFAULTS = {
  track_number: true,
  title: true,
  duration: true,
  artist: true,
  album: true,
  album_artist: true,
  genre: true,
  year: true,
  disc_number: false,
  format: false,
  bitrate: false,
  sample_rate: false,
  bit_depth: false,
  date_added: false,
  filename: false,
  favourite: true,
  actions: true,
};
let _tableColVisible = { ..._TABLE_COL_DEFAULTS };
let _tableColsPopoverEl = null;
let _tableColsContextKeys = _TABLE_COLUMNS.map(c => c.key);

function _loadTableColumnPrefs() {
  try {
    const raw = localStorage.getItem(_TABLE_COLUMNS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    _tableColVisible = { ..._TABLE_COL_DEFAULTS };
    for (const c of _TABLE_COLUMNS) {
      if (Object.prototype.hasOwnProperty.call(parsed, c.key)) {
        _tableColVisible[c.key] = !!parsed[c.key];
      }
    }
  } catch (_) {}
}

function _saveTableColumnPrefs() {
  try {
    localStorage.setItem(_TABLE_COLUMNS_STORAGE_KEY, JSON.stringify(_tableColVisible));
  } catch (_) {}
}

function _isTableColVisible(colKey) {
  if (!colKey) return true;
  if (colKey === 'actions') return true;
  if (!Object.prototype.hasOwnProperty.call(_TABLE_COL_DEFAULTS, colKey)) return true;
  return !!_tableColVisible[colKey];
}

function _applyTableColumnVisibility() {
  ['songs-table', 'tracks-table', 'pl-table', 'fav-songs-table'].forEach(id => {
    const table = document.getElementById(id);
    if (!table) return;
    table.querySelectorAll('[data-col]').forEach(el => {
      const key = el.getAttribute('data-col') || '';
      el.style.display = _isTableColVisible(key) ? '' : 'none';
    });
  });
  document.querySelectorAll('#tracks-multi-disc-container [data-col]').forEach(el => {
    const key = el.getAttribute('data-col') || '';
    el.style.display = _isTableColVisible(key) ? '' : 'none';
  });
}

function _ensureTableColsPopover() {
  if (_tableColsPopoverEl) return _tableColsPopoverEl;
  const pop = document.createElement('div');
  pop.id = 'table-columns-popover';
  pop.className = 'table-columns-popover';
  pop.style.display = 'none';
  document.body.appendChild(pop);
  _tableColsPopoverEl = pop;
  return pop;
}

function _renderTableColumnsPopover() {
  const pop = _ensureTableColsPopover();
  const visibleDefs = _TABLE_COLUMNS.filter(c => _tableColsContextKeys.includes(c.key));
  pop.innerHTML = `
    <div class="table-columns-popover-title">Visible Columns</div>
    ${visibleDefs.map(c => `
      <label class="table-columns-popover-item">
        <input type="checkbox" ${_isTableColVisible(c.key) ? 'checked' : ''} onchange="App.setTableColumnVisible('${c.key}', this.checked)" />
        <span>${esc(c.label)}</span>
      </label>
    `).join('')}
  `;
}

function _getColumnContextKeys(anchor) {
  if (!anchor) return _TABLE_COLUMNS.map(c => c.key);
  if (anchor.closest('#view-songs')) {
    return ['track_number', 'title', 'artist', 'album', 'duration', 'favourite', 'genre', 'year', 'disc_number', 'album_artist', 'format', 'bitrate', 'sample_rate', 'bit_depth', 'date_added', 'filename', 'actions'];
  }
  if (anchor.closest('#view-playlist')) {
    return ['track_number', 'title', 'artist', 'album', 'duration', 'genre', 'year', 'favourite', 'actions'];
  }
  if (anchor.closest('#view-fav-songs')) {
    return ['track_number', 'title', 'artist', 'album', 'duration', 'favourite', 'actions'];
  }
  if (anchor.closest('#view-tracks') || anchor.closest('#view-albums')) {
    return ['track_number', 'title', 'album', 'genre', 'duration', 'favourite', 'actions'];
  }
  return _TABLE_COLUMNS.map(c => c.key);
}

function toggleTableColumnsPopover(evt) {
  const anchor = evt?.currentTarget;
  if (!anchor) return;
  const pop = _ensureTableColsPopover();
  const willOpen = pop.style.display !== 'block';
  if (!willOpen) {
    pop.style.display = 'none';
    return;
  }
  _tableColsContextKeys = _getColumnContextKeys(anchor);
  _renderTableColumnsPopover();
  const rect = anchor.getBoundingClientRect();
  pop.style.visibility = 'hidden';
  pop.style.display = 'block';
  const popW = pop.offsetWidth || 240;
  const popH = pop.offsetHeight || 320;
  const pad = 12;
  let left = Math.round(rect.left);
  let top = Math.round(rect.bottom + 8);
  left = Math.max(pad, Math.min(left, window.innerWidth - popW - pad));
  if (top + popH > window.innerHeight - pad) {
    top = Math.round(rect.top - popH - 8);
  }
  top = Math.max(pad, top);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.visibility = '';
}

function setTableColumnVisible(colKey, visible) {
  if (colKey === 'actions') {
    _tableColVisible.actions = true;
    _saveTableColumnPrefs();
    _applyTableColumnVisibility();
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(_TABLE_COL_DEFAULTS, colKey)) return;
  _tableColVisible[colKey] = !!visible;
  _saveTableColumnPrefs();
  _applyTableColumnVisibility();
}

document.addEventListener('click', (e) => {
  const pop = _tableColsPopoverEl;
  if (!pop || pop.style.display !== 'block') return;
  const t = e.target;
  if (pop.contains(t)) return;
  if (t && (t.closest('.table-columns-btn'))) return;
  pop.style.display = 'none';
});

_loadTableColumnPrefs();

function _getSongsFilteredTracks() {
  let tracks = _songsData;
  if (_songsFilter) {
    const q = _songsFilter.toLowerCase();
    tracks = tracks.filter(t =>
      ((t.title || '') + ' ' + (t.artist || '') + ' ' + (t.album || '')).toLowerCase().includes(q)
    );
  }
  return tracks;
}

async function loadSongsView() {
  try {
    _songsData = await api(`/library/songs?sort=${_songsSort.col}&order=${_songsSort.order}`);
  } catch (e) {
    _songsData = [];
    const wrap = document.getElementById('songs-table-wrap');
    if (wrap) wrap.innerHTML =
      `<div class="library-error-banner"><p>Could not load songs: ${esc(e.message)}</p>
       <p class="library-error-hint">Check that your music folder is accessible, then rescan in Settings.</p></div>`;
    return;
  }
  renderSongsTable();
}

function renderSongsTable() {
  let tracks = _getSongsFilteredTracks();
  const total = tracks.length;
  const songsWrap = document.getElementById('songs-table-wrap');
  const songsEmpty = document.getElementById('songs-empty');
  if (!total) {
    if (songsWrap) songsWrap.style.display = 'none';
    if (songsEmpty) songsEmpty.style.display = 'flex';
    const count = document.getElementById('songs-count');
    if (count) count.textContent = '0 songs';
    const paginationEl = document.getElementById('songs-pagination');
    if (paginationEl) paginationEl.style.display = 'none';
    return;
  }
  if (songsWrap) songsWrap.style.display = '';
  if (songsEmpty) songsEmpty.style.display = 'none';

  const totalPages = Math.ceil(total / SONGS_PER_PAGE);
  if (_songsPage >= totalPages) _songsPage = Math.max(0, totalPages - 1);
  const start = _songsPage * SONGS_PER_PAGE;
  const end = Math.min(start + SONGS_PER_PAGE, total);
  const page = tracks.slice(start, end);

  const count = document.getElementById('songs-count');
  if (count) count.textContent = `${total.toLocaleString()} songs`;

  // Pagination bar
  let paginationEl = document.getElementById('songs-pagination');
  if (!paginationEl) {
    paginationEl = document.createElement('div');
    paginationEl.id = 'songs-pagination';
    paginationEl.className = 'songs-pagination';
    const wrap = document.getElementById('songs-table-wrap');
    if (wrap) wrap.after(paginationEl);
  }
  if (totalPages > 1) {
    paginationEl.innerHTML = `
      <button class="btn-secondary" onclick="App.songsPrevPage()" ${_songsPage === 0 ? 'disabled' : ''}>‹ Prev</button>
      <span class="songs-page-info">Page ${_songsPage + 1} of ${totalPages} &nbsp;·&nbsp; ${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}</span>
      <button class="btn-secondary" onclick="App.songsNextPage()" ${_songsPage >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>
    `;
    paginationEl.style.display = 'flex';
  } else {
    paginationEl.style.display = 'none';
  }

  const tbody = document.getElementById('songs-tbody');
  if (!tbody) return;

  // Update sort arrows
  document.querySelectorAll('#songs-table .sort-arrow').forEach(el => el.textContent = '');
  const arrow = document.getElementById(`songs-sort-${_songsSort.col}`);
  if (arrow) arrow.textContent = _songsSort.order === 'asc' ? '\u25B2' : '\u25BC';

  Player.registerTracks(page);
  Player.setPlaybackContext(tracks, { sourceType: 'songs', sourceId: '', sourceLabel: 'Songs' });

  tbody.innerHTML = page.map((t, i) => {
    const globalIdx = start + i;
    const fmtDate = t.date_added ? new Date(t.date_added * 1000).toLocaleDateString() : '';
    const bitrate = t.bitrate ? t.bitrate + ' kbps' : '';
    const sampleRate = t.sample_rate ? `${t.sample_rate} Hz` : '';
    const bitDepth = t.bits_per_sample ? `${t.bits_per_sample}-bit` : '';
    const playIcon = playSvg(11);
    return `
    <tr data-id="${t.id}" ondblclick="Player.playTrackById('${t.id}')" oncontextmenu="App.showTrackCtxMenu(event,'${t.id}')">
      <td class="col-num" data-col="track_number" onclick="App.toggleTrackSelection('${t.id}', ${globalIdx}, event)">
        <div class="num-cell">
          <span class="track-check-indicator"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><polyline points="20 6 9 17 4 12"/></svg></span>
          <span class="track-num">${t.track_number || (globalIdx + 1)}</span>
        </div>
      </td>
      <td data-col="title">
        <div class="title-cell">
          <div class="thumb-wrap" style="width:34px;height:34px">
            <div class="thumb">${thumbImg(t.artwork_key, 34, '4px')}</div>
            <button class="thumb-play-btn" onclick="event.stopPropagation();Player.playTrackById('${t.id}')" title="Play">${playIcon}</button>
          </div>
          <div class="track-info">
            <div class="track-title" title="${esc(t.title)}">${esc(t.title)}</div>
          </div>
        </div>
      </td>
      <td data-col="artist" class="cell-artist" title="${esc(t.artist)}">${esc(t.artist)}</td>
      <td data-col="album" class="cell-album" title="${esc(t.album)}">${esc(t.album)}</td>
      <td data-col="duration" class="col-dur">${esc(t.duration_fmt || '')}</td>
      <td data-col="favourite" class="col-fav-cell">${_favToggleBtn('songs', t.id, 'track-fav-btn')}</td>
      <td data-col="genre" style="color:var(--text-sub);font-size:var(--text-sm)" title="${esc(t.genre || '')}">${esc(t.genre || '')}</td>
      <td data-col="year" style="color:var(--text-muted);font-size:var(--text-sm)">${esc(t.year || '')}</td>
      <td data-col="disc_number" style="color:var(--text-muted);font-size:var(--text-sm)">${esc(t.disc_number || '')}</td>
      <td data-col="album_artist" style="color:var(--text-sub);font-size:var(--text-sm)" title="${esc(t.album_artist || '')}">${esc(t.album_artist || '')}</td>
      <td data-col="format" style="color:var(--text-muted);font-size:var(--text-sm)">${esc(t.format || '')}</td>
      <td data-col="bitrate" style="color:var(--text-muted);font-size:var(--text-sm)">${bitrate}</td>
      <td data-col="sample_rate" style="color:var(--text-muted);font-size:var(--text-sm)">${sampleRate}</td>
      <td data-col="bit_depth" style="color:var(--text-muted);font-size:var(--text-sm)">${bitDepth}</td>
      <td data-col="date_added" style="color:var(--text-muted);font-size:var(--text-sm)">${fmtDate}</td>
      <td data-col="filename" style="color:var(--text-muted);font-size:var(--text-sm)" title="${esc(t.filename || '')}">${esc(t.filename || '')}</td>
      <td data-col="actions"><div class="col-act-inner">
        <button class="row-ctx-btn" onclick="event.stopPropagation();App.showTrackCtxMenu(event,'${t.id}')" title="More actions">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>
        <button class="track-edit-btn" onclick="event.stopPropagation();App.openTagEditor('${t.id}')" title="Edit tags">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="add-btn" onclick="App.showAddDropdown(event, '${t.id}')" title="Add to playlist">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div></td>
    </tr>`;
  }).join('');
  _applyTableColumnVisibility();
}

function sortSongs(col) {
  if (_songsSort.col === col) {
    _songsSort.order = _songsSort.order === 'asc' ? 'desc' : 'asc';
  } else {
    _songsSort.col = col;
    _songsSort.order = 'asc';
  }
  _songsPage = 0;
  loadSongsView();
}

function songsPrevPage() {
  if (_songsPage > 0) { _songsPage--; renderSongsTable(); _scrollSongsTop(); }
}
function songsNextPage() {
  _songsPage++; renderSongsTable(); _scrollSongsTop();
}
function _scrollSongsTop() {
  const main = document.getElementById('main');
  if (main) main.scrollTop = 0;
}

const _debouncedRenderSongsTable = _debounce(() => renderSongsTable(), 200);
function filterSongs(val) {
  _songsFilter = val;
  _songsPage = 0;
  const clearBtn = document.getElementById('songs-filter-clear');
  if (clearBtn) clearBtn.style.display = val ? 'block' : 'none';
  _debouncedRenderSongsTable();
}

function clearSongsFilter() {
  _songsFilter = '';
  const inp = document.getElementById('songs-filter-input');
  if (inp) inp.value = '';
  const clearBtn = document.getElementById('songs-filter-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  renderSongsTable();
}

/* ── Backup & Browse ────────────────────────────────────────────────── */
async function browseFolder(inputId) {
  const res = await api('/browse/folder', { method: 'POST' }).catch(() => null);
  if (!res) { toast('Could not open folder picker'); return; }
  if (res.error) { toast(res.error); return; }
  if (res.path) {
    const el = document.getElementById(inputId);
    if (el) {
      let value = res.path;
      if (inputId === 'dap-music-root') {
        const mount = (document.getElementById('dap-mount')?.value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
        const chosen = value.replace(/\\/g, '/');
        if (mount && chosen.toLowerCase().startsWith(mount.toLowerCase() + '/')) {
          value = chosen.slice(mount.length + 1);
        }
      }
      el.value = value;
      el.focus();
      if (inputId === 'dap-path-template') dapTemplateChanged();
    }
  }
  // res.path === null means user cancelled — do nothing
}

function exportBackup() {
  window.location.href = '/api/backup/export';
}

async function importBackup(input) {
  const file = input.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/backup/import', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.ok) {
      toast('Backup restored successfully — reloading…');
      setTimeout(() => location.reload(), 1500);
    } else {
      toast('Restore failed. The file may be corrupt.');
    }
  } catch(e) {
    toast('Restore failed. The file may be corrupt.');
  }
  input.value = '';  // reset so same file can be re-selected
}

/* ── Settings ──────────────────────────────────────────────────────── */
async function loadSettings() {
  const [settings, cap] = await Promise.all([
    api('/settings').catch(() => ({})),
    fetch('/api/player/capabilities').then(r => r.json()).catch(() => ({})),
    loadBaselines(),
  ]);
  if (typeof Player !== 'undefined' && Player.updateCapabilities) {
    Player.updateCapabilities(cap || {});
  }
  const inp = document.getElementById('lib-path-input');
  if (inp) inp.value = settings.library_path || '/Volumes/Storage/Music/FLAC';
  const dirEl = document.getElementById('settings-data-dir');
  if (dirEl && settings._data_dir) dirEl.textContent = settings._data_dir;

  // Populate audio device picker
  const deviceSelect = document.getElementById('audio-device-select');
  if (deviceSelect) {
    const mpvOk = !!(cap && cap.mpv_available);
    deviceSelect.disabled = !mpvOk;
    if (mpvOk) {
      try {
        const { devices } = await fetch('/api/player/audio_devices').then(r => r.json());
        deviceSelect.innerHTML = '';
        (devices || []).forEach(d => {
          const opt = document.createElement('option');
          opt.value       = d.name;
          opt.textContent = d.description || d.name;
          if (d.name === (cap.audio_device || 'auto')) opt.selected = true;
          deviceSelect.appendChild(opt);
        });
        // Keep player's output popover in sync
        if (typeof Player !== 'undefined' && Player.updateOutputDevice) {
          Player.updateOutputDevice(cap.audio_device || 'auto');
        }
      } catch (_) {}
    }
  }

  // Populate exclusive mode toggle
  const toggle  = document.getElementById('exclusive-mode-toggle');
  const badge   = document.getElementById('exclusive-backend-badge');
  const bpPill  = document.getElementById('exclusive-bp-pill');
  const installActions = document.getElementById('mpv-install-actions');
  const installBtn = document.getElementById('mpv-install-btn');
  if (toggle) {
    const mpvOk      = !!(cap && cap.mpv_available);
    const activeMode = mpvOk && !!(cap && cap.exclusive_mode);
    toggle.disabled = !mpvOk;
    toggle.checked  = !!(cap && cap.exclusive_mode);
    if (badge) {
      badge.style.display = '';
      const mpvErr = String((cap && cap.mpv_error) || '');
      const missingPyMpv = /No module named ['"]mpv['"]/.test(mpvErr);
      badge.textContent   = mpvOk
        ? `mpv ${cap.mpv_version || ''}`.trim()
        : (missingPyMpv ? 'python-mpv missing' : 'mpv backend unavailable');
      badge.className     = `settings-badge ${mpvOk ? 'settings-badge--ok' : 'settings-badge--warn'}`;
      badge.title = cap && cap.mpv_error ? cap.mpv_error : '';
    }
    if (bpPill) bpPill.style.display = activeMode ? '' : 'none';
    if (installActions) installActions.style.display = mpvOk ? 'none' : '';
    if (installBtn) {
      installBtn.disabled = false;
      installBtn.textContent = 'Install mpv';
    }
  }

  // Populate artist image service settings
  const imgSvc = document.getElementById('artist-image-service-select');
  if (imgSvc) {
    imgSvc.value = settings.artist_image_service || 'itunes';
    onArtistImageServiceChange(imgSvc.value);
  }
  const lastfmIn = document.getElementById('lastfm-api-key-input');
  if (lastfmIn) lastfmIn.value = settings.lastfm_api_key || '';
  const fanartIn = document.getElementById('fanart-api-key-input');
  if (fanartIn) fanartIn.value = settings.fanart_api_key || '';
  window._artistImageServicePref = settings.artist_image_service || 'itunes';

  const listeningToggle = document.getElementById('listening-tracking-toggle');
  if (listeningToggle) {
    listeningToggle.checked = settings.listening_tracking_enabled !== false;
  }

  // Resume batch-job progress banner if a job is already running
  try {
    const batchStatus = await fetch('/api/artists/images/batch/status').then(r => r.json());
    _updateArtistBatchBanner(batchStatus);
    if (batchStatus.status === 'running') _startArtistBatchPolling();
  } catch (_) {}

  // Display app version + channel picker
  try {
    const ver = await fetch('/api/version').then(r => r.json());
    const verEl = document.getElementById('app-version-display');
    const channelSel = document.getElementById('update-channel-select');
    if (verEl && ver.version && ver.version !== 'unknown') {
      const display = ver.version_full || ver.version;
      verEl.textContent = `v${display}${ver.released ? '  ·  ' + ver.released : ''}`;
    }
    if (channelSel && ver.channel) channelSel.value = ver.channel;
  } catch (_) {}

  return settings;
}

async function setListeningTracking(enabled) {
  try {
    await api('/settings', { method: 'PUT', body: { listening_tracking_enabled: !!enabled } });
    toast(enabled ? 'Listening history enabled' : 'Listening history paused');
  } catch (e) {
    const toggle = document.getElementById('listening-tracking-toggle');
    if (toggle) toggle.checked = !enabled;
    toast('Could not update listening history');
  }
}

async function clearListeningHistory() {
  const ok = await _showConfirm({
    title: 'Clear listening history?',
    message: 'This removes Home recommendations and 12-month listening stats.',
    okText: 'Clear',
    danger: true,
  });
  if (!ok) return;
  try {
    await fetch('/api/player/events/clear', { method: 'POST' });
    toast('Listening history cleared');
    if (state.view === 'home') loadHome();
  } catch (e) {
    toast('Could not clear listening history');
  }
}

async function setExclusiveMode(enabled) {
  try {
    const data = await fetch('/api/player/exclusive', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ enabled }),
    }).then(r => r.json());

    // Sync player bar badge and Settings BP pill immediately
    if (typeof Player !== 'undefined' && Player.updateExclusiveMode) {
      Player.updateExclusiveMode(!!data.exclusive_mode);
    }
    const bpPill = document.getElementById('exclusive-bp-pill');
    if (bpPill) bpPill.style.display = data.exclusive_mode ? '' : 'none';

    // Resume same track at same position on the new mpv instance
    if (data.resume_track_id && typeof Player !== 'undefined') {
      await Player.resumeAt(
        data.resume_track_id,
        data.resume_position || 0,
        !!data.was_playing
      );
    }

    toast(data.exclusive_mode ? 'Exclusive mode on — bit-perfect output active' : 'Exclusive mode off');
  } catch (e) {
    toast('Could not toggle exclusive mode');
  }
}

async function setAudioDevice(device) {
  try {
    const data = await fetch('/api/player/audio_device', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ device }),
    }).then(r => r.json());
    const appliedDevice = data.audio_device || device;
    if (data.resume_track_id && typeof Player !== 'undefined') {
      await Player.resumeAt(
        data.resume_track_id,
        data.resume_position || 0,
        !!data.was_playing
      );
    }
    // Sync player output popover selection
    if (typeof Player !== 'undefined' && Player.updateOutputDevice) {
      Player.updateOutputDevice(appliedDevice);
    }
    // Sync settings select
    const sel = document.getElementById('audio-device-select');
    if (sel) sel.value = appliedDevice;
    const label = sel
      ? Array.from(sel.options).find(opt => opt.value === appliedDevice)
      : null;
    if (data.requested_device && data.requested_device !== appliedDevice) {
      toast('Requested output unavailable. Using: ' + (label ? label.textContent : appliedDevice));
    } else {
      toast('Audio output: ' + (label ? label.textContent : appliedDevice));
    }
  } catch (e) {
    toast('Error switching audio device: ' + e.message);
  }
}

async function installMpv() {
  const btn = document.getElementById('mpv-install-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Installing...';
  }
  try {
    const res = await fetch('/api/player/install_mpv', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) {
      const err = new Error(data.error || 'Install failed');
      err.status = data.status || null;
      throw err;
    }
    await loadSettings();
    toast('mpv runtime ready. Bit-perfect output is now available.');
  } catch (e) {
    let msg = e.message;
    try {
      const status = (typeof e === 'object' && e && e.status) ? e.status : null;
      if (status && status.python_mpv_ok && !status.libmpv_path) {
        msg = `${msg} (python-mpv is installed, but libmpv is still missing)`;
      }
    } catch (_) {}
    toast('mpv install failed. Restart the app and try again.');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Install mpv';
    }
  }
}

async function retryMpvDetection() {
  const btn = document.getElementById('mpv-retry-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Checking...';
  }
  try {
    const cap = await fetch('/api/player/capabilities').then(r => r.json());
    await loadSettings();
    if (cap && cap.mpv_available) {
      toast(`mpv detected${cap.mpv_version ? ' (' + cap.mpv_version + ')' : ''}.`);
    } else {
      toast('mpv still unavailable. Use Install mpv or restart app after installation.');
    }
  } catch (e) {
    toast('mpv detection failed: ' + e.message);
  } finally {
    const retryBtn = document.getElementById('mpv-retry-btn');
    if (retryBtn) {
      retryBtn.disabled = false;
      retryBtn.textContent = 'Retry detection';
    }
  }
}

async function saveLibraryPath() {
  const path = document.getElementById('lib-path-input').value.trim();
  if (!path) { toast('Please enter a valid path'); return; }
  try {
    await api('/settings', { method: 'PUT', body: { library_path: path } });
    toast('Library path saved. Rescan to apply changes.');
  } catch (e) {
    toast('Could not save library path');
  }
}

function closeOnboarding() {
  const modal = document.getElementById('onboarding-modal');
  if (modal) modal.style.display = 'none';
}

function _showOnboarding(settings = {}) {
  const modal = document.getElementById('onboarding-modal');
  if (!modal) return;
  const pathEl = document.getElementById('onboard-lib-path');
  const structureEl = document.getElementById('onboard-folder-format');
  const formatEl = document.getElementById('onboard-file-format');
  if (pathEl) pathEl.value = settings.library_path || '/Users/you/Music';
  if (structureEl) structureEl.value = settings.library_structure || 'artist_album_track';
  if (formatEl) formatEl.value = settings.preferred_audio_format || 'flac';
  modal.style.display = 'flex';
}

async function completeOnboarding() {
  const path = (document.getElementById('onboard-lib-path')?.value || '').trim();
  const libraryStructure = document.getElementById('onboard-folder-format')?.value || 'artist_album_track';
  const preferredAudioFormat = document.getElementById('onboard-file-format')?.value || 'flac';

  if (!path) {
    toast('Choose your music library folder');
    return;
  }

  try {
    await api('/settings', {
      method: 'PUT',
      body: {
        library_path: path,
        library_structure: libraryStructure,
        preferred_audio_format: preferredAudioFormat,
        onboarding_completed: true,
      },
    });
    closeOnboarding();
    const libInput = document.getElementById('lib-path-input');
    if (libInput) libInput.value = path;
    toast('Welcome to TuneBridge. Setup saved.');
  } catch (e) {
    toast('Could not save settings');
  }
}

async function restartApp() {
  const btn = document.getElementById('restart-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px;animation:spin 1s linear infinite"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/></svg>Restarting…'; }
  try {
    await fetch('/api/restart', { method: 'POST' });
  } catch (_) { /* connection may drop before response — expected */ }

  // Poll until the server is back up, then reload
  const poll = setInterval(async () => {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok) { clearInterval(poll); window.location.reload(); }
    } catch (_) { /* still restarting */ }
  }, 800);
}

let _updateDownloadUrl = '';

function _setUpdateStatus(state, text) {
  const line  = document.getElementById('update-status-line');
  const icon  = document.getElementById('update-status-icon');
  const label = document.getElementById('update-status-label');
  if (!line) return;
  line.style.display = '';
  line.className = 'settings-update-status' + (state ? ' settings-update-status--' + state : '');
  if (icon)  icon.textContent  = state === 'ok' ? '✓' : state === 'avail' ? '↑' : state === 'error' ? '✕' : '…';
  if (label) label.textContent = text;
}

async function setUpdateChannel(channel) {
  try {
    await fetch('/api/version/channel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel }),
    });
  } catch (_) {}
  // Reset status and auto-check on channel switch
  const line  = document.getElementById('update-status-line');
  const dlBtn = document.getElementById('update-download-btn');
  if (line)  line.style.display = 'none';
  if (dlBtn) dlBtn.style.display = 'none';
  _updateDownloadUrl = '';
  checkForUpdate();
}

async function checkForUpdate() {
  const btn   = document.getElementById('check-update-btn');
  const dlBtn = document.getElementById('update-download-btn');

  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  if (dlBtn) dlBtn.style.display = 'none';
  _setUpdateStatus('', 'Checking for updates…');

  try {
    const res = await fetch('/api/update/check').then(r => r.json());
    if (res.error) {
      _setUpdateStatus('error', res.error);
    } else if (res.update_available) {
      const rel = res.released ? ' · ' + res.released : '';
      _setUpdateStatus('avail', `v${res.latest} available${rel}`);
      _updateDownloadUrl = res.download_url || '';
      if (dlBtn) dlBtn.style.display = '';
    } else {
      _setUpdateStatus('ok', `v${res.current} — you're up to date`);
    }
  } catch (e) {
    _setUpdateStatus('error', 'Could not reach update server');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check for Update'; }
  }
}

async function confirmUpdate() {
  const channelSel = document.getElementById('update-channel-select');
  const channel = channelSel?.value || 'prod';
  const disclaimers = {
    dev: 'Dev builds are unstable and may break functionality. Only update if you know what you\'re doing.',
    rc:  'RC builds are pre-release candidates. They\'re mostly stable but may have minor issues.',
  };
  const disclaimer = disclaimers[channel];
  if (disclaimer) {
    const ok = await _showConfirm({
      title: `Update to ${channel.toUpperCase()} build?`,
      message: disclaimer,
      okText: 'Update Anyway',
      danger: false,
    });
    if (!ok) return;
  }
  if (_updateDownloadUrl) window.open(_updateDownloadUrl, '_blank');
}

function setHealthSectionExpanded(expanded) {
  const grid = document.getElementById('health-grid');
  const lastRun = document.getElementById('health-last-run');
  if (grid) grid.style.display = expanded ? 'grid' : 'none';
  if (lastRun) {
    lastRun.style.display = expanded ? '' : 'none';
    if (!expanded) lastRun.textContent = '';
  }
}

async function runHealthCheck() {
  setHealthSectionExpanded(true);
  const btn = document.getElementById('health-check-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }

  let data;
  try {
    data = await api('/health/status');
  } catch(e) {
    toast('Health check failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Run Health Check'; }
    return;
  }

  // Build grid HTML
  const dot = ok => `<div class="health-dot health-dot-${ok ? 'ok' : 'err'}"></div>`;
  const dotState = state => `<div class="health-dot health-dot-${state}"></div>`;

  // Library
  const lib = data.library;
  let libDetail;
  if (!lib.ok) {
    libDetail = 'Path not found';
  } else if (data.database) {
    libDetail = `${lib.tracks} tracks`;
  } else {
    libDetail = `${lib.tracks} tracks · ${lib.cache_age_hours != null ? `cache ${lib.cache_age_hours}h old` : 'no cache'}`;
  }
  const libHtml = `
    <div class="health-item">
      ${dot(lib.ok)}
      <div class="health-item-body">
        <div class="health-item-label">Local Library</div>
        <div class="health-item-detail">${esc(lib.path)}<br>${esc(libDetail)}</div>
      </div>
    </div>`;

  // squig.link
  const sq = data.squig;
  const sqHtml = `
    <div class="health-item">
      ${dot(sq.ok)}
      <div class="health-item-body">
        <div class="health-item-label">squig.link</div>
        <div class="health-item-detail">${sq.ok ? 'Reachable' : esc(sq.error || 'Unreachable')}</div>
      </div>
    </div>`;

  // DAPs
  const daps = data.daps || [];
  const hasIdentityConnected = daps.some(d => d.mounted && d.mount_match_method === 'identity');
  const hasPathConnected = daps.some(d => d.mounted && d.mount_match_method === 'path');
  const dapDetail = daps.length === 0
    ? 'No DAPs configured'
    : daps.map(d => {
      const rowState = d.mounted
        ? (d.mount_match_method === 'identity' ? 'ok' : 'warn')
        : 'err';
      const statusText = !d.mounted
        ? 'Not connected'
        : (d.mount_match_method === 'identity'
          ? 'Connected'
          : 'Connected (path-only, unverified)');
      return `<div class="health-dap-row">${dotState(rowState)}<span style="font-size:var(--text-xs);color:var(--text-sub)">${esc(d.name)}: ${statusText}</span></div>`;
    }).join('');
  const dapsOk = daps.length > 0 && hasIdentityConnected;
  const dapHtml = `
    <div class="health-item">
      <div class="health-dot health-dot-${daps.length === 0 ? 'idle' : dapsOk ? 'ok' : hasPathConnected ? 'warn' : 'warn'}"></div>
      <div class="health-item-body">
        <div class="health-item-label">DAPs</div>
        <div class="health-item-detail"><div class="health-dap-list">${dapDetail}</div></div>
      </div>
    </div>`;

  // Playback runtime (mpv + dependency/runtime readiness)
  const pb = data.playback || {};
  const rt = pb.runtime || {};
  const pyOk = !!rt.python_mpv_ok;
  const libmpvOk = !!rt.libmpv_path;
  const backendOk = !!pb.mpv_available;
  const deviceOk = pb.selected_audio_device_available;
  const pbState = backendOk ? 'ok' : (pb.missing_dependency ? 'warn' : 'err');
  const pbLines = [
    `Backend: ${backendOk ? `Ready${pb.mpv_version ? ` (${pb.mpv_version})` : ''}` : 'Unavailable'}`,
    `python-mpv: ${pyOk ? 'Installed' : 'Missing'}`,
    `libmpv: ${libmpvOk ? 'Found' : 'Missing'}`,
    `Device: ${esc(pb.effective_audio_device || pb.selected_audio_device || 'auto')}${deviceOk === false ? ' (unavailable)' : ''}`,
    `Exclusive mode: ${pb.exclusive_mode ? 'On' : 'Off'}`,
  ];
  const pbActions = Array.isArray(pb.fix_actions) && pb.fix_actions.includes('install_mpv')
    ? `<div class="health-actions"><button class="btn-secondary health-action-btn" onclick="App.installMpv()">Install missing playback dependencies</button></div>`
    : '';
  const playbackHtml = `
    <div class="health-item">
      ${dotState(pbState)}
      <div class="health-item-body">
        <div class="health-item-label">Playback Runtime</div>
        <div class="health-item-detail">${pbLines.map(esc).join('<br>')}${pbActions}</div>
      </div>
    </div>`;

  // Database
  const db = data.database || {};
  const dbDetail = db.ok
    ? `${db.engine} · ${db.size_mb} MB · ${db.tables} tables · v${db.schema_version}`
    : 'Database not found';
  const storageHtml = `
    <div class="health-item">
      ${dot(!!db.ok)}
      <div class="health-item-body">
        <div class="health-item-label">Database</div>
        <div class="health-item-detail">${esc(dbDetail)}</div>
      </div>
    </div>`;

  const grid = document.getElementById('health-grid');
  if (grid) grid.innerHTML = libHtml + sqHtml + dapHtml + playbackHtml + storageHtml;

  const lastRun = document.getElementById('health-last-run');
  if (lastRun) lastRun.textContent = 'Last checked: ' + new Date().toLocaleTimeString();

  if (btn) { btn.disabled = false; btn.textContent = 'Run Health Check'; }
}

/* ── Baselines (FR tuning targets) ─────────────────────────────────── */
let _baselines = [];

// Design-system–aligned palette for baseline colours
const BASELINE_COLORS = [
  '#f0b429', // amber
  '#adc6ff', // accent blue
  '#ffb3b5', // accent pink
  '#53e16f', // accent green
  '#a78bfa', // violet
  '#fb923c', // orange
  '#38bdf8', // sky
  '#f472b6', // rose
  '#34d399', // emerald
  '#4ecdc4', // teal
];
let _selectedBaselineColor = BASELINE_COLORS[0];

function _initBaselineColorPicker() {
  const menu = document.getElementById('baseline-color-menu');
  if (!menu || menu.dataset.init) return;
  menu.dataset.init = '1';
  menu.innerHTML = BASELINE_COLORS.map(c => `
    <button class="baseline-color-option${c === _selectedBaselineColor ? ' active' : ''}"
      style="background:${c}" title="${c}"
      onclick="App.selectBaselineColor('${c}')"></button>
  `).join('');
}

function selectBaselineColor(color) {
  _selectedBaselineColor = color;
  const swatch = document.getElementById('baseline-color-swatch');
  if (swatch) swatch.style.background = color;
  // Update active state in grid
  document.querySelectorAll('.baseline-color-option').forEach(btn => {
    btn.classList.toggle('active', btn.style.background === color ||
      btn.style.backgroundColor === color);
  });
  // Close picker
  const menu = document.getElementById('baseline-color-menu');
  if (menu) menu.style.display = 'none';
}

function toggleBaselineColorPicker() {
  _initBaselineColorPicker();
  const menu = document.getElementById('baseline-color-menu');
  if (!menu) return;
  const isOpen = menu.style.display !== 'none';
  menu.style.display = isOpen ? 'none' : 'grid';
  if (!isOpen) {
    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function _close(e) {
        const wrap = document.getElementById('baseline-color-wrap');
        if (wrap && !wrap.contains(e.target)) {
          menu.style.display = 'none';
          document.removeEventListener('click', _close);
        }
      });
    }, 0);
  }
}

async function loadBaselines() {
  _baselines = await api('/baselines').catch(() => []);
  _renderBaselines();
}

function _renderBaselines() {
  const el = document.getElementById('baselines-list');
  if (!el) return;
  if (!_baselines.length) {
    el.innerHTML = '<p class="settings-baseline-empty">No baselines added yet.</p>';
    return;
  }
  el.innerHTML = _baselines.map(b => `
    <div class="baseline-item">
      <span class="baseline-dot" style="background:${b.color}"></span>
      <span class="baseline-item-name">${esc(b.name)}</span>
      <span class="baseline-item-url" title="${esc(b.url)}">${esc(b.url)}</span>
      <button class="baseline-remove-btn" onclick="App.deleteBaseline('${b.id}')">Remove</button>
    </div>`).join('');
}

async function addBaseline() {
  const nameEl = document.getElementById('baseline-name-input');
  const urlEl  = document.getElementById('baseline-url-input');
  const btn    = document.getElementById('baseline-add-btn');
  const name = nameEl.value.trim();
  const url  = urlEl.value.trim();
  if (!name || !url) { toast('Enter a name and a squig.link URL'); return; }
  if (url && !url.match(/^https?:\/\/(?:[^./]+\.)?squig\.link\//i)) {
    toast('That doesn\'t look like a squig.link URL');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  try {
    const bl = await api('/baselines', { method: 'POST', body: { name, url, color: _selectedBaselineColor } });
    _baselines = [..._baselines.filter(b => b.id !== bl.id), bl];
    _renderBaselines();
    nameEl.value = '';
    urlEl.value  = '';
    // Cycle to next colour for convenience
    const nextIdx = (BASELINE_COLORS.indexOf(_selectedBaselineColor) + 1) % BASELINE_COLORS.length;
    selectBaselineColor(BASELINE_COLORS[nextIdx]);
    toast(`Added baseline: ${bl.name}`);
  } catch (e) {
    toast('Error: ' + (e.message || 'Could not fetch measurement'));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
}

async function deleteBaseline(bid) {
  await api(`/baselines/${bid}`, { method: 'DELETE' }).catch(() => {});
  _baselines = _baselines.filter(b => b.id !== bid);
  _renderBaselines();
  toast('Baseline removed');
}

/* ── Icon dropdown (replaces grid picker) ──────────────────────────── */
/* ── OS-aware mount path defaults ──────────────────────────────────── */
function _getOsPlatform() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) return 'mac';
  if (ua.includes('win')) return 'windows';
  return 'linux';
}

/* ── Public API ─────────────────────────────────────────────────────── */
const App = {
  showView,
  loadHome,
  homeOpenItem,
  homePlayItem,
  homeChangePeriod,
  homeForceRefresh,
  homeRailStep,
  homeShuffleLibrary,
  homeResumeListening,
  navBack,
  backToArtists,
  showArtist,
  showAlbum,
  toggleFavourite,
  toggleCurrentTrackFavourite,
  loadFavourites,
  loadFavArtists,
  loadFavAlbums,
  loadFavSongs,
  playAllFavouriteArtists,
  playAllFavouriteAlbums,
  playAllFavouriteSongs,
  selectFavouritesPanel,
  setFavArtistsSort,
  setFavAlbumsSort,
  setFavSongsSort,
  favSongsReorder,
  favArtistsReorder,
  favAlbumsReorder,
  exportFavSongs,
  copyFavSongsToDap,
  copyFavSongsToConnectedDap,
  bulkFavouriteSelected,
  bulkUnfavouriteSelected,
  openPlaylist,
  createPlaylist,
  createPlaylistAndAdd,
  showCreatePlaylistModal,
  closeCreatePlaylistModal,
  submitCreatePlaylist,
  openMlPlaylistGenerator,
  closeMlPlaylistGenerator,
  runMlPlaylistPreview,
  regenerateMlPlaylist,
  saveMlGeneratedPlaylist,
  mlGenAddReference,
  mlGenRemoveReference,
  mlGenClearReferences,
  mlGenUseCurrentSelection,
  openMlReferenceBrowser,
  closeMlReferenceBrowser,
  mlRefBrowserSearch,
  mlRefBrowserToggle,
  applyMlReferenceBrowser,
  _confirmYes,
  _confirmNo,
  deletePlaylist,
  deleteCurrentPlaylist,
  renamePlaylist,
  removeSongFromFavourites,
  showAddDropdown,
  showTrackCtxMenu,
  playArtistCard,
  showArtistCtxMenu,
  showAlbumCtxMenu,
  showArtistDetailCtxMenu,
  showAlbumDetailCtxMenu,
  hideCtxMenu,
  ctxPlayNext,
  ctxAddToQueue,
  ctxCreateSmartPlaylist,
  ctxToggleFavourite,
  ctxEditAlbumTags,
  ctxRenameArtist,
  ctxAddToPlaylist,
  ctxRemoveFromPlaylist,
  openCtxSubmenu,
  closeCtxSubmenu,
  _ctxSubmenuLeaveItem,
  _ctxSubmenuEnter,
  _ctxSubmenuLeave,
  _ctxPickPlaylist,
  _ctxNewPlaylistAndAdd,
  addToPlaylist,
  addAllToPlaylist,
  addAllToSpecificPlaylist,
  addAllArtistSongs,
  addAlbumToPlaylist,
  playAlbum,
  _commitToPlaylist,
  setArtistSearch,
  clearArtistSearch,
  setArtistAlphaFilter,
  setAlbumSearch,
  clearAlbumSearch,
  setAlbumAlphaFilter,
  scrollToLetter,
  scrollToAlbumLetter,
  backToGear,
  loadGearView,
  toggleIemCompareMode,
  toggleIemCompareSelect,
  showIemCompare,
  closeIemCompare,
  _toggleCompareDataset,
  toggleFrOverlayMenu,
  setFrOverlay,
  frOverlaysDefault,
  frOverlaysBasic,
  frOverlaysAdvanced,
  frOverlaysPrimaryOnly,
  frOverlaysAll,
  frOverlaysNone,
  frOverlaysClearSecondary,
  frOverlaysResetDefaults,

  loadPlaylistsView,
  togglePlViewSort,
  removeFromPlaylist,
  dupCancel,
  dupSkip,
  dupAddAnyway,
  exportPlaylistDap,
  exportToDeviceDap,
  renderDapExportPills,
  togglePlaylistDapMenu,
  closePlaylistDapMenu,
  pickConnectedDapExport,
  toggleHeroMore,
  togglePlMoreMenu,
  focusPlaylistName,
  rescan,
  rescanClean,
  toggleRescanMenu,
  closeRescanMenu,
  showSettings: () => {},
  closeSettings: () => {},
  saveSettings: () => {},
  showHelp,
  closeHelp,
  triggerImport,
  handleImportFile,
  closeImportModal,
  confirmImport,
  searchForMapping,
  selectMapping,
  clearMapping,
  triggerArtworkUpload,
  handleArtworkFile,
  removePlaylistArtwork,
  downloadPlaylistArtwork,
  toggleSidebarSort,
  setSidebarSort,
  filterPlaylist,
  clearPlaylistFilter,
  setPlaylistInSort,
  showArtistTracks,
  toggleTrackSelection,
  clearSelection,
  removeSelectedFromPlaylist,
  showSync,
  closeSyncModal,
  selectSyncDevice,
  syncUpdatePickNextCta,
  startSyncFromSelection,
  startSyncScan,
  syncToggleAll,
  toggleSyncSection,
  syncSelectionChanged,
  executeSync,
  syncScanAgain,
  sortTracks,
  // Songs
  sortSongs,
  filterSongs,
  clearSongsFilter,
  songsPrevPage,
  songsNextPage,
  toggleTableColumnsPopover,
  setTableColumnVisible,
  // Settings
  loadSettings,
  saveLibraryPath,
  closeOnboarding,
  completeOnboarding,
  restartApp,
  setUpdateChannel,
  checkForUpdate,
  confirmUpdate,
  setExclusiveMode,
  setAudioDevice,
  retryMpvDetection,
  installMpv,
  browseFolder,
  exportBackup,
  importBackup,
  setListeningTracking,
  clearListeningHistory,
  // Baselines
  addBaseline,
  deleteBaseline,
  toggleBaselineColorPicker,
  selectBaselineColor,
  // DAP
  checkAllDapSyncStatus,
  checkDapSyncStatus,
  showDapDetail,
  showAddDapModal,
  showEditDapModal,
  closeDapModal,
  revertDapModalChanges,
  dapModelPreset,
  refreshDapMounts,
  browseDapMount,
  selectDapMount,
  toggleDapManualMount,
  validateDapForm,
  dapTemplatePreset,
  dapTemplateChanged,
  insertDapToken,
  toggleDapHelp,
  toggleDapTemplateHelp,
  saveDap,
  deleteDap,
  dapExportPlaylist,
  dapExportAllPlaylists,
  // IEM
  showIemDetail,
  showAddIemModal,
  showEditIemModal,
  iemModalChanged,
  revertIemModalChanges,
  toggleIemHelp,
  closeIemModal,
  saveIem,
  deleteIem,
  applyPeqToGraph,
  applyIemSourceToGraph,
  openPeqEditor,
  closePeqEditor,
  onPeqPrimaryAction,
  onPeqSecondaryAction,
  applyAndClosePeqEditor,
  resetCustomPeq,
  renderPeqEditorBands,
  togglePeqBand,
  onPeqBandTypeChange,
  onPeqBandFcChange,
  onPeqBandGainChange,
  onPeqBandQChange,
  onPeqPreampChange,
  onPeqWorkspaceIemChange,
  onPeqWorkspacePeqChange,
  onPeqWorkspaceTargetChange,
  saveCustomPeqAsProfile,
  cancelCustomPeqSaveProfile,
  confirmCustomPeqSaveProfile,
  downloadCustomPeqTxt,
  copyCustomPeqToConnectedDap,
  togglePeqWorkspaceCurve,
  isPeqWorkspaceOpen,
  toggleIemCurve,
  runHealthCheck,
  togglePeqAccordion,
  downloadPeq,
  showPeqModal,
  closePeqModal,
  savePeq,
  deletePeq,
  loadInsightsView,
  startLibraryAnalysis,
  cancelLibraryAnalysis,
  insightsRescanLibrary,
  openProblemTracksModal,
  closeProblemTracksModal,
  openMissingTagsEditor,
  closeMissingTagsEditor,
  setMissingTagsFilter,
  setMissingTagsSearch,
  setMissingTagDraft,
  saveMissingTagRow,
  toggleMissingTagSelection,
  toggleMissingTagsSelectAll,
  openMissingTagsBulkEditor,
  closeMissingTagsBulkEditor,
  saveMissingTagsBulkEditor,
  openGenreDistributionModal,
  closeGenreDistributionModal,

  showInsightsHelp,
  changeGearFitTarget,
  changeGearFitSort,
  // IEM / Headphone Fit
  runMatchingAnalysis,
  changeMatchTarget,
  _toggleIemAccordion,
  iemFitChangePeq,
  iemFitChangeSource,
  iemFitChangeGenre,
  iemFitChangeGenreOverlay,
  iemFitAddGenreToHeatmap,
  iemFitRemoveGenreFromHeatmap,
  showAllIemGenres,
  showAllIemBlindspots,
  closeAllBlindspots,
  // Tag editing
  openTagEditor,
  closeTagEditor,
  saveTagEditor,
  openAlbumTagEditor,
  closeAlbumTagEditor,
  saveAlbumTags,
  openArtistRename,
  closeArtistRename,
  saveArtistRename,
  // Artist images
  openArtistImageModal,
  closeArtistImageModal,
  searchArtistImages,
  onArtistImageFileSelected,
  saveArtistImage,
  removeArtistImage,
  onArtistImageServiceChange,
  saveArtistImageSettings,
  startArtistImageBatch,
  cancelArtistImageBatch,
  // Album art
  openAlbumArtModal,
  _openAlbumArtForCard,
  closeAlbumArtModal,
  searchAlbumArt,
  onAlbumArtServiceChange,
  onAlbumArtFileSelected,
  saveAlbumArt,
  removeAlbumArt,
};

/* ═══════════════════════════════════════════════════════════════════════════
   Insights — Phase 1: Library Overview + Tag Health
   ═══════════════════════════════════════════════════════════════════════════ */

let _insightsFormatChart = null;
let _insightsSrChart     = null;
let _insightsBdChart     = null;

const _INSIGHTS_COLORS = [
  '#adc6ff', '#53e16f', '#ffb3b5', '#f0b429',
  '#a78bfa', '#fb923c', '#38bdf8', '#f472b6', '#34d399', '#4ecdc4',
];

function _insightsTooltipDefaults() {
  return {
    backgroundColor: 'rgba(53,53,52,0.95)',
    titleColor: '#e5e2e1',
    bodyColor: '#c1c6d7',
    borderColor: 'rgba(65,71,85,0.3)',
    borderWidth: 1,
    padding: 10,
    cornerRadius: 8,
  };
}

async function loadInsightsView() {
  state.view = 'insights';
  setActiveNav('insights');
  showViewEl('insights');

  // Resume polling if analysis is already running + show coverage status
  const [statusRes, infoRes] = await Promise.all([
    fetch('/api/insights/analyse/status').catch(() => null),
    fetch('/api/insights/analyse/info').catch(() => null),
  ]);
  if (statusRes && statusRes.ok) {
    const s = await statusRes.json();
    _updateAnalysisBanner(s);
    if (s.status === 'running') _startAnalysisPolling();
  }
  if (infoRes && infoRes.ok) {
    _updateAnalysisInfo(await infoRes.json());
  }

  const [overviewRes, tagRes] = await Promise.all([
    fetch('/api/insights/overview').catch(() => null),
    fetch('/api/insights/tag-health').catch(() => null),
  ]);

  if (overviewRes && overviewRes.ok) {
    try {
      const overviewData = await overviewRes.json();
      _renderInsightsOverview(overviewData);
      _renderInsightsGenreDistribution(overviewData);
    }
    catch (e) { document.getElementById('insights-overview-content').innerHTML =
      '<p class="insights-error">Error rendering overview. Check console for details.</p>';
      document.getElementById('insights-genre-content').innerHTML =
      '<p class="insights-error">Could not load genre distribution.</p>'; }
  } else {
    document.getElementById('insights-overview-content').innerHTML =
      '<p class="insights-error">Could not load overview. Try rescanning your library first.</p>';
    document.getElementById('insights-genre-content').innerHTML =
      '<p class="insights-error">Could not load genre distribution.</p>';
  }

  if (tagRes && tagRes.ok) {
    try { _renderInsightsTagHealth(await tagRes.json()); }
    catch (e) { document.getElementById('insights-tag-health-content').innerHTML =
      '<p class="insights-error">Error rendering tag health data.</p>'; }
  } else {
    document.getElementById('insights-tag-health-content').innerHTML =
      '<p class="insights-error">Could not load tag health data.</p>';
  }

  // Phase 2 & 3 — only available after analysis has been run
  const [sonicRes, matchRes] = await Promise.all([
    fetch('/api/insights/sonic-profile').catch(() => null),
    fetch('/api/insights/matching/overview').catch(() => null),
  ]);
  if (sonicRes && sonicRes.ok)  { try { _renderInsightsSonicProfile(await sonicRes.json()); } catch (_) {} }
  if (matchRes && matchRes.ok)  { try { _renderInsightsMatchOverview(await matchRes.json()); } catch (_) { _renderInsightsMatchOverview(null); } }
  else                          _renderInsightsMatchOverview(null);  // show CTA to run analysis
}

let _insightsGenreChart = null;
let _allInsightGenres = [];
let _insightsMissingTags = [];
let _insightsMissingTagsFilter = 'all';
let _insightsMissingTagsSearch = '';
let _insightsMissingTagsOpen = false;
let _insightsMissingSelected = new Set();
let _insightsMissingDrafts = {};

function _missingIssuesForTrack(t) {
  const issues = [];
  if (!String(t?.title || '').trim()) issues.push('title');
  if (!String(t?.artist || '').trim()) issues.push('artist');
  if (!String(t?.album || '').trim()) issues.push('album');
  if (!String(t?.year || '').trim()) issues.push('year');
  if (!String(t?.genre || '').trim()) issues.push('genre');
  return issues;
}

function _missingFieldPlaceholder(field) {
  const map = {
    title: 'Enter title',
    artist: 'Enter artist',
    album: 'Enter album',
    year: 'YYYY',
    genre: 'Enter genre',
  };
  return map[field] || 'Enter value';
}

function _missingDraftFor(trackId) {
  return _insightsMissingDrafts[trackId] || {};
}

function _renderMissingInlineEditor(track) {
  const issues = track?.issues || [];
  if (!issues.length) return '<span class="muted">No missing tags</span>';
  const draft = _missingDraftFor(track.id);
  const fieldsHtml = issues.map(field => {
    const v = String(draft[field] || '').replace(/"/g, '&quot;');
    const ph = _missingFieldPlaceholder(field);
    return `<label class="missing-inline-field">
      <span>${esc(field)}</span>
      <input
        type="text"
        class="missing-inline-input"
        value="${v}"
        placeholder="${ph}"
        oninput="App.setMissingTagDraft('${track.id}', '${field}', this.value)"
      />
    </label>`;
  }).join('');
  return `<div class="missing-inline-editor">${fieldsHtml}</div>`;
}

function _renderInsightsOverview(d) {
  const el = document.getElementById('insights-overview-content');

  [_insightsFormatChart, _insightsSrChart, _insightsBdChart, _insightsGenreChart]
    .forEach(c => { if (c) c.destroy(); });
  _insightsFormatChart = _insightsSrChart = _insightsBdChart = _insightsGenreChart = null;

  // Icons
  const _noteSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  const _discSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>`;
  const _peopleSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
  const _genreSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10V4H4v16h8"/><path d="M4 8h16"/><path d="M10 4v4"/><path d="M17 17l2 2 3-3"/></svg>`;

  const _statCard = (icon, badge, number, label) => `
    <div class="ov-stat-card">
      <div class="ov-stat-card-top">
        <span class="ov-stat-icon">${icon}</span>
        <span class="ov-stat-badge">${badge}</span>
      </div>
      <div class="ov-stat-number">${number}</div>
      <div class="ov-stat-label">${label}</div>
    </div>`;

  // Top format for donut center
  const fmtEntries = Object.entries(d.formats || {}).sort((a, b) => b[1] - a[1]);
  const topFmt      = fmtEntries[0] ? fmtEntries[0][0] : 'FLAC';
  const topFmtCount = fmtEntries[0] ? fmtEntries[0][1] : 0;
  const topFmtPct   = d.total_tracks > 0 ? Math.round(topFmtCount / d.total_tracks * 100) : 0;
  const topFmtLabel = ['FLAC','ALAC','WAV','AIFF'].includes(topFmt.toUpperCase())
    ? `${topFmt.toUpperCase()} LOSSLESS` : topFmt.toUpperCase();

  // CSS bar renderer (no Chart.js needed for SR/BD)
  const _cssBars = (data, color) => {
    const entries = Object.entries(data || {}).sort((a, b) => b[1] - a[1]);
    const maxVal  = entries.length > 0 ? Math.max(...entries.map(([,v]) => v)) : 1;
    return entries.map(([label, count]) => {
      const pct = Math.round(count / maxVal * 100);
      return `<div class="ov-bar-row">
        <div class="ov-bar-label">${esc(label)}</div>
        <div class="ov-bar-track"><div class="ov-bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <div class="ov-bar-count">${count.toLocaleString()}</div>
      </div>`;
    }).join('');
  };

  // Format legend (below donut)
  const fmtLegendHtml = fmtEntries.map(([label, count], i) => `
    <div class="ov-legend-item">
      <span class="ov-legend-dot" style="background:${_INSIGHTS_COLORS[i]}"></span>
      <span class="ov-legend-name">${esc(label)}</span>
      <span class="ov-legend-count">${count.toLocaleString()}</span>
    </div>`).join('');

  el.innerHTML = `
    <div class="ov-stat-grid">
      ${_statCard(_noteSvg, 'FLAC library', d.total_tracks.toLocaleString(), 'Total Tracks')}
      ${_statCard(_discSvg, `${d.total_albums.toLocaleString()} in library`, d.total_albums.toLocaleString(), 'Albums')}
      ${_statCard(_peopleSvg, 'Unique artists', d.total_artists.toLocaleString(), 'Artists')}
      ${_statCard(_genreSvg, 'Tagged categories', (d.genres_total != null ? d.genres_total : Object.keys(d.genres || {}).length).toLocaleString(), 'Genres')}
    </div>

    <div class="ov-charts-row">
      <div class="ov-card ov-format-card">
        <div class="ov-card-title">File Format Distribution</div>
        <div class="ov-format-inner">
          <div class="ov-donut-wrap">
            <canvas id="insights-format-canvas"></canvas>
            <div class="ov-donut-center">
              <div class="ov-donut-pct">${topFmtPct}%</div>
              <div class="ov-donut-lbl">${topFmtLabel}</div>
            </div>
          </div>
          <div class="ov-format-legend">${fmtLegendHtml}</div>
        </div>
      </div>

      <div class="ov-card ov-bars-card">
        <div class="ov-card-title">Sample Rate
          <svg class="ov-card-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 12 Q5 4 8 12 Q11 20 14 12 Q17 4 20 12 Q21 16 22 12"/></svg>
        </div>
        <div class="ov-bar-list">${_cssBars(d.sample_rates, 'rgba(173,198,255,0.8)')}</div>
      </div>
      <div class="ov-card ov-bars-card">
        <div class="ov-card-title">Bit Depth
          <svg class="ov-card-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="18" y="3" width="4" height="18" rx="1"/><rect x="10" y="8" width="4" height="13" rx="1"/><rect x="2" y="13" width="4" height="8" rx="1"/></svg>
        </div>
        <div class="ov-bar-list">${_cssBars(d.bit_depths, 'rgba(83,225,111,0.8)')}</div>
      </div>
    </div>
  `;

  // Doughnut chart (no SR/BD charts needed — pure CSS bars now)
  _insightsFormatChart = new Chart(document.getElementById('insights-format-canvas'), {
    type: 'doughnut',
    data: {
      labels: fmtEntries.map(([l]) => l),
      datasets: [{ data: fmtEntries.map(([,v]) => v),
        backgroundColor: _INSIGHTS_COLORS.slice(0, fmtEntries.length),
        borderWidth: 0, hoverOffset: 6 }],
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      cutout: '70%',
      plugins: { legend: { display: false }, tooltip: _insightsTooltipDefaults() },
    },
  });

  _insightsGenreChart = null;
}

function _renderInsightsGenreDistribution(d) {
  const el = document.getElementById('insights-genre-content');
  if (!el) return;

  const totalTracks = d.total_tracks || 0;
  const taggedPct = d.genres_tagged != null && totalTracks > 0
    ? Math.round(d.genres_tagged / totalTracks * 100)
    : null;
  const genreSource = d.genres_all || d.genres || {};
  const genreEntries = Object.entries(genreSource).sort((a, b) => b[1] - a[1]);
  _allInsightGenres = genreEntries;

  if (!genreEntries.length) {
    el.innerHTML = '<p class="insights-empty-note">No genre metadata found in library tags.</p>';
    return;
  }

  const topGenres = genreEntries.slice(0, 5);
  const maxGenreCount = topGenres[0][1] || 1;

  el.innerHTML = `
    <div class="ov-genre-header-row">
      <p class="insights-hint">${totalTracks.toLocaleString()} tracks scanned</p>
      ${taggedPct != null ? `<span class="ov-card-badge">${taggedPct}% tagged</span>` : ''}
    </div>
    <div class="ov-genre-list ov-genre-list--compact">
      ${topGenres.map(([genre, count], idx) => {
        const pct = Math.max(8, Math.round((count / maxGenreCount) * 100));
        return `<div class="ov-genre-row">
          <div class="ov-genre-name-wrap">
            <span class="ov-genre-rank">${idx + 1}</span>
            <span class="ov-genre-name">${esc(genre)}</span>
          </div>
          <div class="ov-genre-bar-track"><div class="ov-genre-bar-fill" style="width:${pct}%"></div></div>
          <div class="ov-genre-count">${count.toLocaleString()}</div>
        </div>`;
      }).join('')}
    </div>
    <div class="ov-genre-actions">
      <button class="tag-health-problem-btn" onclick="App.openGenreDistributionModal()">
        View all ${genreEntries.length.toLocaleString()} genres →
      </button>
    </div>`;
}

function _renderInsightsTagHealth(d) {
  const el = document.getElementById('insights-tag-health-content');

  const fieldLabels = { title: 'Title', artist: 'Artist', album: 'Album', year: 'Year', genre: 'Genre' };
  const fieldOrder = ['title', 'artist', 'album', 'year', 'genre'];

  const barsHtml = fieldOrder.filter(f => d.completeness[f]).map(field => {
    const s = d.completeness[field];
    const col = s.pct >= 95 ? '#53e16f' : s.pct >= 70 ? '#f0b429' : '#ffb3b5';
    return `<div class="tag-health-pill">
      <div class="tag-health-pill-top">
        <span class="tag-health-pill-label">${fieldLabels[field] || field}</span>
        <span class="tag-health-pill-pct" style="color:${col}">${s.pct}%</span>
      </div>
      <div class="tag-health-pill-track"><div class="tag-health-pill-fill" style="width:${s.pct}%;background:${col}"></div></div>
      <div class="tag-health-pill-meta">${s.present.toLocaleString()} / ${d.total.toLocaleString()} tracks</div>
    </div>`;
  }).join('');

  // Pre-populate problem tracks modal (legacy)
  const modalTitle = document.getElementById('problem-tracks-modal-title');
  const modalBody  = document.getElementById('problem-tracks-modal-body');
  if (d.problem_track_count > 0 && modalBody) {
    if (modalTitle) modalTitle.textContent = `Problem Tracks (${d.problem_track_count.toLocaleString()})`;
    modalBody.innerHTML = d.problem_tracks.map(t =>
      `<div class="problem-track-row">
        <div class="problem-track-info"><span class="problem-track-title">${esc(t.title)}</span><span class="problem-track-artist">${esc(t.artist)}</span></div>
        <div class="problem-track-issues">${t.issues.map(i => `<span class="tag-issue-chip">${esc(i)}</span>`).join('')}</div>
      </div>`
    ).join('');
  }

  const problemFooter = d.problem_track_count === 0
    ? `<span class="tag-health-ok-note">All tracks have complete metadata</span>`
    : `<button class="tag-health-problem-btn" onclick="App.openMissingTagsEditor()">
        Manage ${d.problem_track_count.toLocaleString()} track${d.problem_track_count > 1 ? 's' : ''} with missing tags →
      </button>`;

  const dupNote = d.artist_duplicates.length > 0
    ? `<span class="tag-health-dup-note">${d.artist_duplicates.length} artist name${d.artist_duplicates.length > 1 ? 's have' : ' has'} case/spacing inconsistencies</span>`
    : '';

  el.innerHTML = `
    <div class="tag-health-meta-row">
      <p class="insights-hint">${d.total.toLocaleString()} tracks scanned</p>
      <div class="tag-health-meta-right">
        ${dupNote || ''}
      </div>
    </div>
    <div class="tag-health-bars tag-health-bars--compact">${barsHtml}</div>
    <div class="tag-health-footer">
      ${problemFooter}
    </div>`;
}

function openProblemTracksModal() {
  document.getElementById('problem-tracks-modal').style.display = 'flex';
}

function closeProblemTracksModal() {
  document.getElementById('problem-tracks-modal').style.display = 'none';
}

function _filteredMissingTags() {
  const q = (_insightsMissingTagsSearch || '').toLowerCase().trim();
  return (_insightsMissingTags || []).filter(t => {
    const matchFilter = _insightsMissingTagsFilter === 'all'
      ? true
      : (t.issues || []).includes(_insightsMissingTagsFilter);
    if (!matchFilter) return false;
    if (!q) return true;
    const blob = `${t.title || ''} ${t.artist || ''} ${t.album || ''} ${t.path || ''}`.toLowerCase();
    return blob.includes(q);
  });
}

function _syncMissingTagsActions() {
  const selectedCount = _insightsMissingSelected.size;
  const bulkBtn = document.getElementById('missing-tags-bulk-edit-btn');
  if (bulkBtn) {
    bulkBtn.disabled = selectedCount === 0;
    bulkBtn.textContent = selectedCount > 0 ? `Edit selected (${selectedCount})` : 'Edit selected';
  }
  const filteredRows = _filteredMissingTags();
  const allSelected = filteredRows.length > 0 && filteredRows.every(t => _insightsMissingSelected.has(t.id));
  const selectAllBtn = document.getElementById('missing-tags-select-all-btn');
  if (selectAllBtn) {
    selectAllBtn.textContent = allSelected ? 'Unselect all' : 'Select all';
  }
}

function _renderMissingTagsTable() {
  const wrap = document.getElementById('insights-missing-tags-content');
  if (!wrap) return;
  const rows = _filteredMissingTags();
  if (!rows.length) {
    wrap.innerHTML = `<div class="insights-missing-tags-empty">No tracks match the current filter.</div>`;
    _syncMissingTagsActions();
    return;
  }
  wrap.innerHTML = `<div class="insights-missing-tags-wrap">
    <table class="insights-missing-tags-table">
      <thead>
        <tr>
          <th style="width:44px"></th>
          <th>Title</th>
          <th>Artist</th>
          <th>Album</th>
          <th>Missing Tags</th>
          <th style="min-width:260px">Inline Edit</th>
          <th>Save</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(t => `
          <tr>
            <td>
              <input type="checkbox" class="row-select" ${_insightsMissingSelected.has(t.id) ? 'checked' : ''} onchange="App.toggleMissingTagSelection('${t.id}', this.checked)" />
            </td>
            <td><div class="track-title">${esc(t.title || '')}</div></td>
            <td>${esc(t.artist || '')}</td>
            <td>${esc(t.album || '')}</td>
            <td>${(t.issues || []).map(i => `<span class="tag-issue-chip">${esc(i)}</span>`).join(' ')}</td>
            <td>${_renderMissingInlineEditor(t)}</td>
            <td><button class="btn-primary btn-sm" onclick="App.saveMissingTagRow('${t.id}')">Save</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>`;
  _syncMissingTagsActions();
}

async function openMissingTagsEditor() {
  const section = document.getElementById('view-missing-tags');
  const content = document.getElementById('insights-missing-tags-content');
  if (!section || !content) return;
  if (state.view !== 'missing-tags') _pushToNavHistory();
  state.view = 'missing-tags';
  setActiveNav('missing-tags');
  renderSidebarPlaylists();
  showViewEl('missing-tags');
  const filterEl = document.getElementById('insights-missing-tags-filter');
  const searchEl = document.getElementById('insights-missing-tags-search');
  if (filterEl) filterEl.value = _insightsMissingTagsFilter;
  if (searchEl) searchEl.value = _insightsMissingTagsSearch;
  _insightsMissingTagsOpen = true;
  content.innerHTML = '<div class="insights-spinner-wrap"><div class="spinner"></div></div>';
  try {
    const res = await fetch('/api/insights/tag-health?problem_limit=10000');
    if (!res.ok) throw new Error('Could not load problem tracks');
    const data = await res.json();
    _insightsMissingTags = (data.problem_tracks || []).map(t => ({
      ...t,
      issues: Array.isArray(t.issues) && t.issues.length ? t.issues : _missingIssuesForTrack(t),
    }));
    _insightsMissingSelected = new Set();
    _insightsMissingDrafts = {};
    _renderMissingTagsTable();
  } catch (e) {
    content.innerHTML = '<div class="insights-missing-tags-empty">Could not load missing-tag tracks.</div>';
    _syncMissingTagsActions();
  }
}

function closeMissingTagsEditor() {
  _insightsMissingTagsOpen = false;
  state.view = 'insights';
  setActiveNav('insights');
  renderSidebarPlaylists();
  showViewEl('insights');
  loadInsightsView();
}

function setMissingTagDraft(trackId, field, value) {
  const id = String(trackId || '');
  if (!id || !field) return;
  if (!_insightsMissingDrafts[id]) _insightsMissingDrafts[id] = {};
  _insightsMissingDrafts[id][field] = String(value || '');
}

async function saveMissingTagRow(trackId) {
  const id = String(trackId || '');
  if (!id) return;
  const draft = _missingDraftFor(id);
  const payload = {};
  ['title', 'artist', 'album', 'year', 'genre'].forEach(k => {
    const v = String(draft[k] || '').trim();
    if (v) payload[k] = v;
  });
  if (!Object.keys(payload).length) {
    toast('Add at least one value for this row');
    return;
  }
  if (!_validateYear(payload.year || '')) {
    toast('Year must be a 4-digit number');
    return;
  }
  try {
    const updated = await api(`/library/tracks/${encodeURIComponent(id)}/tags`, {
      method: 'PUT',
      body: payload,
    });
    const idx = (_insightsMissingTags || []).findIndex(t => String(t.id) === id);
    if (idx >= 0) {
      const next = { ..._insightsMissingTags[idx], ...updated };
      next.issues = _missingIssuesForTrack(next);
      if (!next.issues.length) {
        _insightsMissingTags.splice(idx, 1);
        _insightsMissingSelected.delete(id);
      } else {
        _insightsMissingTags[idx] = next;
      }
    }
    delete _insightsMissingDrafts[id];
    _renderMissingTagsTable();
    toast('Tags saved');
  } catch (e) {
    toast(e.message || 'Could not save tags');
  }
}

function setMissingTagsFilter(value) {
  _insightsMissingTagsFilter = value || 'all';
  _renderMissingTagsTable();
}

function setMissingTagsSearch(value) {
  _insightsMissingTagsSearch = value || '';
  _renderMissingTagsTable();
}

function toggleMissingTagSelection(trackId, checked) {
  if (checked) _insightsMissingSelected.add(trackId);
  else _insightsMissingSelected.delete(trackId);
  _syncMissingTagsActions();
}

function toggleMissingTagsSelectAll() {
  const rows = _filteredMissingTags();
  if (!rows.length) return;
  const allSelected = rows.every(t => _insightsMissingSelected.has(t.id));
  if (allSelected) rows.forEach(t => _insightsMissingSelected.delete(t.id));
  else rows.forEach(t => _insightsMissingSelected.add(t.id));
  _renderMissingTagsTable();
}

function openMissingTagsBulkEditor() {
  const selected = _insightsMissingSelected.size;
  if (!selected) {
    toast('Select at least one track');
    return;
  }
  document.getElementById('missing-tags-bulk-warning-text').textContent =
    `This will overwrite tags on ${selected} selected file${selected !== 1 ? 's' : ''} on disk. Only filled fields are applied.`;
  ['mtb-artist', 'mtb-album-artist', 'mtb-album', 'mtb-year', 'mtb-genre'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  _hideTagError('mtb-error');
  const btn = document.getElementById('mtb-save-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Save Tags'; }
  const modal = document.getElementById('missing-tags-bulk-modal');
  if (modal) modal.style.display = 'flex';
}

function closeMissingTagsBulkEditor() {
  const modal = document.getElementById('missing-tags-bulk-modal');
  if (modal) modal.style.display = 'none';
}

async function saveMissingTagsBulkEditor() {
  const ids = [..._insightsMissingSelected];
  if (!ids.length) return;
  const changes = {
    artist: document.getElementById('mtb-artist')?.value.trim() || '',
    album_artist: document.getElementById('mtb-album-artist')?.value.trim() || '',
    album: document.getElementById('mtb-album')?.value.trim() || '',
    year: document.getElementById('mtb-year')?.value.trim() || '',
    genre: document.getElementById('mtb-genre')?.value.trim() || '',
  };
  if (!_validateYear(changes.year)) {
    _showTagError('mtb-error', 'Year must be a 4-digit number (e.g. 2003).');
    return;
  }
  const payload = {};
  Object.entries(changes).forEach(([k, v]) => {
    if (v) payload[k] = v;
  });
  if (!Object.keys(payload).length) {
    _showTagError('mtb-error', 'Fill in at least one field to update.');
    return;
  }
  const btn = document.getElementById('mtb-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  _hideTagError('mtb-error');
  try {
    const result = await api('/library/tracks/bulk-tags', {
      method: 'PUT',
      body: { track_ids: ids, changes: payload },
    });
    const errors = result.errors || [];
    if (errors.length) {
      toast(`Saved ${result.updated}/${result.total} tracks`, 4500);
    } else {
      toast(`Tags saved for ${result.updated} track${result.updated !== 1 ? 's' : ''}`);
    }
    closeMissingTagsBulkEditor();
    await openMissingTagsEditor();
  } catch (e) {
    _showTagError('mtb-error', e.message || 'Bulk save failed.');
    if (btn) { btn.disabled = false; btn.textContent = 'Save Tags'; }
  }
}

function openGenreDistributionModal() {
  const modal = document.getElementById('genre-distribution-modal');
  const body  = document.getElementById('genre-distribution-modal-body');
  if (!modal || !body) return;
  const maxCount = _allInsightGenres.length ? _allInsightGenres[0][1] : 1;
  body.innerHTML = _allInsightGenres.map(([genre, count], idx) => {
    const pct = Math.max(4, Math.round((count / maxCount) * 100));
    return `<div class="genre-modal-row">
      <div class="genre-modal-rank">${idx + 1}</div>
      <div class="genre-modal-main">
        <div class="genre-modal-name">${esc(genre)}</div>
        <div class="genre-modal-track"><div class="genre-modal-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="genre-modal-count">${count.toLocaleString()}</div>
    </div>`;
  }).join('');
  modal.style.display = 'flex';
}

function closeGenreDistributionModal() {
  const modal = document.getElementById('genre-distribution-modal');
  if (modal) modal.style.display = 'none';
}

let _analysisPoller = null;

async function startLibraryAnalysis() {
  const ok = await _showConfirm({
    title: 'Analyse Library',
    message: 'Audio analysis reads every file in your library. This runs in the background and may take a while depending on library size and machine speed.',
    okText: 'Start Analysis',
    danger: false,
  });
  if (!ok) return;

  const res = await fetch('/api/insights/analyse', { method: 'POST' });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    showToast(d.error || 'Could not start analysis.');
    return;
  }
  const d = await res.json().catch(() => ({}));
  if (d.already_up_to_date) {
    showToast('Analysis is already up to date.');
    const infoRes = await fetch('/api/insights/analyse/info').catch(() => null);
    if (infoRes && infoRes.ok) _updateAnalysisInfo(await infoRes.json());
    return;
  }
  // Immediately show the banner — don't wait for the first poll tick
  _updateAnalysisBanner({ status: 'running', done: 0, total: d.total || 0 });
  // Scroll the banner into view so the user sees it appear
  const banner = document.getElementById('insights-analysis-banner');
  if (banner) banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  _startAnalysisPolling();
}

async function cancelLibraryAnalysis() {
  const res = await fetch('/api/insights/analyse/cancel', { method: 'POST' });
  if (!res.ok) {
    showToast('Could not cancel analysis.');
    return;
  }
  // Optimistically reset UI; poller will reconcile on next tick
  _updateAnalysisBanner({ status: 'idle' });
  if (_analysisPoller) { clearInterval(_analysisPoller); _analysisPoller = null; }
}

/* ── Insights: rescan library tags ──────────────────────────────────────── */
let _insightsScanPoller = null;

async function insightsRescanLibrary() {
  const btn = document.getElementById('insights-rescan-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }

  const res = await fetch('/api/library/scan', { method: 'POST' }).catch(() => null);
  if (!res || !res.ok) {
    showToast('Could not start rescan.');
    if (btn) { btn.disabled = false; btn.textContent = 'Rescan tags'; }
    return;
  }

  _showInsightsScanBanner('Scanning library…', 0);
  if (_insightsScanPoller) clearInterval(_insightsScanPoller);
  _insightsScanPoller = setInterval(_pollInsightsScan, 900);
}

async function _pollInsightsScan() {
  const status = await fetch('/api/library/status').then(r => r.json()).catch(() => null);
  if (!status) return;

  // Also update the sidebar scan display
  const msg = document.getElementById('scan-msg');
  const bar = document.getElementById('scan-bar');
  const barWrap = document.getElementById('scan-bar-wrap');

  if (status.status === 'scanning') {
    const pct = status.total > 0 ? Math.round(status.progress / status.total * 100) : 0;
    _showInsightsScanBanner(`Scanning… ${status.progress} / ${status.total} tracks`, pct);
    if (msg) msg.textContent = `Scanning… ${status.progress}/${status.total}`;
    if (barWrap) barWrap.style.display = 'block';
    if (bar) bar.style.width = pct + '%';
    return;
  }

  // Scan finished — stop poller
  clearInterval(_insightsScanPoller);
  _insightsScanPoller = null;

  // Update sidebar
  if (barWrap) barWrap.style.display = 'none';
  if (status.status === 'done' && status.total_tracks != null) {
    const newLine = status.new_tracks > 0 ? `<span class="scan-new">+${status.new_tracks} new</span>`
      : status.new_tracks < 0 ? `<span class="scan-removed">${status.new_tracks} removed</span>`
      : `<span class="scan-unchanged">No changes</span>`;
    if (msg) msg.innerHTML = `<span class="scan-ready">Library ready</span><span class="scan-total">${status.total_tracks.toLocaleString()} tracks</span>${newLine}`;
  }

  // Hide banner and restore button
  _hideInsightsScanBanner();
  const btn = document.getElementById('insights-rescan-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Rescan tags'; }

  // Reload overview + tag health so updated tags are reflected
    if (state.view === 'insights') {
      const [overviewRes, tagRes] = await Promise.all([
        fetch('/api/insights/overview'),
        fetch('/api/insights/tag-health'),
      ]);
    if (overviewRes.ok) {
      const overviewData = await overviewRes.json();
      _renderInsightsOverview(overviewData);
      _renderInsightsGenreDistribution(overviewData);
    }
    if (tagRes.ok)      _renderInsightsTagHealth(await tagRes.json());
    // Also refresh analysis info (track count may have changed)
    const infoRes = await fetch('/api/insights/analyse/info').catch(() => null);
    if (infoRes && infoRes.ok) _updateAnalysisInfo(await infoRes.json());
  }
}

function _showInsightsScanBanner(message, pct) {
  const banner = document.getElementById('insights-scan-banner');
  const msgEl  = document.getElementById('insights-scan-msg');
  const barEl  = document.getElementById('insights-scan-bar');
  if (!banner) return;
  banner.style.display = 'block';
  if (msgEl) msgEl.textContent = message;
  if (barEl) barEl.style.width = (pct || 0) + '%';
}

function _hideInsightsScanBanner() {
  const banner = document.getElementById('insights-scan-banner');
  if (banner) banner.style.display = 'none';
}

function _startAnalysisPolling() {
  if (_analysisPoller) return;  // already polling
  _analysisPoller = setInterval(_pollAnalysisStatus, 1500);
  // No immediate tick — the banner was already shown by startLibraryAnalysis()
  // calling _updateAnalysisBanner({ status: 'running' }). An immediate poll risks
  // a race condition where the background thread hasn't set analysis_state yet
  // (e.g. it's still importing soundfile/numpy), so the server still returns
  // 'idle', which would hide the banner we just showed.
}

async function _pollAnalysisStatus() {
  try {
    const res = await fetch('/api/insights/analyse/status');
    if (!res.ok) return;
    const s = await res.json();
    _updateAnalysisBanner(s);

    if (s.status === 'done' || s.status === 'error' || s.status === 'idle') {
      clearInterval(_analysisPoller);
      _analysisPoller = null;
      if (s.status === 'done') {
        // Refresh overview charts now that sample_rate/bit_depth data is fresh
        setTimeout(() => {
          if (state.view === 'insights') loadInsightsView();
        }, 800);
      }
    }
  } catch (_) { /* network hiccup — keep polling */ }
}

/* ── Analysis coverage status (incremental delta display) ──────────────── */
function _updateAnalysisInfo(info) {
  const el  = document.getElementById('insights-analyse-status');
  const btn = document.getElementById('insights-analyse-btn');
  if (!el) return;
  if (info.status === 'needs_upgrade' || info.needs_upgrade) {
    el.innerHTML = `<span class="analyse-status-dot analyse-status-dot--warn"></span>Model upgraded — re-analysis required for Library Fit`;
    if (btn && !btn.disabled) btn.textContent = 'Re-analyse Library';
  } else if (info.status === 'up_to_date') {
    el.innerHTML = `<span class="analyse-status-dot analyse-status-dot--ok"></span>Analysis up to date — ${info.analysed.toLocaleString()} tracks analysed`;
    if (btn && !btn.disabled) btn.textContent = 'Re-analyse';
  } else if (info.status === 'pending') {
    el.innerHTML = `<span class="analyse-status-dot analyse-status-dot--warn"></span>${info.pending.toLocaleString()} song${info.pending !== 1 ? 's' : ''} pending analysis`;
    if (btn && !btn.disabled) btn.textContent = 'Analyse Library';
  } else {
    el.textContent = '';
    if (btn && !btn.disabled) btn.textContent = 'Analyse Library';
  }
}

/* ── Insights section help popovers ────────────────────────────────────── */
const _INSIGHTS_HELP = {
  overview: {
    title: 'Library Overview',
    body: `<p>Shows the distribution of <strong>file formats</strong>, <strong>sample rates</strong>, and <strong>bit depths</strong> across your entire library.</p>
           <p><strong>How to read:</strong> Taller bars = more tracks in that category. Ideally your library is consistent — e.g. mostly FLAC at 44.1 kHz / 16-bit for CD rips, or 96–192 kHz for Hi-Res downloads.</p>
           <p><strong>Example:</strong> If 95% of your tracks are FLAC at 44.1 kHz / 16-bit, your library is clean and consistent. A large MP3 slice alongside FLAC suggests rips from mixed sources.</p>`,
  },
  'tag-health': {
    title: 'Tag Health',
    body: `<p>Measures how <strong>complete</strong> the metadata tags are across your library files.</p>
           <p><strong>How to read:</strong> Green = high coverage, red = many tracks missing that tag. Title, Artist, and Album are critical for browsing; Genre and Year are optional but useful for filtering and playlists.</p>
           <p><strong>Example:</strong> A Genre score of 45% means more than half your tracks have no genre tag — worth fixing before building genre-based playlists.</p>`,
  },
  genre: {
    title: 'Genre Distribution',
    body: `<p>Shows your most common genres by <strong>track count</strong> so you can quickly understand collection balance.</p>
           <p><strong>How to read:</strong> The inline card shows the <strong>top 5</strong> genres for fast scanning. Use <em>View all genres</em> to drill into the complete list.</p>
           <p><strong>Note:</strong> Results are only as good as your file tags. Sparse or inconsistent genre tags will reduce accuracy.</p>`,
  },
  sonic: {
    title: 'Sonic Profile',
    body: `<p>Summarises your library's <strong>tonal demand</strong> so you can understand what IEM/headphone signatures are likely to suit your collection.</p>
           <p><strong>Library Tonal Demand</strong> shows where your music places most emphasis across perceptual frequency bands. This is the same signal used in compatibility scoring.</p>
           <p><strong>Brightness Distribution</strong> indicates how often tracks skew warm/dark vs bright/forward.</p>
           <p><strong>RMS Energy Distribution</strong> reflects mastering density (more compressed vs more dynamic recordings).</p>
           <p><strong>Note:</strong> Analysis covers FLAC files only. M4A/AAC tracks are skipped (libsndfile limitation). Results update after running "Analyse Library".</p>`,
  },
  gear: {
    title: 'IEM / Headphone Fit',
    body: `<p>Scores how well each IEM matches your library's tonal demands, measured against a chosen target curve.</p>
           <p><strong>Scoring target</strong> — the FR curve each IEM is scored against. <em>Flat / Neutral</em> (default) = perfectly flat response. You can also pick any target you've added in Settings (e.g. Harman, Rtings) to score IEMs against a preferred tuning signature instead.</p>
           <p><strong>Library character</strong> — which frequency bands your music exercises most (salience). Deviations from the target in heavily-used bands cost more points.</p>
           <p><strong>IEM Fit Score</strong> — 100% = matches the target exactly. Factory vs PEQ tabs let you compare the raw measurement against a PEQ-equalised version.</p>
           <p><strong>Band bars</strong> — deviation from the target at 0 dB centre. Left = recessed vs target; right = boosted vs target.</p>
           <p><strong>Collection Coverage</strong> — across all your IEMs, how well is each band covered by at least one IEM close to the target?</p>
           <p><strong>Example:</strong> Scoring against Harman IEM 2019 instead of flat will favour IEMs with a slight bass shelf and ear-gain peak — penalising overly neutral-sounding IEMs that most listeners find thin.</p>`,
  },
};

let _helpCloseHandler = null;

function showInsightsHelp(sectionKey, e) {
  e.stopPropagation();
  const btn  = e.currentTarget;
  const pop  = document.getElementById('insights-help-popover');
  const help = _INSIGHTS_HELP[sectionKey];
  if (!pop || !help) return;

  // Toggle off if already showing this section
  if (pop.dataset.openFor === sectionKey && pop.style.display !== 'none') {
    pop.style.display = 'none';
    pop.dataset.openFor = '';
    return;
  }

  document.getElementById('insights-help-title').textContent = help.title;
  document.getElementById('insights-help-body').innerHTML   = help.body;
  pop.dataset.openFor = sectionKey;
  pop.style.display   = 'block';

  // Position: fixed, right-aligned; open above button if not enough space below
  const rect    = btn.getBoundingClientRect();
  const popW    = 360;
  const margin  = 12;
  const vGap    = 8;
  const maxH    = Math.min(window.innerHeight * 0.65, 420);

  let left = rect.right - popW;
  if (left < margin) left = margin;
  if (left + popW > window.innerWidth - margin) left = window.innerWidth - popW - margin;

  const spaceBelow = window.innerHeight - rect.bottom - vGap - margin;
  let top;
  if (spaceBelow >= 160) {
    top = rect.bottom + vGap;
  } else {
    top = rect.top - vGap - maxH;
    if (top < margin) top = margin;
  }

  pop.style.top       = top + 'px';
  pop.style.left      = left + 'px';
  pop.style.width     = popW + 'px';
  pop.style.maxHeight = maxH + 'px';
  pop.style.overflowY = 'auto';

  // Close on outside click
  if (_helpCloseHandler) document.removeEventListener('click', _helpCloseHandler);
  _helpCloseHandler = function () {
    pop.style.display = 'none';
    pop.dataset.openFor = '';
    document.removeEventListener('click', _helpCloseHandler);
    _helpCloseHandler = null;
  };
  setTimeout(() => document.addEventListener('click', _helpCloseHandler), 0);
}

function _updateAnalysisBanner(s) {
  const banner   = document.getElementById('insights-analysis-banner');
  const navDot   = document.getElementById('insights-nav-dot');
  const icon       = document.getElementById('insights-analysis-icon');
  const label      = document.getElementById('insights-analysis-label');
  const sub        = document.getElementById('insights-analysis-sub');
  const bar        = document.getElementById('insights-analysis-bar');
  const cta        = document.getElementById('insights-analyse-btn');
  const cancelBtn  = document.getElementById('insights-cancel-btn');
  if (!banner) return;

  if (s.status === 'idle') {
    banner.style.display = 'none';
    if (navDot) navDot.style.display = 'none';
    if (cta) { cta.disabled = false; cta.innerHTML = 'Analyse Library'; }
    if (cancelBtn) cancelBtn.style.display = 'none';
    return;
  }

  banner.style.display = 'block';
  banner.className = 'insights-analysis-banner';

  const _spinnerSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></path></svg>`;
  const _doneSvg   = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const _errorSvg  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

  if (s.status === 'running') {
    if (navDot) navDot.style.display = 'flex';
    icon.innerHTML = _spinnerSvg;
    label.textContent = 'Analysing library…';
    const pct = s.total > 0 ? Math.round(s.done / s.total * 100) : 0;
    sub.textContent = s.total > 0
      ? `${s.done.toLocaleString()} / ${s.total.toLocaleString()} tracks · ${pct}%`
      : 'Starting…';
    bar.className = 'insights-analysis-bar';
    bar.style.width = `${pct}%`;
    if (cta) {
      cta.disabled = true;
      cta.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="animation:spin 1s linear infinite;flex-shrink:0"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> Analysing…`;
    }
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
  } else if (s.status === 'done') {
    if (navDot) navDot.style.display = 'none';
    banner.classList.add('insights-analysis-banner--done');
    icon.innerHTML = _doneSvg;
    label.textContent = 'Analysis complete';
    const ts = s.completed_at ? new Date(s.completed_at * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    sub.textContent = `${s.total.toLocaleString()} tracks analysed${ts ? ' · ' + ts : ''}`;
    bar.className = 'insights-analysis-bar';
    bar.style.width = '100%';
    if (cta) { cta.disabled = false; cta.innerHTML = 'Re-analyse'; }
    if (cancelBtn) cancelBtn.style.display = 'none';
  } else if (s.status === 'error') {
    if (navDot) navDot.style.display = 'none';
    banner.classList.add('insights-analysis-banner--error');
    icon.innerHTML = _errorSvg;
    label.textContent = 'Analysis failed';
    sub.textContent = s.error || 'Unknown error';
    bar.style.width = '0%';
    if (cta) { cta.disabled = false; cta.innerHTML = 'Analyse Library'; }
    if (cancelBtn) cancelBtn.style.display = 'none';
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Insights — Phase 2: Sonic Profile
   ═══════════════════════════════════════════════════════════════════════════ */

let _sonicBrightnessChart = null;
let _sonicEnergyChart     = null;
let _sonicScatterChart    = null;
let _sonicBandChart       = null;

function _renderInsightsSonicProfile(d) {
  const el = document.getElementById('insights-sonic-content');

  [_sonicBrightnessChart, _sonicEnergyChart, _sonicScatterChart, _sonicBandChart]
    .forEach(c => { if (c) c.destroy(); });
  _sonicBrightnessChart = _sonicEnergyChart = _sonicScatterChart = _sonicBandChart = null;

  const _hz = v => v >= 1000 ? `${(v/1000).toFixed(v%1000===0?0:1)}k` : Math.round(v).toString();
  const _barOpts = () => ({
    responsive: true, maintainAspectRatio: false,
    scales: {
      x: { ticks: { color: '#6b6b7b', font: { size: 10 } }, grid: { color: 'rgba(173,198,255,0.05)' }, border: { color: 'transparent' } },
      y: { ticks: { color: '#6b6b7b', font: { size: 9 } }, grid: { color: 'rgba(173,198,255,0.06)' }, border: { color: 'transparent' } },
    },
    plugins: { legend: { display: false }, tooltip: _insightsTooltipDefaults() },
  });

  const bs = d.brightness.stats;
  const es = d.energy.stats;
  const bandLabels = d.band_labels || {};
  const bandEntries = Object.entries(d.band_profile || {}).sort((a, b) => b[1] - a[1]);

  const _sumBands = keys => keys.reduce((acc, k) => acc + Number((d.band_profile || {})[k] || 0), 0);
  const bassDemand   = _sumBands(['sub_bass', 'bass', 'bass_feel', 'slam']);
  const midDemand    = _sumBands(['lower_mids', 'upper_mids', 'note_weight']);
  const trebleDemand = _sumBands(['lower_treble', 'upper_treble', 'detail', 'sibilance', 'texture']);

  const topBands = bandEntries.slice(0, 3).map(([k]) => bandLabels[k] || k).join(' · ');
  const brightnessMedian = Number(bs.median || 0);
  const energySpread = Math.max(0, Number(es.p75 || 0) - Number(es.p25 || 0));

  let tonalTilt = 'Balanced tonal demand';
  if (bassDemand > trebleDemand + 0.08) tonalTilt = 'Low-end weighted demand';
  else if (trebleDemand > bassDemand + 0.08) tonalTilt = 'Treble-weighted demand';
  else if (midDemand > bassDemand && midDemand > trebleDemand) tonalTilt = 'Mid-centric demand';

  let brightnessRead = 'Mixed brightness profile';
  if (brightnessMedian >= 4500) brightnessRead = 'Mostly bright / detail-forward';
  else if (brightnessMedian <= 2500) brightnessRead = 'Mostly warm / low-end-forward';

  let dynamicsRead = 'Moderate mastering spread';
  if (energySpread >= 0.08) dynamicsRead = 'Wide spread (dynamic + compressed)';
  else if (energySpread <= 0.03) dynamicsRead = 'Consistent mastering density';

  const cues = [];
  if (bassDemand > trebleDemand + 0.08) cues.push('Prioritise bass control and low-end separation.');
  if (trebleDemand > bassDemand + 0.08) cues.push('Smoother upper mids/treble can reduce fatigue.');
  if (brightnessMedian <= 2500) cues.push('A touch more upper-mid/treble presence may improve clarity.');
  if (brightnessMedian >= 4500) cues.push('Neutral-to-warm signatures may sound more natural.');
  if (energySpread >= 0.08) cues.push('Good dynamics help across mixed mastering quality.');
  if (!cues.length) cues.push('Balanced signatures should perform consistently across your library.');

  const bandProfileHtml = d.band_profile
    ? `<div class="sonic-band-card">
        <div class="sonic-chart-title">Library Tonal Demand (Compatibility Signal)</div>
        <div class="sonic-chart-subtitle">Relative frequency emphasis used by IEM/headphone matching.</div>
        <div class="insights-chart-wrap" style="height:148px"><canvas id="sonic-band-canvas"></canvas></div>
       </div>`
    : '';

  el.innerHTML = `
    <div class="sonic-profile-stack">
    <div class="sonic-insight-grid">
      <div class="sonic-insight-card">
        <div class="sonic-insight-kicker">Tonal Tilt</div>
        <div class="sonic-insight-title">${tonalTilt}</div>
        <div class="sonic-insight-meta">Top demand: ${esc(topBands || 'N/A')}</div>
      </div>
      <div class="sonic-insight-card">
        <div class="sonic-insight-kicker">Brightness Read</div>
        <div class="sonic-insight-title">${brightnessRead}</div>
        <div class="sonic-insight-meta">Median centroid: ${_hz(bs.median)} Hz</div>
      </div>
      <div class="sonic-insight-card">
        <div class="sonic-insight-kicker">Dynamics Read</div>
        <div class="sonic-insight-title">${dynamicsRead}</div>
        <div class="sonic-insight-meta">RMS IQR: ${es.p25.toFixed(3)} - ${es.p75.toFixed(3)}</div>
      </div>
    </div>
    <div class="sonic-charts-grid">
      <div class="sonic-chart-card">
        <div class="sonic-chart-title">Brightness Distribution (Tonal Tilt)</div>
        <div class="insights-chart-wrap" style="height:138px"><canvas id="sonic-brightness-canvas"></canvas></div>
        <div class="sonic-stat-row">
          <span class="sonic-stat">Median <strong>${_hz(bs.median)} Hz</strong></span>
          <span class="sonic-stat">Mean <strong>${_hz(bs.mean)} Hz</strong></span>
          <span class="sonic-stat">IQR <strong>${_hz(bs.p25)}–${_hz(bs.p75)} Hz</strong></span>
        </div>
      </div>
      <div class="sonic-chart-card">
        <div class="sonic-chart-title">RMS Energy Distribution (Mastering Density)</div>
        <div class="insights-chart-wrap" style="height:138px"><canvas id="sonic-energy-canvas"></canvas></div>
        <div class="sonic-stat-row">
          <span class="sonic-stat">Median <strong>${es.median.toFixed(3)}</strong></span>
          <span class="sonic-stat">Mean <strong>${es.mean.toFixed(3)}</strong></span>
          <span class="sonic-stat">IQR <strong>${es.p25.toFixed(3)}–${es.p75.toFixed(3)}</strong></span>
        </div>
      </div>
    </div>
    ${bandProfileHtml}
    <div class="sonic-caveat">
      <strong>Compatibility cues</strong> — ${cues.map(c => esc(c)).join(' ')} <strong>Analysis covers FLAC files only</strong> — M4A/AAC tracks are skipped.
    </div>
    </div>`;

  _sonicBrightnessChart = new Chart(document.getElementById('sonic-brightness-canvas'), {
    type: 'bar',
    data: { labels: d.brightness.histogram.midpoints,
            datasets: [{ data: d.brightness.histogram.counts, backgroundColor: 'rgba(173,198,255,0.65)', borderColor: 'rgba(173,198,255,0.9)', borderWidth: 1, borderRadius: 3 }] },
    options: {
      ..._barOpts(),
      scales: { ..._barOpts().scales,
        x: { ..._barOpts().scales.x,
             ticks: { ...(_barOpts().scales.x.ticks), callback: function(_, i) { return _hz(this.chart.data.labels[i]); } } } },
    },
  });

  _sonicEnergyChart = new Chart(document.getElementById('sonic-energy-canvas'), {
    type: 'bar',
    data: { labels: d.energy.histogram.midpoints,
            datasets: [{ data: d.energy.histogram.counts, backgroundColor: 'rgba(83,225,111,0.65)', borderColor: 'rgba(83,225,111,0.9)', borderWidth: 1, borderRadius: 3 }] },
    options: {
      ..._barOpts(),
      scales: { ..._barOpts().scales,
        x: { ..._barOpts().scales.x,
             ticks: { ...(_barOpts().scales.x.ticks), callback: function(_, i) { return this.chart.data.labels[i].toFixed(2); } } } },
    },
  });

  if (d.band_profile && document.getElementById('sonic-band-canvas')) {
    const bl     = d.band_labels || {};
    const bKeys  = Object.keys(d.band_profile);
    const bVals  = bKeys.map(k => d.band_profile[k]);
    const bLabels = bKeys.map(k => bl[k] || k);
    _sonicBandChart = new Chart(document.getElementById('sonic-band-canvas'), {
      type: 'bar',
      data: {
        labels: bLabels,
        datasets: [{
          data: bVals,
          backgroundColor: bVals.map(v => `rgba(173,198,255,${0.3 + v * 0.5})`),
          borderColor: 'rgba(173,198,255,0.8)',
          borderWidth: 1, borderRadius: 3,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: '#6b6b7b', font: { size: 9 }, maxRotation: 45 },
               grid: { color: 'rgba(173,198,255,0.05)' }, border: { color: 'transparent' } },
          y: { min: 0, max: 1,
               ticks: { color: '#6b6b7b', font: { size: 9 },
                        callback: v => (v * 100).toFixed(0) + '%' },
               grid: { color: 'rgba(173,198,255,0.05)' }, border: { color: 'transparent' },
               title: { display: true, text: 'Relative energy', color: '#6b6b7b', font: { size: 10 } } },
        },
        plugins: { legend: { display: false },
                   tooltip: { ..._insightsTooltipDefaults(),
                              callbacks: { label: ctx => `${(ctx.parsed.y * 100).toFixed(1)}% of peak band` } } },
      },
    });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Insights — Phase 3: IEM Match (Genre-IEM Matching Module)
   ═══════════════════════════════════════════════════════════════════════════ */

let _matchData      = null;   // cached full matrix response
let _matchTarget    = 'flat'; // currently selected scoring target
let _matchRadarChart = null;  // kept for compat
let _matchRadarIems  = [];    // kept for compat

// IEM / Headphone Fit state
let _iemFitSelectedId  = null;  // currently expanded IEM id
let _iemFitMatrixData  = null;  // cached matrix response
let _iemFitFRCharts    = {};    // iemId → Chart.js FR instance
let _iemFitPeqState    = {};    // iemId → active peqId (string | null)
let _iemFitPeqVariants = {};    // iemId → {factory_scores, peq_variants, iem_name}
let _iemFitActiveScores12 = {}; // iemId → active 12-band score map used by current UI render
let _iemFitGenreState  = {};    // iemId → selected genre key for FR overlay (string | null)
let _iemFitSourceState = {};    // iemId → selected source id (string | null)
let _iemFitExtraGenres = [];    // user-added heatmap genres
let _iemFitIemSummary  = [];    // cached IEM summary list

// ── Band keys (12 perceptual bands) ───────────────────────────────────────────
const _PERC_BAND_KEYS = [
  'sub_bass','bass','bass_feel','slam','lower_mids','upper_mids',
  'note_weight','lower_treble','upper_treble','detail','sibilance','texture',
];

// Frequency ranges for each perceptual band — mirrors backend _PERC_BANDS exactly.
// Used to map genre fingerprint energy onto the FR chart x-axis.
const _FR_BAND_RANGES = [
  { key: 'sub_bass',      f1: 20,   f2: 60    },
  { key: 'bass',          f1: 60,   f2: 120   },
  { key: 'bass_feel',     f1: 80,   f2: 200   },
  { key: 'slam',          f1: 80,   f2: 150   },
  { key: 'lower_mids',    f1: 200,  f2: 500   },
  { key: 'upper_mids',    f1: 500,  f2: 1500  },
  { key: 'note_weight',   f1: 200,  f2: 1000  },
  { key: 'lower_treble',  f1: 3000, f2: 6000  },
  { key: 'upper_treble',  f1: 6000, f2: 20000 },
  { key: 'detail',        f1: 4000, f2: 10000 },
  { key: 'sibilance',     f1: 5000, f2: 10000 },
  { key: 'texture',       f1: 6000, f2: 15000 },
];
const _ALL_DIM_KEYS_FE = [
  ..._PERC_BAND_KEYS,
  'sound_stage','timbre_color','masking','layering','tonality',
];
const _ALL_DIM_LABELS_FE = {
  sub_bass: 'Sub Bass', bass: 'Bass', bass_feel: 'Bass Feel', slam: 'Slam',
  lower_mids: 'Low Mids', upper_mids: 'Upper Mids', note_weight: 'Note Weight',
  lower_treble: 'Low Treble', upper_treble: 'Up Treble', detail: 'Detail',
  sibilance: 'Sibilance', texture: 'Texture',
  sound_stage: 'Soundstage', timbre_color: 'Timbre', masking: 'Masking',
  layering: 'Layering', tonality: 'Tonality',
};

// ── Compact FR chart builder (reused in IEM Fit accordion) ───────────────────
// Builds a self-contained Chart.js line chart into `canvas` using curves from
// /api/iems/<id>/graph.  Returns the Chart instance.
// genreFingerprint: {bandKey: 0–1} — when provided draws genre salience shading.
// genreLabel: display name for the selected genre (shown as chart annotation).
function _buildCompactFRChart(canvas, curves, genreFingerprint = null, genreLabel = null) {
  const regionPlugin = _createFrOverlayPlugin('fitFRRegions', {
    extraDraw(chart, meta) {
      const { left, right, top, bottom, x, ctx } = meta;
      if (!genreFingerprint) return;
      const N = 300;
      const logMin = Math.log10(20);
      const logMax = Math.log10(20000);
      const saliences = [];
      const freqs = [];
      for (let i = 0; i < N; i++) {
        const f = Math.pow(10, logMin + (logMax - logMin) * i / (N - 1));
        freqs.push(f);
        let s = 0;
        for (const { key, f1, f2 } of _FR_BAND_RANGES) {
          if (f >= f1 && f <= f2) s += genreFingerprint[key] || 0;
        }
        saliences.push(s);
      }
      const maxS = Math.max(...saliences, 1e-9);
      const maxH = 0.42 * (bottom - top);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(left, bottom);
      for (let i = 0; i < N; i++) {
        const px = Math.max(left, Math.min(right, x.getPixelForValue(freqs[i])));
        const py = bottom - (saliences[i] / maxS) * maxH;
        ctx.lineTo(px, py);
      }
      ctx.lineTo(right, bottom);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, bottom - maxH, 0, bottom);
      grad.addColorStop(0,   'rgba(240,168,48,0.28)');
      grad.addColorStop(0.5, 'rgba(240,168,48,0.18)');
      grad.addColorStop(1,   'rgba(240,168,48,0.06)');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
      if (genreLabel) {
        ctx.save();
        ctx.font = '600 10px Inter, sans-serif';
        ctx.fillStyle = 'rgba(240,168,48,0.75)';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(genreLabel, right - 4, bottom - 4);
        ctx.restore();
      }
    },
  });

  function _frCurveColor(id) {
    if (id.includes('-peq-')) return '#53e16f';
    if (id.endsWith('-R'))   return '#e05c5c';
    return '#5b8dee';
  }

  const datasets = curves.map(c => ({
    label: c.label,
    data: c.data.map(([f, spl]) => ({ x: f, y: spl })),
    borderColor: _frCurveColor(c.id),
    borderWidth: c.id.includes('-peq-') ? 1.6 : 1.9,
    pointRadius: 0,
    tension: 0.3,
  }));

  return new Chart(canvas, {
    type: 'line',
    plugins: [regionPlugin],
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 180 },
      scales: {
        x: {
          type: 'logarithmic',
          min: 20, max: 20000,
          ticks: {
            color: '#6b6b7b',
            font: { size: 9, family: 'Inter, sans-serif' },
            callback(v) {
              const labeled = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
              if (!labeled.includes(v)) return '';
              return v >= 1000 ? (v / 1000) + 'k' : v;
            },
            autoSkip: false, maxRotation: 0,
          },
          afterBuildTicks(axis) {
            axis.ticks = [20,30,40,50,60,80,100,150,200,300,400,500,600,800,
              1000,1500,2000,3000,4000,5000,6000,8000,10000,15000,20000
            ].map(v => ({ value: v }));
          },
          grid: {
            color: ctx => [100, 1000, 10000].includes(ctx.tick?.value)
              ? 'rgba(173,198,255,.12)' : 'rgba(173,198,255,.04)',
          },
        },
        y: {
          min: 50, max: 110,
          title: { display: true, text: 'dB', color: '#6b6b7b', font: { size: 10, family: 'Inter, sans-serif' } },
          ticks: { color: '#6b6b7b', font: { size: 9, family: 'Inter, sans-serif' }, stepSize: 10 },
          grid: { color: 'rgba(173,198,255,.06)' },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(30,30,42,0.95)',
          titleColor: '#adc6ff', bodyColor: '#c1c6d7',
          callbacks: {
            title: items => {
              const f = items[0].parsed.x;
              return f >= 1000 ? (f / 1000).toFixed(1) + ' kHz' : Math.round(f) + ' Hz';
            },
            label: item => ` ${item.dataset.label}: ${item.parsed.y.toFixed(1)} dB`,
          },
        },
      },
    },
  });
}

// Recompute a genre match score for any set of 12-band IEM scores (e.g. PEQ variant)
// fingerprint: {band: 0-1}  scores12: {band: 1-10}
function _recomputeGenreScore(fingerprint, scores12) {
  let sumEW = 0, sumE = 0;
  for (const k of _PERC_BAND_KEYS) {
    const e = fingerprint[k] ?? 0;
    sumEW += e * (scores12[k] ?? 5);
    sumE  += e;
  }
  return sumE > 0 ? Math.min(sumEW / sumE * 10, 100) : 50;
}

// ── Score colour ──────────────────────────────────────────────────────────────
function _matchScoreColor(s) {
  return s >= 75 ? '#53e16f' : s >= 55 ? '#f0b429' : '#ffb3b5';
}
function _matchScoreBg(s) {
  return s >= 75 ? 'rgba(83,225,111,0.15)' : s >= 55 ? 'rgba(240,180,41,0.12)' : 'rgba(255,179,181,0.15)';
}

// ── Run matching analysis (fast — no audio I/O) ───────────────────────────────
async function runMatchingAnalysis() {
  const el = document.getElementById('insights-gear-content');
  if (el) el.innerHTML = '<div class="insights-spinner-wrap"><div class="spinner"></div></div>';
  try {
    const res = await fetch('/api/insights/matching/analyse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: _matchTarget }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      _renderInsightsMatchOverview(null, d.error || 'Matching analysis failed.');
      return;
    }
    // Reload overview after analysis
    const ovRes = await fetch('/api/insights/matching/overview');
    if (ovRes.ok) _renderInsightsMatchOverview(await ovRes.json());
    else          _renderInsightsMatchOverview(null);
  } catch (e) {
    _renderInsightsMatchOverview(null, 'Network error — is the server running?');
  }
}

async function changeMatchTarget(selectEl) {
  _matchTarget = selectEl.value;
  // Re-run analysis with new target (fast)
  await runMatchingAnalysis();
}

// ── IEM / Headphone Fit ────────────────────────────────────────────────────────
function _renderInsightsMatchOverview(d, errMsg) {
  const el = document.getElementById('insights-gear-content');
  if (!el) return;

  // Update section-header action button
  const hdrActions = document.getElementById('iemfit-header-actions');
  if (hdrActions) {
    hdrActions.innerHTML = d
      ? `<button class="insights-cta-btn iemfit-reanalyse-btn" onclick="App.runMatchingAnalysis()">Re-analyse</button>`
      : `<button class="insights-cta-btn btn-primary" onclick="App.runMatchingAnalysis()">Run Analysis</button>`;
  }

  if (!d) {
    el.innerHTML = `
      <div class="match-no-data">
        <div class="match-no-data-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
          </svg>
        </div>
        <div class="match-no-data-title">Run IEM Match Analysis</div>
        <div class="match-no-data-desc">Scores each IEM against every genre in your library using 17 perceptual dimensions. Requires audio analysis to be completed first.${errMsg ? `<br><span style="color:var(--accent-secondary)">${esc(errMsg)}</span>` : ''}</div>
      </div>`;
    return;
  }

  // Reset accordion state
  _iemFitIemSummary  = d.iem_summary || [];
  _iemFitSelectedId  = null;
  _iemFitFRCharts    = {};
  _iemFitPeqState    = {};
  _iemFitPeqVariants = {};
  _iemFitGenreState  = {};
  _iemFitSourceState = {};

  const iemListHtml = _iemFitIemSummary.length === 0
    ? `<p class="insights-empty-note">No IEMs with FR data found. Add IEMs in the Gear section.</p>`
    : _iemFitIemSummary.map(iem => {
        const col = _matchScoreColor(iem.library_match_score);
        return `
          <div class="iemfit-iem-item" id="iemfit-item-${esc(iem.iem_id)}">
            <div class="iemfit-iem-card" onclick="App._toggleIemAccordion('${esc(iem.iem_id)}')">
              <div class="iemfit-iem-score-col">
                <span class="iemfit-iem-pct" style="color:${col}">${iem.library_match_score.toFixed(0)}%</span>
              </div>
              <div class="iemfit-iem-info-col">
                <div class="iemfit-iem-name">${esc(iem.iem_name)}</div>
                <div class="iemfit-iem-meta">
                  ${iem.best_genre  ? `Best for <strong>${esc(iem.best_genre)}</strong>` : ''}
                  ${iem.worst_genre ? ` · Worst for <strong>${esc(iem.worst_genre)}</strong>` : ''}
                  ${iem.genres_total ? ` · <span>${iem.genres_above_70}/${iem.genres_total} genres ≥70%</span>` : ''}
                </div>
              </div>
              <svg class="iemfit-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
            <div class="iemfit-detail-panel" id="iemfit-detail-${esc(iem.iem_id)}" style="display:none"></div>
          </div>`;
      }).join('');

  el.innerHTML = `<div class="iemfit-iem-list">${iemListHtml}</div>`;
}

async function _toggleIemAccordion(iemId) {
  const panel = document.getElementById(`iemfit-detail-${iemId}`);
  const card  = panel && panel.previousElementSibling;
  if (!panel) return;

  const isOpen = panel.style.display !== 'none';

  // Close previously open panel (different IEM)
  if (_iemFitSelectedId && _iemFitSelectedId !== iemId) {
    const prev     = document.getElementById(`iemfit-detail-${_iemFitSelectedId}`);
    const prevCard = prev && prev.previousElementSibling;
    if (prev)     prev.style.display = 'none';
    if (prevCard) prevCard.classList.remove('iemfit-iem-card--open');
    if (_iemFitFRCharts[_iemFitSelectedId]) {
      _iemFitFRCharts[_iemFitSelectedId].destroy();
      delete _iemFitFRCharts[_iemFitSelectedId];
    }
  }

  if (isOpen) {
    panel.style.display = 'none';
    if (card) card.classList.remove('iemfit-iem-card--open');
    if (_iemFitFRCharts[iemId]) {
      _iemFitFRCharts[iemId].destroy();
      delete _iemFitFRCharts[iemId];
    }
    _iemFitSelectedId = null;
    return;
  }

  // Expand
  _iemFitSelectedId = iemId;
  if (card) card.classList.add('iemfit-iem-card--open');
  panel.style.display = 'block';
  panel.innerHTML = '<div class="insights-spinner-wrap"><div class="spinner"></div></div>';

  // Fetch matrix + heatmap config if not cached
  if (!_iemFitMatrixData) {
    try {
      const r = await fetch('/api/insights/matching/matrix');
      if (r.ok) _iemFitMatrixData = await r.json();
    } catch (_) {}
  }
  if (!_iemFitExtraGenres.length) {
    try {
      const r = await fetch('/api/insights/matching/heatmap-genres');
      if (r.ok) { const cfg = await r.json(); _iemFitExtraGenres = cfg.extra_genres || []; }
    } catch (_) {}
  }

  _renderIemDetail(iemId, panel);
  setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
}

function _renderIemDetail(iemId, container) {
  container.innerHTML = `
    <div class="iemfit-detail-inner">
      <div class="iemfit-detail-top-grid">
        <div class="iemfit-detail-section">
          <div class="iemfit-detail-section-hdr">
            <span class="iemfit-detail-section-title">Genre Scores</span>
            <span class="iemfit-detail-section-hint">How well this IEM matches each genre in your library</span>
          </div>
          <div id="iemfit-heatmap-${esc(iemId)}" class="iemfit-heatmap-body"></div>
        </div>
        <div class="iemfit-detail-section">
          <div class="iemfit-detail-section-hdr">
            <span class="iemfit-detail-section-title">Blindspot Detector</span>
            <span class="iemfit-detail-section-hint">Genres this IEM handles least well</span>
          </div>
          <div id="iemfit-bs-${esc(iemId)}" class="iemfit-bs-body"></div>
        </div>
      </div>
      <div class="iemfit-detail-section">
        <div class="iemfit-detail-section-hdr">
          <span class="iemfit-detail-section-title">Frequency Response</span>
          <div class="iemfit-fr-controls" id="iemfit-fr-controls-${esc(iemId)}"></div>
        </div>
        <div class="iemfit-fr-wrap">
          <canvas id="iemfit-fr-canvas-${esc(iemId)}"></canvas>
        </div>
        <div id="iemfit-fr-legend-${esc(iemId)}" class="iemfit-fr-legend"></div>
      </div>
    </div>`;

  _renderIemFRPanel(iemId, null); // also drives heatmap + blindspot
}

async function _renderIemFRPanel(iemId, activePeqId) {
  const canvas     = document.getElementById(`iemfit-fr-canvas-${iemId}`);
  const controlsEl = document.getElementById(`iemfit-fr-controls-${iemId}`);
  const legendEl   = document.getElementById(`iemfit-fr-legend-${iemId}`);
  if (!canvas) return;

  // Track active PEQ
  if (activePeqId !== undefined) _iemFitPeqState[iemId] = activePeqId || null;
  const peqId = _iemFitPeqState[iemId] || null;

  // Fetch PEQ profiles + optional 12-band scores on first open.
  // Strategy: always fetch the live IEM endpoint for the up-to-date PEQ profile list
  // (so the dropdown is never stale), then layer in 12-band scores from the radar
  // endpoint if matching analysis has been run.
  if (!_iemFitPeqVariants[iemId]) {
    // Seed an empty entry so both fetches can populate it in any order
    _iemFitPeqVariants[iemId] = {
      factory_scores: {}, peq_variants: [], iem_name: iemId,
      has_scores: false, sources: [], selected_source_id: null,
    };

    // Tier 1: radar endpoint — 12-band scores for genre/blindspot recomputation
    // Optional: returns 404 when analysis hasn't been run yet; safe to skip.
    let radarVariantMap = {};  // peq_id → scores_12band, for merging below
    try {
      const r1 = await fetch(`/api/insights/matching/iem/${encodeURIComponent(iemId)}/radar`);
      if (r1.ok) {
        const rd = await r1.json();
        _iemFitPeqVariants[iemId].factory_scores = rd.scores || {};
        _iemFitPeqVariants[iemId].iem_name       = rd.iem_name || iemId;
        _iemFitPeqVariants[iemId].has_scores     = true;
        (rd.peq_variants || []).forEach(v => { radarVariantMap[v.peq_id] = v.scores || null; });
      }
    } catch (_) {}

    // Tier 2: IEM endpoint — always available, gives current PEQ profile list
    try {
      const r2 = await fetch(`/api/iems/${encodeURIComponent(iemId)}`);
      if (r2.ok) {
        const iemRaw = await r2.json();
        if (iemRaw.name) _iemFitPeqVariants[iemId].iem_name = iemRaw.name;
        _iemFitPeqVariants[iemId].sources = iemRaw.squig_sources || [];
        _iemFitPeqVariants[iemId].selected_source_id = iemRaw.primary_source_id || ((_iemFitPeqVariants[iemId].sources[0] || {}).id) || null;
        if (_iemFitSourceState[iemId] == null) {
          _iemFitSourceState[iemId] = _iemFitPeqVariants[iemId].selected_source_id;
        }
        _iemFitPeqVariants[iemId].peq_variants = (iemRaw.peq_profiles || []).map(p => ({
          peq_id: p.id,
          name:   p.name || 'PEQ',
          scores: radarVariantMap[p.id] || null,  // merge 12-band scores if available
        }));
      }
    } catch (_) {}
  }

  const iemData     = _iemFitPeqVariants[iemId] || {};
  const peqVariants = iemData.peq_variants || [];
  const sourceVariants = iemData.sources || [];
  const sourceId = _iemFitSourceState[iemId] || iemData.selected_source_id || (sourceVariants[0] || {}).id || null;

  // Genre overlay state
  const genreKey   = _iemFitGenreState[iemId] || null;
  const genreRow   = (_iemFitMatrixData?.matrix || []).find(r => r.genre === genreKey);
  const genreFingerprint = genreRow?.fingerprint || null;

  // Render controls — PEQ dropdown + Genre overlay dropdown
  if (controlsEl) {
    const peqCtrl = peqVariants.length > 0
      ? `<div class="iemfit-fr-ctrl-group">
           <label class="iemfit-fr-ctrl-label">PEQ</label>
           <select class="iemfit-radar-select" onchange="App.iemFitChangePeq('${esc(iemId)}',this.value)">
             <option value="">Factory</option>
             ${peqVariants.map(v =>
               `<option value="${esc(v.peq_id)}" ${v.peq_id === peqId ? 'selected' : ''}>${esc(v.name)}</option>`
             ).join('')}
           </select>
         </div>` : '';

    const sourceCtrl = sourceVariants.length > 1
      ? `<div class="iemfit-fr-ctrl-group">
           <label class="iemfit-fr-ctrl-label">Source</label>
           <select class="iemfit-radar-select" onchange="App.iemFitChangeSource('${esc(iemId)}',this.value)">
             ${sourceVariants.map(s =>
               `<option value="${esc(s.id || '')}" ${(s.id || '') === (sourceId || '') ? 'selected' : ''}>${esc(s.label || 'Source')}</option>`
             ).join('')}
           </select>
         </div>` : '';

    const genres = (_iemFitMatrixData?.matrix || [])
      .slice().sort((a, b) => b.track_count - a.track_count);
    const genreCtrl = genres.length > 0
      ? `<div class="iemfit-fr-ctrl-group">
           <label class="iemfit-fr-ctrl-label">Genre overlay</label>
           <select class="iemfit-radar-select" onchange="App.iemFitChangeGenreOverlay('${esc(iemId)}',this.value)">
             <option value="">None</option>
             ${genres.map(r =>
               `<option value="${esc(r.genre)}" ${r.genre === genreKey ? 'selected' : ''}>${esc(r.genre)}</option>`
             ).join('')}
           </select>
         </div>` : '';
    const overlayCtrl = `<div class="fr-overlay-host fr-overlay-host--compact" data-fr-overlay-host="1" data-fr-overlay-context="iemfit:${esc(iemId)}"></div>`;
    controlsEl.innerHTML = sourceCtrl + peqCtrl + overlayCtrl + genreCtrl;
    _refreshFrOverlayControls();
  }

  // Fetch FR curves from graph endpoint
  let curves = [];
  try {
    const graphParams = [];
    if (peqId) graphParams.push(`peq=${encodeURIComponent(peqId)}`);
    if (sourceId) graphParams.push(`source=${encodeURIComponent(sourceId)}`);
    const url = graphParams.length
      ? `/api/iems/${encodeURIComponent(iemId)}/graph?${graphParams.join('&')}`
      : `/api/iems/${encodeURIComponent(iemId)}/graph`;
    const r = await fetch(url);
    if (r.ok) {
      const gd = await r.json();
      if (gd.selected_source_id) _iemFitSourceState[iemId] = gd.selected_source_id;
      // Filter out baselines — keep only L, R, and PEQ overlay curves
      curves = (gd.curves || []).filter(c => c.id && !c.id.startsWith('baseline-'));
    }
  } catch (_) {}

  // Destroy stale chart
  if (_iemFitFRCharts[iemId]) {
    _iemFitFRCharts[iemId].destroy();
    delete _iemFitFRCharts[iemId];
  }

  if (!curves.length) {
    const wrap = canvas.parentElement;
    if (wrap) wrap.innerHTML = '<p class="insights-error" style="padding:1rem 0">FR data unavailable. Check this IEM\'s squig.link URL.</p>';
    return;
  }

  _iemFitFRCharts[iemId] = _buildCompactFRChart(canvas, curves, genreFingerprint, genreKey);

  // Legend — genre swatch first (if active), then IEM curves
  if (legendEl) {
    const genreSwatch = genreKey
      ? `<div class="iemfit-fr-legend-item">
           <span style="display:inline-block;width:14px;height:8px;background:rgba(240,168,48,0.45);margin-right:5px;vertical-align:middle;border-radius:2px"></span>
           <span style="color:rgba(240,168,48,0.9)">${esc(genreKey)} energy</span>
         </div>`
      : '';
    const curveLegend = curves.map(c => {
      const col = c.id.includes('-peq-') ? '#53e16f' : c.id.endsWith('-R') ? '#e05c5c' : '#5b8dee';
      return `<div class="iemfit-fr-legend-item">
        <span style="display:inline-block;width:14px;height:2px;background:${col};margin-right:5px;vertical-align:middle;border-radius:1px"></span>
        <span>${esc(c.label || c.id)}</span>
      </div>`;
    }).join('');
    legendEl.innerHTML = genreSwatch + curveLegend;
  }

  // Update genre scores + blindspot panels to match factory or PEQ-adjusted FR
  const activePeqVariant = peqId ? peqVariants.find(v => v.peq_id === peqId) : null;
  const peqScores12 = activePeqVariant ? activePeqVariant.scores : null;
  _iemFitActiveScores12[iemId] = peqScores12 || null;
  _renderIemHeatmapPanel(iemId, peqScores12);
  _renderIemBlindspotPanel(iemId, peqScores12);
}

function _renderIemHeatmapPanel(iemId, peqScores12 = null) {
  const el = document.getElementById(`iemfit-heatmap-${iemId}`);
  if (!el) return;
  if (!_iemFitMatrixData || !_iemFitMatrixData.matrix) {
    el.innerHTML = '<p class="insights-empty-note">Matrix data unavailable.</p>';
    return;
  }
  const allRows = _iemFitMatrixData.matrix;

  // Build score map — recompute from fingerprint when PEQ is active
  const scoreMap = {};
  allRows.forEach(row => {
    const factoryScore = ((row.matches || []).find(m => m.iem_id === iemId) || {}).score ?? null;
    const peqScore     = peqScores12 ? _recomputeGenreScore(row.fingerprint || {}, peqScores12) : null;
    const score        = peqScore !== null ? peqScore : factoryScore;
    const delta        = (peqScore !== null && factoryScore !== null) ? peqScore - factoryScore : null;
    if (score !== null) scoreMap[row.genre] = { score, delta, tc: row.track_count };
  });

  // Top 8 by track count
  const shown = [...allRows].sort((a, b) => b.track_count - a.track_count)
    .slice(0, 8).map(r => r.genre);
  const total = allRows.length;

  const rowsHtml = shown.map(genre => {
    const entry = scoreMap[genre];
    if (!entry) return '';
    const { score, delta, tc } = entry;
    const fillColor = score >= 75 ? 'rgba(83,225,111,0.75)' : score >= 55 ? 'rgba(240,180,41,0.75)' : 'rgba(255,179,181,0.75)';
    const deltaBadge = delta !== null
      ? `<span class="iemfit-score-delta ${delta >= 0.5 ? 'pos' : delta <= -0.5 ? 'neg' : 'neu'}">${delta >= 0 ? '+' : ''}${delta.toFixed(0)}</span>`
      : '';
    return `<div class="iemfit-heatmap-row">
      <div class="iemfit-heatmap-genre">${esc(genre)}</div>
      <div class="iemfit-heatmap-bar-wrap">
        <div class="iemfit-heatmap-bar-track">
          <div class="iemfit-heatmap-bar-fill" style="width:${score.toFixed(0)}%;background:${fillColor}"></div>
        </div>
      </div>
      <div class="iemfit-heatmap-score" style="color:${_matchScoreColor(score)}">${score.toFixed(0)}%${deltaBadge}</div>
    </div>`;
  }).join('');

  const viewAllBtn = total > 8
    ? `<button class="iemfit-bs-more-btn iemfit-panel-cta" onclick="App.showAllIemGenres('${esc(iemId)}')">${total} genres total — view all →</button>`
    : '';

  el.innerHTML = `<div class="iemfit-heatmap-grid">${rowsHtml}</div>${viewAllBtn}`;
}


function _renderIemBlindspotPanel(iemId, peqScores12 = null) {
  const el = document.getElementById(`iemfit-bs-${iemId}`);
  if (!el) return;
  if (!_iemFitMatrixData || !_iemFitMatrixData.matrix) {
    el.innerHTML = '<p class="insights-empty-note">Matrix data unavailable.</p>';
    return;
  }
  const genreScores = _iemFitMatrixData.matrix
    .map(row => {
      const factoryScore = ((row.matches || []).find(m => m.iem_id === iemId) || {}).score ?? null;
      const peqScore     = peqScores12 ? _recomputeGenreScore(row.fingerprint || {}, peqScores12) : null;
      const score        = peqScore !== null ? peqScore : factoryScore;
      const delta        = (peqScore !== null && factoryScore !== null) ? peqScore - factoryScore : null;
      return { genre: row.genre, score, delta, tc: row.track_count };
    })
    .filter(g => g.score !== null)
    .sort((a, b) => a.score - b.score);

  const shown  = genreScores.slice(0, 10);
  const total  = genreScores.length;

  const rowsHtml = shown.map(g => {
    const fillColor = g.score >= 75 ? 'rgba(83,225,111,0.75)' : g.score >= 55 ? 'rgba(240,180,41,0.75)' : 'rgba(255,179,181,0.75)';
    const deltaBadge = g.delta !== null
      ? `<span class="iemfit-score-delta ${g.delta >= 0.5 ? 'pos' : g.delta <= -0.5 ? 'neg' : 'neu'}">${g.delta >= 0 ? '+' : ''}${g.delta.toFixed(0)}</span>`
      : '';
    return `<div class="iemfit-bs-row">
      <div class="iemfit-bs-genre">${esc(g.genre)}</div>
      <div class="iemfit-bs-bar-wrap">
        <div class="iemfit-bs-bar-track">
          <div class="iemfit-bs-bar-fill" style="width:${g.score.toFixed(0)}%;background:${fillColor}"></div>
        </div>
      </div>
      <div class="iemfit-bs-score" style="color:${_matchScoreColor(g.score)}">${g.score.toFixed(0)}%${deltaBadge}</div>
    </div>`;
  }).join('');

  const moreBtn = total > 10
    ? `<button class="iemfit-bs-more-btn iemfit-panel-cta" onclick="App.showAllIemBlindspots('${esc(iemId)}')">${total} genres total — view all →</button>`
    : '';

  el.innerHTML = `<div class="iemfit-bs-list">${rowsHtml}</div>${moreBtn}`;
}

// Controls
async function iemFitChangePeq(iemId, peqId) {
  await _renderIemFRPanel(iemId, peqId || null);
}
async function iemFitChangeSource(iemId, sourceId) {
  _iemFitSourceState[iemId] = sourceId || null;
  await _renderIemFRPanel(iemId, _iemFitPeqState[iemId] || null);
}
function iemFitChangeGenre() {} // legacy stub — kept for safety
async function iemFitChangeGenreOverlay(iemId, genre) {
  _iemFitGenreState[iemId] = genre || null;
  await _renderIemFRPanel(iemId, _iemFitPeqState[iemId] || null);
}
async function iemFitAddGenreToHeatmap(iemId) {
  const sel = document.getElementById(`iemfit-add-genre-${iemId}`);
  if (!sel || !sel.value) return;
  const genre = sel.value;
  if (_iemFitExtraGenres.includes(genre) || _iemFitExtraGenres.length >= 5) return;
  _iemFitExtraGenres = [..._iemFitExtraGenres, genre];
  try {
    await fetch('/api/insights/matching/heatmap-genres', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extra_genres: _iemFitExtraGenres }),
    });
  } catch (_) {}
  _renderIemHeatmapPanel(iemId);
}
async function iemFitRemoveGenreFromHeatmap(genre, iemId) {
  _iemFitExtraGenres = _iemFitExtraGenres.filter(g => g !== genre);
  try {
    await fetch('/api/insights/matching/heatmap-genres', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extra_genres: _iemFitExtraGenres }),
    });
  } catch (_) {}
  _renderIemHeatmapPanel(iemId);
}

function _activePeqScores12(iemId) {
  // Prefer the exact score map used in the current visible panel render.
  if (_iemFitActiveScores12[iemId]) return _iemFitActiveScores12[iemId];

  const peqId = _iemFitPeqState[iemId];
  if (!peqId) return null;
  const iemData = _iemFitPeqVariants[iemId];
  if (!iemData) return null;
  const v = (iemData.peq_variants || []).find(v => v.peq_id === peqId);
  return v ? v.scores : null;
}

async function _resolveActivePeqScores12(iemId) {
  const peqId = _iemFitPeqState[iemId];
  if (!peqId) return null;

  const immediate = _activePeqScores12(iemId);
  if (immediate) return immediate;

  // Fallback: refresh 12-band variant scores from radar endpoint, then merge.
  try {
    const r = await fetch(`/api/insights/matching/iem/${encodeURIComponent(iemId)}/radar`);
    if (!r.ok) return null;
    const rd = await r.json();
    const map = {};
    (rd.peq_variants || []).forEach(v => { map[v.peq_id] = v.scores || null; });

    const iemData = _iemFitPeqVariants[iemId];
    if (iemData && Array.isArray(iemData.peq_variants)) {
      iemData.peq_variants = iemData.peq_variants.map(v => ({
        ...v,
        scores: map[v.peq_id] || v.scores || null,
      }));
    }

    const refreshed = _activePeqScores12(iemId);
    if (refreshed) _iemFitActiveScores12[iemId] = refreshed;
    return refreshed || null;
  } catch (_) {
    return null;
  }
}

async function showAllIemGenres(iemId) {
  if (!_iemFitMatrixData || !_iemFitMatrixData.matrix) return;
  const iemInfo    = _iemFitIemSummary.find(i => i.iem_id === iemId);
  const iemName    = iemInfo ? iemInfo.iem_name : iemId;
  const peqScores12 = await _resolveActivePeqScores12(iemId);

  const genreScores = _iemFitMatrixData.matrix
    .map(row => {
      const factoryScore = ((row.matches || []).find(m => m.iem_id === iemId) || {}).score ?? null;
      const peqScore = peqScores12 ? _recomputeGenreScore(row.fingerprint || {}, peqScores12) : null;
      const score = peqScore !== null ? peqScore : factoryScore;
      const delta = (peqScore !== null && factoryScore !== null) ? peqScore - factoryScore : null;
      return { genre: row.genre, score, delta };
    })
    .filter(g => g.score !== null)
    .sort((a, b) => b.score - a.score); // best → worst

  const titleEl = document.getElementById('iem-blindspot-modal-title');
  const bodyEl  = document.getElementById('iem-blindspot-modal-body');
  const modal   = document.getElementById('iem-blindspot-modal');
  if (!modal || !bodyEl) return;
  if (titleEl) titleEl.textContent = `All Genres — ${iemName}`;

  bodyEl.innerHTML = genreScores.map(g => {
    const fillColor = g.score >= 75 ? 'rgba(83,225,111,0.75)' : g.score >= 55 ? 'rgba(240,180,41,0.75)' : 'rgba(255,179,181,0.75)';
    const deltaBadge = g.delta !== null
      ? `<span class="iemfit-score-delta ${g.delta >= 0.5 ? 'pos' : g.delta <= -0.5 ? 'neg' : 'neu'}">${g.delta >= 0 ? '+' : ''}${g.delta.toFixed(0)}</span>`
      : '';
    return `<div class="iemfit-bs-row" style="margin-bottom:10px">
      <div class="iemfit-bs-genre">${esc(g.genre)}</div>
      <div class="iemfit-bs-bar-wrap">
        <div class="iemfit-bs-bar-track">
          <div class="iemfit-bs-bar-fill" style="width:${g.score.toFixed(0)}%;background:${fillColor}"></div>
        </div>
      </div>
      <div class="iemfit-bs-score" style="color:${_matchScoreColor(g.score)};min-width:42px;text-align:right">${g.score.toFixed(0)}%${deltaBadge}</div>
    </div>`;
  }).join('');

  modal.style.display = 'flex';
}

async function showAllIemBlindspots(iemId) {
  if (!_iemFitMatrixData || !_iemFitMatrixData.matrix) return;
  const iemInfo     = _iemFitIemSummary.find(i => i.iem_id === iemId);
  const iemName     = iemInfo ? iemInfo.iem_name : iemId;
  const peqScores12 = await _resolveActivePeqScores12(iemId);

  const genreScores = _iemFitMatrixData.matrix
    .map(row => {
      const factoryScore = ((row.matches || []).find(m => m.iem_id === iemId) || {}).score ?? null;
      const peqScore = peqScores12 ? _recomputeGenreScore(row.fingerprint || {}, peqScores12) : null;
      const score = peqScore !== null ? peqScore : factoryScore;
      const delta = (peqScore !== null && factoryScore !== null) ? peqScore - factoryScore : null;
      return { genre: row.genre, score, delta };
    })
    .filter(g => g.score !== null)
    .sort((a, b) => a.score - b.score);

  const titleEl = document.getElementById('iem-blindspot-modal-title');
  const bodyEl  = document.getElementById('iem-blindspot-modal-body');
  const modal   = document.getElementById('iem-blindspot-modal');
  if (!modal || !bodyEl) return;
  if (titleEl) titleEl.textContent = `All Genres — ${iemName}`;

  bodyEl.innerHTML = genreScores.map(g => {
    const fillColor = g.score >= 75 ? 'rgba(83,225,111,0.75)' : g.score >= 55 ? 'rgba(240,180,41,0.75)' : 'rgba(255,179,181,0.75)';
    const deltaBadge = g.delta !== null
      ? `<span class="iemfit-score-delta ${g.delta >= 0.5 ? 'pos' : g.delta <= -0.5 ? 'neg' : 'neu'}">${g.delta >= 0 ? '+' : ''}${g.delta.toFixed(0)}</span>`
      : '';
    return `<div class="iemfit-bs-row" style="margin-bottom:10px">
      <div class="iemfit-bs-genre">${esc(g.genre)}</div>
      <div class="iemfit-bs-bar-wrap">
        <div class="iemfit-bs-bar-track">
          <div class="iemfit-bs-bar-fill" style="width:${g.score.toFixed(0)}%;background:${fillColor}"></div>
        </div>
      </div>
      <div class="iemfit-bs-score" style="color:${_matchScoreColor(g.score)};min-width:42px;text-align:right">${g.score.toFixed(0)}%${deltaBadge}</div>
    </div>`;
  }).join('');

  modal.style.display = 'flex';
}

function closeAllBlindspots() {
  const modal = document.getElementById('iem-blindspot-modal');
  if (modal) modal.style.display = 'none';
}

// Compat stubs
function _openRadarForIem(iemId) { _toggleIemAccordion(iemId); }
function _showHeatmapDetail() {}
function changeGearFitTarget() {}
function changeGearFitSort() {}

/* ── ID3 Tag Editing ─────────────────────────────────────────────────── */

let _tagEditorTrackId   = null;
let _tagEditorOriginal  = {};
let _albumTagOriginal   = {};
let _artistRenameOriginal = '';

// ── Validation helpers ─────────────────────────────────────────────────
function _validateYear(val) {
  return !val || /^\d{4}$/.test(val.trim());
}
function _validateTrackNum(val) {
  return !val || /^\d+(\s*\/\s*\d+)?$/.test(val.trim());
}

// ── Dirty-state helpers ────────────────────────────────────────────────
function _getTagEditorValues() {
  return {
    title:        document.getElementById('te-title')?.value.trim()        ?? '',
    artist:       document.getElementById('te-artist')?.value.trim()       ?? '',
    album_artist: document.getElementById('te-album-artist')?.value.trim() ?? '',
    album:        document.getElementById('te-album')?.value.trim()        ?? '',
    track_number: document.getElementById('te-track-number')?.value.trim() ?? '',
    year:         document.getElementById('te-year')?.value.trim()         ?? '',
    genre:        document.getElementById('te-genre')?.value.trim()        ?? '',
  };
}
function _tagEditorDirty() {
  const cur = _getTagEditorValues();
  return Object.keys(cur).some(k => cur[k] !== (_tagEditorOriginal[k] ?? ''));
}
function _getAlbumTagValues() {
  return {
    title:        document.getElementById('ate-title')?.value.trim()        ?? '',
    artist:       document.getElementById('ate-artist')?.value.trim()       ?? '',
    album:        document.getElementById('ate-album')?.value.trim()        ?? '',
    album_artist: document.getElementById('ate-album-artist')?.value.trim() ?? '',
    track_number: document.getElementById('ate-track-number')?.value.trim() ?? '',
    disc_number:  document.getElementById('ate-disc-number')?.value.trim()  ?? '',
    year:         document.getElementById('ate-year')?.value.trim()         ?? '',
    genre:        document.getElementById('ate-genre')?.value.trim()        ?? '',
    composer:     document.getElementById('ate-composer')?.value.trim()     ?? '',
    comment:      document.getElementById('ate-comment')?.value.trim()      ?? '',
    compilation:  document.getElementById('ate-compilation')?.value         ?? '',
  };
}
function _albumTagDirty() {
  const cur = _getAlbumTagValues();
  return Object.keys(cur).some(k => cur[k] !== (_albumTagOriginal[k] ?? ''));
}
function _showTagError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'flex';
  const span = el.querySelector('span');
  if (span) span.textContent = msg;
  else el.textContent = msg;
}
function _hideTagError(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// ── Track Tag Editor ───────────────────────────────────────────────────
async function openTagEditor(trackId) {
  _tagEditorTrackId  = trackId;
  _tagEditorOriginal = {};

  const btn = document.getElementById('te-save-btn');
  _hideTagError('te-error');
  btn.disabled    = true;
  btn.textContent = 'Loading…';

  // Disable inputs and show modal with loading pulse
  const inputIds = ['te-title','te-artist','te-album-artist','te-album','te-track-number','te-year','te-genre'];
  inputIds.forEach(id => { const el = document.getElementById(id); if (el) { el.value = ''; el.disabled = true; } });
  document.getElementById('tag-editor-modal').style.display = 'flex';

  // Fetch accurate track data from server
  try {
    let t = null;
    const byId = await fetch(`/api/library/tracks/${encodeURIComponent(trackId)}`).catch(() => null);
    if (byId && byId.ok) t = await byId.json();
    if (!t) {
      const allTracks = await fetch(`/api/library/tracks?q=${encodeURIComponent(trackId)}`)
        .then(r => r.json()).catch(() => []);
      t = allTracks.find(x => x.id === trackId)
       || (state.tracks || []).find(x => x.id === trackId);
    }

    if (!t) {
      _showTagError('te-error', 'Track data not found. Try rescanning the library.');
      inputIds.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
      btn.disabled = false; btn.textContent = 'Save Tags';
      return;
    }

    document.getElementById('te-title').value        = t.title        || '';
    document.getElementById('te-artist').value       = t.artist       || '';
    document.getElementById('te-album-artist').value = t.album_artist || '';
    document.getElementById('te-album').value        = t.album        || '';
    document.getElementById('te-track-number').value = t.track_number || '';
    document.getElementById('te-year').value         = t.year         || '';
    document.getElementById('te-genre').value        = t.genre        || '';

    _tagEditorOriginal = _getTagEditorValues();
    inputIds.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
    btn.disabled = false; btn.textContent = 'Save Tags';
    document.getElementById('te-title').focus();
  } catch (e) {
    _showTagError('te-error', 'Failed to load track data.');
    inputIds.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
    btn.disabled = false; btn.textContent = 'Save Tags';
  }

  // Keyboard handlers (Enter = save, Escape = close)
  document.querySelectorAll('#tag-editor-modal input').forEach(inp => {
    inp.onkeydown = e => {
      if (e.key === 'Enter' && !e.shiftKey) saveTagEditor();
      if (e.key === 'Escape') closeTagEditor();
    };
  });
}

async function closeTagEditor() {
  if (_tagEditorDirty()) {
    const ok = await _showConfirm({
      title: 'Discard changes?',
      message: 'Your tag edits haven\'t been saved.',
      okText: 'Discard', danger: false,
    });
    if (!ok) return;
  }
  document.getElementById('tag-editor-modal').style.display = 'none';
  _tagEditorTrackId  = null;
  _tagEditorOriginal = {};
}

async function saveTagEditor() {
  if (!_tagEditorTrackId) return;
  const btn = document.getElementById('te-save-btn');
  _hideTagError('te-error');

  const cur = _getTagEditorValues();

  // Validation
  if (!cur.title) {
    _showTagError('te-error', 'Title is required.');
    document.getElementById('te-title').focus();
    return;
  }
  if (!_validateYear(cur.year)) {
    _showTagError('te-error', 'Year must be a 4-digit number (e.g. 2003).');
    document.getElementById('te-year').focus();
    return;
  }
  if (!_validateTrackNum(cur.track_number)) {
    _showTagError('te-error', 'Track number must be a number or "N/M" format (e.g. 3 or 3/12).');
    document.getElementById('te-track-number').focus();
    return;
  }

  // Only send fields that actually changed (empty = skip, not clear)
  const changes = {};
  Object.entries(cur).forEach(([k, v]) => {
    if (v && v !== (_tagEditorOriginal[k] ?? '')) changes[k] = v;
  });
  if (!Object.keys(changes).length) {
    // Nothing changed — silently close
    document.getElementById('tag-editor-modal').style.display = 'none';
    _tagEditorTrackId = null; _tagEditorOriginal = {};
    return;
  }

  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    await api(`/library/tracks/${_tagEditorTrackId}/tags`, { method: 'PUT', body: changes });
    toast('Tags saved');
    document.getElementById('tag-editor-modal').style.display = 'none';
    _tagEditorTrackId = null; _tagEditorOriginal = {};
    if (state.view === 'tracks') loadTracks(state.artist, state.album);
    else if (state.view === 'songs') loadSongs();
    else if (state.view === 'insights') {
      const tagRes = await fetch('/api/insights/tag-health').catch(() => null);
      if (tagRes && tagRes.ok) _renderInsightsTagHealth(await tagRes.json());
      if (_insightsMissingTagsOpen) await openMissingTagsEditor();
    } else if (state.view === 'missing-tags') {
      await openMissingTagsEditor();
    }
  } catch (e) {
    _showTagError('te-error', e.message || 'Save failed. The file may be read-only or in use.');
    btn.disabled = false; btn.textContent = 'Save Tags';
  }
}

// ── Album Tag Editor ───────────────────────────────────────────────────

function openAlbumTagEditor() {
  document.querySelectorAll('.hero-more-menu.open').forEach(m => m.classList.remove('open'));
  if (!state.album || !state.artist) { toast('Open an album first'); return; }

  const tracks = state.tracks || [];
  const count  = tracks.length;
  const first  = tracks[0] || {};

  document.getElementById('album-tag-modal-title').textContent = 'Edit Album Tags';
  document.getElementById('album-tag-warning-text').textContent =
    `This will overwrite tags on ${count} file${count !== 1 ? 's' : ''} on disk. Only filled fields are applied.`;

  document.getElementById('ate-title').value        = '';
  document.getElementById('ate-artist').value       = '';
  document.getElementById('ate-album').value        = first.album        || '';
  document.getElementById('ate-album-artist').value = first.album_artist || '';
  document.getElementById('ate-track-number').value = '';
  document.getElementById('ate-disc-number').value  = '';
  document.getElementById('ate-year').value         = first.year         || '';
  document.getElementById('ate-genre').value        = first.genre        || '';
  document.getElementById('ate-composer').value     = '';
  document.getElementById('ate-comment').value      = '';
  document.getElementById('ate-compilation').value  = '';
  _hideTagError('ate-error');
  document.getElementById('ate-save-btn').disabled    = false;
  document.getElementById('ate-save-btn').textContent = 'Save Tags';

  _albumTagOriginal = _getAlbumTagValues();

  document.querySelectorAll('#album-tag-modal input').forEach(inp => {
    inp.onkeydown = e => { if (e.key === 'Escape') closeAlbumTagEditor(); };
  });

  document.getElementById('album-tag-modal').style.display = 'flex';
  document.getElementById('ate-album').focus();
}

async function closeAlbumTagEditor() {
  if (_albumTagDirty()) {
    const ok = await _showConfirm({
      title: 'Discard changes?',
      message: 'Your album tag edits haven\'t been saved.',
      okText: 'Discard', danger: false,
    });
    if (!ok) return;
  }
  document.getElementById('album-tag-modal').style.display = 'none';
  _albumTagOriginal = {};
}

async function saveAlbumTags() {
  if (!state.artist || !state.album) return;
  const btn = document.getElementById('ate-save-btn');
  _hideTagError('ate-error');

  const cur = _getAlbumTagValues();

  // Validation
  if (!_validateYear(cur.year)) {
    _showTagError('ate-error', 'Year must be a 4-digit number (e.g. 2003).');
    document.getElementById('ate-year').focus();
    return;
  }
  if (!_validateTrackNum(cur.track_number)) {
    _showTagError('ate-error', 'Track number must be a number or "N/M" format (e.g. 3 or 3/12).');
    document.getElementById('ate-track-number').focus();
    return;
  }
  if (cur.disc_number && !/^\d+(\s*\/\s*\d+)?$/.test(cur.disc_number)) {
    _showTagError('ate-error', 'Disc number must be a number or "N/M" format (e.g. 1 or 1/2).');
    document.getElementById('ate-disc-number').focus();
    return;
  }

  // Build changes (non-empty fields only)
  const changes = {};
  if (cur.title)        changes.title        = cur.title;
  if (cur.artist)       changes.artist       = cur.artist;
  if (cur.album)        changes.album        = cur.album;
  if (cur.album_artist) changes.album_artist = cur.album_artist;
  if (cur.track_number) changes.track_number = cur.track_number;
  if (cur.disc_number)  changes.disc_number  = cur.disc_number;
  if (cur.year)         changes.year         = cur.year;
  if (cur.genre)        changes.genre        = cur.genre;
  if (cur.composer)     changes.composer     = cur.composer;
  if (cur.comment)      changes.comment      = cur.comment;
  if (cur.compilation !== '') changes.compilation = cur.compilation;

  if (!Object.keys(changes).length) {
    _showTagError('ate-error', 'Fill in at least one field to update.');
    return;
  }

  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const params = `?artist=${encodeURIComponent(state.artist)}&album=${encodeURIComponent(state.album)}`;
    const result = await api(`/library/albums/tags${params}`, { method: 'PUT', body: changes });
    const errs   = result.errors || [];
    if (errs.length) {
      // Partial success — stay open so user sees the error
      _showTagError('ate-error',
        `${errs.length} file${errs.length !== 1 ? 's' : ''} could not be updated (possibly read-only). ` +
        `${result.updated} of ${result.total} succeeded.`);
      toast(`Saved ${result.updated}/${result.total} tracks`, 4000);
      btn.disabled = false; btn.textContent = 'Save Tags';
    } else {
      toast(`Album tags saved (${result.updated} track${result.updated !== 1 ? 's' : ''})`);
      document.getElementById('album-tag-modal').style.display = 'none';
      _albumTagOriginal = {};
      loadTracks(state.artist, state.album);
    }
  } catch (e) {
    _showTagError('ate-error', e.message || 'Save failed. Files may be read-only or in use.');
    btn.disabled = false; btn.textContent = 'Save Tags';
  }
}

// ── Artist Rename ──────────────────────────────────────────────────────

function openArtistRename() {
  document.querySelectorAll('.hero-more-menu.open').forEach(m => m.classList.remove('open'));
  if (!state.artist) { toast('Open an artist first'); return; }

  const trackCount = (state.tracks || []).length ||
    (state.artists || []).find(a => a.name.toLowerCase() === state.artist.toLowerCase())?.track_count || '?';

  document.getElementById('artist-rename-warning-text').textContent =
    `This will rewrite the Artist and Album Artist tags on all ${trackCount} track${trackCount !== 1 ? 's' : ''} for "${state.artist}". This cannot be undone.`;
  document.getElementById('ar-new-name').value = state.artist;
  _hideTagError('ar-error');
  document.getElementById('ar-save-btn').disabled    = false;
  document.getElementById('ar-save-btn').textContent = 'Rename Artist';

  _artistRenameOriginal = state.artist;

  document.getElementById('ar-new-name').onkeydown = e => {
    if (e.key === 'Enter')  saveArtistRename();
    if (e.key === 'Escape') closeArtistRename();
  };

  document.getElementById('artist-rename-modal').style.display = 'flex';
  document.getElementById('ar-new-name').focus();
  document.getElementById('ar-new-name').select();
}

async function closeArtistRename() {
  const cur = document.getElementById('ar-new-name')?.value.trim() || '';
  if (cur !== _artistRenameOriginal) {
    const ok = await _showConfirm({
      title: 'Discard changes?',
      message: 'The new artist name hasn\'t been saved.',
      okText: 'Discard', danger: false,
    });
    if (!ok) return;
  }
  document.getElementById('artist-rename-modal').style.display = 'none';
  _artistRenameOriginal = '';
}

async function saveArtistRename() {
  if (!state.artist) return;
  const btn     = document.getElementById('ar-save-btn');
  const newName = document.getElementById('ar-new-name').value.trim();
  _hideTagError('ar-error');

  if (!newName) {
    _showTagError('ar-error', 'Artist name cannot be empty.');
    return;
  }
  if (newName === state.artist) {
    document.getElementById('artist-rename-modal').style.display = 'none';
    _artistRenameOriginal = '';
    return;
  }

  btn.disabled = true; btn.textContent = 'Renaming…';

  try {
    const result = await api(`/library/artists/${encodeURIComponent(state.artist)}/tags`, {
      method: 'PUT', body: { artist: newName },
    });
    const errs = result.errors || [];
    if (errs.length) {
      // Partial success — stay open
      _showTagError('ar-error',
        `${errs.length} file${errs.length !== 1 ? 's' : ''} could not be renamed. ` +
        `${result.updated} of ${result.total} succeeded.`);
      toast(`Renamed ${result.updated}/${result.total} tracks`, 4000);
      btn.disabled = false; btn.textContent = 'Rename Artist';
    } else {
      toast(`Artist renamed to "${newName}" (${result.updated} track${result.updated !== 1 ? 's' : ''})`);
      document.getElementById('artist-rename-modal').style.display = 'none';
      _artistRenameOriginal = '';
      state.artist = newName;
      loadArtists();
    }
  } catch (e) {
    _showTagError('ar-error', e.message || 'Rename failed. Files may be read-only or in use.');
    btn.disabled = false; btn.textContent = 'Rename Artist';
  }
}

/* ── Album Art Management ────────────────────────────────────────────── */

let _albumArtArtist = null;
let _albumArtAlbum  = null;
let _albumArtSelectedUrl  = null;
let _albumArtSelectedFile = null;

function openAlbumArtModal() {
  document.querySelectorAll('.hero-more-menu.open').forEach(m => m.classList.remove('open'));
  if (!state.artist || !state.album) { toast('Open an album first'); return; }

  _albumArtArtist       = state.artist;
  _albumArtAlbum        = state.album;
  _albumArtSelectedUrl  = null;
  _albumArtSelectedFile = null;

  document.getElementById('album-art-modal-subtitle').textContent =
    `${state.artist} — ${state.album}`;

  // Reset candidate grid, error, buttons, file input
  document.getElementById('aa-candidates').innerHTML =
    '<p class="artist-image-hint">Select a service and click Search to find covers.</p>';
  _hideTagError('aa-error');
  const useBtn = document.getElementById('aa-use-btn');
  useBtn.disabled    = true;
  useBtn.textContent = 'Save Art';
  document.getElementById('aa-file-name').textContent = '';
  document.getElementById('aa-file-input').value = '';

  // Pre-fill service from global preference (set when settings are loaded)
  const svcSel = document.getElementById('aa-service-select');
  if (svcSel) svcSel.value = window._artistImageServicePref || 'itunes';

  _resetAlbumArtSearchBtn();

  // Show Remove only if this album has existing artwork
  const albumObj = (state.albums || []).find(a =>
    a.name === state.album && a.artist === state.artist);
  document.getElementById('aa-remove-btn').style.display =
    albumObj?.artwork_key ? '' : 'none';

  document.getElementById('album-art-modal').style.display = 'flex';
}

function _openAlbumArtForCard(artist, album) {
  // Temporarily populate state so openAlbumArtModal works from the card
  state.artist = artist;
  state.album  = album;
  openAlbumArtModal();
}

function closeAlbumArtModal() {
  document.getElementById('album-art-modal').style.display = 'none';
}

function _resetAlbumArtSearchBtn() {
  const btn = document.getElementById('aa-search-btn');
  if (!btn) return;
  btn.disabled = false;
  btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Search`;
}

async function searchAlbumArt() {
  if (!_albumArtArtist || !_albumArtAlbum) return;
  const btn       = document.getElementById('aa-search-btn');
  const container = document.getElementById('aa-candidates');
  btn.disabled    = true;
  btn.innerHTML   = 'Searching…';
  _hideTagError('aa-error');
  container.innerHTML = '<p class="artist-image-hint">Searching…</p>';
  _albumArtSelectedUrl  = null;
  _albumArtSelectedFile = null;
  document.getElementById('aa-use-btn').disabled = true;

  const service = document.getElementById('aa-service-select')?.value || 'itunes';

  try {
    const q = [
      `artist=${encodeURIComponent(_albumArtArtist)}`,
      `album=${encodeURIComponent(_albumArtAlbum)}`,
      `service=${encodeURIComponent(service)}`,
    ].join('&');
    const data = await fetch(`/api/library/albums/artwork/search?${q}`).then(r =>
      r.ok ? r.json() : r.json().then(d => { throw new Error(d.error || 'Search failed'); }));

    const candidates = data.candidates || [];
    const svcLabel = { itunes: 'iTunes', lastfm: 'Last.fm', fanart: 'Fanart.tv' }[service] || service;
    if (!candidates.length) {
      container.innerHTML = `<p class="artist-image-hint">No results found on ${svcLabel}. Try a different service or upload your own image.</p>`;
      _resetAlbumArtSearchBtn();
      return;
    }

    container.innerHTML = '';
    candidates.forEach(c => {
      const img = document.createElement('img');
      img.src       = c.thumbnail_url || c.url;
      img.className = 'artist-img-candidate';
      img.title     = c.label || '';
      img.loading   = 'lazy';
      img.onerror   = () => { img.style.opacity = '0.25'; img.style.pointerEvents = 'none'; };
      img.onclick   = () => {
        container.querySelectorAll('.artist-img-candidate').forEach(x => x.classList.remove('selected'));
        img.classList.add('selected');
        _albumArtSelectedUrl  = c.url;
        _albumArtSelectedFile = null;
        document.getElementById('aa-file-name').textContent = '';
        document.getElementById('aa-use-btn').disabled = false;
      };
      container.appendChild(img);
    });
  } catch (e) {
    _showTagError('aa-error', e.message || 'Search failed.');
    container.innerHTML = '';
  }

  _resetAlbumArtSearchBtn();
}

function onAlbumArtServiceChange(value) {
  // Reset the candidate grid when the service changes so stale results are cleared
  const container = document.getElementById('aa-candidates');
  if (container) {
    container.innerHTML = '<p class="artist-image-hint">Select a service and click Search to find covers.</p>';
  }
  _albumArtSelectedUrl  = null;
  _albumArtSelectedFile = null;
  document.getElementById('aa-file-name').textContent = '';
  const useBtn = document.getElementById('aa-use-btn');
  if (useBtn) useBtn.disabled = true;
  _hideTagError('aa-error');
}

function onAlbumArtFileSelected(input) {
  const file = input.files[0];
  if (!file) return;
  _albumArtSelectedFile = file;
  _albumArtSelectedUrl  = null;
  document.getElementById('aa-file-name').textContent = file.name;
  document.getElementById('aa-use-btn').disabled = false;
  document.querySelectorAll('#aa-candidates .artist-img-candidate').forEach(x => x.classList.remove('selected'));
  _hideTagError('aa-error');
}

async function saveAlbumArt() {
  if (!_albumArtArtist || !_albumArtAlbum) return;
  const btn = document.getElementById('aa-use-btn');
  btn.disabled    = true;
  btn.textContent = 'Saving…';
  _hideTagError('aa-error');

  const q = `artist=${encodeURIComponent(_albumArtArtist)}&album=${encodeURIComponent(_albumArtAlbum)}`;
  try {
    let res;
    if (_albumArtSelectedFile) {
      const fd = new FormData();
      fd.append('file', _albumArtSelectedFile);
      res = await fetch(`/api/library/albums/artwork?${q}`, { method: 'POST', body: fd })
        .then(r => r.ok ? r.json() : r.json().then(d => { throw new Error(d.error || 'Upload failed'); }));
    } else if (_albumArtSelectedUrl) {
      res = await fetch(`/api/library/albums/artwork?${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_url: _albumArtSelectedUrl }),
      }).then(r => r.ok ? r.json() : r.json().then(d => { throw new Error(d.error || 'Save failed'); }));
    } else {
      throw new Error('No image selected');
    }

    toast(`Album art saved (${res.size_kb} KB)`);
    closeAlbumArtModal();
    // Reload albums + current track view to show new art
    await loadAlbums(state.artist);
    if (state.view === 'tracks') loadTracks(state.artist, state.album);
    // Refresh hero art immediately without waiting for full reload
    const newKey = res.artwork_key;
    const heroArt = document.getElementById('album-hero-art');
    if (heroArt && newKey) {
      heroArt.innerHTML = `<img src="/api/artwork/${newKey}?t=${Date.now()}" alt="${esc(_albumArtAlbum)}" />`;
    }
  } catch (e) {
    _showTagError('aa-error', e.message || 'Save failed. Check the image is accessible.');
    btn.disabled    = false;
    btn.textContent = 'Save Art';
  }
}

async function removeAlbumArt() {
  if (!_albumArtArtist || !_albumArtAlbum) return;
  const confirmed = await _showConfirm({
    title: 'Remove Album Art',
    message: `Remove the artwork for "${_albumArtAlbum}"? The album will show a placeholder until art is re-extracted or uploaded.`,
    okText: 'Remove', danger: true,
  });
  if (!confirmed) return;

  const q = `artist=${encodeURIComponent(_albumArtArtist)}&album=${encodeURIComponent(_albumArtAlbum)}`;
  try {
    await fetch(`/api/library/albums/artwork?${q}`, { method: 'DELETE' });
    toast('Album art removed');
    closeAlbumArtModal();
    await loadAlbums(state.artist);
    if (state.view === 'tracks') loadTracks(state.artist, state.album);
    const heroArt = document.getElementById('album-hero-art');
    if (heroArt) heroArt.innerHTML = coverPlaceholder('album', 64, 'var(--radius)', true);
  } catch (e) {
    toast('Error removing art: ' + e.message);
  }
}

/* ── Artist Image Management ─────────────────────────────────────────── */

let _artistImageKey = null;
let _artistImageName = null;
let _selectedImageUrl = null;
let _selectedImageSource = null;
let _selectedImageFile = null;

function openArtistImageModal() {
  document.querySelectorAll('.hero-more-menu.open').forEach(m => m.classList.remove('open'));
  if (!state.artist) { toast('Open an artist first'); return; }

  _artistImageKey      = _artistKey(state.artist);
  _artistImageName     = state.artist;
  _selectedImageUrl    = null;
  _selectedImageSource = null;
  _selectedImageFile   = null;

  // Header subtitle shows the artist name
  document.getElementById('artist-image-modal-subtitle').textContent = state.artist;

  // Reset candidate grid
  document.getElementById('ai-candidates').innerHTML =
    '<p class="artist-image-hint">Select a service and click Search to find photos.</p>';

  // Reset error, save button, file input
  _hideTagError('ai-error');
  const useBtn = document.getElementById('ai-use-btn');
  useBtn.disabled    = true;
  useBtn.textContent = 'Save Photo';
  document.getElementById('ai-file-name').textContent = '';
  document.getElementById('ai-file-input').value = '';

  // Reset search button state
  const searchBtn = document.getElementById('ai-search-btn');
  searchBtn.disabled = false;
  searchBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Search`;

  // Pre-select preferred service
  const svc = document.getElementById('ai-service-select');
  if (svc) svc.value = window._artistImageServicePref || 'itunes';

  // Show Remove Photo only if this artist already has an image
  const artistObj = (state.artists || []).find(a => a.name === state.artist);
  const removeBtn = document.getElementById('ai-remove-btn');
  if (removeBtn) removeBtn.style.display = artistObj?.image_key ? '' : 'none';

  document.getElementById('artist-image-modal').style.display = 'flex';
}

function closeArtistImageModal() {
  document.getElementById('artist-image-modal').style.display = 'none';
}

function _artistKey(name) {
  const a = (state.artists || []).find(x => x.name === name);
  return a?.image_key || null;
}

async function searchArtistImages() {
  if (!_artistImageName) return;
  const btn = document.getElementById('ai-search-btn');
  const service = document.getElementById('ai-service-select').value;
  const container = document.getElementById('ai-candidates');
  const errEl = document.getElementById('ai-error');

  btn.disabled = true;
  btn.innerHTML = 'Searching…';
  _hideTagError('ai-error');
  container.innerHTML = '<p class="artist-image-hint">Searching…</p>';
  _selectedImageUrl = null;
  _selectedImageSource = null;
  document.getElementById('ai-use-btn').disabled = true;

  const _resetSearchBtn = () => {
    btn.disabled = false;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Search`;
  };

  try {
    const q = encodeURIComponent(_artistImageName);
    const url = `/api/artists/by-name/image/search?q=${q}&service=${service}`;
    const data = await fetch(url).then(r => {
      if (!r.ok) return r.json().then(d => { throw new Error(d.error || 'Search failed'); });
      return r.json();
    });

    const candidates = data.candidates || [];
    if (!candidates.length) {
      container.innerHTML = '<p class="artist-image-hint">No results found. Try a different service or check your API key in Settings.</p>';
      _resetSearchBtn();
      return;
    }

    container.innerHTML = '';
    candidates.forEach((c) => {
      const img = document.createElement('img');
      img.src = c.thumbnail_url || c.url;
      img.className = 'artist-img-candidate';
      img.title = c.label || '';
      img.loading = 'lazy';
      img.onerror = () => { img.style.opacity = '0.25'; img.style.pointerEvents = 'none'; };
      img.onclick = () => {
        container.querySelectorAll('.artist-img-candidate').forEach(x => x.classList.remove('selected'));
        img.classList.add('selected');
        _selectedImageUrl    = c.url;
        _selectedImageSource = c.source;
        _selectedImageFile   = null;
        document.getElementById('ai-file-name').textContent = '';
        document.getElementById('ai-use-btn').disabled = false;
      };
      container.appendChild(img);
    });
  } catch (e) {
    _showTagError('ai-error', e.message || 'Search failed. Check your API key in Settings.');
    container.innerHTML = '';
  }

  _resetSearchBtn();
}


function onArtistImageFileSelected(input) {
  const file = input.files[0];
  if (!file) return;
  _selectedImageFile   = file;
  _selectedImageUrl    = null;
  _selectedImageSource = 'upload';
  document.getElementById('ai-file-name').textContent = file.name;
  document.getElementById('ai-use-btn').disabled = false;
  // Deselect any grid candidate
  document.querySelectorAll('.artist-img-candidate').forEach(x => x.classList.remove('selected'));
  _hideTagError('ai-error');
}

async function saveArtistImage() {
  if (!_artistImageName) return;
  const btn = document.getElementById('ai-use-btn');
  btn.disabled    = true;
  btn.textContent = 'Saving…';
  _hideTagError('ai-error');

  try {
    let res;
    if (_selectedImageFile) {
      const formData = new FormData();
      formData.append('file', _selectedImageFile);
      formData.append('artist_name', _artistImageName);
      res = await fetch('/api/artists/by-name/image', { method: 'POST', body: formData })
        .then(r => r.ok ? r.json() : r.json().then(d => { throw new Error(d.error || 'Upload failed'); }));
    } else if (_selectedImageUrl) {
      res = await fetch('/api/artists/by-name/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_url: _selectedImageUrl, artist_name: _artistImageName, source: _selectedImageSource }),
      }).then(r => r.ok ? r.json() : r.json().then(d => { throw new Error(d.error || 'Save failed'); }));
    } else {
      throw new Error('No image selected');
    }

    toast(`Photo saved for ${_artistImageName} (${res.size_kb} KB)`);
    closeArtistImageModal();
    await loadArtists();
    if (state.view === 'albums' || state.view === 'tracks') _refreshArtistHeroImage();
  } catch (e) {
    _showTagError('ai-error', e.message || 'Save failed. Check the image URL is accessible.');
    btn.disabled    = false;
    btn.textContent = 'Save Photo';
  }
}

async function removeArtistImage() {
  if (!_artistImageKey) { toast('No image to remove'); return; }
  const confirmed = await _showConfirm({
    title: 'Remove Artist Image',
    message: `Remove the portrait for "${_artistImageName}"? The artist cards will revert to album art.`,
    okText: 'Remove',
    danger: true,
  });
  if (!confirmed) return;

  try {
    await fetch(`/api/artists/${_artistImageKey}/image`, { method: 'DELETE' });
    toast('Artist image removed');
    closeArtistImageModal();
    await loadArtists();
    _refreshArtistHeroImage();
  } catch (e) {
    toast('Error removing image: ' + e.message);
  }
}

function _refreshArtistHeroImage() {
  const artist = (state.artists || []).find(a => a.name === state.artist);
  const heroArt = document.getElementById('artist-hero-art');
  if (!heroArt) return;
  if (artist?.image_key) {
    heroArt.innerHTML = `<img src="/api/artists/${artist.image_key}/image?t=${Date.now()}" alt="${esc(artist.name)}" />`;
  }
}

// ── Artist Image Settings ────────────────────────────────────────────────────

function onArtistImageServiceChange(value) {
  const lastfmRow = document.getElementById('lastfm-key-row');
  const fanartRow = document.getElementById('fanart-key-row');
  if (lastfmRow) lastfmRow.style.display = value === 'lastfm' ? '' : 'none';
  if (fanartRow) fanartRow.style.display = value === 'fanart' ? '' : 'none';
}

/* ── Artist Image Batch Fetch ────────────────────────────────────────── */

let _artistBatchPoller = null;

async function startArtistImageBatch() {
  const service = document.getElementById('artist-image-service-select')?.value || 'itunes';
  try {
    const res = await fetch('/api/artists/images/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || 'Could not start batch job', 'error');
      return;
    }
    _updateArtistBatchBanner({ status: 'running', done: 0, total: 0, fetched: 0, skipped: 0, failed: 0 });
    _startArtistBatchPolling();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function cancelArtistImageBatch() {
  await fetch('/api/artists/images/batch/cancel', { method: 'POST' }).catch(() => {});
  _updateArtistBatchBanner({ status: 'cancelled', done: 0, total: 0, fetched: 0, skipped: 0, failed: 0 });
  _stopArtistBatchPolling();
}

function _startArtistBatchPolling() {
  if (_artistBatchPoller) return;
  _artistBatchPoller = setInterval(_pollArtistBatchStatus, 1200);
}

function _stopArtistBatchPolling() {
  if (_artistBatchPoller) { clearInterval(_artistBatchPoller); _artistBatchPoller = null; }
}

async function _pollArtistBatchStatus() {
  try {
    const s = await fetch('/api/artists/images/batch/status').then(r => r.json());
    _updateArtistBatchBanner(s);
    if (s.status !== 'running') _stopArtistBatchPolling();
  } catch (e) {
    // network blip — keep polling
  }
}

function _updateArtistBatchBanner(s) {
  const banner    = document.getElementById('batch-img-banner');
  const bar       = document.getElementById('batch-img-bar');
  const msg       = document.getElementById('batch-img-msg');
  const startBtn  = document.getElementById('batch-img-start-btn');
  const cancelBtn = document.getElementById('batch-img-cancel-btn');
  if (!banner) return;

  const running = s.status === 'running';
  banner.style.display   = (s.status === 'idle') ? 'none' : '';
  if (startBtn)  startBtn.disabled    = running;
  if (cancelBtn) cancelBtn.style.display = running ? '' : 'none';

  if (s.status === 'running') {
    const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
    if (bar) bar.style.width = pct + '%';
    if (msg) msg.textContent = `Searching… ${s.done.toLocaleString()} / ${s.total.toLocaleString()} artists — ${s.fetched} found, ${s.skipped} skipped`;
  } else if (s.status === 'done') {
    if (bar) bar.style.width = '100%';
    if (msg) {
      const errNote = s.failed > 0 ? `, ${s.failed} not found` : '';
      msg.textContent = `Done — ${s.fetched} new photos${errNote}, ${s.skipped} already had photos`;
    }
    if (startBtn) startBtn.disabled = false;
  } else if (s.status === 'cancelled') {
    if (bar) bar.style.width = '0%';
    if (msg) msg.textContent = `Cancelled after ${s.done.toLocaleString()} artists — ${s.fetched} photos saved`;
    if (startBtn) startBtn.disabled = false;
  } else if (s.status === 'error') {
    if (msg) msg.textContent = 'Batch job encountered an error.';
    if (startBtn) startBtn.disabled = false;
  }
}

async function saveArtistImageSettings() {
  const service = document.getElementById('artist-image-service-select')?.value || 'itunes';
  const lastfmKey = (document.getElementById('lastfm-api-key-input')?.value || '').trim();
  const fanartKey = (document.getElementById('fanart-api-key-input')?.value || '').trim();
  try {
    await api('/settings', {
      method: 'PUT',
      body: {
        artist_image_service: service,
        lastfm_api_key: lastfmKey,
        fanart_api_key: fanartKey,
      },
    });
    window._artistImageServicePref = service;
    toast('Artist image settings saved');
  } catch (e) {
    toast('Error saving settings: ' + e.message);
  }
}

/* ── Init ───────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  _initFrOverlaySelection();
  window.addEventListener('beforeunload', (e) => {
    if (!_hasUnsavedMlPreview()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('add-dropdown');
    if (dd && !dd.contains(e.target)) hideDropdown();
    if (!e.target.closest('#pl-dap-export-dd')) closePlaylistDapMenu();

    // Close hero ··· menus
    if (!e.target.closest('.hero-more-wrap')) {
      document.querySelectorAll('.hero-more-menu.open').forEach(m => m.classList.remove('open'));
    }
    // Close playlist toolbar ··· menu
    if (!e.target.closest('.pl-more-wrap')) {
      const plMenu = document.getElementById('pl-more-menu');
      if (plMenu) plMenu.style.display = 'none';
    }

    // Close any open mapping results dropdowns
    if (!e.target.closest('.map-row-target')) {
      document.querySelectorAll('.map-results').forEach(el => el.style.display = 'none');
    }
    if (!e.target.closest('.fr-ov-shell')) {
      _closeFrOverlayMenu();
    }

  });

  // Keyboard shortcut: Escape closes dropdown and context menu
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideDropdown(); hideCtxMenu(); closePlaylistDapMenu(); _closeFrOverlayMenu(); }
  });

  // Close context menu on outside click or scroll
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctx-menu') && !e.target.closest('#ctx-submenu')) hideCtxMenu();
  });
  document.addEventListener('scroll', (e) => {
    // Ignore scrolls inside the submenu — those are intentional
    if (e.target && (e.target.id === 'ctx-submenu' || e.target.closest?.('#ctx-submenu'))) return;
    hideCtxMenu();
  }, true);

  Player.init();
  _updateNavButtonStates();
  window.addEventListener('tb-track-change', () => {
    refreshPlayerFavouriteButton();
    if (state.view === 'home') {
      clearTimeout(_homeTrackRefreshTimer);
      _homeTrackRefreshTimer = setTimeout(() => {
        _homeBackgroundRefresh();
      }, 1200);
    }
  });

  window.addEventListener('resize', () => {
    if (state.view !== 'home') return;
    window.requestAnimationFrame(_homeRefreshRailAffordances);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.view === 'home') _homeBackgroundRefresh();
  });
  await loadGearProfiles();
  // Enter submits create playlist modal
  const cpInput = document.getElementById('create-playlist-input');
  if (cpInput) cpInput.addEventListener('keydown', e => { if (e.key === 'Enter') App.submitCreatePlaylist(); });
  const settings = await loadSettings();
  await loadFavourites();
  await loadPlaylists();
  pollScanStatus();
  showView('home');
  refreshPlayerFavouriteButton();

  // Show first-run onboarding only when settings file does not exist yet.
  if (!settings._settings_exists && !settings.onboarding_completed) {
    _showOnboarding(settings);
  }
});

// Expose scrollToLetter globally for inline onclick in alpha bar
window.scrollToLetter = scrollToLetter;
