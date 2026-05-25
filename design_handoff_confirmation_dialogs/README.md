# Handoff: TuneBridge Confirmation Dialog System

## Overview

A unified design system for **confirmation, warning, and informational dialogs** in TuneBridge. Replaces five inconsistent dialogs (Already in Playlist, Delete DAP, Delete Playlist, Save Custom EQ, Support TuneBridge) with one cohesive shell that handles destructive actions, unsaved-changes prompts, warnings, and one-button acknowledgements.

Confirmation dialogs are **decisions, not forms** — a single question with one clear answer. They are a subsystem of the broader TuneBridge modal language (see `TuneBridge Modal System.html`) and share its primitives (buttons, close affordance, surface colours, type ramp).

## About the Design Files

The files in this bundle are **design references created in HTML/React-via-Babel** — prototypes showing intended look and behaviour, not production code to copy directly. The task is to **recreate these designs in the TuneBridge codebase's environment** (the existing Electron / SwiftUI / web stack), using its established patterns and component conventions.

The JSX in `confirmation-system.jsx` is a faithful reference implementation: the props API, state shape, and styling values are all intentional and should map cleanly onto whatever component layer the app uses.

## Fidelity

**High-fidelity.** All colours, spacing, radii, type sizes, icon sizes, and footer button orderings are final. The developer should reproduce them exactly. Hex values and pixel measurements are listed in the **Design Tokens** section below.

---

## Anatomy

```
┌────────────────────────────────────────────────────┐
│  [icon]  Title                              [×]    │  ← header
│                                                    │
│  Body paragraph explaining the consequence         │  ← body (flush-left)
│  in 1–2 short sentences.                           │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │ ▪ Context primary                            │  │  ← optional ContextStrip
│  │   Context secondary                          │  │
│  └──────────────────────────────────────────────┘  │
├────────────────────────────────────────────────────┤  ← hairline (1px rgba .06)
│                              [Cancel]  [Confirm]   │  ← footer
└────────────────────────────────────────────────────┘
```

- **Width** is fixed: `420px` (compact, default) or `480px` (`wide` — long-form copy only, e.g. Support TuneBridge).
- **Height** is determined by content. Do not stretch.
- **Padding**: `18px` left/right on header, body, and footer. Body uses the same left edge as the icon (flush) — not indented under the title.
- **Header gap**: `12px` between icon and title block.
- **Body gap**: `12px` between paragraphs and the optional context strip.

---

## Kinds (5)

| Kind      | Tint      | Icon       | Use                                                                 |
|-----------|-----------|------------|---------------------------------------------------------------------|
| `danger`  | `#ffb3b5` | trash      | Irreversible removals (delete playlist, delete DAP, clear library). |
| `warning` | `#f0b429` | warning ▲  | "Already exists" / operations with notable side effects.            |
| `prompt`  | `#adc6ff` | alert (!)  | Unsaved-changes / leave-without-saving questions.                   |
| `info`    | `#adc6ff` | info (i)   | General confirmations and informational asks (e.g. support nag).    |
| `success` | `#53e16f` | checkmark  | Post-action acknowledgement ("Sync complete").                      |

Each kind drives:
1. The **icon tint** (color value).
2. The **default `confirmTone`** for the right-most button (`danger` → BtnDanger pink ghost; everything else → BtnPrimary blue).

The icon is a **bare tinted glyph**, 24×24. **No background plate, no border, no outline.** SVGs are in `assets/icons/` and use `fill="currentColor"`.

---

## Component API (`<Confirm>`)

```jsx
<Confirm
  kind          // 'danger' | 'warning' | 'prompt' | 'info' | 'success'
  title         // string. Imperative or question. Ends in '?' only if a question.
  body          // string | ReactNode. Plain copy or rich markup.
  context       // optional <ContextStrip> — describes the affected item.
  confirmLabel  // string | ReactNode. The committing action label.
  confirmTone   // 'danger' | 'primary' | 'secondary'. Defaults from kind.
  cancelLabel   // string. Defaults to 'Cancel'. Pass '' to hide.
  altLabel      // optional 3rd action (ghost, leftmost). Use sparingly.
  onConfirm     // () => void
  onCancel      // () => void
  onAlt         // () => void
  onClose       // () => void. Defaults to onCancel. For the × glyph.
  wide          // boolean. true = 480px. Default 420px.
  showClose     // boolean. Default true. Hide the × if needed.
/>
```

### `<Acknowledge>` (one-button variant)

```jsx
<Acknowledge
  kind          // default 'success'
  title
  body
  context
  buttonLabel   // default 'OK'
  onClose
  wide
/>
```

### `<ContextStrip>` (affected-item ledger row)

```jsx
<ContextStrip
  primary       // string. Item name. 12.5px / 500 / text colour.
  secondary     // optional string. 11.5px / muted.
  swatch        // optional CSS background. Renders 24×24 swatch on the left.
  mono          // boolean. Use monospace font (for paths, IDs).
/>
```

- Surface: `rgba(255,255,255,0.025)` background, `rgba(255,255,255,0.05)` 1px border, `radius: 7px`, `padding: 8px 11px`.
- Replaces the legacy inline `title — subtitle` lines.

---

## Footer patterns

macOS convention throughout: **Cancel left, committing action right.** Default action gets focus via `autoFocus`.

1. **Destructive** — `[Cancel]  [Delete]` — secondary button left, BtnDanger right.
2. **Affirmative** — `[Cancel]  [Save]` — secondary left, BtnPrimary right.
3. **Three-option (prompt)** — `[Discard]  ……  [Cancel]  [Save]` — ghost-left + secondary + primary. Reserved for unsaved-changes.
4. **Either-or (no destructive)** — `[Add Anyway]  [Skip]` — secondary + primary, both equal weight.
5. **Acknowledge** — `[OK]` — single BtnPrimary.

Footer layout: `padding: 11px 14px 13px`, `border-top: 1px solid rgba(255,255,255,0.06)`, gap `8px` between buttons.

---

## The Five Rebuilt Dialogs (exact copy & props)

### 1. Already in Playlist (`warning`)
```jsx
<Confirm
  kind="warning"
  title="Already in Playlist"
  body={<>“Slice of Heaven” is already in <b>80s Hits Essentials</b>. Add it a second time, or skip?</>}
  context={<ContextStrip primary="Slice of Heaven" secondary="Dave Dobbyn · 1986" swatch="..." />}
  cancelLabel="Add Anyway"
  confirmLabel="Skip"
  confirmTone="primary"
/>
```

### 2. Delete DAP (`danger`)
```jsx
<Confirm
  kind="danger"
  title="Delete DAP?"
  body="This DAP and all its export history will be removed. The device files on disk are untouched."
  context={<ContextStrip primary="HiBy R6 III" secondary="/Volumes/HIBY_R6 · 412 exports" />}
  confirmLabel="Delete"
/>
```

### 3. Delete Playlist (`danger`)
```jsx
<Confirm
  kind="danger"
  title="Delete Playlist?"
  body={<>“00s Essential Hits” will be permanently deleted. Tracks remain in your library.</>}
  confirmLabel="Delete"
/>
```

### 4. Save Custom EQ (`prompt`, three-option)
```jsx
<Confirm
  kind="prompt"
  title="Save Custom EQ?"
  body="You have unsaved changes to the Custom PEQ. Save to keep the live edits, or discard to leave without them."
  altLabel="Discard"
  cancelLabel="Cancel"
  confirmLabel="Save"
/>
```

### 5. Support TuneBridge (`info`, wide)
```jsx
<Confirm
  kind="info"
  title="Support TuneBridge"
  body="TuneBridge is free and built by one person. If it has made your music library easier to enjoy, a small donation helps keep the app alive and funds the next round of improvements."
  cancelLabel="Maybe later"
  confirmLabel={<><KofiCup /> Support on Ko-fi</>}
  wide
/>
```

---

## Behaviour

- **Open**: dialog appears centred over a dimmed app surface. The host modal layer handles backdrop dimming + focus trap.
- **Close affordances**: `×` button, `Cancel` button, `Esc` key, and clicking the backdrop all call `onCancel`. (If `onClose` is provided separately, the `×` uses that.)
- **Default focus**: the committing button (`onConfirm`). `Enter` triggers it.
- **Keyboard**: `Esc` → cancel. `Enter` → confirm. `Tab` cycles within the dialog.
- **Animation**: 120ms ease-out fade + scale-from-98% on open; same in reverse on close. (Inherited from modal layer.)
- **No internal scroll**: confirmation dialogs are short by design. If copy doesn't fit in a `wide` dialog, the content belongs in a regular Modal, not a Confirm.

---

## State Management

`<Confirm>` itself is stateless and controlled. The caller owns:
- **Visibility** (mount/unmount via the host modal manager).
- **The decision** — `onConfirm`, `onCancel`, `onAlt` handlers fire the consequence and dismiss.

Suggested host integration:
```ts
modals.show(<Confirm kind="danger" title="Delete Playlist?" … onConfirm={() => { deletePlaylist(id); modals.dismiss(); }} onCancel={() => modals.dismiss()} />);
```

---

## Design Tokens

### Colours
| Token              | Value                            | Use                                          |
|--------------------|----------------------------------|----------------------------------------------|
| Modal surface      | `#1d1d1f`                        | Dialog background                            |
| Modal border       | `rgba(255,255,255,0.07)`         | 1px outer border                             |
| Modal shadow       | `0 24px 56px rgba(0,0,0,0.5), 0 4px 10px rgba(0,0,0,0.35)` | Ambient |
| Hairline           | `rgba(255,255,255,0.06)`         | Footer top border                            |
| Text               | `#e8e6e5`                        | Title, button labels                         |
| Text sub           | `#c1c6d7`                        | Body copy                                    |
| Text muted         | `#8a8a96`                        | Context secondary, captions                  |
| Accent / primary   | `#adc6ff`                        | BtnPrimary, info, prompt tint                |
| Accent ink         | `#0a1f47`                        | BtnPrimary label                             |
| Danger             | `#ffb3b5`                        | Danger tint, BtnDanger label/border          |
| Warning            | `#f0b429`                        | Warning tint                                 |
| Success            | `#53e16f`                        | Success tint                                 |
| Field bg           | `#2a2a2c`                        | BtnSecondary background                      |
| Context strip bg   | `rgba(255,255,255,0.025)`        | ContextStrip surface                         |
| Context strip border | `rgba(255,255,255,0.05)`       | ContextStrip 1px border                      |

### Typography
| Element        | Size  | Weight | Letter-spacing | Line-height | Color       |
|----------------|-------|--------|----------------|-------------|-------------|
| Title          | 15px  | 600    | -0.01em        | 1.3         | text        |
| Body           | 13px  | 400    | —              | 1.55        | text-sub    |
| Context primary| 12.5px| 500    | —              | 1.4         | text        |
| Context secondary | 11.5px | 400 | —              | 1.4         | text-muted  |
| Button         | 13px  | 500–600| —              | —           | (per tone)  |
| Section eyebrow| 10.5px| 700    | 0.12em uppercase | —         | text-muted  |

Font stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif`.

### Spacing & radii
| Token              | Value     |
|--------------------|-----------|
| Dialog width (default) | 420px |
| Dialog width (wide)    | 480px |
| Dialog radius      | 12px      |
| Button radius      | 7px       |
| ContextStrip radius| 7px       |
| Padding (header)   | 18px / 18px 0 |
| Padding (body)     | 10px 18px 16px |
| Padding (footer)   | 11px 14px 13px |
| Gap (header)       | 12px      |
| Gap (body sections)| 12px      |
| Gap (footer btns)  | 8px       |

### Icons
- 24×24px, `fill="currentColor"`, no border/plate.
- Files: `assets/icons/trash.svg`, `warning.svg`, `alert.svg`, `info.svg`, `checkmark.svg`.
- All on a 24-grid viewBox; can be uniformly scaled in CSS without re-export.

### Buttons (inherit from modal-system)
- **BtnPrimary**: `#adc6ff` bg, `#0a1f47` text, 600 weight, `7px 16px`, 7px radius. Hover: `#c4d5ff`.
- **BtnSecondary**: `#2e2e30` bg, `text` color, 500 weight, `1px solid rgba(255,255,255,0.07)`. Hover bg: `#36363a`.
- **BtnGhost**: transparent bg, `text-sub` colour. Hover: subtle.
- **BtnDanger**: `rgba(255,179,181,0.1)` bg, `#ffb3b5` text, `1px solid rgba(255,179,181,0.22)`. Hover: brighter bg.
- **CloseBtn**: 22px circle, `rgba(255,255,255,0.06)` bg, `text-muted` color. Hover: `rgba(255,255,255,0.12)` + `text`.

---

## Assets

Icon set (provided by user, included in `assets/icons/`):
- `trash.svg`
- `warning.svg`
- `alert.svg`
- `info.svg`
- `checkmark.svg`

All five are filled-path glyphs on a 24×24 viewBox using `fill="currentColor"` so the tint can be driven by the parent.

---

## Files in this bundle

| File                                      | Purpose                                                   |
|-------------------------------------------|-----------------------------------------------------------|
| `TuneBridge Confirmation System.html`     | Host page that renders the design canvas with all examples |
| `confirmation-system.jsx`                 | The `<Confirm>` / `<Acknowledge>` / `<ContextStrip>` / `<KindTile>` components — reference implementation |
| `confirmation-examples.jsx`               | Anatomy diagram + kinds gallery + footer patterns + 8 example dialog instances |
| `modal-system.jsx`                        | Shared primitives — buttons, CloseBtn, Modal shell. Confirmation system depends on `BtnPrimary`, `BtnSecondary`, `BtnGhost`, `BtnDanger`, `CloseBtn`, and the `T` token table |
| `colors_and_type.css`                     | TuneBridge global tokens — colour, type ramp, radius, shadow, spacing scale |
| `assets/icons/*.svg`                      | Five icon glyphs |

To run the reference design locally, open `TuneBridge Confirmation System.html` in any modern browser — no build step required.

---

## Notes for implementation

- **Do not reintroduce the boxed icon tile.** The bare-glyph treatment is intentional — the early version had a coloured plate and was rejected.
- **Body text is flush-left**, not indented under the title. Indenting created a dead "L" of whitespace under the icon.
- **Only `danger` uses the pink button.** "Save" buttons (even for the EQ prompt) use the blue primary. The legacy designs incorrectly used pink for non-destructive saves — this read as destructive.
- **One width, one icon size, one title scale.** Do not introduce new sizes; reach for `wide` only when copy genuinely needs it.
- **Cancel is the safe default** — visually weightier than `Delete` for destructive flows. Don't auto-focus Delete.
