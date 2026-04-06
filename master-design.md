# TuneBridge Master Design System

Status: v1.0 Locked (implementation-aligned)
Owner: Product + Design + Engineering
Scope: TuneBridge macOS app (webview UI)

## 1. Purpose
This document is the single source of truth for TuneBridge UI, UX, visual language, and interaction behavior.

Use this file to:
- Design new screens/components.
- Review UI changes for consistency.
- Define acceptance criteria for frontend implementation.
- Avoid style drift between pages (Gear, Favourites, Insights, Library views).

If a new UI pattern is needed, update this file first (or in the same PR) before shipping.

## 2. Design North Star
TuneBridge uses a dark, premium visual language inspired by "Luminous Depth / Obsidian Gallery":
- Tonal layering over hard lines.
- Soft atmospheric glow over sharp contrast.
- Editorial hierarchy (clear title rhythm + restrained metadata).
- Dense enough for power users, but never cramped.

## 3. Core Principles
1. No-line hierarchy first.
- Prefer tonal contrast, spacing, and subtle glow.
- Use thin ghost borders only when needed for affordance.

2. Rhythm over noise.
- Preserve consistent vertical rhythm between title, controls, content.
- Keep paddings and gaps in shared ranges (see spacing scale).

3. Surface consistency.
- Cards/modals/dropdowns should feel from one family.
- Same corner radius families and shadow behavior across pages.

4. Functional color semantics.
- Blue = primary interaction.
- Green = success/synced/healthy.
- Amber = warning/out of sync.
- Pink = danger/remove/error context.

5. Action clarity.
- Primary CTA is visually obvious.
- Secondary actions are subdued but discoverable.

## 4. Tokens (Canonical)
Derived from current `static/style.css` and approved facelift work.

### 4.1 Color Tokens
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

- `--border` (ghost): `rgba(65,71,85,0.15)`
- `--border-focus`: `rgba(173,198,255,0.4)`

### 4.2 Typography Tokens
- `--text-xs`: `11px`
- `--text-sm`: `12px`
- `--text-base`: `13px`
- `--text-md`: `14px`
- `--text-lg`: `15px`

Page title pattern:
- Common page headers: `22px`, `700`, `-0.02em` tracking.

Editorial section label pattern:
- Overline: uppercase, `11px`, `700`, `0.1em` tracking.

Typography source of truth:
- Keep the current system font stack as canonical for production UI.
- Do not introduce a new global font without first updating this document and validating app-wide visual impact.

### 4.3 Radius Tokens
- `--radius`: `12px`
- `--radius-lg`: `24px`
- Full pill: `9999px`

### 4.4 Spacing Rhythm (Reference)
- Standard page content padding: `28px 32px`
- View header bottom spacing: `20px`
- Section-to-content gap: `16px` to `20px`
- Between major sections on same page: `32px`
- Card grid gaps: `16px` to `18px`

### 4.5 Glassmorphism & Surface Tint
- Floating surfaces (modals, dropdowns, elevated cards) should use glass treatment.
- Standard backdrop blur: `20px`.
- Hero/spotlight blur: up to `40px` where hierarchy needs stronger depth.
- Surface tint should use semi-transparent high-surface overlays so background tones subtly bleed through.

### 4.6 Elevation & Shadow Ranges
- Ambient shadow should be soft and “felt,” not sharp.
- Recommended range:
  - Blur: `40px` to `80px` for major floating surfaces.
  - Opacity: `4%` to `8%`.
- Prefer tinted shadows (accent-influenced) over pure black where possible.
- Inner shadows are discouraged in primary UI surfaces.

## 5. Layout Rules

### 5.1 Page Frame
- Use shared `.view` rhythm (`28px 32px`) unless content is specialized (e.g., playlist detail hero).
- Preserve bottom safe area for persistent player.

### 5.2 Headers
- Header = title block left, controls right.
- On narrower screens, controls wrap below title (left-aligned).

### 5.3 Grid Consistency
For Artist and Album card families (including Favourites inline panels):
- Desktop target: 6 columns on large screens.
- Responsive breakpoints:
  - `<=1460px`: 5 cols
  - `<=1220px`: 4 cols
  - `<=980px`: 3 cols
  - `<=720px`: 2 cols
  - `<=520px`: 1 col

## 6. Component Standards

### 6.1 Buttons
- Primary CTA: soft blue gradient/pill shape.
- Secondary CTA: dark pill with ghost border or tonal surface.
- Danger CTA: pink/red tonal variant; reserve for destructive actions.
- "Play All": use icon + clear emphasis where it is the dominant action.
- Pill button shape: `9999px` radius.
- Pill button spacing guidance:
  - Vertical: equivalent of `spacing-2.5`.
  - Horizontal: equivalent of `spacing-6`.
- Hover treatment should increase visual lift/brightness subtly without introducing noisy color shifts.

### 6.2 Cards
Card construction:
- Tonal gradient surface + subtle ghost border.
- Optional radial tint for depth.
- Soft ambient shadow.
- Hover lifts slightly (`translateY(-1px to -2px)`) and brightens border.

### 6.3 Status Chips / Pills
- Synced/success: green tone.
- Warning/out-of-sync: amber tone.
- Neutral/not checked: muted neutral tone.
- Use concise labels with optional icon glyph.

### 6.4 Data Visualization & Progress Bars
- Progress/bar tracks should sit on high-surface tonal bases.
- Indicator colors should follow semantic mapping:
  - Success/healthy: green.
  - Warning/risk: amber.
  - Error/critical: pink/red.
- Avoid fully rounded “capsule” bar caps for analytical charts unless explicitly required by chart intent.
- Prefer sharp or subtle radii for instrument-like readability.

### 6.5 Tables
- Keep row heights consistent regardless of item count.
- Header should not overlap filter/sort controls.
- Actions and favorite controls should have explicit columns where needed.

### 6.6 Input Fields
- Input backgrounds should use low/elevated tonal surfaces.
- Avoid heavy full-border treatments as a default.
- Focus state should prioritize glow/contrast change over hard outline blocks.
- Bottom-edge glow accent is preferred where context supports it.

### 6.7 Modals
- Glassmorphism shell, layered dark surface.
- Clear header with title/subtitle.
- Vertical rhythm should prioritize scanability.
- Long modals must remain scrollable.

## 7. Iconography Rules
1. Prefer SVG or curated PNG assets.
2. Emoji is prohibited in runtime UI surfaces (hard rule).
3. Icon size should align to component density:
- Small controls: 14px to 16px.
- Card leading icons: 30px to 32px container.
4. IEM/Headphone icons use dedicated assets and must maintain app tone (muted-luminous, not flat high-contrast stickers).
5. Use one icon style family per context (avoid mixed stroke weights within the same toolbar).

## 8. Interaction & Behavior Contracts

### 8.1 Playback + Shuffle
- Play/Play All from Artists, Albums, Playlists, Favourites must respect player shuffle state.
- With shuffle ON:
  - Play/Play All should start from a randomized first track on each trigger.
  - Explicit single-track play (row selection/double-click) should preserve chosen start track.

### 8.2 Sync Status UX
- Cached/estimated states must be clearly labeled as estimated.
- User-triggered "Check Sync Status" provides verified state.
- Do not imply "synced" if never verified on connected media.

### 8.3 Empty States
- Empty states should be contextual and action-oriented.
- Keep message + one clear recovery CTA where relevant.

## 9. Page-Specific Notes

### 9.1 Gear
- Must visually match Favourites/Insights card language.
- Title hierarchy and section spacing follow global rhythm.
- DAP + IEM cards share surface style, with information hierarchy adapted to content.

### 9.2 Favourites
- Overview cards are top-level selectors.
- Detail content opens inline below cards to minimize navigation depth.
- Favourite Songs behaves as a standard playlist-detail experience with favourite-specific copy only where required.

### 9.3 Insights
- Keep compact data-dense layouts.
- Avoid redundant info sidebars when primary area already contains same data.

## 10. Accessibility & Readability
- Never use pure white for main text on obsidian backgrounds.
- Maintain color + text cues for statuses (not color-only).
- Ensure interactive targets remain usable at compact density.

## 10.1 Do / Don’t Rules
### Do
- Use asymmetry intentionally where it improves hierarchy (for example, left-weighted title blocks with right-side utility controls).
- Let negative space carry hierarchy; avoid over-framing every block.
- Keep semantic color usage consistent across screens.

### Don’t
- Don’t use `#FFFFFF` as default body text on dark surfaces.
- Don’t introduce arbitrary radius values outside the established radius scale.
- Don’t rely on inner shadows for depth.
- Don’t add new component variants without documenting them in this file.

## 11. Governance (How We Keep This Accurate)
For every UI change PR:
1. Validate against this file.
2. If introducing a new pattern, update this file in same PR.
3. Add short entry in `codex.md` summarizing design-system impact.
4. Complete the UI checklist in `README.md` before merge.

## 12. Definition of Done for UI Changes
A UI task is done only if:
- It matches token usage and spacing rhythm from this document.
- It is consistent with adjacent screens.
- Hover/focus/active states are coherent.
- Empty/loading/error states are handled.
- Behavior contracts (e.g., shuffle/sync status semantics) are preserved.

## 13. Implementation References
Primary implementation files:
- `static/style.css`
- `static/index.html`
- `static/app.js`
- `static/player.js`

Living context and decision log:
- `codex.md`

---

## 14. Locked Decisions
1. Typography:
- System font stack remains canonical.

2. Icon policy:
- Emoji in runtime UI is prohibited (hard rule).

3. Border policy:
- Keep ghost-border fallback as the standard when containment affordance is required.

4. Grid breakpoint policy:
- Artist/album-family card grid ladder is canonical:
  - 6 → 5 → 4 → 3 → 2 → 1

## 15. Design Changelog
- 2026-04-06: v1.0 locked.
  - Canonicalized system font stack.
  - Locked icon rule (no emoji in runtime UI).
  - Locked ghost-border fallback policy.
  - Locked artist/album grid breakpoint ladder.
  - Added governance tie-in to `README.md` UI checklist.
- 2026-04-06: v1.1 patch.
  - Added explicit glass/surface tint guidance.
  - Added elevation/shadow numeric ranges.
  - Added data-viz/progress-bar styling rules.
  - Added input behavior rules.
  - Added stronger Do/Don’t guidance.
