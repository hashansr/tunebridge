# TuneBridge Modal Design Spec (Stitch-Ready)

## 1) Design Intent
TuneBridge modals should feel:
- compact, premium, calm
- glass + depth (not foggy)
- high hierarchy clarity
- consistent across all flows

Baseline: **Compact Glass Baseline**

## 2) Type Scale
Use one modal type hierarchy across all overlays:

- `modal-step-eyebrow`: 13px / 700 / 0.12em / uppercase
- `h-modal-title`: 26px / 750
- `h-modal-subtitle`: 18px / 500
- `section-label`: 12px / 700 / uppercase / 0.1em
- `body`: 16px / 500
- `body-sm`: 14px / 500
- `caption`: 12px / 500
- `stat-number`: 30px / 800
- `stat-label`: 18px / 600

## 3) Color System
### Base / Surfaces
- `--tb-bg-0`: `#070A10`
- `--tb-bg-1`: `#0D121C`
- `--tb-surface-1`: `rgba(20, 26, 40, 0.78)`
- `--tb-surface-2`: `rgba(30, 38, 56, 0.78)`
- `--tb-surface-3`: `rgba(43, 56, 82, 0.72)`
- `--tb-surface-hover`: `rgba(68, 89, 126, 0.26)`
- `--tb-border-soft`: `rgba(173, 198, 255, 0.18)`
- `--tb-border-strong`: `rgba(173, 198, 255, 0.38)`

### Text
- `--tb-text-primary`: `#E9EEF9`
- `--tb-text-secondary`: `#AEB9D3`
- `--tb-text-muted`: `#7E89A8`
- `--tb-text-inverse`: `#0F172A`

### Accent / Semantic
- `--tb-accent`: `#ADC6FF`
- `--tb-accent-strong`: `#8FB1FF`
- `--tb-success`: `#4ADE80`
- `--tb-warning`: `#FBBF24`
- `--tb-danger`: `#F87171`

### Gradient
- Modal shell gradient:
  - `linear-gradient(135deg, rgba(34,40,56,0.92) 0%, rgba(23,28,42,0.90) 48%, rgba(24,45,34,0.86) 100%)`

## 4) Spacing, Radius, Shadows
- Spacing scale: `4, 8, 12, 16, 20, 24, 28, 32`
- Modal paddings:
  - header: `20px 24px 12px`
  - body: `0 24px`
  - footer: `14px 24px 20px`
- Radius:
  - chip/input: `12px`
  - cards/rows: `14px`
  - modal shell: `22px`
  - icon tile: `16px`
  - pill buttons: `999px`
- Shadows:
  - shell: `0 24px 60px rgba(0,0,0,.45)`
  - hover: `0 0 0 1px var(--tb-border-strong) inset`

## 5) Modal Shell Standard
- Pane-scoped overlay (content pane only), onboarding is full-screen exception.
- Size tiers:
  - `modal-sm`: 560w
  - `modal-md`: 760w
  - `modal-lg`: 920w
  - `modal-xl`: 1080w
- Max height: `min(84vh, 860px)`
- Header fixed, body scrollable, footer fixed when action-heavy.
- Remove decorative horizontal separators unless semantically needed.
- Step indicator uses bottom dot/pill rail.

## 6) Header Standard
- Left: icon tile + step/title/subtitle stack
- Right: close button
- Icon tile:
  - 56x56
  - icon 28
  - aligned to text stack center line
- Step label above title.
- Subtitle single line when possible.

## 7) Footer Standard
- Left: step rail dots/pill
- Right: secondary then primary CTA
- Destructive uses danger style
- Disable states:
  - lowered opacity
  - no glow
  - cursor `not-allowed`

## 8) Component Standards
### Buttons
- Primary pill (accent fill)
- Secondary pill (surface fill + border)
- Ghost icon button
- Danger pill (red tint, no neon)

### Inputs
- Height 48
- Radius 12
- Border soft default, accent on focus
- Placeholder muted

### Chips/Badges/Pills
- Status pills: success/warn/danger/neutral
- Filter chips: active accent tint
- Count badges compact, min width 26

### Tables
- Sticky header inside scroll container
- No wrapped headers
- Left-align data cells by default
- Icon-only action cells allowed
- Horizontal scroll for dense columns

### Accordions
- Header radius top-only when expanded
- Content panel seamlessly joins with squared top corners
- Chevron rotates 180 on open

## 9) Iconography
- One icon set / stroke family per modal
- Sizes:
  - 16 inline
  - 20 controls
  - 24 close/action
  - 28 hero icon tile
- Stroke: 1.75–2
- Keep icon color tied to text tier unless semantic

## 10) Interaction + Accessibility
- ESC closes unless blocked state
- Click backdrop closes unless dirty/busy guard
- Focus ring visible for all controls
- Minimum contrast:
  - body text 4.5:1
  - large text 3:1
- Keyboard nav for all modal controls

## 11) Sync Modal Specific Rules
- 5-step flow with bottom step rail
- No top progress strip
- Compact shell
- Header icon per phase
- Step 3 uses explicit discrepancy action sections
- Step 4/5 strong progress/status hierarchy
- Keep typography compact (no oversized headline text)

## 12) Stitch Do/Don't
### Do
- reuse same token map and component primitives
- keep modal compact and dense
- preserve TuneBridge dark luminous style
- keep CTA hierarchy consistent

### Don't
- enlarge modal to near fullscreen by default
- invent new random accent hues
- mix multiple radius systems
- add heavy separators that reduce clarity
