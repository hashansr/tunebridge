# Modal Inventory Audit (Current App)

Source: `static/index.html` modal overlays  
Total overlays found: **25**

## Inventory
1. `iem-compare-modal`
2. `problem-tracks-modal`
3. `genre-distribution-modal`
4. `iem-blindspot-modal`
5. `missing-tags-bulk-modal`
6. `dup-modal`
7. `import-modal`
8. `help-modal`
9. `settings-modal`
10. `sync-modal`
11. `rename-modal`
12. `dap-modal`
13. `iem-modal`
14. `peq-modal`
15. `confirm-modal`
16. `onboarding-modal` (full-screen exception)
17. `create-playlist-modal`
18. `ml-gen-modal`
19. `sr-modal`
20. `ml-ref-modal`
21. `tag-editor-modal`
22. `album-tag-modal`
23. `artist-rename-modal`
24. `album-art-modal`
25. `artist-image-modal`

## Current consistency gaps
- Multiple global modal base definitions in CSS.
- Heavy inline-style usage in several modals (`dap`, `sync`, `import`, `help`, etc.).
- Mixed header patterns and close button variants.
- Inconsistent separators, paddings, and density.
- Some modals use unique component styling instead of shared primitives.

## Modal family mapping
- Form: `settings`, `dap`, `iem`, `peq`, `tag-editor`, `album-tag`, `artist-rename`, `rename`
- Selection/list review: `sync`, `create-playlist`, `sr`, `ml-gen`
- Confirm/destructive: `confirm`, `dup`, `import`
- Insight/detail: `problem-tracks`, `genre-distribution`, `iem-blindspot`, `ml-ref`
- Media editor: `album-art`, `artist-image`
- Specialized compare: `iem-compare`
- Exception: `onboarding`

## Standardization targets
- Shared shell + header/body/footer primitives.
- Shared token usage for type/color/spacing/radius/shadow.
- Shared button/input/chip/table/accordion behavior.
- Shared close/escape/dirty-guard rules.
- Removal of ad-hoc inline styles (migrate to classes/tokens).

## Rollout recommendation
### Phase 1 (core/high traffic)
- `sync-modal`
- `confirm-modal`
- `settings-modal`
- `dap-modal`
- `iem-modal`
- `peq-modal`
- `create-playlist-modal`
- `tag-editor-modal`

### Phase 2 (complete pass)
- remaining overlays from inventory list, including insights and media editors
