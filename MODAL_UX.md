# TuneBridge Modal UX Policy

Status: Active

Primary baseline reference:
- `SYNC_MODAL_BASELINE.md` (design/UI/UX/behavior standard used to normalize all non-onboarding modals)

## Intent
Keep modal interactions premium, predictable, and low-friction while preserving context (sidebar + player) for routine tasks.

## Modal Types

1. Pane-scoped overlays (default)
- Use for forms and short tasks: add/edit device, add/edit IEM, imports, helper dialogs.
- Overlay only the active content area.
- Sidebar and player remain visible.

2. Full-screen overlays (exception)
- Use only for first-run onboarding and similarly high-focus onboarding flows.

3. Workspace/page surfaces (not modal)
- Use for deep, multi-step editing workflows (for example Custom PEQ workspace).

## Navigation Behavior

When users click left-nav while a pane-scoped modal is open:
- Attempt to close the modal and continue navigation.
- If the modal has unsaved data, prompt for discard first.
- If user cancels, stay on current screen and keep modal open.

## Unsaved Warning Coverage

Warn on navigation-away for:
- DAP add/edit modal
- IEM add/edit modal
- PEQ upload modal
- Create playlist modal
- Import modal mappings
- Sync modal while scanning/copying
- Custom PEQ workspace (existing guard)
- ML generator preview (existing guard)

## Layout Rules

- Pane-scoped overlays should start below top chrome and above player.
- Avoid oversized wide modals; keep density aligned with app rhythm.
- Keep header/action spacing compact and consistent with `master-design.md`.

### IEM Modal Baseline Tokens (Reusable)

Use these as the baseline spacing/density values when standardizing other form modals:

- `--iem-control-height`: `48px`
- `--iem-section-gap`: `8px`
- `--iem-section-pad-y`: `10px`
- `--iem-section-first-top`: `12px`
- `--iem-section-first-bottom`: `6px`
- `--iem-section-title-gap`: `12px`
- `--iem-label-gap`: `6px`
- `--iem-actions-gap-top`: `8px`
- `--iem-actions-pad-top`: `10px`
- `--iem-source-row-gap`: `6px`
- `--iem-source-label-col`: `170px`

Behavior notes for this baseline:
- Optional source labels are supported per measurement URL row.
- If a source label is provided, FR graph source dropdowns should display that label.
- If label is blank, fallback naming is allowed (`Source 1`, `Source 2`, etc.).

## Implementation Notes

Primary files:
- `static/app.js` (navigation/modal guards + dirty checks)
- `static/style.css` (pane-scoped vs full-screen overlay layout)
