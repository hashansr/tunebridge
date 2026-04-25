---
name: TuneBridge Modal System
colors:
  surface: '#121317'
  surface-dim: '#121317'
  surface-bright: '#38393d'
  surface-container-lowest: '#0d0e11'
  surface-container-low: '#1a1b1f'
  surface-container: '#1e1f23'
  surface-container-high: '#292a2d'
  surface-container-highest: '#343538'
  on-surface: '#e3e2e7'
  on-surface-variant: '#c4c6d0'
  inverse-surface: '#e3e2e7'
  inverse-on-surface: '#2f3034'
  outline: '#8e909a'
  outline-variant: '#44474f'
  surface-tint: '#adc6ff'
  primary: '#d8e2ff'
  on-primary: '#122f5f'
  primary-container: '#adc6ff'
  on-primary-container: '#385283'
  inverse-primary: '#455e90'
  secondary: '#afc6ff'
  on-secondary: '#002d6d'
  secondary-container: '#1c448b'
  on-secondary-container: '#94b4ff'
  tertiary: '#ffdea4'
  on-tertiary: '#412d00'
  tertiary-container: '#ebc06e'
  on-tertiary-container: '#6c4d01'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#d8e2ff'
  primary-fixed-dim: '#adc6ff'
  on-primary-fixed: '#001a42'
  on-primary-fixed-variant: '#2c4677'
  secondary-fixed: '#d9e2ff'
  secondary-fixed-dim: '#afc6ff'
  on-secondary-fixed: '#001944'
  on-secondary-fixed-variant: '#1c448b'
  tertiary-fixed: '#ffdea5'
  tertiary-fixed-dim: '#ebc06e'
  on-tertiary-fixed: '#261900'
  on-tertiary-fixed-variant: '#5d4200'
  background: '#121317'
  on-background: '#e3e2e7'
  surface-variant: '#343538'
  bg-deep: '#070A10'
  bg-base: '#0D121C'
  surface-1: rgba(20, 26, 40, 0.78)
  surface-2: rgba(30, 38, 56, 0.78)
  surface-3: rgba(43, 56, 82, 0.72)
  surface-hover: rgba(68, 89, 126, 0.26)
  border-soft: rgba(173, 198, 255, 0.18)
  border-strong: rgba(173, 198, 255, 0.38)
  text-primary: '#E9EEF9'
  text-secondary: '#AEB9D3'
  text-muted: '#7E89A8'
  text-inverse: '#0F172A'
  success: '#4ADE80'
  warning: '#FBBF24'
  danger: '#F87171'
  modal-gradient: linear-gradient(135deg, rgba(34,40,56,0.92) 0%, rgba(23,28,42,0.90)
    48%, rgba(24,45,34,0.86) 100%)
typography:
  modal-step-eyebrow:
    fontFamily: manrope
    fontSize: 13px
    fontWeight: '700'
    letterSpacing: 0.12em
  h-modal-title:
    fontFamily: manrope
    fontSize: 26px
    fontWeight: '750'
    lineHeight: '1.2'
  h-modal-subtitle:
    fontFamily: manrope
    fontSize: 18px
    fontWeight: '500'
    lineHeight: '1.4'
  section-label:
    fontFamily: manrope
    fontSize: 12px
    fontWeight: '700'
    letterSpacing: 0.1em
  body:
    fontFamily: manrope
    fontSize: 16px
    fontWeight: '500'
    lineHeight: '1.5'
  body-sm:
    fontFamily: manrope
    fontSize: 14px
    fontWeight: '500'
    lineHeight: '1.5'
  caption:
    fontFamily: manrope
    fontSize: 12px
    fontWeight: '500'
    lineHeight: '1.4'
  stat-number:
    fontFamily: manrope
    fontSize: 30px
    fontWeight: '800'
    lineHeight: '1.1'
  stat-label:
    fontFamily: manrope
    fontSize: 18px
    fontWeight: '600'
    lineHeight: '1.2'
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 20px
  2xl: 24px
  3xl: 28px
  4xl: 32px
  modal-header-p: 20px 24px 12px
  modal-body-p: 0 24px
  modal-footer-p: 14px 24px 20px
---

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
