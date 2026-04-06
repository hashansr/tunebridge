# Sync Improvements — Implementation Brief

**For:** Implementing agent
**Status:** Ready to build — all issues researched and scoped
**Files in scope:** `app.py`, `static/app.js`, `static/index.html`, `static/style.css`

---

## Background

TuneBridge has two separate sync systems that currently operate in isolation:

1. **Music Sync** — bidirectional file diff + copy between local `MUSIC_BASE` and a DAP's `music_root` folder. Accessed via the Sync Music modal (sidebar button).
2. **Playlist Export** — generates M3U files and copies them to the DAP's playlist folder. Accessed per-playlist via "Copy to [DAP]" pills.

Both need fixes. This document lists every issue, its exact location, and how to fix it. Implement all of them.

---

## 1. CORRECTNESS BUGS

### 1.1 `sync_state` has no thread lock

**File:** `app.py`
**Location:** Global declaration ~line 239; written by `do_scan` / `do_copy` background threads; read by `/api/sync/status` request thread.

**Problem:** Python's GIL doesn't prevent torn reads when the Flask request thread reads multiple keys from `sync_state` while a background thread is mid-`dict.update({...})`. The compound `sync_state.update({...})` calls in `do_scan` and `do_copy` are not atomic from the outside.

**Fix:**
1. Declare a module-level lock: `sync_state_lock = threading.Lock()` alongside `sync_state`.
2. Wrap every `sync_state.update(...)` and every multi-key read that matters (in `/api/sync/status`) with `with sync_state_lock:`.
3. Single-key writes like `sync_state['progress'] = progress` can be left unguarded (GIL protects them), but the bulk updates must be locked.

---

### 1.2 Tracks without track-number tags render as `Unknown track - Title.flac`

**File:** `app.py`
**Location:** `_track_tokens()` ~line 2069; `_render_device_relpath()` ~line 2076.

**Problem:**
In `_track_tokens`, when `track_number` metadata is absent, `tokens['track'] = ''`. In `_render_device_relpath`, `_safe_segment('')` returns `''`, which triggers the `not safe` fallback: `safe = _safe_segment('Unknown track')`. The rendered path for the default template `%artist%/%album%/%track% - %title%` becomes `Artist/Album/Unknown track - Title.flac`.

This causes two issues:
- If the actual file on disk is named `01. Title.flac` (filename has track number but metadata tag doesn't), the rendered target_rel won't match the original file on the device after an initial sync — perpetual false "out of sync" for those tracks.
- The fallback string `Unknown track` is user-visible on the device filesystem.

**Fix:**
In `_render_device_relpath`, after substituting all tokens, strip any resulting path segment that starts with or is entirely whitespace/punctuation due to an empty token. Specifically: if `%track%` resolves to empty string, collapse the ` - ` separator next to it. The cleanest approach:

After all token substitutions, apply a cleanup regex on the rendered string before `_normalize_rel`:
```python
# Remove leading separators left by empty %track% token (e.g., " - Title" → "Title")
rendered = re.sub(r'^[ \t]*[-–—_]+[ \t]*', '', rendered, flags=re.MULTILINE)
# Also clean up within path segments (last segment only matters here):
# e.g., "Unknown track - Title" → just use title when track was empty
```

Better: change the fallback behaviour so that when `track_num` is empty, `tokens['track']` is set to a sentinel that causes the template token AND its adjacent ` - ` separator to be stripped. The simplest implementation:
- If `track_num == ''`, do NOT substitute `%track%` with `Unknown track`. Instead substitute it with `''`, then post-process the rendered string with `re.sub(r'\s*%track%\s*[-–]\s*', '', rendered)` — but since substitution already happened, do it differently:
- Before substitution, if `v == ''` for the `track` key, temporarily replace the whole `%track% - ` pattern in the template with an empty string.

Recommended clean approach in `_render_device_relpath`:
```python
# Pre-process template: if track token will be empty, strip "track - " prefix pattern
tpl = _normalize_path_template(template)
tokens = _track_tokens(track)
# Remove "%track% - " from template when track is empty (avoids "Unknown track - Title")
if not tokens.get('track'):
    tpl = re.sub(r'%track%\s*[-–_]\s*', '', tpl)
    tpl = re.sub(r'\s*[-–_]\s*%track%', '', tpl)
```

Also update `_track_tokens` to return `''` (not `'00'`) for missing track numbers — currently `''.zfill(2)` would return `'00'`, but the `if track_num` guard prevents this. Verify this remains correct after any refactor.

---

### 1.3 Space check only covers local → device direction

**File:** `app.py` (`sync_execute`) and `static/app.js` (`syncSelectionChanged`)
**Location:** `sync_execute` ~line 2475; `syncSelectionChanged` ~line 3464.

**Problem:**
The space check before copy (`required_selected`) only sums bytes for files being sent TO the device. Files being copied from device to local never check whether the local drive has room.

**Fix — backend (`sync_execute`):**
After computing `required_selected` (device-bound bytes), also compute `required_local`:
```python
required_local = 0
for rel in device_paths:
    src = device_path / rel
    try:
        if src.exists():
            required_local += int(src.stat().st_size)
    except Exception:
        pass
# Check local drive free space
if required_local > 0:
    try:
        local_free = int(shutil.disk_usage(get_music_base()).free)
        if required_local > local_free:
            return jsonify({
                'error': 'Not enough local disk space for selected files',
                'space_required_bytes': required_local,
                'space_available_bytes': local_free,
            }), 400
    except Exception:
        pass
```

**Fix — frontend (`syncSelectionChanged`):**
The space summary panel currently only shows device space. Add a second line for local space when `device_paths` are selected:
- Compute `required_local_bytes` from `_syncLastStatus.device_only_sizes` (a new field — see §3.1 below).
- Show `Local drive: available X • required Y` as a second line in the panel when anything is selected in the "copy to local" section.

---

### 1.4 Library cache not invalidated after device→local copy

**File:** `app.py` — `do_copy()` inside `sync_execute`, ~line 2535.

**Problem:**
When files are copied from device to local (`device_paths`), the in-memory `library` list is not updated. The new files won't appear in the UI until the user manually rescans.

**Fix:**
At the end of `do_copy()`, after all copies are complete, if any `device_paths` were successfully copied, trigger a background library rescan:
```python
if device_paths and not errors:
    # Signal library to rescan new arrivals
    threading.Thread(target=lambda: scan_library(get_music_base()), daemon=True).start()
```
Also set a flag in `sync_state` so the done phase can show a "Library rescan started" note in the UI. Add `'library_rescan_started': True` to the final `sync_state.update({...})` when `device_paths` were processed.

---

### 1.5 `playlist_out_of_sync_count` includes every never-exported playlist

**File:** `app.py` — `_playlist_sync_counts_for_dap()` ~line 2296; and `get_daps` route ~line 2909.

**Problem:**
`never_exported = sum(1 for pl in playlists.values() if pl.get('id') not in exports)` counts ALL playlists in the library that haven't been exported to this DAP — including ones the user never intended to put on this device. A new DAP will always show a large "N playlists out of sync" badge even though no playlists were ever assigned to it.

**Fix:**
Only count `never_exported` as zero. The badge should only show playlists that have been exported at least once and have since changed (stale). Remove `never_exported` from `playlist_out_of_sync_count`:

In `_playlist_sync_counts_for_dap`:
```python
def _playlist_sync_counts_for_dap(dap):
    playlists = load_playlists()
    exports = (dap or {}).get('playlist_exports', {}) or {}
    stale_count = sum(
        1 for pl in playlists.values()
        if pl.get('id') in exports and pl.get('updated_at', 0) > exports[pl.get('id')]
    )
    never_exported = sum(1 for pl in playlists.values() if pl.get('id') not in exports)
    return stale_count, never_exported  # keep returning both for DAP detail view
```

In `_start_dap_sync_status_check` ~line 2334, change:
```python
'playlist_out_of_sync_count': int(stale_count) + int(never_exported),
```
to:
```python
'playlist_out_of_sync_count': int(stale_count),  # only previously-exported-but-now-stale
```

Apply the same change in `get_daps` route ~line 2913:
```python
summary['playlist_out_of_sync_count'] = int(d['stale_count'])  # not + never_exported
```

The `never_exported` count is still useful in the DAP detail view — show it there as a separate "Never exported: N" line, not as part of the sync badge on the card.

---

### 1.6 Playlist M3U existence not verified for sync status

**File:** `app.py` — `dap_export_playlist` ~line 3121; `_playlist_sync_counts_for_dap` ~line 2296.

**Problem:**
Sync status is purely timestamp-based. If a user manually deletes an M3U file from the device, the DAP card still shows "up to date". The stale check `pl.get('updated_at', 0) > exports[pl['id']]` never checks whether the file actually exists on device.

**Fix:**
In `_playlist_sync_counts_for_dap`, add a device file existence check when the device is mounted:
```python
def _playlist_sync_counts_for_dap(dap):
    playlists = load_playlists()
    exports = (dap or {}).get('playlist_exports', {}) or {}
    device_root, _ = _resolve_dap_mount(dap)
    export_folder = str(dap.get('export_folder') or 'Playlists')

    stale_count = 0
    never_exported = 0
    for pl in playlists.values():
        pid = pl.get('id')
        if pid not in exports:
            never_exported += 1
            continue
        # Timestamp-based stale check
        if pl.get('updated_at', 0) > exports[pid]:
            stale_count += 1
            continue
        # Existence check (only when device mounted)
        if device_root and device_root.exists():
            safe_name = pl['name'].replace('/', '-').replace(':', '-')
            m3u_path = device_root / export_folder / f"{safe_name}.m3u"
            if not m3u_path.exists():
                stale_count += 1  # file was deleted from device
    return stale_count, never_exported
```

This is a disk-access call — it's fine in the background `_start_dap_sync_status_check` thread but avoid calling it in the hot `get_daps` list route. In `get_daps`, keep using the cached `sync_summary.playlist_out_of_sync_count` value (set by the background checker). Only the background check should do the file-existence scan.

---

## 2. MISSING FEATURE: DELETE FROM DEVICE

This is the most significant missing feature. Currently, "device_only" files (on DAP but not in local library) can only be "copied to local". There is no way to delete files from the device within TuneBridge — a common workflow when the user has intentionally removed albums locally and wants the device to reflect that.

### 2.1 New backend route: `POST /api/sync/delete`

**File:** `app.py`

Add a new route that accepts a list of device-relative paths and deletes them from the device. This is a **destructive, irreversible operation** and must be clearly documented.

```python
@app.route('/api/sync/delete', methods=['POST'])
def sync_delete():
    """Delete selected files from the device. Irreversible."""
    # Must have completed a scan to know which device this refers to
    if sync_state.get('status') not in ('ready', 'done'):
        return jsonify({'error': 'Run scan first'}), 400

    data = request.json or {}
    device_paths = data.get('device_paths', [])
    if not device_paths:
        return jsonify({'error': 'No paths specified'}), 400

    dap_id = sync_state.get('dap_id')
    if not dap_id:
        return jsonify({'error': 'No active sync session'}), 400

    device_music_path = get_dap_music_path(dap_id)
    if not device_music_path or not device_music_path.exists():
        return jsonify({'error': 'Device not mounted'}), 400

    # Security: only allow deletion of files that were in the last scan's device_only list
    # Prevents path traversal attacks by only allowing pre-approved paths
    allowed = set(sync_state.get('device_only') or [])
    rejected = [p for p in device_paths if p not in allowed]
    if rejected:
        return jsonify({'error': f'{len(rejected)} path(s) were not in the scan results and cannot be deleted.'}), 400

    deleted = []
    errors = []
    for rel in device_paths:
        # Extra security: resolve path and verify it's under device_music_path
        try:
            target = (device_music_path / rel).resolve()
            music_root = device_music_path.resolve()
            if not str(target).startswith(str(music_root) + '/') and target != music_root:
                errors.append(f'{rel}: path escapes music root (rejected)')
                continue
            if target.exists():
                target.unlink()
                # Remove empty parent directories up to music root
                parent = target.parent
                while parent != music_root and parent.exists():
                    if not any(parent.iterdir()):
                        parent.rmdir()
                        parent = parent.parent
                    else:
                        break
                deleted.append(rel)
            else:
                deleted.append(rel)  # already gone, count as success
        except Exception as e:
            errors.append(f'{rel}: {e}')

    return jsonify({
        'deleted': deleted,
        'errors': errors,
        'ok': len(errors) == 0,
    })
```

**Security notes built into this route:**
- Only paths from the most recent scan's `device_only` list are allowed (whitelist).
- Path resolution + prefix check prevents any `../` traversal.
- Empty parent directories are cleaned up (tidy device filesystem).

### 2.2 Frontend: Add "Delete from device" section in preview phase

**File:** `static/index.html` — inside `#sync-phase-preview`, after `#sync-section-device`.

Add a new collapsible section for delete candidates. The section should be **collapsed by default** and require explicit expansion before files are shown:

```html
<!-- Delete from device section — collapsed by default -->
<div id="sync-section-delete" class="sync-section sync-section--danger" style="display:none">
  <div class="sync-section-hdr sync-section-hdr--collapse" onclick="App.syncToggleDeleteSection()">
    <div class="sync-section-hdr-left">
      <!-- trash SVG icon in red/warning colour -->
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2.5" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
      <span class="sync-section-title" style="color:#f87171">Delete from device</span>
      <span class="sync-count-pill sync-count-pill--danger" id="sync-delete-count">0</span>
    </div>
    <span class="sync-section-collapse-arrow" id="sync-delete-arrow">▸ Show files</span>
  </div>
  <!-- File list hidden until user expands -->
  <div id="sync-delete-list-wrap" style="display:none">
    <div class="sync-delete-warning-banner">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2"><path d="M12 3l9 16H3z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      Files deleted from your device cannot be recovered. Check carefully before proceeding.
    </div>
    <label class="sync-check-all">
      <input type="checkbox" id="chk-all-delete" onchange="App.syncToggleAll('delete', this.checked)" />
      Select all
    </label>
    <div class="sync-list" id="sync-list-delete"></div>
  </div>
</div>
```

**File:** `static/app.js`

In `_syncFileRows`, add a `'delete'` variant that renders red-tinted rows with a warning icon instead of a folder icon:
```javascript
function _syncDeleteRows(paths) {
  if (!paths.length) return `<div class="sync-empty">No files to delete.</div>`;
  return paths.map(p => {
    const parts = p.split('/');
    const filename = parts[parts.length - 1];
    const folder = parts.slice(0, -1).join('/');
    return `<label class="sync-file-row sync-file-row--danger">
      <input type="checkbox" class="sync-chk sync-chk-delete" data-path="${esc(p)}" onchange="App.syncSelectionChanged()" />
      <div class="sync-file-path-wrap">
        <span class="sync-file-folder">${esc(folder)}/</span>
        <span class="sync-file-name">${esc(filename)}</span>
      </div>
    </label>`;
  }).join('');
}
```

In `renderSyncPreview`, populate the delete section from `status.device_only`:
```javascript
// device_only files appear in BOTH "copy to local" AND "delete from device"
// The two actions are mutually exclusive per file (selecting delete unchecks copy and vice versa)
document.getElementById('sync-delete-count').textContent = status.device_only.length;
document.getElementById('sync-list-delete').innerHTML = _syncDeleteRows(status.device_only);
document.getElementById('sync-section-delete').style.display =
  status.device_only.length ? 'block' : 'none';
```

Add mutual-exclusion logic: when a user checks a file in the "delete" list, automatically uncheck it in the "copy to local" list, and vice versa.

Add `syncToggleDeleteSection()` to expand/collapse the delete list:
```javascript
function syncToggleDeleteSection() {
  const wrap = document.getElementById('sync-delete-list-wrap');
  const arrow = document.getElementById('sync-delete-arrow');
  const open = wrap.style.display !== 'none';
  wrap.style.display = open ? 'none' : 'block';
  arrow.textContent = open ? '▸ Show files' : '▴ Hide files';
}
```

### 2.3 Frontend: Two-stage delete confirmation flow

**File:** `static/app.js`

When the user clicks "Start Sync" and there are files checked in the delete list, intercept the normal `executeSync` flow with a two-stage confirmation sequence using the existing `_showConfirm()` modal:

**Stage 1 — Review what will be deleted:**
```javascript
const deleteCount = [...document.querySelectorAll('.sync-chk-delete:checked')].length;
if (deleteCount > 0) {
  const deletePaths = [...document.querySelectorAll('.sync-chk-delete:checked')].map(cb => cb.dataset.path);
  const fileList = deletePaths.slice(0, 5).join('\n') + (deletePaths.length > 5 ? `\n…and ${deletePaths.length - 5} more` : '');
  const confirmed1 = await _showConfirm({
    title: `Delete ${deleteCount} file${deleteCount === 1 ? '' : 's'} from device?`,
    message: `The following files will be permanently removed from your device:\n\n${fileList}`,
    okText: `Yes, delete ${deleteCount} file${deleteCount === 1 ? '' : 's'}`,
    danger: true,
  });
  if (!confirmed1) return; // user cancelled

  // Stage 2 — Final irreversible warning
  const confirmed2 = await _showConfirm({
    title: 'This cannot be undone',
    message: `Files deleted from your device cannot be recovered. TuneBridge does not keep a backup.\n\nAre you absolutely sure?`,
    okText: 'Delete permanently',
    danger: true,
  });
  if (!confirmed2) return; // user cancelled at second stage
}
// Proceed with sync + delete
```

After both confirmations pass, include the delete operation alongside the copy operation. The delete call is separate from `/api/sync/execute` — call `/api/sync/delete` after `/api/sync/execute` completes (or in parallel if no copy operations).

Update `_showSyncDone` to report how many files were deleted, with a warning-coloured badge if any were deleted.

---

## 3. UX IMPROVEMENTS

### 3.1 `device_only_sizes` missing from scan result

**File:** `app.py` — `_compute_sync_diff_for_dap()` ~line 2232.

**Problem:** `local_only_sizes` (bytes per file being sent to device) is computed and returned. There is no equivalent `device_only_sizes` for files being copied to local or deleted. This means the space panel can't show how much local drive space is needed for a device→local copy, and the delete section can't show total size being freed.

**Fix:** In `_compute_sync_diff_for_dap`, after computing `local_only_sizes`, add:
```python
device_only_sizes = {}
for rel in device_only:
    src = device_path / rel
    size = 0
    try:
        if src.exists():
            size = int(src.stat().st_size)
    except Exception:
        size = 0
    device_only_sizes[rel] = size
```

Return `device_only_sizes` in the result dict. Propagate it through `sync_state` (add `'device_only_sizes': {}` to the initial state and `sync_state.update(...)` in `do_scan`). Surface it to the frontend via `/api/sync/status`.

In `syncSelectionChanged`, use `_syncLastStatus.device_only_sizes` to show:
- How much local drive space copying device files will require
- How much device space will be freed by deleting selected files (shown as "Freeing X from device" in the space panel)

### 3.2 Poll timer not cleared on navigation away

**File:** `static/app.js` — `closeSyncModal()` ~line 3372.

**Problem:** `clearInterval(_syncPollTimer)` is called in `closeSyncModal()`, which is correct. But if the user navigates away (e.g., clicks a sidebar nav item) while the scan is running, the modal hides but the timer keeps running. The background thread is harmless, but the poll fires every 600ms forever until the next `showSync()` call.

**Fix:** Add a cleanup call in `showViewEl()` or in any nav function that could be called while sync is open:
```javascript
// At the top of showSync(), already has: await api('/sync/reset', ...) which handles re-entry.
// In closeSyncModal() — already correct.
// Add to any sidebar nav function: if sync modal is open, clear the timer.
function closeSyncModal() {
  clearInterval(_syncPollTimer);
  _syncPollTimer = null;
  document.getElementById('sync-modal').style.display = 'none';
  // Reset state so re-open starts fresh
  _syncLastStatus = null;
}
```

Also ensure `showViewEl` (the main view switcher) calls `closeSyncModal()` if the modal is currently visible:
```javascript
function showViewEl(name) {
  // Close sync modal if open when navigating away
  const syncModal = document.getElementById('sync-modal');
  if (syncModal && syncModal.style.display !== 'none') {
    closeSyncModal();
  }
  // ... existing show/hide logic
}
```

### 3.3 Progress bar shows file count, not bytes

**File:** `app.py` — `do_copy()` ~line 2509; `static/app.js` — `executeSync()` poll ~line 3548.

**Problem:** Progress is reported as `N / M files`. For large FLAC files this is meaningless — one 300 MB file takes as long as ten 30 MB files but shows identical progress to them.

**Fix — backend:** Track bytes copied alongside file count in `do_copy()`:
```python
bytes_done = 0
bytes_total = sum(
    int(local_only_sizes.get(rel) or 0) for rel in local_paths
) + sum(
    int((device_path / rel).stat().st_size) if (device_path / rel).exists() else 0
    for rel in device_paths
)
sync_state['bytes_total'] = bytes_total
```

After each successful copy, add the file size to `bytes_done` and update `sync_state['bytes_done']`. Keep the file count progress as well.

**Fix — frontend:** In the copy phase, show both:
```
Copying 12 / 48 files • 1.2 GB / 3.8 GB
```
Update the progress bar width based on bytes percentage when `bytes_total > 0`, falling back to file count percentage otherwise.

### 3.4 Playlist sync status is siloed from Sync modal

**Problem:** The Sync modal only handles music file sync. To also push stale playlists, the user must navigate away, find each playlist, and click "Copy to [DAP]" individually. There is no "sync everything" path.

**Fix — add a playlist section to the sync modal's preview phase.**

**File:** `static/index.html` — inside `#sync-phase-preview`, after the warnings section.

Add a new playlist sync section:
```html
<div id="sync-section-playlists" class="sync-section" style="display:none">
  <div class="sync-section-hdr">
    <div class="sync-section-hdr-left">
      <!-- playlist SVG icon -->
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#adc6ff" stroke-width="2.5"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
      <span class="sync-section-title">Stale playlists</span>
      <span class="sync-count-pill" id="sync-playlist-count">0</span>
    </div>
    <label class="sync-check-all">
      <input type="checkbox" id="chk-all-playlists" onchange="App.syncToggleAll('playlist', this.checked)" checked />
      Select all
    </label>
  </div>
  <div class="sync-list" id="sync-list-playlists"></div>
</div>
```

**File:** `app.py` — add playlist stale data to `/api/sync/scan` response.

In `do_scan()`, after computing the music diff, also compute stale playlists for the DAP and include them in `sync_state`:
```python
playlists = load_playlists()
exports = dap.get('playlist_exports', {}) or {}
stale_playlists = [
    {'id': pl['id'], 'name': pl['name']}
    for pl in playlists.values()
    if pl['id'] in exports and pl.get('updated_at', 0) > exports[pl['id']]
]
sync_state['stale_playlists'] = stale_playlists
```

**File:** `static/app.js` — render playlist rows in `renderSyncPreview`:
```javascript
const stalePlaylists = status.stale_playlists || [];
document.getElementById('sync-playlist-count').textContent = stalePlaylists.length;
document.getElementById('sync-list-playlists').innerHTML = stalePlaylists.length
  ? stalePlaylists.map(pl => `
      <label class="sync-file-row">
        <input type="checkbox" class="sync-chk sync-chk-playlist" data-id="${esc(pl.id)}" checked onchange="App.syncSelectionChanged()" />
        <div class="sync-file-path-wrap"><span class="sync-file-name">${esc(pl.name)}</span></div>
      </label>`).join('')
  : `<div class="sync-empty">All exported playlists are up to date.</div>`;
document.getElementById('sync-section-playlists').style.display =
  stalePlaylists.length ? 'block' : 'none';
```

In `executeSync`, after the music copy completes, export checked playlists:
```javascript
const playlistIds = [...document.querySelectorAll('.sync-chk-playlist:checked')].map(cb => cb.dataset.id);
// After music copy done, sequentially export each selected playlist:
for (const pid of playlistIds) {
  await api(`/daps/${dapId}/export/${pid}`, { method: 'POST' }).catch(() => {});
}
```

Update `_showSyncDone` to show how many playlists were exported.

### 3.5 Path template change warning

**Problem:** If the user changes a DAP's `path_template` after an initial sync, every single track will appear as "to add" on next scan (device has old-template paths, scan expects new-template paths). No warning is shown.

**Fix — backend:** In `_compute_sync_diff_for_dap`, after computing `local_only`, check whether the template may have changed by looking for a high "local_only" ratio:

```python
total_local = len(track_entries)
if total_local > 0 and len(local_only) > 0.8 * total_local and len(device_files) > 0:
    # Most local files are "missing" from device, but device has files — template likely changed
    warnings.append(
        'More than 80% of local tracks are not found on device. '
        'If you recently changed the path template, files may appear as missing '
        'because they were synced under a different filename pattern. '
        'Check your DAP path template in Gear → [DAP name].'
    )
```

This is a heuristic but catches the most common mistake.

### 3.6 "Start Sync" space panel text is wrong when nothing is selected

**File:** `static/app.js` — `syncSelectionChanged()` ~line 3487.

**Problem:** When `noSelection` is true (nothing checked), the space line shows `Required 0 B` which is technically correct but misleading. The `remaining` calc is `available - 0 = available`, showing the full free space as "after sync" when nothing will be synced.

**Fix:** When `noSelection`, show only:
- "Nothing selected — Start Sync to proceed or close."
- Or just show the available space without the misleading "after sync" line.

Update the `noSelection` branch in `syncSelectionChanged`:
```javascript
if (noSelection) {
  spaceLine = available !== null ? `Device free: ${_fmtBytes(available)}` : 'Space check unavailable';
  className += ' sync-space-summary--ok';
}
```

---

## 4. CSS ADDITIONS NEEDED

**File:** `static/style.css`

Add styles for new elements. Insert near the existing `/* Sync modal */` section:

```css
/* Sync delete section */
.sync-section--danger {
  border-left: 2px solid rgba(248, 113, 113, 0.35);
  padding-left: 12px;
}
.sync-section-hdr--collapse {
  cursor: pointer;
  user-select: none;
}
.sync-section-collapse-arrow {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: auto;
}
.sync-file-row--danger {
  color: var(--text-muted);
}
.sync-file-row--danger .sync-file-name {
  color: #f87171;
}
.sync-count-pill--danger {
  background: rgba(248, 113, 113, 0.18);
  color: #f87171;
}
.sync-delete-warning-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(251, 191, 36, 0.08);
  border-radius: 6px;
  font-size: 12px;
  color: #fbbf24;
  margin-bottom: 8px;
}
```

---

## 5. IMPLEMENTATION ORDER

Implement in this order to avoid breaking things mid-way:

1. **`sync_state` thread lock** (§1.1) — low risk, do first
2. **`device_only_sizes` backend field** (§3.1) — needed by later frontend work
3. **Track number template fix** (§1.2) — isolated, low risk
4. **Stale playlist badge fix** (§1.5) — isolated, backend only
5. **Playlist M3U existence check** (§1.6) — backend only
6. **Space check for local drive** (§1.3) — backend + frontend
7. **Library rescan after device→local** (§1.4) — backend only
8. **Poll timer cleanup** (§3.2) — frontend only, isolated
9. **Space panel text fix** (§3.6) — frontend only, trivial
10. **Progress bar bytes** (§3.3) — backend + frontend
11. **Path template warning** (§3.5) — backend only, in `_compute_sync_diff_for_dap`
12. **Delete from device** — backend (§2.1), then HTML (§2.2), then JS (§2.3), then CSS (§4)
13. **Playlist section in sync modal** (§3.4) — HTML, backend, JS

---

## 6. TESTING CHECKLIST

After implementation, verify:

- [ ] Opening Sync modal with a connected DAP loads without errors
- [ ] Scan completes and shows correct file counts
- [ ] "Copy to device" section works as before
- [ ] "Copy to local" section copies files and triggers library rescan hint
- [ ] "Delete from device" section is hidden by default; click header to expand
- [ ] Selecting files in "delete" section unchecks them from "copy to local" (mutual exclusion)
- [ ] Clicking "Start Sync" with files selected in delete section triggers confirm modal 1
- [ ] Confirming once shows the second "cannot be undone" confirm
- [ ] Cancelling at either confirm returns to preview without any deletions
- [ ] After double-confirm, files are deleted from device and empty dirs are cleaned
- [ ] Done phase shows correct counts for: copied, deleted, exported playlists, errors
- [ ] Stale playlist section shows correctly for a DAP that has previously exported playlists
- [ ] A DAP with no prior exports shows 0 in the playlist stale badge (not all playlists)
- [ ] Space summary updates correctly when toggling checkboxes
- [ ] Closing modal mid-scan clears the poll timer
- [ ] Tracks without track-number tags render a clean filename (no "Unknown track")
- [ ] Path template change warning appears when >80% of files are flagged as missing

---

## 7. KEY FACTS FOR THE IMPLEMENTING AGENT

- **Project location:** `/Users/hashan/Documents/Claude/Projects/Playlist Creator/`
- **Run server:** `source venv/bin/activate && python app.py` (port 5001; preview proxy on 5002)
- **All frontend is in three files:** `static/app.js`, `static/index.html`, `static/style.css`
- **All backend is in one file:** `app.py`
- **Confirmation dialogs:** Use the existing `_showConfirm({title, message, okText, danger})` function in `app.js` — it returns a `Promise<bool>`. Do NOT use `window.confirm()`.
- **Toast notifications:** Use `toast(message)` for non-blocking feedback.
- **API calls from frontend:** Use `api('/path', {method, body})` helper — it handles JSON serialisation and error parsing.
- **Existing sync state shape** (add new fields to this, do not rename existing ones):
  ```python
  sync_state = {
      'status',         # idle|scanning|ready|copying|done|error
      'dap_id',
      'message', 'current',
      'progress', 'total',
      'local_only',     # list of device-relative paths (copy to device)
      'device_only',    # list of device-relative paths (on device, not local)
      'warnings',
      'local_copy_map', # {device_rel: local_rel}
      'local_only_sizes',  # {device_rel: bytes}
      # NEW: add these
      'device_only_sizes', # {device_rel: bytes}
      'stale_playlists',   # [{id, name}]
      'bytes_done', 'bytes_total',
      'library_rescan_started',
      # existing space fields...
  }
  ```
- **The `_showConfirm` modal** already has a "danger" variant with a red/pink button. Use `danger: true` for both delete confirmation steps.
- **Do not rename or remove any existing `App` exports** — they are referenced from HTML `onclick` attributes.
- **Add new exported functions** to the `App` object at the bottom of `app.js` (around line 5780+).
