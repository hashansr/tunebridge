/* ── State ──────────────────────────────────────────────────────────── */
const state = {
  view: 'artists',         // artists | albums | tracks | search | playlist
  artist: null,
  album: null,
  playlist: null,          // full playlist object (with enriched tracks)
  playlists: [],           // sidebar list
  tracks: [],              // tracks in current library view
  artists: [],
  albums: [],
  searchResults: [],
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
      if (['artists', 'albums', 'tracks', 'search'].includes(state.view)) {
        refreshCurrentLibraryView();
      }
    }
  }
}

async function refreshCurrentLibraryView() {
  if (state.view === 'artists') await loadArtists();
  else if (state.view === 'albums') await loadAlbums(state.artist);
  else if (state.view === 'tracks') await loadTracks(state.artist, state.album);
  else if (state.view === 'search' && state.searchQuery) await doSearch(state.searchQuery);
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
      <div class="artist-card" ${anchor} onclick="App.showArtist('${esc(a.name)}')">
        <div class="artist-thumb">
          ${thumbImg(a.artwork_key, 120, '6px')}
        </div>
        <div class="artist-name" title="${esc(a.name)}">${esc(a.name)}</div>
        <div class="artist-meta">${a.album_count} album${a.album_count !== 1 ? 's' : ''} · ${a.track_count} songs</div>
        <div class="artist-card-overlay">
          <button class="card-add-btn" onclick="event.stopPropagation();App.addAllArtistSongs('${esc(a.name)}',event)" title="Add all songs to playlist">+</button>
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
    <div class="album-card" onclick="App.showAlbum('${esc(al.artist)}', '${esc(al.name)}')">
      <div class="album-thumb">
        ${thumbImg(al.artwork_key, 160, '6px')}
        <div class="album-thumb-overlay">
          <button class="card-add-btn" onclick="event.stopPropagation();App.addAlbumToPlaylist('${esc(al.artist)}','${esc(al.name)}',event)" title="Add album to playlist">+</button>
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
  if (artist) crumbParts.push(`<span class="crumb" onclick="App.showArtist('${esc(artist)}')">${esc(artist)}</span>`);
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
      ? `<span class="link" onclick="App.showArtist('${esc(artist)}')">${esc(artist)}</span>` : '';
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
      `<span class="link" onclick="App.showArtist('${esc(artist)}')">${esc(artist)}</span>`;
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

/* ── Search ─────────────────────────────────────────────────────────── */
let searchTimer;
async function doSearch(query) {
  state.searchQuery = query;
  clearTimeout(searchTimer);
  if (!query.trim()) {
    document.getElementById('search-results-info').textContent = '';
    document.getElementById('search-tbody').innerHTML = '';
    return;
  }
  searchTimer = setTimeout(async () => {
    const tracks = await api(`/library/tracks?q=${encodeURIComponent(query)}`);
    state.searchResults = tracks;
    const info = document.getElementById('search-results-info');
    const tbody = document.getElementById('search-tbody');
    if (!tracks.length) {
      info.textContent = 'No results found.';
      tbody.innerHTML = '';
      return;
    }
    info.textContent = `${tracks.length} result${tracks.length !== 1 ? 's' : ''}`;
    tbody.innerHTML = tracks.map((t, i) => trackRow(t, i + 1, false)).join('');
  }, 250);
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
  checkDevices();
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
  if (state.view === 'search') return state.searchResults;
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

async function checkDevices() {
  const devices = await api('/devices/status').catch(() => ({ poweramp: false, ap80: false }));
  state.devices = devices;
  document.getElementById('poweramp-device-btn').style.display = devices.poweramp ? 'flex' : 'none';
  document.getElementById('ap80-device-btn').style.display = devices.ap80 ? 'flex' : 'none';
}

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
  dd.style.display = 'block';
  dd.style.left = (rect.left - 180 + rect.width) + 'px';
  dd.style.top = (rect.bottom + 6) + 'px';
  setTimeout(() => {
    const r = dd.getBoundingClientRect();
    if (r.right > window.innerWidth)  dd.style.left = (window.innerWidth - r.width - 8) + 'px';
    if (r.bottom > window.innerHeight) dd.style.top = (rect.top - r.height - 6) + 'px';
    if (r.left < 8) dd.style.left = '8px';
  }, 0);
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
  const tracks = await api(`/library/tracks?artist=${encodeURIComponent(artistName)}`);
  if (!tracks.length) { toast('No tracks found'); return; }
  const anchor = (event && event.currentTarget) || document.getElementById('artist-hero-add');
  await addAllToPlaylist(tracks.map(t => t.id), anchor);
}

async function addAlbumToPlaylist(artist, album, event) {
  const tracks = await api(`/library/tracks?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`);
  if (!tracks.length) { toast('No tracks found'); return; }
  const anchor = (event && event.currentTarget) || document.getElementById('add-all-btn');
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
async function exportPlaylist(fmt) {
  if (!state.playlist) return;
  const url = `/api/playlists/${state.playlist.id}/export/${fmt}`;
  const a = document.createElement('a');
  a.href = url;
  a.click();
  toast(`Downloading ${fmt === 'poweramp' ? 'Poweramp' : 'AP80'} playlist…`);
}

async function exportToDevice(device) {
  if (!state.playlist) return;
  try {
    const res = await api('/devices/export', {
      method: 'POST',
      body: { playlist_id: state.playlist.id, device },
    });
    toast(`Exported to ${res.path}`);
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
  else if (viewName === 'search') {
    setTimeout(() => document.getElementById('search-input').focus(), 50);
  }
}

function showViewEl(name) {
  const views = ['artists', 'albums', 'tracks', 'search', 'playlist'];
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
  checkDevices();
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

  // Show mount status on device buttons
  const devices = await api('/devices/status').catch(() => ({ poweramp: false, ap80: false }));
  const m21Status = document.getElementById('sync-m21-status');
  const ap80Status = document.getElementById('sync-ap80-status');
  const m21Btn = document.getElementById('sync-btn-m21');
  const ap80Btn = document.getElementById('sync-btn-ap80');

  if (m21Status) m21Status.textContent = devices.poweramp ? 'Connected' : 'Not connected';
  if (ap80Status) ap80Status.textContent = devices.ap80 ? 'Connected' : 'Not connected';
  if (m21Btn) m21Btn.disabled = !devices.poweramp;
  if (ap80Btn) ap80Btn.disabled = !devices.ap80;

  document.getElementById('sync-modal').style.display = 'flex';
}

function closeSyncModal() {
  clearInterval(_syncPollTimer);
  _syncPollTimer = null;
  document.getElementById('sync-modal').style.display = 'none';
}

async function startSyncScan(device) {
  _syncPhase('scanning');
  document.getElementById('sync-scanning-msg').textContent = 'Scanning files…';
  document.getElementById('sync-scan-bar').style.width = '0%';

  const res = await api('/sync/scan', { method: 'POST', body: { device } });
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
  exportPlaylist,
  exportToDevice,
  doSearch,
  rescan,
  rescanClean,
  toggleRescanMenu,
  closeRescanMenu,
  showSettings,
  closeSettings,
  saveSettings,
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
