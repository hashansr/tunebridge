# Google Stitch Prompt Pack — TuneBridge Modals

## 1) Master Prompt
Design a reusable modal design system for TuneBridge desktop app using a compact glass aesthetic.

Requirements:
- Pane-scoped modal behavior (except onboarding).
- Standardized modal shell with size tiers: sm 560, md 760, lg 920, xl 1080.
- Tokenized style system:
  - dark luminous background
  - glass surfaces with subtle border glow
  - text tiers (primary/secondary/muted)
  - semantic colors (success/warning/danger)
  - spacing scale 4/8/12/16/20/24/28/32
  - radius scale 12/14/16/22/pill
- Typography:
  - step eyebrow 13 uppercase
  - modal title 26
  - subtitle 18
  - section label 12
  - body 16
  - stat number 30
  - stat label 18
- Components:
  - buttons: primary/secondary/danger/ghost
  - inputs/select/search/toggle/checkbox/radio
  - chips, badges, pills
  - accordions
  - tables (sticky header, no wrapping headers, horizontal overflow for dense modes)
  - progress rows and status blocks
- Modal anatomy:
  - header: icon tile + step/title/subtitle + close
  - body: scrollable
  - footer: step dots/pill on left, actions on right
- Sync modal 5-step examples must be included and consistent with the same system.

Output:
1) token table
2) reusable component sheet
3) 5 modal templates
4) Sync step 1–5 variants

## 2) Refinement Prompt (Compactness)
Refine current modal concepts to match TuneBridge compact density:
- reduce shell width and vertical padding
- tighten title/subtitle spacing
- reduce oversized typography
- preserve readability and hierarchy
- keep icon tile aligned to text block center

## 3) Sync Modal Prompt
Generate Sync Music modal variants for steps 1–5 with one shared shell:
- step metadata in header
- phase-specific icon
- no top progress strip
- bottom step dots/pill indicator
- compact actions row
- discrepancy sections in review step:
  - New in Library -> Add to DAP
  - Deleted from Library (on DAP)
  - On DAP only (not in Library)
  - Playlists to Sync
  - Skipped tracks (collapsed)

## 4) Table + Accordion Prompt
Generate standardized modal table and accordion components:
- table: sticky header, left-aligned data, icon-only actions, horizontal scroll support
- accordion: seamless expanded state with squared joining edge
- hover/focus/selected/disabled states must use token colors
