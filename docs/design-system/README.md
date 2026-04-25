# TuneBridge Modal Design System (Stitch Handoff)

This folder contains the modal design handoff pack for Google Stitch.

## Files
- `design-system-v1.md`  
  Canonical design-system token and primitive contract for TuneBridge.
- `modal-system-policy.md`  
  Mandatory modal implementation policy + guardrail checklist.
- `modal-migration-audit-matrix.md`  
  Migration tracking matrix for all modal overlays.
- `modal-stitch-spec.md`  
  Canonical modal system spec (tokens, type scale, component standards, modal anatomy, behavior).
- `modal-stitch-mockup.html`  
  Visual reference mockup with token preview + modal/component examples.
- `modal-stitch-prompts.md`  
  Copy-ready prompts for Stitch to generate/refine designs consistently.
- `modal-inventory-audit.md`  
  Audit of all current modal overlays and standardization targets.

## Share with Stitch first
1. `modal-stitch-spec.md`
2. `modal-stitch-mockup.html`
3. `modal-stitch-prompts.md` (master prompt)

## Direction
- Visual baseline: **Compact Glass Baseline**
- Scope: **pane-scoped modals** (except onboarding)
- Goal: consistent, compact, premium modal language across all TuneBridge overlays

## Guardrail Validation
Run:
```bash
python3 scripts/check_modal_design_system.py
```
