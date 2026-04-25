# TuneBridge Design System V1 (Canonical)

This document is the single source of truth for TuneBridge UI tokens and primitives.

## Core Principles
- One token system (`--tb-*`) for color, type, spacing, radius, elevation, motion.
- Semantic aliases (`--text`, `--accent`, etc.) map to canonical tokens.
- No ad-hoc modal color/radius/shadow values in component CSS.
- Modal and table updates must consume shared primitives before adding view-specific overrides.

## Token Contract
### Color
- Base: `--tb-bg-0`, `--tb-bg-1`
- Surface: `--tb-surface-1`, `--tb-surface-2`, `--tb-surface-3`, `--tb-surface-hover`
- Border: `--tb-border-soft`, `--tb-border-strong`
- Text: `--tb-text-primary`, `--tb-text-secondary`, `--tb-text-muted`, `--tb-text-inverse`
- Semantic: `--tb-accent`, `--tb-accent-strong`, `--tb-success`, `--tb-warning`, `--tb-danger`

### Type
- Step eyebrow: `--tb-font-step-eyebrow`
- Modal title/subtitle: `--tb-font-title`, `--tb-font-subtitle`
- Section/body/caption: `--tb-font-section`, `--tb-font-body`, `--tb-font-body-sm`, `--tb-font-caption`
- Stats: `--tb-font-stat-number`, `--tb-font-stat-label`

### Layout
- Spacing: `--tb-space-1..8`
- Radius: `--tb-radius-xs/sm/md/lg/xl/pill`
- Shadows: `--tb-shadow-shell`, `--tb-shadow-elev-1`, `--tb-shadow-elev-2`
- Motion: `--tb-motion-fast`, `--tb-motion-base`
- Icons: `--tb-icon-inline/control/action/hero`

## Primitive Component Contract
Defined in `static/style.css` and reused everywhere:
- Modal shell: `.tb-modal-overlay`, `.tb-modal-shell`, `.tb-modal--sm|md|lg|xl`
- Modal anatomy: `.tb-modal-header`, `.tb-modal-header-left`, `.tb-modal-icon-tile`, `.tb-modal-body`, `.tb-modal-footer`
- Step rail: `.tb-step-rail`, `.tb-step-dot`
- Buttons: `.tb-btn`, `.tb-btn-primary`, `.tb-btn-secondary`
- Inputs/chips: `.tb-input`, `.tb-chip`

## Usage Rules
- Prefer primitives first; only add local classes for layout/behavior specifics.
- If a new modal needs a unique style, add a new token or primitive variant first.
- Keep headers and footers structurally consistent (icon + text stack + close, bottom step rail where applicable).

## Forbidden Patterns
- Hardcoded hex/rgba colors for modal shells and controls when a token exists.
- Inline style for visual treatment in modal markup.
- New one-off radius/shadow constants in modal selectors.
- Duplicated modal base logic outside shared primitives.

## Sync Modal Parity Notes
- Sync remains functionally complete (actions/ignored/rescan/delete confirm/playlists).
- Visual system now follows shared modal primitives and Stitch-aligned hierarchy.
