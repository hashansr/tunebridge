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
  plSortDir: 'asc',
  plFilter: '',
};

let _currentGearTab = 'daps';

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

/* ── Create playlist modal state ────────────────────────────────────── */
let _createPlPendingIds = [];

/* ── Generic confirm modal ──────────────────────────────────────────── */
let _confirmResolve = null;

function _showConfirm({ title = '', message = '', okText = 'Delete', danger = true, icon = null } = {}) {
  return new Promise(resolve => {
    _confirmResolve = resolve;
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-msg').textContent   = message;
    const okBtn = document.getElementById('confirm-modal-ok');
    okBtn.textContent  = okText;
    okBtn.className    = danger ? 'btn-danger-pill' : 'btn-danger-pill btn-danger-pill--neutral';
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

  // Sort playlists
  const pls = [...state.playlists];
  if (state.playlistSortMode === 'alpha') {
    pls.sort((a, b) => a.name.localeCompare(b.name));
  } else if (state.playlistSortMode === 'created') {
    pls.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  } else {
    pls.sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0));
  }

  if (!pls.length) {
    grid.innerHTML = '';
    if (empty) empty.style.display = 'flex';
    return;
  }
  if (empty) empty.style.display = 'none';

  grid.innerHTML = pls.map(pl => {
    // Build cover art HTML
    let coverHtml;
    if (pl.has_artwork) {
      coverHtml = `<img src="/api/playlists/${pl.id}/artwork?t=${Date.now()}" style="width:100%;height:100%;object-fit:cover" loading="lazy" onerror="this.style.display='none'" />`;
    } else {
      const keys = (pl.artwork_keys || []).slice(0, 4);
      if (!keys.length) {
        coverHtml = `<div class="cover-placeholder">${musicNote(40)}</div>`;
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
}

/* ── Artists view ───────────────────────────────────────────────────── */
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

  const grid = document.getElementById('artists-grid');
  const alphaBar = document.getElementById('alpha-bar');
  document.getElementById('artists-count').textContent = `${artists.length} artists`;

  const artistsEmpty = document.getElementById('artists-empty');
  if (!artists.length) {
    grid.innerHTML = '';
    if (artistsEmpty) artistsEmpty.style.display = 'flex';
    alphaBar.innerHTML = '';
    return;
  }
  if (artistsEmpty) artistsEmpty.style.display = 'none';

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
      <div class="artist-card" ${anchor} data-artist="${esc(a.name)}" onclick="App.showArtist(this.dataset.artist)" oncontextmenu="event.preventDefault();App.showArtistCtxMenu(event,this.dataset.artist)">
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

  // Restore saved scroll position (breadcrumb back) or reset to top (sidebar nav)
  const main = document.getElementById('main');
  if (main) main.scrollTop = state._artistsScrollTop || 0;
  state._artistsScrollTop = 0;
}

function scrollToLetter(letter) {
  const el = document.getElementById(`alpha-${letter}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Briefly highlight active letter
  document.querySelectorAll('.alpha-btn').forEach(b => b.classList.remove('active'));
  const btn = [...document.querySelectorAll('.alpha-btn')].find(b => b.textContent === letter);
  if (btn) { btn.classList.add('active'); setTimeout(() => btn.classList.remove('active'), 800); }
}

function scrollToAlbumLetter(letter) {
  const el = document.getElementById(`albums-alpha-${letter}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Briefly highlight the clicked letter button (same UX as artist alpha bar)
  const bar = document.getElementById('albums-alpha-bar');
  if (bar) {
    bar.querySelectorAll('.alpha-btn').forEach(b => b.classList.remove('active'));
    const btn = [...bar.querySelectorAll('.alpha-btn')].find(b => b.textContent === letter);
    if (btn) { btn.classList.add('active'); setTimeout(() => btn.classList.remove('active'), 800); }
  }
}

/* ── Albums view ────────────────────────────────────────────────────── */
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
  state.albums = albums;

  const grid = document.getElementById('albums-grid');
  const countEl = document.getElementById('albums-count');
  const crumb = document.getElementById('albums-breadcrumb');
  const hero = document.getElementById('artist-hero');
  const albumsAlphaBar = document.getElementById('albums-alpha-bar');
  const albumsEmpty = document.getElementById('albums-empty');

  countEl.textContent = `${albums.length} album${albums.length !== 1 ? 's' : ''}`;

  if (artistFilter) {
    crumb.innerHTML = `
      <span class="crumb" onclick="App.backToArtists()">Artists</span>
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
    const artistPlayBtn = document.getElementById('artist-hero-play');
    if (artistPlayBtn) {
      artistPlayBtn.style.display = '';
      artistPlayBtn.onclick = async () => {
        const t = await api(`/library/tracks?artist=${encodeURIComponent(artistFilter)}`);
        if (t && t.length) Player.playAll(t);
      };
    }
    hero.style.display = 'flex';
  } else {
    crumb.innerHTML = `<span class="crumb-current" style="font-size:22px;font-weight:700">Albums</span>`;
    hero.style.display = 'none';
  }

  // Empty state
  if (!albums.length) {
    grid.innerHTML = '';
    if (albumsEmpty) albumsEmpty.style.display = 'flex';
    if (albumsAlphaBar) albumsAlphaBar.style.display = 'none';
    return;
  }
  if (albumsEmpty) albumsEmpty.style.display = 'none';

  if (!artistFilter && albumsAlphaBar) {
    // Sort letter: strip leading articles (The/A/An) to match backend sort key
    const _albumLetter = name => {
      const stripped = (name || '').replace(/^(the|a|an)\s+/i, '');
      const first = stripped.charAt(0).toUpperCase();
      return /[A-Z]/.test(first) ? first : '#';
    };
    // Alpha bar for all-albums view
    const LETTERS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const presentLetters = new Set(albums.map(al => _albumLetter(al.name)));
    albumsAlphaBar.style.display = 'flex';
    albumsAlphaBar.innerHTML = LETTERS.map(l => `
      <button class="alpha-btn" ${presentLetters.has(l) ? `onclick="App.scrollToAlbumLetter('${l}')"` : 'disabled'}
        title="${l === '#' ? 'Numbers / symbols' : l}">${l}</button>
    `).join('');

    // Re-render grid with letter anchors
    let lastLetter = null;
    grid.innerHTML = albums.map(al => {
      const letter = _albumLetter(al.name);
      let anchor = '';
      if (letter !== lastLetter) {
        anchor = `id="albums-alpha-${letter}"`;
        lastLetter = letter;
      }
      return `
        <div class="album-card" ${anchor} data-artist="${esc(al.artist)}" data-album="${esc(al.name)}" onclick="App.showAlbum(this.dataset.artist, this.dataset.album)" oncontextmenu="event.preventDefault();App.showAlbumCtxMenu(event,this.dataset.artist,this.dataset.album)">
          <div class="album-thumb">
            ${thumbImg(al.artwork_key, 160, '6px')}
            <div class="album-thumb-overlay">
              <button class="card-play-btn" data-artist="${esc(al.artist)}" data-album="${esc(al.name)}" onclick="event.stopPropagation();App.playAlbum(this.dataset.artist,this.dataset.album)" title="Play album">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21" transform="translate(1.5,0)"/></svg>
              </button>
              <button class="card-add-btn" data-artist="${esc(al.artist)}" data-album="${esc(al.name)}" onclick="event.stopPropagation();App.addAlbumToPlaylist(this.dataset.artist,this.dataset.album,event)" title="Add album to playlist">+</button>
            </div>
          </div>
          <div class="album-name" title="${esc(al.name)}">${esc(al.name)}</div>
          <div class="album-artist">${esc(al.artist)}</div>
          ${al.year ? `<div class="album-year">${esc(al.year)}</div>` : ''}
        </div>
      `;
    }).join('');
  } else {
    if (albumsAlphaBar) albumsAlphaBar.style.display = 'none';
    grid.innerHTML = albums.map(al => `
      <div class="album-card" data-artist="${esc(al.artist)}" data-album="${esc(al.name)}" onclick="App.showAlbum(this.dataset.artist, this.dataset.album)" oncontextmenu="event.preventDefault();App.showAlbumCtxMenu(event,this.dataset.artist,this.dataset.album)">
        <div class="album-thumb">
          ${thumbImg(al.artwork_key, 160, '6px')}
          <div class="album-thumb-overlay">
            <button class="card-play-btn" data-artist="${esc(al.artist)}" data-album="${esc(al.name)}" onclick="event.stopPropagation();App.playAlbum(this.dataset.artist,this.dataset.album)" title="Play album">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21" transform="translate(1.5,0)"/></svg>
            </button>
            <button class="card-add-btn" data-artist="${esc(al.artist)}" data-album="${esc(al.name)}" onclick="event.stopPropagation();App.addAlbumToPlaylist(this.dataset.artist,this.dataset.album,event)" title="Add album to playlist">+</button>
          </div>
        </div>
        <div class="album-name" title="${esc(al.name)}">${esc(al.name)}</div>
        ${!artistFilter ? `<div class="album-artist">${esc(al.artist)}</div>` : ''}
        ${al.year ? `<div class="album-year">${esc(al.year)}</div>` : ''}
      </div>
    `).join('');
  }
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

  const crumb = document.getElementById('tracks-breadcrumb');
  const crumbParts = [`<span class="crumb" onclick="App.backToArtists()">Artists</span>`];
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
  Player.registerTracks(tracks);

  document.getElementById('add-all-btn').onclick = () => App.addAllToPlaylist(tracks.map(t => t.id));

  // Play All button on album/artist hero (always #album-hero in view-tracks)
  const heroActions = document.querySelector('#album-hero .hero-actions');
  if (heroActions) {
    let playBtn = heroActions.querySelector('.btn-play-all');
    if (!playBtn) {
      playBtn = document.createElement('button');
      playBtn.className = 'btn-play-all';
      playBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Play All`;
      heroActions.prepend(playBtn);
    }
    playBtn.onclick = () => Player.playAll(tracks);
  }
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
  const playIcon  = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`;

  return `
    <tr data-id="${t.id}" ondblclick="Player.playTrackById('${t.id}')" oncontextmenu="App.showTrackCtxMenu(event,'${t.id}')">
      <td class="col-num" onclick="App.toggleTrackSelection('${t.id}', ${num - 1}, event)">
        <div class="num-cell">
          ${dragHandle}
          <span class="track-num">${num}</span>
          <span class="track-check-indicator">${checkIcon}</span>
        </div>
      </td>
      <td>
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
      ${inPlaylist ? `<td class="cell-artist" title="${esc(t.artist)}">${esc(t.artist)}</td>` : ''}
      <td class="cell-album" title="${esc(t.album)}">${esc(t.album)}</td>
      <td class="col-dur">${esc(t.duration_fmt || '')}</td>
      ${inPlaylist ? `<td class="col-genre" style="color:var(--text-muted);font-size:var(--text-sm)">${esc(t.genre || '')}</td>` : ''}
      ${inPlaylist ? `<td class="col-year" style="color:var(--text-muted);font-size:var(--text-sm)">${t.year || ''}</td>` : ''}
      <td><div class="col-act-inner">${add}</div></td>
    </tr>`;
}

/* ── Playlist view ──────────────────────────────────────────────────── */
async function openPlaylist(pid) {
  const pl = await api(`/playlists/${pid}`);
  state.playlist = pl;
  state.view = 'playlist';
  clearSelection();
  setActiveNav('playlist');
  renderSidebarPlaylists();
  showViewEl('playlist');

  document.getElementById('pl-name').textContent = pl.name;

  renderPlaylistTracks(pl.tracks);
  updatePlaylistCover(pl.tracks);
  updatePlaylistStats(pl.tracks);
  renderDapExportPills(pid);

  // Register tracks with player and add/update Play button
  Player.registerTracks(pl.tracks);
  let playAllBtn = document.getElementById('pl-play-all-btn');
  if (!playAllBtn) {
    playAllBtn = document.createElement('button');
    playAllBtn.id = 'pl-play-all-btn';
    playAllBtn.className = 'btn-play-all';
    playAllBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Play`;
    const stats = document.getElementById('pl-stats');
    if (stats) stats.insertAdjacentElement('afterend', playAllBtn);
  }
  playAllBtn.onclick = () => Player.playAll(pl.tracks);
  playAllBtn.style.display = pl.tracks.length ? '' : 'none';
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
  if (tracks && tracks.length) Player.registerTracks(tracks);
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
    toast('Error: ' + e.message);
  }
}

function showAddDropdown(event, trackId) {
  event.stopPropagation();
  showPlaylistPicker(event.currentTarget, [trackId]);
}

/* ── Right-click context menu ───────────────────────────────────────── */
function _showCtxMenu(x, y, tracks, label) {
  _ctxTracks = tracks;
  const menu = document.getElementById('ctx-menu');
  const labelEl = document.getElementById('ctx-label');
  if (labelEl) labelEl.textContent = label || (tracks.length === 1 ? tracks[0].title : `${tracks.length} songs`);
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
}

function showTrackCtxMenu(e, trackId) {
  e.preventDefault();
  e.stopPropagation();
  hideDropdown();
  const track = Player.getTrack(trackId);
  if (!track) return;
  _showCtxMenu(e.clientX, e.clientY, [track], track.title);
}

async function showArtistCtxMenu(e, artistName) {
  e.preventDefault();
  e.stopPropagation();
  hideDropdown();
  try {
    const tracks = await api(`/library/tracks?artist=${encodeURIComponent(artistName)}`);
    _showCtxMenu(e.clientX, e.clientY, tracks,
      `${artistName} · ${tracks.length} song${tracks.length !== 1 ? 's' : ''}`);
  } catch (_) {}
}

async function showAlbumCtxMenu(e, artist, album) {
  e.preventDefault();
  e.stopPropagation();
  hideDropdown();
  try {
    const tracks = await api(`/library/tracks?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`);
    _showCtxMenu(e.clientX, e.clientY, tracks,
      `${album} · ${tracks.length} song${tracks.length !== 1 ? 's' : ''}`);
  } catch (_) {}
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

function ctxAddToPlaylist(e) {
  // Legacy path — now handled by submenu; kept as fallback
  openCtxSubmenu(e);
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
  if (!state.playlist) return;
  await api(`/playlists/${state.playlist.id}/tracks/${trackId}`, { method: 'DELETE' });
  state.playlist.tracks = state.playlist.tracks.filter(t => t.id !== trackId);
  renderPlaylistTracks(state.playlist.tracks);
  updatePlaylistCover(state.playlist.tracks);
  updatePlaylistStats(state.playlist.tracks);
  loadPlaylists();  // refresh track_count in list view
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
  }
  await openPlaylist(pl.id);
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
  if (state.playlist?.id === pid) {
    state.playlist = null;
    showView('playlists');
  }
  await loadPlaylists();
}

async function deleteCurrentPlaylist() {
  if (!state.playlist) return;
  await deletePlaylist(state.playlist.id);
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

  if (viewName === 'artists') { state._artistsScrollTop = 0; loadArtists(); }
  else if (viewName === 'albums') { state.artist = null; loadAlbums(); }
  else if (viewName === 'songs') loadSongsView();
  else if (viewName === 'gear') loadGearView();
  else if (viewName === 'playlists') loadPlaylistsView();
  else if (viewName === 'settings') loadSettings();
  else if (viewName === 'insights') loadInsightsView();
}

function showViewEl(name) {
  const views = ['artists', 'albums', 'tracks', 'songs', 'playlist', 'gear', 'dap-detail', 'iem-detail', 'settings', 'playlists', 'insights'];
  views.forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.style.display = v === name ? (v === 'playlist' ? 'flex' : 'block') : 'none';
  });
}

function setActiveNav(view) {
  const NAV_MAP = {
    'tracks': 'artists',
    'dap-detail': 'gear',
    'iem-detail': 'gear',
    'playlist': 'playlists',
  };
  const navView = NAV_MAP[view] || view;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === navView);
  });
}

function backToArtists() {
  state.view = 'artists';
  clearSelection();
  setActiveNav('artists');
  renderSidebarPlaylists();
  showViewEl('artists');
  loadArtists(); // restores _artistsScrollTop if set
}

function backToGear() {
  state.view = 'gear';
  clearSelection();
  setActiveNav('gear');
  showViewEl('gear');
  loadGearView();
}

async function showArtist(artist) {
  const main = document.getElementById('main');
  state._artistsScrollTop = main ? main.scrollTop : 0;
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

  const svgDevice = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18" stroke-width="3"/></svg>`;

  if (!daps.length) {
    container.innerHTML = `<p style="color:var(--text-muted);font-size:13px">No DAPs configured — add one in <strong>Gear → DAPs</strong> first.</p>`;
  } else {
    container.innerHTML = daps.map(dap => {
      const connected = dap.mounted;
      return `
        <button class="sync-device-card${connected ? ' sync-device-card--online' : ''}"
          ${connected ? '' : 'disabled'}
          onclick="App.startSyncScan('${dap.id}')">
          <div class="sync-device-card-icon">${svgDevice}</div>
          <div class="sync-device-card-info">
            <span class="sync-device-card-name">${esc(dap.name)}</span>
            <span class="sync-device-status${connected ? ' sync-device-status--on' : ''}">
              <span class="sync-device-status-dot"></span>
              ${connected ? 'Connected' : 'Not connected'}
            </span>
          </div>
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

  const res = await api('/sync/scan', { method: 'POST', body: { dap_id: dapId } });
  if (res.error) { toast(res.error); _syncPhase('pick'); return; }

  // CSS indeterminate animation runs on the bar — just poll for completion
  clearInterval(_syncPollTimer);
  _syncPollTimer = setInterval(async () => {
    const status = await api('/sync/status').catch(() => null);
    if (!status) return;

    document.getElementById('sync-scanning-msg').textContent = status.current || status.message;

    if (status.status === 'ready') {
      clearInterval(_syncPollTimer);
      renderSyncPreview(status);
    } else if (status.status === 'error') {
      clearInterval(_syncPollTimer);
      toast('Scan error: ' + status.message);
      _syncPhase('pick');
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

/* ── DAP management ─────────────────────────────────────────────────── */

// SVG icon used for all DAP cards/headers
const _DAP_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="14" r="3"/><line x1="9" y1="6" x2="15" y2="6"/></svg>`;
const _IEM_SVG  = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`;

async function loadDapsView() {
  document.getElementById('daps-grid').innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  const daps = await api('/daps').catch(() => []);
  const grid  = document.getElementById('daps-grid');
  const empty = document.getElementById('daps-empty');
  if (!daps.length) { grid.innerHTML = ''; empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  grid.innerHTML = daps.map(d => {
    const syncRow = (d.stale_count > 0 || d.never_exported > 0) ? `
      <div class="gear-card-row">
        ${d.stale_count  > 0 ? `<span class="gear-sync-badge gear-sync-stale">⚠ ${d.stale_count} outdated</span>` : ''}
        ${d.never_exported > 0 ? `<span class="gear-sync-badge gear-sync-never">${d.never_exported} unsynced</span>` : ''}
      </div>` : '';
    return `
    <div class="gear-card" onclick="App.showDapDetail('${d.id}')">
      <div class="gear-card-icon">${_DAP_SVG}</div>
      <div class="gear-card-body">
        <div class="gear-card-name">${esc(d.name)}</div>
        <div class="gear-card-row">
          <span class="gear-badge ${d.mounted ? 'gear-badge-connected' : 'gear-badge-disconnected'}">
            ${d.mounted ? '● Connected' : '○ Not connected'}
          </span>
        </div>
        ${syncRow}
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
    const badgeClass  = i.type === 'Headphone' ? 'gear-badge-hp' : 'gear-badge-iem';
    const peqCount    = i.peq_profiles?.length || 0;
    const peqStr      = peqCount ? `${peqCount} EQ${peqCount !== 1 ? 's' : ''}` : '';
    const isSelected  = _iemCompareSelected.has(i.id);
    const clickAction = _iemCompareMode
      ? `App.toggleIemCompareSelect('${i.id}', event)`
      : `App.showIemDetail('${i.id}')`;
    return `
    <div class="gear-card${isSelected ? ' gear-card--selected' : ''}" id="gear-iem-card-${i.id}" onclick="${clickAction}">
      <div class="gear-card-icon">${_IEM_SVG}</div>
      <div class="gear-card-body">
        <div class="gear-card-name">${esc(i.name)}</div>
        <div class="gear-card-row">
          <span class="gear-badge ${badgeClass}">${esc(i.type || 'IEM')}</span>
          ${peqStr ? `<span class="gear-card-meta-text">${peqStr}</span>` : ''}
        </div>
      </div>
      ${_iemCompareMode ? `<div class="gear-compare-check${isSelected ? ' checked' : ''}"></div>` : ''}
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
  if (!canvas) return;
  if (_iemCompareChart) { _iemCompareChart.destroy(); _iemCompareChart = null; }

  // Use backend-assigned colors directly — each IEM has its own palette color
  const datasets = data.curves.map(c => ({
    label:       c.label,
    data:        c.data.map(([f, spl]) => ({ x: f, y: spl })),
    borderColor: c.color,
    borderWidth: c.id.startsWith('baseline-') ? 1.4 : 1.9,
    borderDash:  c.dash ? [6, 4] : undefined,
    pointRadius: 0,
    tension:     0.3,
    hidden:      c.id.startsWith('baseline-'),
  }));

  const regionPlugin = {
    id: 'compareRegions',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: { left, right, top, bottom }, scales: { x } } = chart;
      [{ f1:20,f2:80,c:.04 },{ f1:80,f2:300,c:.025 },{ f1:300,f2:1000,c:.015 },
       { f1:1000,f2:4000,c:.025 },{ f1:4000,f2:6000,c:.04 },{ f1:6000,f2:10000,c:.025 },
       { f1:10000,f2:20000,c:.04 }].forEach(r => {
        ctx.fillStyle = `rgba(173,198,255,${r.c})`;
        ctx.fillRect(Math.max(x.getPixelForValue(r.f1), left), top,
          Math.min(x.getPixelForValue(r.f2), right) - Math.max(x.getPixelForValue(r.f1), left),
          bottom - top);
      });
    },
  };

  _iemCompareChart = new Chart(canvas, {
    type: 'line',
    plugins: [regionPlugin],
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 200 },
      scales: {
        x: {
          type: 'logarithmic', min: 20, max: 20000,
          title: { display: true, text: 'Frequency (Hz)', color: '#6b6b7b', font: { size: 11 } },
          ticks: {
            color: '#6b6b7b', font: { size: 9 }, autoSkip: false, maxRotation: 0,
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
          title: { display: true, text: 'dB', color: '#6b6b7b', font: { size: 11 } },
          ticks: { color: '#6b6b7b', font: { size: 10 }, stepSize: 10 },
          grid: { color: 'rgba(173,198,255,.06)' },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(53,53,52,0.95)', titleColor: '#e5e2e1',
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
      return `<div class="compare-legend-item" onclick="App._toggleCompareDataset(${i})" id="cmp-legend-${i}">
        <svg width="24" height="8" viewBox="0 0 24 8">
          <line x1="0" y1="4" x2="24" y2="4" stroke="${ds.borderColor}" stroke-width="${ds.borderWidth||1.5}" ${dash}/>
        </svg>
        <span>${esc(ds.label)}</span>
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
  if (item) item.style.opacity = visible ? '1' : '0.35';
}

async function loadGearView() {
  await Promise.all([loadDapsView(), loadIemsView()]);
}

async function showDapDetail(id) {
  const [dap, playlists] = await Promise.all([
    api(`/daps/${id}`),
    api('/playlists'),
  ]);
  state.view = 'dap-detail';
  clearSelection();
  setActiveNav('gear');
  showViewEl('dap-detail');

  document.getElementById('dap-detail-breadcrumb').innerHTML = `
    <span class="crumb" onclick="App.backToGear()">Gear</span>
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
      <div class="dap-detail-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="14" r="3"/><line x1="9" y1="6" x2="15" y2="6"/></svg></div>
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
      showView('gear');
    }
  } catch (e) {
    toast('Error: ' + e.message);
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

async function showIemDetail(id) {
  const iem = await api(`/iems/${id}`);
  _currentIemId = id;
  _activePeqId = null;
  state.view = 'iem-detail';
  clearSelection();
  setActiveNav('gear');
  showViewEl('iem-detail');

  document.getElementById('iem-detail-breadcrumb').innerHTML = `
    <span class="crumb" onclick="App.backToGear()">Gear</span>
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
  let tracks = _songsData;
  if (_songsFilter) {
    const q = _songsFilter.toLowerCase();
    tracks = tracks.filter(t =>
      ((t.title || '') + ' ' + (t.artist || '') + ' ' + (t.album || '')).toLowerCase().includes(q)
    );
  }
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
  if (arrow) arrow.textContent = _songsSort.order === 'asc' ? ' \u25B2' : ' \u25BC';

  Player.registerTracks(page);

  tbody.innerHTML = page.map((t, i) => {
    const globalIdx = start + i;
    const fmtDate = t.date_added ? new Date(t.date_added * 1000).toLocaleDateString() : '';
    const bitrate = t.bitrate ? t.bitrate + ' kbps' : '';
    const playIcon = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`;
    return `
    <tr data-id="${t.id}" ondblclick="Player.playTrackById('${t.id}')" oncontextmenu="App.showTrackCtxMenu(event,'${t.id}')">
      <td class="col-num" onclick="App.toggleTrackSelection('${t.id}', ${globalIdx}, event)">
        <div class="num-cell">
          <span class="track-num">${t.track_number || (globalIdx + 1)}</span>
          <span class="track-check-indicator"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><polyline points="20 6 9 17 4 12"/></svg></span>
        </div>
      </td>
      <td>
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

/* ── Backup & Browse ────────────────────────────────────────────────── */
async function browseFolder(inputId) {
  const res = await api('/browse/folder', { method: 'POST' }).catch(() => null);
  if (!res) { toast('Could not open folder picker'); return; }
  if (res.error) { toast(res.error); return; }
  if (res.path) {
    const el = document.getElementById(inputId);
    if (el) { el.value = res.path; el.focus(); }
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
      toast('Import failed: ' + (data.error || 'Unknown error'));
    }
  } catch(e) {
    toast('Import failed: ' + e.message);
  }
  input.value = '';  // reset so same file can be re-selected
}

/* ── Settings ──────────────────────────────────────────────────────── */
async function loadSettings() {
  const [settings] = await Promise.all([
    api('/settings').catch(() => ({})),
    loadBaselines(),
  ]);
  const inp = document.getElementById('lib-path-input');
  if (inp) inp.value = settings.library_path || '/Volumes/Storage/Music/FLAC';
  const dirEl = document.getElementById('settings-data-dir');
  if (dirEl && settings._data_dir) dirEl.textContent = settings._data_dir;
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
  backToArtists,
  showArtist,
  showAlbum,
  openPlaylist,
  createPlaylist,
  createPlaylistAndAdd,
  showCreatePlaylistModal,
  closeCreatePlaylistModal,
  submitCreatePlaylist,
  _confirmYes,
  _confirmNo,
  deletePlaylist,
  deleteCurrentPlaylist,
  renamePlaylist,
  showAddDropdown,
  showTrackCtxMenu,
  showArtistCtxMenu,
  showAlbumCtxMenu,
  hideCtxMenu,
  ctxPlayNext,
  ctxAddToQueue,
  ctxAddToPlaylist,
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
  scrollToLetter,
  scrollToAlbumLetter,
  backToGear,
  loadGearView,
  toggleIemCompareMode,
  toggleIemCompareSelect,
  showIemCompare,
  closeIemCompare,
  _toggleCompareDataset,

  loadPlaylistsView,
  togglePlViewSort,
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
  browseFolder,
  exportBackup,
  importBackup,
  // Baselines
  addBaseline,
  deleteBaseline,
  toggleBaselineColorPicker,
  selectBaselineColor,
  // DAP
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
  loadInsightsView,
  startLibraryAnalysis,
  cancelLibraryAnalysis,
  insightsRescanLibrary,
  openProblemTracksModal,
  closeProblemTracksModal,
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
  iemFitChangeGenre,
  iemFitChangeGenreOverlay,
  iemFitAddGenreToHeatmap,
  iemFitRemoveGenreFromHeatmap,
  showAllIemGenres,
  showAllIemBlindspots,
  closeAllBlindspots,
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

  // Pre-populate problem tracks modal
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
    : `<button class="tag-health-problem-btn" onclick="App.openProblemTracksModal()">
        View ${d.problem_track_count.toLocaleString()} track${d.problem_track_count > 1 ? 's' : ''} with missing tags →
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
    body: `<p><strong>Spectral Brightness</strong> — the spectral centroid is the "centre of mass" of a track's frequency content. Higher values (4–6 kHz) mean bright, treble-forward music; lower values (1–2 kHz) indicate warm, bass-heavy music.</p>
           <p><strong>RMS Energy</strong> — average loudness. Heavily compressed recordings (modern pop, metal) score higher than dynamic classical recordings.</p>
           <p><strong>Band Energy Profile</strong> — relative spectral emphasis across 12 perceptual bands averaged across your library. Shows which frequency ranges your collection emphasises most.</p>
           <p><strong>Note:</strong> Analysis covers FLAC files only. M4A/AAC tracks are skipped (libsndfile limitation). Results update after running "Analyse Library" in this section.</p>`,
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

  const bandProfileHtml = d.band_profile
    ? `<div class="sonic-band-card">
        <div class="sonic-chart-title">Perceptual Band Energy Profile</div>
        <div class="sonic-chart-subtitle">Average energy per perceptual band across your library (normalised)</div>
        <div class="insights-chart-wrap" style="height:180px"><canvas id="sonic-band-canvas"></canvas></div>
       </div>`
    : '';

  el.innerHTML = `
    <div class="sonic-charts-grid">
      <div class="sonic-chart-card">
        <div class="sonic-chart-title">Spectral Brightness</div>
        <div class="insights-chart-wrap" style="height:180px"><canvas id="sonic-brightness-canvas"></canvas></div>
        <div class="sonic-stat-row">
          <span class="sonic-stat">Median <strong>${_hz(bs.median)} Hz</strong></span>
          <span class="sonic-stat">Mean <strong>${_hz(bs.mean)} Hz</strong></span>
          <span class="sonic-stat">IQR <strong>${_hz(bs.p25)}–${_hz(bs.p75)} Hz</strong></span>
        </div>
      </div>
      <div class="sonic-chart-card">
        <div class="sonic-chart-title">RMS Energy</div>
        <div class="insights-chart-wrap" style="height:180px"><canvas id="sonic-energy-canvas"></canvas></div>
        <div class="sonic-stat-row">
          <span class="sonic-stat">Median <strong>${es.median.toFixed(3)}</strong></span>
          <span class="sonic-stat">Mean <strong>${es.mean.toFixed(3)}</strong></span>
          <span class="sonic-stat">IQR <strong>${es.p25.toFixed(3)}–${es.p75.toFixed(3)}</strong></span>
        </div>
      </div>
    </div>
    ${bandProfileHtml}
    <div class="sonic-caveat">
      <strong>About this data</strong> — Spectral brightness (spectral centroid) is the frequency-weighted average of a track's spectrum. RMS energy reflects overall loudness. Band profile shows relative spectral emphasis using multi-window FFT. <strong>Analysis covers FLAC files only</strong> — M4A/AAC tracks are skipped.
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
let _iemFitGenreState  = {};    // iemId → selected genre key for FR overlay (string | null)
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
  const regionPlugin = {
    id: 'fitFRRegions',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: { left, right, top, bottom }, scales: { x } } = chart;

      // ── 1. Frequency region bands (cool blue tint, always shown) ──────────
      const regions = [
        { f1: 20,    f2: 80,    color: 'rgba(173,198,255,.05)' },
        { f1: 80,    f2: 300,   color: 'rgba(173,198,255,.03)' },
        { f1: 300,   f2: 1000,  color: 'rgba(173,198,255,.015)' },
        { f1: 1000,  f2: 4000,  color: 'rgba(173,198,255,.03)' },
        { f1: 4000,  f2: 6000,  color: 'rgba(173,198,255,.05)' },
        { f1: 6000,  f2: 10000, color: 'rgba(173,198,255,.03)' },
        { f1: 10000, f2: 20000, color: 'rgba(173,198,255,.05)' },
      ];
      regions.forEach(r => {
        const x1 = Math.max(x.getPixelForValue(r.f1), left);
        const x2 = Math.min(x.getPixelForValue(r.f2), right);
        ctx.fillStyle = r.color;
        ctx.fillRect(x1, top, x2 - x1, bottom - top);
      });

      // ── 2. Genre salience shading (amber, shown when a genre is selected) ──
      if (genreFingerprint) {
        // Sample 300 log-spaced frequencies and sum band energies at each point.
        // Bands overlap intentionally — summing creates a smooth "importance terrain".
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

        // Draw filled path rising from the bottom of the chart
        const MAX_H = 0.42 * (bottom - top);  // salience fills up to 42% of chart height
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(left, bottom);
        for (let i = 0; i < N; i++) {
          const px = Math.max(left, Math.min(right, x.getPixelForValue(freqs[i])));
          const py = bottom - (saliences[i] / maxS) * MAX_H;
          ctx.lineTo(px, py);
        }
        ctx.lineTo(right, bottom);
        ctx.closePath();

        // Vertical gradient: brighter at peak, fades toward the bottom
        const grad = ctx.createLinearGradient(0, bottom - MAX_H, 0, bottom);
        grad.addColorStop(0,   'rgba(240,168,48,0.28)');
        grad.addColorStop(0.5, 'rgba(240,168,48,0.18)');
        grad.addColorStop(1,   'rgba(240,168,48,0.06)');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();

        // Genre name label — bottom-right corner, subtle amber
        if (genreLabel) {
          ctx.save();
          ctx.font = '600 10px Inter, sans-serif';
          ctx.fillStyle = 'rgba(240,168,48,0.75)';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'bottom';
          ctx.fillText(genreLabel, right - 4, bottom - 4);
          ctx.restore();
        }
      }
    },
  };

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

  const coveragePct = d.overall_coverage_pct || 0;
  const covColor = coveragePct >= 70 ? '#53e16f' : coveragePct >= 45 ? '#f0b429' : '#ffb3b5';

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

  el.innerHTML = `
    <div class="iemfit-summary-card">
      <div class="iemfit-summary-score">
        <div class="iemfit-summary-pct" style="color:${covColor}">${coveragePct.toFixed(0)}%</div>
        <div class="iemfit-summary-pct-label">of your library<br>matched</div>
      </div>
      <div class="iemfit-summary-body">
        <div class="iemfit-summary-text">${esc(d.summary_text || '')}</div>
      </div>
    </div>
    <div class="iemfit-iem-list">${iemListHtml}</div>`;
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
    _iemFitPeqVariants[iemId] = { factory_scores: {}, peq_variants: [], iem_name: iemId, has_scores: false };

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

    controlsEl.innerHTML = peqCtrl + genreCtrl;
  }

  // Fetch FR curves from graph endpoint
  let curves = [];
  try {
    const url = peqId
      ? `/api/iems/${encodeURIComponent(iemId)}/graph?peq=${encodeURIComponent(peqId)}`
      : `/api/iems/${encodeURIComponent(iemId)}/graph`;
    const r = await fetch(url);
    if (r.ok) {
      const gd = await r.json();
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
    ? `<button class="iemfit-bs-more-btn" onclick="App.showAllIemGenres('${esc(iemId)}')">${total} genres total — view all →</button>`
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
    ? `<button class="iemfit-bs-more-btn" onclick="App.showAllIemBlindspots('${esc(iemId)}')">${total} genres total — view all →</button>`
    : '';

  el.innerHTML = `<div class="iemfit-bs-list">${rowsHtml}</div>${moreBtn}`;
}

// Controls
async function iemFitChangePeq(iemId, peqId) {
  await _renderIemFRPanel(iemId, peqId || null);
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
  const peqId = _iemFitPeqState[iemId];
  if (!peqId) return null;
  const iemData = _iemFitPeqVariants[iemId];
  if (!iemData) return null;
  const v = (iemData.peq_variants || []).find(v => v.peq_id === peqId);
  return v ? v.scores : null;
}

function showAllIemGenres(iemId) {
  if (!_iemFitMatrixData || !_iemFitMatrixData.matrix) return;
  const iemInfo    = _iemFitIemSummary.find(i => i.iem_id === iemId);
  const iemName    = iemInfo ? iemInfo.iem_name : iemId;
  const peqScores12 = _activePeqScores12(iemId);

  const genreScores = _iemFitMatrixData.matrix
    .map(row => ({
      genre: row.genre,
      score: peqScores12
        ? _recomputeGenreScore(row.fingerprint || {}, peqScores12)
        : ((row.matches || []).find(m => m.iem_id === iemId) || {}).score ?? null,
    }))
    .filter(g => g.score !== null)
    .sort((a, b) => b.score - a.score); // best → worst

  const titleEl = document.getElementById('iem-blindspot-modal-title');
  const bodyEl  = document.getElementById('iem-blindspot-modal-body');
  const modal   = document.getElementById('iem-blindspot-modal');
  if (!modal || !bodyEl) return;
  if (titleEl) titleEl.textContent = `All Genres — ${iemName}`;

  bodyEl.innerHTML = genreScores.map(g => {
    const fillColor = g.score >= 75 ? 'rgba(83,225,111,0.75)' : g.score >= 55 ? 'rgba(240,180,41,0.75)' : 'rgba(255,179,181,0.75)';
    return `<div class="iemfit-bs-row" style="margin-bottom:10px">
      <div class="iemfit-bs-genre">${esc(g.genre)}</div>
      <div class="iemfit-bs-bar-wrap">
        <div class="iemfit-bs-bar-track">
          <div class="iemfit-bs-bar-fill" style="width:${g.score.toFixed(0)}%;background:${fillColor}"></div>
        </div>
      </div>
      <div class="iemfit-bs-score" style="color:${_matchScoreColor(g.score)};min-width:42px;text-align:right">${g.score.toFixed(0)}%</div>
    </div>`;
  }).join('');

  modal.style.display = 'flex';
}

function showAllIemBlindspots(iemId) {
  if (!_iemFitMatrixData || !_iemFitMatrixData.matrix) return;
  const iemInfo     = _iemFitIemSummary.find(i => i.iem_id === iemId);
  const iemName     = iemInfo ? iemInfo.iem_name : iemId;
  const peqScores12 = _activePeqScores12(iemId);

  const genreScores = _iemFitMatrixData.matrix
    .map(row => ({
      genre: row.genre,
      score: peqScores12
        ? _recomputeGenreScore(row.fingerprint || {}, peqScores12)
        : ((row.matches || []).find(m => m.iem_id === iemId) || {}).score ?? null,
    }))
    .filter(g => g.score !== null)
    .sort((a, b) => a.score - b.score);

  const titleEl = document.getElementById('iem-blindspot-modal-title');
  const bodyEl  = document.getElementById('iem-blindspot-modal-body');
  const modal   = document.getElementById('iem-blindspot-modal');
  if (!modal || !bodyEl) return;
  if (titleEl) titleEl.textContent = `All Genres — ${iemName}`;

  bodyEl.innerHTML = genreScores.map(g => {
    const fillColor = g.score >= 75 ? 'rgba(83,225,111,0.75)' : g.score >= 55 ? 'rgba(240,180,41,0.75)' : 'rgba(255,179,181,0.75)';
    return `<div class="iemfit-bs-row" style="margin-bottom:10px">
      <div class="iemfit-bs-genre">${esc(g.genre)}</div>
      <div class="iemfit-bs-bar-wrap">
        <div class="iemfit-bs-bar-track">
          <div class="iemfit-bs-bar-fill" style="width:${g.score.toFixed(0)}%;background:${fillColor}"></div>
        </div>
      </div>
      <div class="iemfit-bs-score" style="color:${_matchScoreColor(g.score)};min-width:42px;text-align:right">${g.score.toFixed(0)}%</div>
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

/* ── Init ───────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('add-dropdown');
    if (dd && !dd.contains(e.target)) hideDropdown();

    // Close any open mapping results dropdowns
    if (!e.target.closest('.map-row-target')) {
      document.querySelectorAll('.map-results').forEach(el => el.style.display = 'none');
    }

  });

  // Keyboard shortcut: Escape closes dropdown and context menu
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideDropdown(); hideCtxMenu(); }
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
  // Enter submits create playlist modal
  const cpInput = document.getElementById('create-playlist-input');
  if (cpInput) cpInput.addEventListener('keydown', e => { if (e.key === 'Enter') App.submitCreatePlaylist(); });
  await loadSettings();
  await loadPlaylists();
  pollScanStatus();
  loadArtists();
});

// Expose scrollToLetter globally for inline onclick in alpha bar
window.scrollToLetter = scrollToLetter;
