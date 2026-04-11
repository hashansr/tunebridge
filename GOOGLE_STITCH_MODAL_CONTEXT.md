# TuneBridge Modal Redesign Context (Google Stitch Handoff)

Status: Draft for redesign handoff
Branch: `feature/modal-ux-facelift`
Scope: All overlay modals except onboarding

## 1. Product Context
TuneBridge is a desktop music app with:
- Persistent left navigation
- Persistent bottom player bar
- Content views in the main area

Current modal policy (target UX):
- Standard modals are pane-scoped (main content area only), not full-app takeover.
- Sidebar and player stay visible.
- Exception: onboarding remains full-screen takeover.

## 2. Modal Inventory
Total overlay modals in app: `18`
- Redesign scope: `17` (exclude onboarding)

Redesign modals (IDs):
1. `iem-compare-modal`
2. `problem-tracks-modal`
3. `genre-distribution-modal`
4. `iem-blindspot-modal`
5. `dup-modal`
6. `import-modal`
7. `help-modal`
8. `settings-modal` (legacy/low-priority)
9. `sync-modal`
10. `rename-modal`
11. `dap-modal`
12. `iem-modal`
13. `peq-modal` (PEQ profile upload)
14. `confirm-modal` (generic confirm)
15. `create-playlist-modal`
16. `ml-gen-modal`
17. `ml-ref-modal`

Excluded:
- `onboarding-modal` (must remain full-screen)

Related non-modal takeover surface (not in this redesign):
- `peq-workspace` (full workspace/editor surface)

## 3. Per-Modal Functional Context

### 3.1 `iem-compare-modal` (IEM FR Compare)
- Purpose: Compare selected IEM/headphone FR curves.
- Inputs: none (data selected before open).
- Content: chart canvas + legend toggles.
- Primary action: inspect/close.
- Data source: compare API result already built in app.

### 3.2 `problem-tracks-modal`
- Purpose: Show tracks needing metadata/analysis attention.
- Inputs: none.
- Content: list/table-like diagnostics.
- Primary action: inspect/close.

### 3.3 `genre-distribution-modal`
- Purpose: Expanded genre distribution list.
- Inputs: none.
- Content: ranked list of genres/counts.
- Primary action: inspect/close.

### 3.4 `iem-blindspot-modal`
- Purpose: Full “blindspot genres” view for selected IEM.
- Inputs: none in modal body.
- Content: scrollable analysis list.
- Primary action: inspect/close.

### 3.5 `dup-modal` (Duplicate Warning)
- Purpose: Resolve duplicate add-to-playlist conflict.
- Inputs: none.
- Actions:
- `Cancel`
- `Skip Duplicates`
- `Add Anyway`
- Data gathered: user decision only.

### 3.6 `import-modal` (Playlist Import Confirmation)
- Purpose: Confirm imported playlist details and mappings.
- Inputs:
- `import-name-input` (playlist name override)
- Dynamic mapping rows for unmatched entries (search + select)
- Actions:
- `Cancel`
- `Import Playlist`
- Data gathered:
- Target playlist name
- Mapped track IDs for unmatched entries

### 3.7 `help-modal`
- Purpose: Help center / operational guidance.
- Inputs: none.
- Content: docs-style sections + dynamic device info.
- Primary action: close.

### 3.8 `settings-modal` (Legacy)
- Purpose: Legacy settings block (mount/prefix paths).
- Inputs:
- `s-poweramp-mount`
- `s-poweramp-prefix`
- `s-ap80-mount`
- Actions:
- `Cancel`
- `Save`
- Data gathered: 3 legacy path settings.
- Note: Lower product priority vs main Settings page.

### 3.9 `sync-modal` (Multi-step flow)
- Purpose: Run scan + selective sync to DAP.
- Structure: phased modal (`pick`, `scanning`, `preview`, `copying`, `done`)
- Inputs:
- `chk-all-local`, `chk-all-device` (selection helpers)
- Actions:
- `Cancel` / `Start Sync` / `Run Another Scan` / `Close`
- Data gathered:
- Selected DAP
- Selected add/remove operations
- Critical UX constraint: while scan/copy active, warn before dismissing.

### 3.10 `rename-modal`
- Purpose: Rename playlist.
- Input:
- `rename-input`
- Actions:
- `Cancel`
- `Rename`
- Data gathered: new playlist name.

### 3.11 `dap-modal` (Add/Edit Digital Audio Player)
- Purpose: Configure DAP for sync/export.
- Inputs:
- Identity: hidden IDs + mount selection/manual path
- Device metadata: name, model
- Music settings: root path, template preset, custom template
- Playlist settings: export folder, optional prefix
- Actions:
- `Cancel`
- `Save Device`
- Data gathered:
- DAP profile used for path generation and sync behavior.
- Unsaved warning: required on dismiss/navigation.

### 3.12 `iem-modal` (Add/Edit IEM/Headphone)
- Purpose: Add/edit listening gear profile.
- Inputs:
- `iem-name`
- `iem-type`
- Up to 3 labeled measurement source URLs (squig.link)
- Actions:
- `Cancel`
- `Save IEM`
- Data gathered:
- IEM metadata + source URLs.
- Unsaved warning: required on dismiss/navigation.

### 3.13 `peq-modal` (Upload PEQ Profile)
- Purpose: Upload PEQ text file to current IEM.
- Inputs:
- `peq-name`
- `peq-file-input` (`.txt`, `.peq`)
- Actions:
- `Cancel`
- `Upload`
- Data gathered:
- profile name
- uploaded file content
- Unsaved warning: required when name/file selected.

### 3.14 `confirm-modal` (Generic Confirmation)
- Purpose: Reusable confirm dialog for destructive/risky actions.
- Inputs: none.
- Actions:
- configurable OK (danger/neutral)
- configurable Cancel
- Data gathered: boolean decision.

### 3.15 `create-playlist-modal`
- Purpose: Create a new playlist (optionally with preselected tracks).
- Input:
- `create-playlist-input`
- Actions:
- `Cancel`
- `Create`
- Data gathered: playlist name.
- Unsaved warning: if name typed but not submitted.

### 3.16 `ml-gen-modal` (Smart Playlist Generator)
- Purpose: Generate playlists from genre/seed controls.
- Inputs:
- Name
- Mode, target genre, length, mood, year range
- Sliders (energy/brightness/diversity/smoothness)
- Reference track selection controls
- Actions:
- `Preview`, `Regenerate`, `Save Playlist`, `Close`
- Data gathered:
- generation config + selected reference tracks.
- Unsaved warning already required for generated preview.

### 3.17 `ml-ref-modal` (Reference Track Browser)
- Purpose: Search/select reference tracks for ML generator.
- Input:
- `ml-ref-search`
- Actions:
- `Cancel`
- `Use Selected`
- Data gathered: selected reference track IDs.

## 4. UX Behavior Requirements

### 4.1 Navigation while modal is open
- Left-nav clicks should close modal and navigate.
- If modal has unsaved changes, show discard warning first.
- If user cancels warning, keep modal open and remain on current view.

### 4.2 Dismissal rules
- Support close button everywhere.
- Click-outside close only where safe (not for destructive/complex phases).
- `Esc` should close modal when no blocking state is active.

### 4.3 Unsaved/active-process warnings
Current required protections:
- DAP modal dirty form
- IEM modal dirty form
- PEQ upload modal dirty
- Create playlist modal dirty
- Import modal with pending mapping data
- Sync modal during scan/copy
- ML generator unsaved preview
- PEQ workspace unsaved edits (outside modal scope but keep consistent language)

### 4.4 Density and sizing
- Avoid large empty top/bottom space.
- Keep modal shell compact and top-biased in pane-scoped overlay.
- Prefer dynamic height with internal scrolling for long content.

## 5. Visual System Constraints (from `master-design.md`)

### 5.1 Colors/tokens
- `--bg`: `#131313`
- `--bg-elevated`: `#1c1b1b`
- `--bg-hover`: `#2a2a2a`
- `--bg-active`: `#353534`
- `--accent`: `#adc6ff`
- `--accent-secondary`: `#ffb3b5`
- `--accent-success`: `#53e16f`
- `--text`: `#e5e2e1`
- `--text-sub`: `#c1c6d7`
- `--text-muted`: `#6b6b7b`
- `--border`: `rgba(65,71,85,0.15)`

### 5.2 Typography
- Canonical app font: system stack (do not replace globally).
- Header rhythm:
- Page/modal title style should align to existing hierarchy.
- Overlines/labels:
- uppercase, compact tracking, restrained use.

### 5.3 Radius/elevation
- Radius families:
- small components: ~8-12px
- cards/modals: ~20-24px
- pills/buttons: `9999px`
- Shadows:
- soft, ambient, tinted, never harsh.

### 5.4 Modal style language
- Glassmorphism shell with layered dark surfaces.
- Subtle ghost borders.
- Blue is primary action color.
- Keep danger actions in pink/red tonal variants.

### 5.5 Iconography
- No emoji in runtime UI.
- Keep icon family/stroke consistent in each modal.
- Small controls: ~14-16px icon sizing.

## 6. Redesign Guidance for Stitch

### 6.1 What to optimize
- Stronger consistency across all 17 modals.
- Better spacing cadence with less dead area.
- Clear primary/secondary CTA hierarchy.
- Cleaner step clarity in sync and ML modals.
- Better field grouping in DAP/IEM forms.

### 6.2 What not to break
- Existing data model and field intent.
- Existing functional actions/flow logic.
- Sidebar/player persistence for pane-scoped modals.
- Onboarding full-screen exception.

### 6.3 Recommended component primitives
- One shared modal shell component
- Header slot (title, subtitle optional, close)
- Body slot with standardized section spacing
- Sticky footer action row for long forms
- Shared input/select row patterns
- Reusable confirm dialog variant

## 7. Engineering Handoff Notes

When converting Stitch output into code:
- Preserve existing IDs and event hooks where feasible.
- Keep modal IDs stable (many app functions query by ID).
- Verify keyboard focus order + `Esc` behavior.
- Re-test unsaved guards across all covered modals.
- Re-test pane-scoped placement against sidebar/player at responsive breakpoints.

## 8. Acceptance Checklist
- Modal looks/spacing align with TuneBridge design system.
- Primary actions are obvious; destructive actions clearly separated.
- No modal introduces full-app takeover (except onboarding).
- Unsaved warning behavior works for all required flows.
- Sync/ML multi-step flows remain understandable and recoverable.
- Sidebar and player remain visible during pane-scoped modal use.
