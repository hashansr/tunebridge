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
  devices: { poweramp: false, ap80: false },
  scanStatus: null,
  activeTrackId: null,     // for add-to dropdown
  sortable: null,
  lastUsedPlaylistId: null, // most recently added-to playlist
  _pendingTrackIds: [],     // track IDs queued for a picker selection
  selectedTrackIds: new Set(),
  lastSelectedIdx: null,
  playlistSortMode: localStorage.getItem('sidebarSort') || 'created',
  plSortMode: 'original',
  plFilter: '',
};

/* ── API helpers ────────────────────────────────────────────────────── */
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

/* ── Toast ──────────────────────────────────────────────────────────── */
let toastTimer;
function toast(msg, duration = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

/* ── Artwork ────────────────────────────────────────────────────────── */
function artworkUrl(key) {
  return key ? `/api/artwork/${key}` : null;
}

function thumbImg(key, size = 38, rounded = '4px') {
  const url = artworkUrl(key);
  if (url) {
    return `<img src="${url}" width="${size}" height="${size}" style="border-radius:${rounded};object-fit:cover" loading="lazy" onerror="this.style.display='none'" />`;
  }
  return musicNote(size);
}

function musicNote(size = 38) {
  const s = Math.round(size * 0.45);
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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

/* ── Sidebar playlists ──────────────────────────────────────────────── */
async function loadPlaylists() {
  const playlists = await api('/playlists');
  state.playlists = playlists;
  renderSidebarPlaylists();
}

function renderSidebarPlaylists() {
  const el = document.getElementById('playlists-list');
  const sorted = [...state.playlists].sort((a, b) => {
    if (state.playlistSortMode === 'alpha') return a.name.localeCompare(b.name);
    if (state.playlistSortMode === 'updated') return (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0);
    return (b.created_at || 0) - (a.created_at || 0); // 'created' default
  });
  el.innerHTML = sorted.map(pl => `
    <div class="playlist-nav-item${state.playlist?.id === pl.id ? ' active' : ''}"
         onclick="App.openPlaylist('${pl.id}')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pl.name)}</span>
      <button class="pl-del" onclick="event.stopPropagation();App.deletePlaylist('${pl.id}')" title="Delete playlist">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');
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
  document.getElementById('sidebar-sort-dd').style.display = 'none';
  ['alpha','created','updated'].forEach(m => {
    const el = document.getElementById(`sidebar-sort-check-${m}`);
    if (el) el.style.opacity = (m === mode) ? '1' : '0';
  });
  renderSidebarPlaylists();
}

/* ── Artists view ───────────────────────────────────────────────────── */
async function loadArtists() {
  const artists = await api('/library/artists');
  state.artists = artists;

  const grid = document.getElementById('artists-grid');
  const alphaBar = document.getElementById('alpha-bar');
  document.getElementById('artists-count').textContent = `${artists.length} artists`;

  // Build A-Z bar
  const LETTERS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const presentLetters = new Set(artists.map(a => {
    const first = a.name.replace(/^(The |A |An )/i, '').charAt(0).toUpperCase();
    return /[A-Z]/.test(first) ? first : '#';
  }));

  alphaBar.innerHTML = LETTERS.map(l => `
    <button class="alpha-btn" ${presentLetters.has(l) ? `onclick="scrollToLetter('${l}')"` : 'disabled'}
      title="${l === '#' ? 'Numbers / symbols' : l}">${l}</button>
  `).join('');

  // Render cards, injecting letter anchors on first card of each letter group
  let lastLetter = null;
  grid.innerHTML = artists.map(a => {
    const sortName = a.name.replace(/^(The |A |An )/i, '');
    const letter = /[A-Z]/i.test(sortName.charAt(0)) ? sortName.charAt(0).toUpperCase() : '#';
    let anchor = '';
    if (letter !== lastLetter) {
      anchor = `id="alpha-${letter}"`;
      lastLetter = letter;
    }
    return `
      <div class="artist-card" ${anchor} data-artist="${esc(a.name)}" onclick="App.showArtist(this.dataset.artist)">
        <div class="artist-thumb">
          ${thumbImg(a.artwork_key, 120, '6px')}
        </div>
        <div class="artist-name" title="${esc(a.name)}">${esc(a.name)}</div>
        <div class="artist-meta">${a.album_count} album${a.album_count !== 1 ? 's' : ''} · ${a.track_count} songs</div>
        <div class="artist-card-overlay">
          <button class="card-add-btn" data-artist="${esc(a.name)}" onclick="event.stopPropagation();App.addAllArtistSongs(this.dataset.artist,event)" title="Add all songs to playlist">+</button>
        </div>
      </div>
    `;
  }).join('');
}

function scrollToLetter(letter) {
  const el = document.getElementById(`alpha-${letter}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Briefly highlight active letter
  document.querySelectorAll('.alpha-btn').forEach(b => b.classList.remove('active'));
  const btn = [...document.querySelectorAll('.alpha-btn')].find(b => b.textContent === letter);
  if (btn) { btn.classList.add('active'); setTimeout(() => btn.classList.remove('active'), 800); }
}

/* ── Albums view ────────────────────────────────────────────────────── */
async function loadAlbums(artistFilter = null) {
  const query = artistFilter ? `?artist=${encodeURIComponent(artistFilter)}` : '';
  const albums = await api('/library/albums' + query);
  state.albums = albums;

  const grid = document.getElementById('albums-grid');
  const countEl = document.getElementById('albums-count');
  const crumb = document.getElementById('albums-breadcrumb');
  const hero = document.getElementById('artist-hero');

  countEl.textContent = `${albums.length} album${albums.length !== 1 ? 's' : ''}`;

  if (artistFilter) {
    crumb.innerHTML = `
      <span class="crumb" onclick="App.showView('artists')">Artists</span>
      <span class="crumb-sep">›</span>
      <span class="crumb-current">${esc(artistFilter)}</span>
    `;
    // Populate artist hero
    const artistData = state.artists?.find(a => a.name === artistFilter);
    const artKey = albums[0]?.artwork_key || artistData?.artwork_key || '';
    document.getElementById('artist-hero-art').innerHTML =
      artKey ? `<img src="${artworkUrl(artKey)}" />` : musicNote(52);
    document.getElementById('artist-hero-name').textContent = artistFilter;
    const totalSongs = albums.reduce((s, al) => s + (al.track_count || 0), 0);
    document.getElementById('artist-hero-meta').textContent =
      `${albums.length} album${albums.length !== 1 ? 's' : ''} · ${totalSongs} songs`;
    document.getElementById('artist-hero-add').onclick = () => App.addAllArtistSongs(artistFilter);
    document.getElementById('artist-hero-browse').onclick = () => App.showArtistTracks(artistFilter);
    hero.style.display = 'flex';
  } else {
    crumb.innerHTML = `<span class="crumb-current" style="font-size:22px;font-weight:700">Albums</span>`;
    hero.style.display = 'none';
  }

  grid.innerHTML = albums.map(al => `
    <div class="album-card" data-artist="${esc(al.artist)}" data-album="${esc(al.name)}" onclick="App.showAlbum(this.dataset.artist, this.dataset.album)">
      <div class="album-thumb">
        ${thumbImg(al.artwork_key, 160, '6px')}
        <div class="album-thumb-overlay">
          <button class="card-add-btn" data-artist="${esc(al.artist)}" data-album="${esc(al.name)}" onclick="event.stopPropagation();App.addAlbumToPlaylist(this.dataset.artist,this.dataset.album,event)" title="Add album to playlist">+</button>
        </div>
      </div>
      <div class="album-name" title="${esc(al.name)}">${esc(al.name)}</div>
      ${!artistFilter ? `<div class="album-artist">${esc(al.artist)}</div>` : ''}
      ${al.year ? `<div class="album-year">${esc(al.year)}</div>` : ''}
    </div>
  `).join('');
}

/* ── Tracks view ────────────────────────────────────────────────────── */
async function loadTracks(artist = null, album = null) {
  let q = [];
  if (artist) q.push(`artist=${encodeURIComponent(artist)}`);
  if (album) q.push(`album=${encodeURIComponent(album)}`);
  const tracks = await api('/library/tracks?' + q.join('&'));
  state.tracks = tracks;

  const crumb = document.getElementById('tracks-breadcrumb');
  const crumbParts = [`<span class="crumb" onclick="App.showView('artists')">Artists</span>`];
  if (artist) crumbParts.push(`<span class="crumb" data-artist="${esc(artist)}" onclick="App.showArtist(this.dataset.artist)">${esc(artist)}</span>`);
  if (album) crumbParts.push(`<span class="crumb-current">${esc(album)}</span>`);
  else if (artist) crumbParts.push(`<span class="crumb-current">All Songs</span>`);
  crumb.innerHTML = crumbParts.join('<span class="crumb-sep">›</span>');

  // Album / artist hero
  const albumHero = document.getElementById('album-hero');
  const heroLabel = albumHero.querySelector('.hero-label');
  if (album && tracks.length) {
    const artKey = tracks[0].artwork_key || '';
    document.getElementById('album-hero-art').innerHTML =
      artKey ? `<img src="${artworkUrl(artKey)}" />` : musicNote(56);
    document.getElementById('album-hero-name').textContent = album;
    document.getElementById('album-hero-artist').innerHTML = artist
      ? `<span class="link" data-artist="${esc(artist)}" onclick="App.showArtist(this.dataset.artist)">${esc(artist)}</span>` : '';
    const totalSecs = tracks.reduce((s, t) => s + (t.duration || 0), 0);
    const yr = tracks[0].year;
    const meta = [
      yr ? String(yr) : null,
      `${tracks.length} songs`,
      totalSecs ? fmtDuration(totalSecs) : null,
    ].filter(Boolean).join(' · ');
    document.getElementById('album-hero-meta').textContent = meta;
    heroLabel.textContent = 'Album';
    albumHero.style.display = 'flex';
  } else if (!album && artist && tracks.length) {
    const artKey = tracks[0].artwork_key || '';
    document.getElementById('album-hero-art').innerHTML =
      artKey ? `<img src="${artworkUrl(artKey)}" />` : musicNote(56);
    document.getElementById('album-hero-name').textContent = 'All Songs';
    document.getElementById('album-hero-artist').innerHTML =
      `<span class="link" data-artist="${esc(artist)}" onclick="App.showArtist(this.dataset.artist)">${esc(artist)}</span>`;
    const totalSecs = tracks.reduce((s, t) => s + (t.duration || 0), 0);
    document.getElementById('album-hero-meta').textContent =
      `${tracks.length} songs${totalSecs ? ' · ' + fmtDuration(totalSecs) : ''}`;
    heroLabel.textContent = 'Artist';
    albumHero.style.display = 'flex';
  } else {
    albumHero.style.display = 'none';
  }

  const tbody = document.getElementById('tracks-tbody');
  tbody.innerHTML = tracks.map((t, i) => trackRow(t, i + 1, false)).join('');

  document.getElementById('add-all-btn').onclick = () => App.addAllToPlaylist(tracks.map(t => t.id));
}

function fmtDuration(totalSecs) {
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min`;
  return `${m} min`;
}

/* ── Track row (library) ────────────────────────────────────────────── */
function trackRow(t, num, inPlaylist) {
  const add = inPlaylist
    ? `<button class="remove-btn" onclick="App.removeFromPlaylist('${t.id}')" title="Remove">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
       </button>`
    : `<button class="add-btn" onclick="App.showAddDropdown(event, '${t.id}')" title="Add to playlist">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
       </button>`;

  const dragHandle = inPlaylist
    ? `<div class="drag-handle" title="Drag to reorder" onclick="event.stopPropagation()">
         <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg>
       </div>`
    : '';

  const checkIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><polyline points="20 6 9 17 4 12"/></svg>`;

  return `
    <tr data-id="${t.id}">
      <td class="col-num" onclick="App.toggleTrackSelection('${t.id}', ${num - 1}, event)">
        <div class="num-cell">
          ${dragHandle}
          <span class="track-num">${num}</span>
          <span class="track-check-indicator">${checkIcon}</span>
        </div>
      </td>
      <td>
        <div class="title-cell">
          <div class="thumb">${thumbImg(t.artwork_key, 38, '4px')}</div>
          <div class="track-info">
            <div class="track-title" title="${esc(t.title)}">${esc(t.title)}</div>
            <div class="track-artist" title="${esc(t.artist)}">${esc(t.artist)}</div>
          </div>
        </div>
      </td>
      ${inPlaylist ? `<td class="cell-artist" title="${esc(t.artist)}">${esc(t.artist)}</td>` : ''}
      <td class="cell-album" title="${esc(t.album)}">${esc(t.album)}</td>
      <td class="col-dur">${esc(t.duration_fmt || '')}</td>
      <td><div class="col-act-inner">${add}</div></td>
    </tr>`;
}

/* ── Playlist view ──────────────────────────────────────────────────── */
async function openPlaylist(pid) {
  const pl = await api(`/playlists/${pid}`);
  state.playlist = pl;
  state.view = 'playlist';
  clearSelection();
  setActiveNav(null);
  renderSidebarPlaylists();
  showViewEl('playlist');

  document.getElementById('pl-name').textContent = pl.name;

  renderPlaylistTracks(pl.tracks);
  updatePlaylistCover(pl.tracks);
  updatePlaylistStats(pl.tracks);
  renderDapExportPills(pid);
}

async function renderDapExportPills(pid) {
  const container = document.getElementById('dap-export-pills');
  if (!container) return;

  const daps = await api('/daps').catch(() => []);
  if (!daps.length) {
    container.innerHTML = `<span style="color:var(--text-muted);font-size:var(--text-xs)">No DAPs configured — add one in Gear → DAPs</span>`;
    return;
  }

  const svgDown = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  const svgDevice = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18" stroke-width="3"/></svg>`;

  container.innerHTML = daps.map(dap => {
    const deviceBtn = dap.mounted
      ? `<button class="btn-export btn-export-device"
           onclick="App.exportToDeviceDap('${dap.id}')"
           title="Copy directly to ${esc(dap.name)}">
           ${svgDevice} → ${esc(dap.name)}
         </button>`
      : '';
    return `
      <div class="export-group">
        <button class="btn-export" onclick="App.exportPlaylistDap('${dap.id}')">
          ${svgDown}${esc(dap.name)} (M3U)
        </button>
        ${deviceBtn}
      </div>`;
  }).join('');
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
  } else if (state.plSortMode === 'date') {
    tracks = [...tracks].sort((a, b) => (b.year || 0) - (a.year || 0));
  }
  return tracks;
}

function renderPlaylistTracks(tracks) {
  const tbody = document.getElementById('pl-tbody');
  const table = document.getElementById('pl-table');
  const empty = document.getElementById('pl-empty');

  const displayed = _getDisplayedTracks();
  const isFiltered = state.plFilter.trim().length > 0;
  const isSorted = state.plSortMode !== 'original';
  const isDragEnabled = !isFiltered && !isSorted;

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

function filterPlaylist(query) {
  state.plFilter = query;
  const clearBtn = document.getElementById('pl-filter-clear');
  if (clearBtn) clearBtn.style.display = query ? 'block' : 'none';
  renderPlaylistTracks(state.playlist?.tracks || []);
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
  state.plSortMode = mode;
  // Update pill active state
  document.querySelectorAll('.pl-sort-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sort === mode);
  });
  renderPlaylistTracks(state.playlist?.tracks || []);
}

/* ── Multi-select ───────────────────────────────────────────────────── */
function _getCurrentViewTrackList() {
  if (state.view === 'tracks') return state.tracks;
  if (state.view === 'playlist') return _getDisplayedTracks();
  return [];
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

  countEl.textContent = `${count} song${count !== 1 ? 's' : ''} selected`;
  bar.classList.toggle('visible', count > 0);
  if (removeBtn) removeBtn.style.display = state.view === 'playlist' && count > 0 ? 'inline-flex' : 'none';

  // Wire add button each time (event could differ)
  if (addBtn) {
    addBtn.onclick = (e) => {
      e.stopPropagation();
      showPlaylistPicker(e.currentTarget, [...state.selectedTrackIds]);
    };
  }

  // Update row visual states across all track tables
  ['tracks-tbody', 'search-tbody', 'pl-tbody'].forEach(tbodyId => {
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
  if (state.view !== 'playlist' || !state.playlist) return;
  const ids = new Set(state.selectedTrackIds);
  const count = ids.size;
  const remaining = state.playlist.tracks
    .filter(t => !ids.has(t.id))
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
  toast(`Removed ${count} song${count !== 1 ? 's' : ''} from playlist`);
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
    cover.innerHTML = `<div class="cover-placeholder">${musicNote(56)}</div>`;
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
    if (state.playlist?.id === pid) await openPlaylist(pid);
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

function showAddDropdown(event, trackId) {
  event.stopPropagation();
  showPlaylistPicker(event.currentTarget, [trackId]);
}

// Keep for backward compat (duplicate dialog "Add Anyway" path uses this)
async function addToPlaylist(pid, plName) {
  state._pendingTrackIds = state._pendingTrackIds.length ? state._pendingTrackIds : [state.activeTrackId];
  await _commitToPlaylist(pid, plName);
}

async function addAllToPlaylist(trackIds, anchorEl) {
  if (!state.playlists.length) { toast('Create a playlist first'); return; }
  if (state.playlists.length === 1) {
    state._pendingTrackIds = trackIds;
    const pl = state.playlists[0];
    await _commitToPlaylist(pl.id, pl.name);
  } else {
    const anchor = anchorEl || document.getElementById('add-all-btn');
    showPlaylistPicker(anchor, trackIds);
  }
}

// Kept for backward compat
async function addAllToSpecificPlaylist(pid, plName) {
  await _commitToPlaylist(pid, plName);
}

/* ── Quick-add helpers (artist / album cards) ───────────────────────── */
async function addAllArtistSongs(artistName, event) {
  const anchor = (event && event.currentTarget) || document.getElementById('artist-hero-add');
  const tracks = await api(`/library/tracks?artist=${encodeURIComponent(artistName)}`);
  if (!tracks.length) { toast('No tracks found'); return; }
  await addAllToPlaylist(tracks.map(t => t.id), anchor);
}

async function addAlbumToPlaylist(artist, album, event) {
  const anchor = (event && event.currentTarget) || document.getElementById('add-all-btn');
  const tracks = await api(`/library/tracks?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`);
  if (!tracks.length) { toast('No tracks found'); return; }
  await addAllToPlaylist(tracks.map(t => t.id), anchor);
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
  if (!state.playlist) return;
  await api(`/playlists/${state.playlist.id}/tracks/${trackId}`, { method: 'DELETE' });
  state.playlist.tracks = state.playlist.tracks.filter(t => t.id !== trackId);
  renderPlaylistTracks(state.playlist.tracks);
  updatePlaylistCover(state.playlist.tracks);
  updatePlaylistStats(state.playlist.tracks);
}

/* ── Playlist CRUD ──────────────────────────────────────────────────── */
async function createPlaylist() {
  const name = prompt('Playlist name:');
  if (!name) return;
  const pl = await api('/playlists', { method: 'POST', body: { name } });
  await loadPlaylists();
  await openPlaylist(pl.id);
}

async function createPlaylistAndAdd() {
  hideDropdown();
  const trackIds = [...state._pendingTrackIds];
  const name = prompt('New playlist name:');
  if (!name) return;
  const pl = await api('/playlists', { method: 'POST', body: { name } });
  await loadPlaylists();
  if (trackIds.length) {
    const res = await api(`/playlists/${pl.id}/tracks`, { method: 'POST', body: { track_ids: trackIds } });
    state.lastUsedPlaylistId = pl.id;
    toast(`Added ${res.added} song${res.added !== 1 ? 's' : ''} to "${pl.name}"`);
  }
  await openPlaylist(pl.id);
}

async function deletePlaylist(pid) {
  const pl = state.playlists.find(p => p.id === pid);
  if (!confirm(`Delete "${pl?.name}"?`)) return;
  await api(`/playlists/${pid}`, { method: 'DELETE' });
  if (state.playlist?.id === pid) {
    state.playlist = null;
    showView('artists');
  }
  await loadPlaylists();
}

let renameTarget = null;
function renamePlaylist(newName) {
  if (!state.playlist || !newName.trim()) return;
  if (newName.trim() === state.playlist.name) return;
  api(`/playlists/${state.playlist.id}`, { method: 'PUT', body: { name: newName.trim() } })
    .then(() => {
      state.playlist.name = newName.trim();
      loadPlaylists();
      toast('Playlist renamed');
    });
}

/* ── Export ─────────────────────────────────────────────────────────── */
async function exportPlaylistDap(did) {
  if (!state.playlist) return;
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
  try {
    const res = await api(`/daps/${did}/export/${state.playlist.id}`, { method: 'POST' });
    toast(`Exported to device ✓`);
    // Refresh pills so sync status updates
    renderDapExportPills(state.playlist.id);
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

/* ── View navigation ────────────────────────────────────────────────── */
function showView(viewName) {
  state.view = viewName;
  state.playlist = null;
  clearSelection();
  setActiveNav(viewName);
  renderSidebarPlaylists();

  showViewEl(viewName);

  if (viewName === 'artists') loadArtists();
  else if (viewName === 'albums') { state.artist = null; loadAlbums(); }
  else if (viewName === 'songs') loadSongsView();
  else if (viewName === 'daps') loadDapsView();
  else if (viewName === 'iems') loadIemsView();
  else if (viewName === 'settings') loadSettings();
}

function showViewEl(name) {
  const views = ['artists', 'albums', 'tracks', 'songs', 'playlist', 'daps', 'dap-detail', 'iems', 'iem-detail', 'settings'];
  views.forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.style.display = v === name ? (v === 'playlist' ? 'flex' : 'block') : 'none';
  });
}

function setActiveNav(view) {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });
}

async function showArtist(artist) {
  state.artist = artist;
  state.view = 'albums';
  clearSelection();
  setActiveNav('albums');
  renderSidebarPlaylists();
  showViewEl('albums');
  await loadAlbums(artist);
}

async function showAlbum(artist, album) {
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
function showHelp() {
  document.getElementById('help-modal').style.display = 'flex';
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

function _syncPhase(name) {
  ['pick', 'scanning', 'preview', 'copying', 'done'].forEach(p => {
    const el = document.getElementById(`sync-phase-${p}`);
    if (el) el.style.display = p === name ? 'block' : 'none';
  });
}

async function showSync() {
  await api('/sync/reset', { method: 'POST' }).catch(() => {});
  _syncPhase('pick');

  const daps = await api('/daps').catch(() => []);
  const container = document.getElementById('sync-device-list');
  if (!container) { document.getElementById('sync-modal').style.display = 'flex'; return; }

  const svgDevice = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18" stroke-width="3"/></svg>`;

  if (!daps.length) {
    container.innerHTML = `<p style="color:var(--text-muted);font-size:13px">No DAPs configured — add one in <strong>Gear → DAPs</strong> first.</p>`;
  } else {
    container.innerHTML = daps.map(dap => {
      const connected = dap.mounted;
      return `
        <button class="sync-device-btn${connected ? '' : ' sync-device-btn-offline'}"
          ${connected ? '' : 'disabled'}
          onclick="App.startSyncScan('${dap.id}')">
          ${svgDevice}
          <span>${esc(dap.name)}</span>
          <span class="sync-device-status${connected ? ' sync-device-status-on' : ''}">
            ${connected ? '● Connected' : '○ Not connected'}
          </span>
        </button>`;
    }).join('');
  }

  document.getElementById('sync-modal').style.display = 'flex';
}

function closeSyncModal() {
  clearInterval(_syncPollTimer);
  _syncPollTimer = null;
  document.getElementById('sync-modal').style.display = 'none';
}

async function startSyncScan(dapId) {
  _syncPhase('scanning');
  document.getElementById('sync-scanning-msg').textContent = 'Scanning files…';
  document.getElementById('sync-scan-bar').style.width = '0%';

  const res = await api('/sync/scan', { method: 'POST', body: { dap_id: dapId } });
  if (res.error) { toast(res.error); _syncPhase('pick'); return; }

  // Animate indeterminate bar while scanning
  let pct = 0;
  document.getElementById('sync-scan-bar').style.transition = 'none';

  clearInterval(_syncPollTimer);
  _syncPollTimer = setInterval(async () => {
    const status = await api('/sync/status').catch(() => null);
    if (!status) return;

    document.getElementById('sync-scanning-msg').textContent = status.current || status.message;

    if (status.status === 'ready') {
      clearInterval(_syncPollTimer);
      document.getElementById('sync-scan-bar').style.width = '100%';
      renderSyncPreview(status);
    } else if (status.status === 'error') {
      clearInterval(_syncPollTimer);
      toast('Scan error: ' + status.message);
      _syncPhase('pick');
    } else {
      // Animate progress bar
      pct = Math.min(pct + 15, 85);
      document.getElementById('sync-scan-bar').style.width = pct + '%';
    }
  }, 600);
}

function _syncFileRows(paths, side) {
  if (!paths.length) {
    return `<div class="sync-empty">Nothing to copy</div>`;
  }
  return paths.map((p, i) => {
    const parts = p.replace(/\\/g, '/').split('/');
    const filename = parts[parts.length - 1];
    const folder = parts.slice(0, -1).join('/');
    return `<label class="sync-file-row">
      <input type="checkbox" class="sync-chk sync-chk-${side}" data-path="${esc(p)}" checked />
      <div class="sync-file-path-wrap"><span class="sync-file-folder">${esc(folder)}/</span><span class="sync-file-name">${esc(filename)}</span></div>
    </label>`;
  }).join('');
}

function renderSyncPreview(status) {
  document.getElementById('sync-local-count').textContent = status.local_only.length;
  document.getElementById('sync-device-count').textContent = status.device_only.length;
  document.getElementById('sync-list-local').innerHTML = _syncFileRows(status.local_only, 'local');
  document.getElementById('sync-list-device').innerHTML = _syncFileRows(status.device_only, 'device');

  // Hide "copy to device" section if nothing to copy
  document.getElementById('sync-section-local').style.display =
    status.local_only.length ? 'block' : 'none';
  document.getElementById('sync-section-device').style.display =
    status.device_only.length ? 'block' : 'none';

  const executeBtn = document.getElementById('sync-execute-btn');
  if (executeBtn) executeBtn.disabled = status.local_only.length === 0 && status.device_only.length === 0;

  // Reset select-all checkboxes
  const allLocal = document.getElementById('chk-all-local');
  const allDevice = document.getElementById('chk-all-device');
  if (allLocal) allLocal.checked = true;
  if (allDevice) allDevice.checked = true;

  _syncPhase('preview');
}

function syncToggleAll(side, checked) {
  document.querySelectorAll(`.sync-chk-${side}`).forEach(cb => cb.checked = checked);
}

async function executeSync() {
  const local_paths = [...document.querySelectorAll('.sync-chk-local:checked')].map(cb => cb.dataset.path);
  const device_paths = [...document.querySelectorAll('.sync-chk-device:checked')].map(cb => cb.dataset.path);

  if (!local_paths.length && !device_paths.length) {
    toast('Select at least one file to sync');
    return;
  }

  _syncPhase('copying');
  document.getElementById('sync-copying-msg').textContent = `Copying 0 / ${local_paths.length + device_paths.length} files…`;
  document.getElementById('sync-copy-bar').style.width = '0%';
  document.getElementById('sync-copying-current').textContent = '';

  await api('/sync/execute', { method: 'POST', body: { local_paths, device_paths } });

  clearInterval(_syncPollTimer);
  _syncPollTimer = setInterval(async () => {
    const status = await api('/sync/status').catch(() => null);
    if (!status) return;

    const pct = status.total > 0 ? Math.round((status.progress / status.total) * 100) : 0;
    document.getElementById('sync-copy-bar').style.width = pct + '%';
    document.getElementById('sync-copying-msg').textContent = status.message;
    document.getElementById('sync-copying-current').textContent = status.current || '';

    if (status.status === 'done') {
      clearInterval(_syncPollTimer);
      _showSyncDone(status);
    } else if (status.status === 'error') {
      clearInterval(_syncPollTimer);
      toast('Sync error: ' + status.message);
    }
  }, 600);
}

function _showSyncDone(status) {
  document.getElementById('sync-done-msg').textContent = status.message;
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
}

async function syncScanAgain() {
  await api('/sync/reset', { method: 'POST' }).catch(() => {});
  _syncPhase('pick');
}

/* ── DAP icon picker ────────────────────────────────────────────────── */
const DAP_ICONS = [
  '📱','🎵','🎶','🎧','📻','💿','🔊','🎸',
  '🎹','🎺','🎻','🥁','🎤','⚡','🌟','🔥',
  '💎','🚀','🌊','🎯','🦋','🎨','📡','🔮',
];

function _renderIconPicker(selected) {
  const container = document.getElementById('dap-icon-picker');
  if (!container) return;
  document.getElementById('dap-icon').value = selected || '📱';
  container.innerHTML = DAP_ICONS.map(icon => `
    <button type="button" class="icon-picker-btn${icon === (selected || '📱') ? ' selected' : ''}"
      onclick="App._selectIcon('${icon}')" title="${icon}">${icon}</button>
  `).join('');
}

function _selectIcon(icon) {
  document.getElementById('dap-icon').value = icon;
  const display = document.getElementById('dap-icon-display');
  if (display) display.textContent = icon;
  document.querySelectorAll('.icon-picker-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.textContent === icon);
  });
  // Close dropdown
  const menu = document.getElementById('dap-icon-menu');
  if (menu) menu.style.display = 'none';
}

/* ── DAP management ─────────────────────────────────────────────────── */
async function loadDapsView() {
  const daps = await api('/daps').catch(() => []);
  const grid = document.getElementById('daps-grid');
  const empty = document.getElementById('daps-empty');
  if (!daps.length) {
    grid.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = daps.map(d => `
    <div class="gear-card" onclick="App.showDapDetail('${d.id}')">
      <div class="gear-card-icon" style="font-size:22px">${esc(d.icon || '📱')}</div>
      <div class="gear-card-name">${esc(d.name)}</div>
      <div class="gear-card-meta">
        <span class="gear-badge ${d.mounted ? 'gear-badge-connected' : 'gear-badge-disconnected'}">
          ${d.mounted ? '● Connected' : '○ Not connected'}
        </span>
        ${d.stale_count > 0 ? `<span class="gear-sync-badge gear-sync-stale">⚠ ${d.stale_count} stale</span>` : ''}
        ${d.never_exported > 0 ? `<span class="gear-sync-badge gear-sync-never">${d.never_exported} unsynced</span>` : ''}
      </div>
    </div>
  `).join('');
}

async function showDapDetail(id) {
  const [dap, playlists] = await Promise.all([
    api(`/daps/${id}`),
    api('/playlists'),
  ]);
  state.view = 'dap-detail';
  clearSelection();
  setActiveNav('daps');
  showViewEl('dap-detail');

  document.getElementById('dap-detail-breadcrumb').innerHTML = `
    <span class="crumb" onclick="App.showView('daps')">DAPs</span>
    <span class="crumb-sep">›</span>
    <span class="crumb-current">${esc(dap.name)}</span>
  `;

  const exports = dap.playlist_exports || {};
  const sortedPl = [...playlists].sort((a, b) => a.name.localeCompare(b.name));

  const plRows = sortedPl.map(pl => {
    const ts = exports[pl.id];
    let statusHtml;
    if (!ts) {
      statusHtml = `<span class="gear-sync-badge gear-sync-never">Never exported</span>`;
    } else if (ts < (pl.updated_at || 0)) {
      statusHtml = `<span class="gear-sync-badge gear-sync-stale">⚠ Stale</span>`;
    } else {
      statusHtml = `<span class="gear-sync-badge gear-sync-ok">✓ Up to date</span>`;
    }
    const canExport = dap.mounted;
    return `
      <tr>
        <td class="dap-pl-name" onclick="App.openPlaylist('${pl.id}')" title="Open playlist">${esc(pl.name)}</td>
        <td>${pl.tracks?.length ?? 0} tracks</td>
        <td>${statusHtml}</td>
        <td style="text-align:right">
          <button class="dap-pl-export-btn" ${canExport ? '' : 'disabled title="Device not mounted"'}
            onclick="App.dapExportPlaylist('${dap.id}','${pl.id}',this)">
            ${dap.mounted ? '→ Export' : 'Not mounted'}
          </button>
        </td>
      </tr>
    `;
  }).join('');

  document.getElementById('dap-detail-content').innerHTML = `
    <div class="dap-detail-header">
      <div class="dap-detail-icon" style="font-size:28px">${esc(dap.icon || '📱')}</div>
      <div>
        <div class="dap-detail-title">${esc(dap.name)}</div>
        <div class="dap-detail-sub">
          <span class="gear-badge ${dap.mounted ? 'gear-badge-connected' : 'gear-badge-disconnected'}">
            ${dap.mounted ? '● Connected' : '○ Not connected'}
          </span>
          <span class="gear-badge gear-badge-dap">${esc(dap.model || 'generic')}</span>
        </div>
        <div class="gear-edit-actions">
          <button class="btn-secondary" onclick="App.showEditDapModal('${dap.id}')">Edit</button>
          <button class="btn-danger-sm" onclick="App.deleteDap('${dap.id}')">Delete</button>
        </div>
      </div>
    </div>
    <div class="dap-config-block">
      <div class="dap-config-field"><label>Mount path</label><span>${esc(dap.mount_path || '—')}</span></div>
      <div class="dap-config-field"><label>Export folder</label><span>${esc(dap.export_folder || 'Playlists')}</span></div>
      <div class="dap-config-field"><label>Path prefix</label><span>${esc(dap.path_prefix || '(none)')}</span></div>
      <div class="dap-config-field"><label>Model</label><span>${esc(dap.model || 'generic')}</span></div>
    </div>
    <div style="font-size:var(--text-xs);font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">
      Playlist Sync Status
    </div>
    <table class="dap-pl-table">
      <thead><tr>
        <th>Playlist</th><th>Tracks</th><th>Status</th><th></th>
      </tr></thead>
      <tbody>${plRows || '<tr><td colspan="4" style="color:var(--text-muted);text-align:center;padding:20px">No playlists yet</td></tr>'}</tbody>
    </table>
  `;
}

async function dapExportPlaylist(dapId, plId, btn) {
  btn.disabled = true;
  btn.textContent = 'Exporting…';
  try {
    await api(`/daps/${dapId}/export/${plId}`, { method: 'POST' });
    btn.textContent = '✓ Exported';
    btn.style.background = '#4caf8f';
    // Refresh stale badge
    const row = btn.closest('tr');
    if (row) {
      const statusCell = row.cells[2];
      if (statusCell) statusCell.innerHTML = `<span class="gear-sync-badge gear-sync-ok">✓ Up to date</span>`;
    }
  } catch (e) {
    toast('Export failed: ' + e.message);
    btn.disabled = false;
    btn.textContent = '→ Export';
  }
}

function showAddDapModal() {
  document.getElementById('dap-modal-title').textContent = 'Add DAP';
  document.getElementById('dap-modal-id').value = '';
  document.getElementById('dap-name').value = '';
  document.getElementById('dap-model').value = 'poweramp';
  document.getElementById('dap-mount').value = '';
  document.getElementById('dap-export-folder').value = 'Playlists';
  document.getElementById('dap-prefix').value = '';
  _renderIconPicker('📱');
  const display = document.getElementById('dap-icon-display');
  if (display) display.textContent = '📱';
  dapModelPreset('poweramp');
  document.getElementById('dap-modal').style.display = 'flex';
}

async function showEditDapModal(id) {
  const dap = await api(`/daps/${id}`);
  document.getElementById('dap-modal-title').textContent = 'Edit DAP';
  document.getElementById('dap-modal-id').value = id;
  document.getElementById('dap-name').value = dap.name || '';
  document.getElementById('dap-model').value = dap.model || 'poweramp';
  document.getElementById('dap-mount').value = dap.mount_path || '';
  document.getElementById('dap-export-folder').value = dap.export_folder || 'Playlists';
  document.getElementById('dap-prefix').value = dap.path_prefix || '';
  const icon = dap.icon || '📱';
  _renderIconPicker(icon);
  const display = document.getElementById('dap-icon-display');
  if (display) display.textContent = icon;
  _updateDapFolderHint(dap.model || 'poweramp');
  document.getElementById('dap-modal').style.display = 'flex';
}

function closeDapModal() {
  document.getElementById('dap-modal').style.display = 'none';
}

const _mountPrefix = (() => {
  const os = _getOsPlatform();
  if (os === 'windows') return { base: 'E:\\', sep: '\\' };
  if (os === 'linux') return { base: '/media/', sep: '/' };
  return { base: '/Volumes/', sep: '/' };
})();

const DAP_MODEL_PRESETS = {
  poweramp: {
    mount: _mountPrefix.base + 'FIIO M21',
    folder: 'Playlists',
    prefix: '',
    hint: 'Poweramp scans all storage for .m3u files. Filename = playlist name.',
  },
  hiby: {
    mount: _mountPrefix.base + 'HiBy',
    folder: 'HiByMusic/Playlist',
    prefix: '',
    hint: 'HiBy OS reads playlists from HiByMusic/Playlist/ on SD card.',
  },
  fiio: {
    mount: _mountPrefix.base + 'FiiO',
    folder: 'Playlists',
    prefix: '',
    hint: 'FiiO Music finds M3U files via Browse Files on the same storage as music.',
  },
  other: {
    mount: _mountPrefix.base + 'MyDAP',
    folder: 'Playlists',
    prefix: '',
    hint: '',
  },
};

function dapModelPreset(model) {
  const preset = DAP_MODEL_PRESETS[model] || DAP_MODEL_PRESETS.other;
  const mountInput = document.getElementById('dap-mount');
  // Only update mount if field is empty or user hasn't customized it
  if (!mountInput.value || Object.values(DAP_MODEL_PRESETS).some(p => mountInput.value === p.mount)) {
    mountInput.value = preset.mount;
  }
  document.getElementById('dap-export-folder').value = preset.folder;
  document.getElementById('dap-prefix').value = preset.prefix;
  _updateDapFolderHint(model);
}

function _updateDapFolderHint(model) {
  const el = document.getElementById('dap-folder-hint');
  if (!el) return;
  const preset = DAP_MODEL_PRESETS[model] || DAP_MODEL_PRESETS.other;
  el.textContent = preset.hint;
}

async function saveDap() {
  const id = document.getElementById('dap-modal-id').value;
  const body = {
    name: document.getElementById('dap-name').value.trim() || 'My DAP',
    model: document.getElementById('dap-model').value,
    icon: document.getElementById('dap-icon').value || '📱',
    mount_path: document.getElementById('dap-mount').value.trim(),
    export_folder: document.getElementById('dap-export-folder').value.trim() || 'Playlists',
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
      showView('daps');
    }
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

async function deleteDap(id) {
  if (!confirm('Delete this DAP?')) return;
  await api(`/daps/${id}`, { method: 'DELETE' });
  showView('daps');
}

/* ── IEM management ─────────────────────────────────────────────────── */
let _iemChart = null;
let _currentIemId = null;
let _activePeqId = null;

async function loadIemsView() {
  const iems = await api('/iems').catch(() => []);
  const grid = document.getElementById('iems-grid');
  const empty = document.getElementById('iems-empty');
  if (!iems.length) {
    grid.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = iems.map(i => {
    const badgeClass = i.type === 'Headphone' ? 'gear-badge-hp' : 'gear-badge-iem';
    return `
      <div class="gear-card" onclick="App.showIemDetail('${i.id}')">
        <div class="gear-card-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>
        </div>
        <div class="gear-card-name">${esc(i.name)}</div>
        <div class="gear-card-meta">
          <span class="gear-badge ${badgeClass}">${esc(i.type || 'IEM')}</span>
          ${i.peq_profiles?.length ? `<span style="font-size:var(--text-xs);color:var(--text-muted)">${i.peq_profiles.length} PEQ${i.peq_profiles.length !== 1 ? 's' : ''}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function showIemDetail(id) {
  const iem = await api(`/iems/${id}`);
  _currentIemId = id;
  _activePeqId = null;
  state.view = 'iem-detail';
  clearSelection();
  setActiveNav('iems');
  showViewEl('iem-detail');

  document.getElementById('iem-detail-breadcrumb').innerHTML = `
    <span class="crumb" onclick="App.showView('iems')">IEMs &amp; Headphones</span>
    <span class="crumb-sep">›</span>
    <span class="crumb-current">${esc(iem.name)}</span>
  `;

  const typeBadge = iem.type === 'Headphone' ? 'gear-badge-hp' : 'gear-badge-iem';
  const hasMeasurement = iem.measurement_L || iem.measurement_R;
  const peqOptions = (iem.peq_profiles || []).map(p =>
    `<option value="${p.id}">${esc(p.name)}</option>`
  ).join('');

  document.getElementById('iem-detail-content').innerHTML = `
    <div class="iem-detail-header">
      <div class="iem-detail-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>
      </div>
      <div>
        <div class="iem-detail-title">${esc(iem.name)}</div>
        <div class="iem-detail-sub">
          <span class="gear-badge ${typeBadge}">${esc(iem.type || 'IEM')}</span>
          ${iem.squig_url ? `<a href="${esc(iem.squig_url)}" target="_blank" style="font-size:var(--text-xs);color:var(--accent);text-decoration:none">squig.link ↗</a>` : ''}
        </div>
        <div class="gear-edit-actions">
          <button class="btn-secondary" onclick="App.showEditIemModal('${iem.id}')">Edit</button>
          <button class="btn-danger-sm" onclick="App.deleteIem('${iem.id}')">Delete</button>
        </div>
      </div>
    </div>

    <div class="freq-graph-wrap">
      <div class="freq-graph-toolbar">
        <label>PEQ:</label>
        <select id="peq-select" onchange="App.applyPeqToGraph(this.value)">
          <option value="">None (raw measurement)</option>
          ${peqOptions}
        </select>
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

  if (hasMeasurement) {
    await _loadIemGraph(id, null);
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

async function _loadIemGraph(iemId, peqId) {
  const params = peqId ? `?peq=${peqId}` : '';
  let data;
  try {
    data = await api(`/iems/${iemId}/graph${params}`);
  } catch (e) {
    toast('Failed to load graph data: ' + e.message);
    return;
  }
  if (!data || !data.curves || !data.curves.length) return;

  const canvas = document.getElementById('freq-canvas');
  if (!canvas) return;

  if (_iemChart) { _iemChart.destroy(); _iemChart = null; }

  const regionPlugin = {
    id: 'freqRegions',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: { left, right, top, bottom, height }, scales: { x } } = chart;
      // squig.link-style 7 region bands
      const regions = [
        { f1: 20,   f2: 80,    color: 'rgba(173,198,255,.04)', label: 'Sub bass' },
        { f1: 80,   f2: 300,   color: 'rgba(173,198,255,.025)', label: 'Mid bass' },
        { f1: 300,  f2: 1000,  color: 'rgba(173,198,255,.015)', label: 'Lower midrange' },
        { f1: 1000, f2: 4000,  color: 'rgba(173,198,255,.025)', label: 'Upper midrange' },
        { f1: 4000, f2: 6000,  color: 'rgba(173,198,255,.04)', label: 'Presence region' },
        { f1: 6000, f2: 10000, color: 'rgba(173,198,255,.025)', label: 'Mid treble' },
        { f1: 10000,f2: 20000, color: 'rgba(173,198,255,.04)', label: 'Air' },
      ];
      regions.forEach(r => {
        const x1 = Math.max(x.getPixelForValue(r.f1), left);
        const x2 = Math.min(x.getPixelForValue(r.f2), right);
        ctx.fillStyle = r.color;
        ctx.fillRect(x1, top, x2 - x1, bottom - top);
      });
      // Draw region labels at bottom
      ctx.save();
      ctx.font = '9px Inter, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      regions.forEach(r => {
        const x1 = Math.max(x.getPixelForValue(r.f1), left);
        const x2 = Math.min(x.getPixelForValue(r.f2), right);
        const cx = (x1 + x2) / 2;
        if (x2 - x1 > 30) { // Only draw if region is wide enough
          ctx.fillText(r.label, cx, bottom - 2);
        }
      });
      ctx.restore();
    },
  };

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
    borderDash: c.dash ? [6, 4] : [],
    pointRadius: 0,
    tension: 0.3,
  }));

  _iemChart = new Chart(canvas, {
    type: 'line',
    plugins: [regionPlugin],
    data: { datasets: datasets.map(ds => ({ ...ds, borderDash: ds.borderDash || [] })) },
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
    return `
      <div class="curve-legend-item" id="legend-item-${i}">
        <button class="eye-toggle" onclick="App.toggleIemCurve(${i})" title="Show/hide curve">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        <svg width="28" height="10" viewBox="0 0 28 10" style="flex-shrink:0">
          <line x1="0" y1="5" x2="28" y2="5" stroke="${ds.borderColor}"
            stroke-width="${ds.borderWidth || 1.5}" ${dash}/>
        </svg>
        <span>${esc(ds.label)}</span>
      </div>`;
  }).join('');
}

function toggleIemCurve(idx) {
  if (!_iemChart) return;
  const nowVisible = !_iemChart.isDatasetVisible(idx);
  _iemChart.setDatasetVisibility(idx, nowVisible);
  _iemChart.update();
  const btn = document.querySelector(`#legend-item-${idx} .eye-toggle`);
  if (btn) btn.classList.toggle('hidden', !nowVisible);
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
  if (_currentIemId) await _loadIemGraph(_currentIemId, _activePeqId);
}

function showAddIemModal() {
  document.getElementById('iem-modal-title').textContent = 'Add IEM / Headphone';
  document.getElementById('iem-modal-id').value = '';
  document.getElementById('iem-name').value = '';
  document.getElementById('iem-type').value = 'IEM';
  document.getElementById('iem-squig-url').value = '';
  document.getElementById('iem-modal-error').style.display = 'none';
  document.getElementById('iem-save-btn').disabled = false;
  document.getElementById('iem-save-btn').textContent = 'Save';
  document.getElementById('iem-modal').style.display = 'flex';
}

async function showEditIemModal(id) {
  const iem = await api(`/iems/${id}`);
  document.getElementById('iem-modal-title').textContent = 'Edit IEM';
  document.getElementById('iem-modal-id').value = id;
  document.getElementById('iem-name').value = iem.name || '';
  document.getElementById('iem-type').value = iem.type || 'IEM';
  document.getElementById('iem-squig-url').value = iem.squig_url || '';
  document.getElementById('iem-modal-error').style.display = 'none';
  document.getElementById('iem-save-btn').disabled = false;
  document.getElementById('iem-save-btn').textContent = 'Save';
  document.getElementById('iem-modal').style.display = 'flex';
}

function closeIemModal() {
  document.getElementById('iem-modal').style.display = 'none';
}

async function saveIem() {
  const id = document.getElementById('iem-modal-id').value;
  const body = {
    name: document.getElementById('iem-name').value.trim() || 'New IEM',
    type: document.getElementById('iem-type').value,
    squig_url: document.getElementById('iem-squig-url').value.trim(),
  };
  const errEl = document.getElementById('iem-modal-error');
  const btn = document.getElementById('iem-save-btn');
  btn.disabled = true;
  btn.textContent = body.squig_url ? 'Fetching measurement…' : 'Saving…';
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
  if (!confirm('Delete this IEM/headphone?')) return;
  if (_iemChart) { _iemChart.destroy(); _iemChart = null; }
  await api(`/iems/${id}`, { method: 'DELETE' });
  showView('iems');
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
  if (!confirm('Delete this PEQ profile?')) return;
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

async function loadSongsView() {
  try {
    _songsData = await api(`/library/songs?sort=${_songsSort.col}&order=${_songsSort.order}`);
  } catch {
    _songsData = [];
  }
  renderSongsTable();
}

function renderSongsTable() {
  let tracks = _songsData;
  if (_songsFilter) {
    const q = _songsFilter.toLowerCase();
    tracks = tracks.filter(t =>
      ((t.title || '') + ' ' + (t.artist || '') + ' ' + (t.album || '')).toLowerCase().includes(q)
    );
  }
  const total = tracks.length;
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
  if (arrow) arrow.textContent = _songsSort.order === 'asc' ? ' \u25B2' : ' \u25BC';

  tbody.innerHTML = page.map((t, i) => {
    const globalIdx = start + i;
    const fmtDate = t.date_added ? new Date(t.date_added * 1000).toLocaleDateString() : '';
    const bitrate = t.bitrate ? t.bitrate + ' kbps' : '';
    return `
    <tr data-id="${t.id}">
      <td class="col-num" onclick="App.toggleTrackSelection('${t.id}', ${globalIdx}, event)">
        <div class="num-cell">
          <span class="track-num">${t.track_number || (globalIdx + 1)}</span>
          <span class="track-check-indicator"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><polyline points="20 6 9 17 4 12"/></svg></span>
        </div>
      </td>
      <td>
        <div class="title-cell">
          <div class="thumb">${thumbImg(t.artwork_key, 34, '4px')}</div>
          <div class="track-info">
            <div class="track-title" title="${esc(t.title)}">${esc(t.title)}</div>
          </div>
        </div>
      </td>
      <td class="cell-artist" title="${esc(t.artist)}">${esc(t.artist)}</td>
      <td class="cell-album" title="${esc(t.album)}">${esc(t.album)}</td>
      <td class="col-dur">${esc(t.duration_fmt || '')}</td>
      <td style="color:var(--text-sub);font-size:var(--text-sm)" title="${esc(t.genre || '')}">${esc(t.genre || '')}</td>
      <td style="color:var(--text-muted);font-size:var(--text-sm)">${esc(t.year || '')}</td>
      <td style="color:var(--text-sub);font-size:var(--text-sm)" title="${esc(t.album_artist || '')}">${esc(t.album_artist || '')}</td>
      <td style="color:var(--text-muted);font-size:var(--text-sm)">${esc(t.format || '')}</td>
      <td style="color:var(--text-muted);font-size:var(--text-sm)">${bitrate}</td>
      <td style="color:var(--text-muted);font-size:var(--text-sm)">${fmtDate}</td>
      <td><div class="col-act-inner">
        <button class="add-btn" onclick="App.showAddDropdown(event, '${t.id}')" title="Add to playlist">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div></td>
    </tr>`;
  }).join('');
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

function filterSongs(val) {
  _songsFilter = val;
  _songsPage = 0;
  const clearBtn = document.getElementById('songs-filter-clear');
  if (clearBtn) clearBtn.style.display = val ? 'block' : 'none';
  renderSongsTable();
}

function clearSongsFilter() {
  _songsFilter = '';
  const inp = document.getElementById('songs-filter-input');
  if (inp) inp.value = '';
  const clearBtn = document.getElementById('songs-filter-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  renderSongsTable();
}

/* ── Settings ──────────────────────────────────────────────────────── */
async function loadSettings() {
  const [settings] = await Promise.all([
    api('/settings').catch(() => ({})),
    loadBaselines(),
  ]);
  const inp = document.getElementById('lib-path-input');
  if (inp) inp.value = settings.library_path || '/Volumes/Storage/Music/FLAC';
}

async function saveLibraryPath() {
  const path = document.getElementById('lib-path-input').value.trim();
  if (!path) { toast('Please enter a valid path'); return; }
  try {
    await api('/settings', { method: 'PUT', body: { library_path: path } });
    toast('Library path saved. Rescan to apply changes.');
  } catch (e) {
    toast('Error: ' + e.message);
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

async function runHealthCheck() {
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

  // Library
  const lib = data.library;
  const libDetail = lib.ok
    ? `${lib.tracks} tracks · ${lib.cache_age_hours != null ? `cache ${lib.cache_age_hours}h old` : 'no cache'}`
    : `Path not found`;
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
  const dapDetail = daps.length === 0
    ? 'No DAPs configured'
    : daps.map(d => `<div class="health-dap-row">${dot(d.mounted)}<span style="font-size:var(--text-xs);color:var(--text-sub)">${esc(d.name)}: ${d.mounted ? 'Connected' : 'Not connected'}</span></div>`).join('');
  const dapsOk = daps.length > 0 && daps.some(d => d.mounted);
  const dapHtml = `
    <div class="health-item">
      <div class="health-dot health-dot-${daps.length === 0 ? 'idle' : dapsOk ? 'ok' : 'warn'}"></div>
      <div class="health-item-body">
        <div class="health-item-label">DAPs</div>
        <div class="health-item-detail"><div class="health-dap-list">${dapDetail}</div></div>
      </div>
    </div>`;

  // Data files
  const df = data.data_files;
  const dfAll = Object.values(df).every(Boolean);
  const dfDetail = Object.entries(df).map(([k, ok]) =>
    `${ok ? '✓' : '✗'} ${k}.json`
  ).join(' · ');
  const dfHtml = `
    <div class="health-item">
      ${dot(dfAll)}
      <div class="health-item-body">
        <div class="health-item-label">Data Files</div>
        <div class="health-item-detail">${esc(dfDetail)}</div>
      </div>
    </div>`;

  const grid = document.getElementById('health-grid');
  if (grid) grid.innerHTML = libHtml + sqHtml + dapHtml + dfHtml;

  const lastRun = document.getElementById('health-last-run');
  if (lastRun) lastRun.textContent = 'Last checked: ' + new Date().toLocaleTimeString();

  if (btn) { btn.disabled = false; btn.textContent = 'Run Health Check'; }
}

/* ── Baselines (FR tuning targets) ─────────────────────────────────── */
let _baselines = [];

async function loadBaselines() {
  _baselines = await api('/baselines').catch(() => []);
  _renderBaselines();
}

function _renderBaselines() {
  const el = document.getElementById('baselines-list');
  if (!el) return;
  if (!_baselines.length) {
    el.innerHTML = '<p style="font-size:var(--text-sm);color:var(--text-muted);margin:0 0 4px">No baselines added yet.</p>';
    return;
  }
  el.innerHTML = _baselines.map(b => `
    <div class="baseline-item">
      <span class="baseline-dot" style="background:${b.color}"></span>
      <span class="baseline-item-name">${esc(b.name)}</span>
      <span class="baseline-item-url" title="${esc(b.url)}">${esc(b.url)}</span>
      <button class="btn-ghost-sm" onclick="App.deleteBaseline('${b.id}')">Remove</button>
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
    toast('⚠ URL doesn\'t look like a squig.link address — double-check it');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  try {
    const bl = await api('/baselines', { method: 'POST', body: { name, url } });
    _baselines = [..._baselines.filter(b => b.id !== bl.id), bl];
    _renderBaselines();
    nameEl.value = '';
    urlEl.value  = '';
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
function toggleIconDropdown() {
  const menu = document.getElementById('dap-icon-menu');
  if (!menu) return;
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

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
  showArtist,
  showAlbum,
  openPlaylist,
  createPlaylist,
  createPlaylistAndAdd,
  deletePlaylist,
  renamePlaylist,
  showAddDropdown,
  addToPlaylist,
  addAllToPlaylist,
  addAllToSpecificPlaylist,
  addAllArtistSongs,
  addAlbumToPlaylist,
  _commitToPlaylist,
  scrollToLetter,
  removeFromPlaylist,
  dupCancel,
  dupSkip,
  dupAddAnyway,
  exportPlaylistDap,
  exportToDeviceDap,
  renderDapExportPills,
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
  startSyncScan,
  syncToggleAll,
  executeSync,
  syncScanAgain,
  // Songs
  sortSongs,
  filterSongs,
  clearSongsFilter,
  songsPrevPage,
  songsNextPage,
  // Settings
  loadSettings,
  saveLibraryPath,
  restartApp,
  // Baselines
  addBaseline,
  deleteBaseline,
  // DAP
  _selectIcon,
  toggleIconDropdown,
  showDapDetail,
  showAddDapModal,
  showEditDapModal,
  closeDapModal,
  dapModelPreset,
  saveDap,
  deleteDap,
  dapExportPlaylist,
  // IEM
  showIemDetail,
  showAddIemModal,
  showEditIemModal,
  closeIemModal,
  saveIem,
  deleteIem,
  applyPeqToGraph,
  toggleIemCurve,
  runHealthCheck,
  togglePeqAccordion,
  downloadPeq,
  showPeqModal,
  closePeqModal,
  savePeq,
  deletePeq,
};

/* ── Init ───────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('add-dropdown');
    if (!dd.contains(e.target)) hideDropdown();

    // Close any open mapping results dropdowns
    if (!e.target.closest('.map-row-target')) {
      document.querySelectorAll('.map-results').forEach(el => el.style.display = 'none');
    }

    // Close icon dropdown
    if (!e.target.closest('.icon-dropdown')) {
      const iconMenu = document.getElementById('dap-icon-menu');
      if (iconMenu) iconMenu.style.display = 'none';
    }
  });

  // Keyboard shortcut: Escape closes dropdown
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideDropdown();
  });

  await loadSettings();
  await loadPlaylists();
  pollScanStatus();
  loadArtists();
});

// Expose scrollToLetter globally for inline onclick in alpha bar
window.scrollToLetter = scrollToLetter;
