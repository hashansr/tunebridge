# TuneBridge Sync Modal Baseline

Status: Active Baseline  
Scope: `#sync-modal` (`pick` → `scanning` → `preview` → `copying` → `done`)  
Purpose: Source-of-truth reference for modal design/UX behavior; use this to standardize all remaining non-onboarding modals.

---

## 1. Intent

The Sync modal represents the target TuneBridge modal experience:
- Clear multi-step flow with minimal cognitive load.
- Premium glass surface aligned to `master-design.md`.
- Stable layout (no jumping controls/loader).
- Strong safety cues during long-running operations.
- One consistent interaction model across all steps.

Use this modal as the **baseline pattern library** for:
- modal shell + header behavior
- typography hierarchy
- warning ribbons
- action area treatment
- long-content scrolling
- progress-state behavior

---

## 2. Placement & Layout Contract

### 2.1 Overlay scope
- Pane-scoped modal only (active content area), not full app takeover.
- Sidebar + player remain visible.
- Modal is centered within active pane on desktop.
- On smaller heights, modal may shift to top-aligned scroll behavior.

### 2.2 Shell
- Width: compact-wide (single, consistent shell across all 5 steps).
- Height: fixed visual envelope; steps swap content, not shell size.
- Surface: dark glass with subtle blue-tinted depth.
- Border: soft ghost border (`--border` family).
- Radius: large family (`--radius-lg` equivalent).

### 2.3 Internal structure
1. Header
2. Warning/progress ribbon area
3. Body panel (`sync-phase-panel`)
4. Step-specific content
5. Actions

No step should introduce bespoke structure outside this pattern.

---

## 3. Typography & Iconography Baseline

Use `master-design.md` token language and rhythm.

### 3.1 Header typography
- Step overline: uppercase, small, high tracking.
- Title: consistent modal title size across all steps.
- Subtitle: one level below title, muted tone.
- Do not upsize step-1 title beyond other steps.

### 3.2 Body typography
- Progress percent: dominant numeric scale.
- Progress mode label (Scanning/Copying/Removing): compact uppercase support label.
- Status line: concise sentence case.
- File/current detail: muted, smaller, truncating where needed.

### 3.3 Iconography
- Single icon family and stroke weight within modal.
- Header icon container matches other modals (muted-luminous).
- Success icon (Step 5): accent-tinted but restrained (not neon/flat).

---

## 4. State Model & Step Contracts

## 4.1 Step 1: Pick device
- Only connected devices are selectable.
- Disconnected devices are visually disabled and non-interactive.
- Primary CTA disabled until valid selection.

## 4.2 Step 2: Scanning
- Circular progress ring + percentage.
- Mode label must read `Scanning`.
- Message should describe scan operation (not copy/sync mixed wording).
- Busy ribbon shown at top.

## 4.3 Step 3: Review changes
- Single scroll container for review content (no nested scrollers).
- Add/remove sections use accordions.
- Warnings are surfaced in top ribbon area (not noisy inline blocks by default).
- Sections with no data should be hidden.
- CTAs grouped logically (cancel + start sync together).

## 4.4 Step 4: Copying/removing
- Same ring treatment as Step 2 for continuity.
- Mode label dynamically reflects operation (`Syncing`, `Copying`, `Removing`).
- Loader position must remain fixed while detail text updates.
- Busy ribbon shown at top.

## 4.5 Step 5: Done
- Centered success composition.
- Clear title + supportive copy + concise result detail.
- Primary completion CTA (`Finish`) plus secondary follow-up (`Run Another Scan`).
- Completion message alignment must remain centered.

---

## 5. Warning Ribbon Standard

Use a dedicated top ribbon zone under the header.

### 5.1 Busy ribbon (scan/copy)
- Semantic: warning/attention tone.
- Text examples:
  - `Sync in progress - do not dismiss.`
  - `Sync in progress. Copying files now.`

### 5.2 Review warning ribbon (preview)
- Semantic: warning tone with count.
- Example:
  - `Warnings detected: N items. Review before syncing.`

### 5.3 Rules
- Ribbon spans modal width (not tiny chip floating in content).
- Ribbon visibility driven by phase + warning state.
- Ribbon styles stay semantically distinct from success/error toasts.

---

## 6. Interaction & Behavior Rules

### 6.1 Close behavior
- During idle phases (`pick`, `preview`, `done`): close allowed.
- During busy phases (`scanning`, `copying`): closing is discouraged and explicitly warned by ribbon.
- Existing discard/guard flows remain authoritative.

### 6.2 Progress behavior
- Progress never regresses visually within a phase unless phase resets.
- Ring and percent update smoothly.
- Status text updates must not cause layout shift of key focal elements (ring + action region).

### 6.3 Selection behavior (Step 3)
- “Select all” reflects row selection state.
- Empty selections should gracefully fall back to “Done” behavior (no dead-end CTA).

### 6.4 Scroll behavior
- One primary vertical scroller per phase panel when needed.
- No nested scroll regions inside warning/add/remove lists.

---

## 7. Accessibility & Usability Baseline

- Keyboard:
  - Tab order: header close → phase controls/content → actions.
  - Enter/Space for primary actions and toggles.
- Focus:
  - Visible, consistent focus ring across controls.
- Semantics:
  - Buttons and checkboxes preserve native semantics.
  - Disabled state uses both style and disabled attributes.
- Readability:
  - Keep contrast aligned with dark theme accessibility goals.
  - Avoid tiny secondary text in critical status moments.

---

## 8. Copy Guidelines

- Keep status lines short, operational, and human.
- Avoid mixing phase language:
  - Scan phase uses “scan/scanning”.
  - Copy phase uses “copying/removing/syncing”.
- Completion copy:
  - Positive and concise.
  - Issue-aware variant when errors exist.

---

## 9. Reusable Modal Pattern Kit (for other modals)

All future modals should inherit:
1. Header hierarchy (step/overline optional, title, subtitle).
2. Ribbon slot (busy/warning/info).
3. Stable body surface panel.
4. Unified CTA row patterns:
   - inline paired actions for procedural steps
   - stacked primary/secondary for completion states when appropriate
5. Single-scroll-content rule.
6. Typography and icon scale consistency with `master-design.md`.

---

## 10. Acceptance Checklist (Standardization Gate)

Use this checklist when redesigning any other modal:

- [ ] Modal is pane-scoped and properly centered in active area.
- [ ] Typography scale matches global modal hierarchy.
- [ ] Icon set/style matches TuneBridge iconography rules.
- [ ] No nested scrollers in core content flow.
- [ ] Warning/busy state uses top ribbon area.
- [ ] Primary CTA is visually clear; secondary actions are subdued.
- [ ] No layout jump in progress/frequent-update states.
- [ ] Empty/no-data states are hidden or handled cleanly.
- [ ] Keyboard focus + disabled semantics are correct.
- [ ] Visual language aligns with `master-design.md`.

---

## 11. Implementation Reference

Current implementation files:
- `static/index.html` (sync modal markup and phase sections)
- `static/style.css` (sync modal shell, phase styling, ribbon, typography)
- `static/app.js` (phase transitions, progress updates, preview rendering, done state)

Related policy docs:
- `master-design.md`
- `MODAL_UX.md`
- `GOOGLE_STITCH_MODAL_CONTEXT.md`

